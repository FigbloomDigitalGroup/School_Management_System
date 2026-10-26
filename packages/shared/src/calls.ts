import { invokeEdge } from "./edge";
import { supabase } from "./supabase";

/**
 * In-app calls and Figbloom live classes, on LiveKit Cloud. The database
 * (supabase/migrations/20261027030000_calls_live_classes.sql) says who may
 * call whom and keeps the call log; the call-token edge function hands out
 * the LiveKit tokens; the audio and video go straight from the browser to
 * LiveKit. Shared so the phone apps can join the same rooms later.
 */

export type CallStatus = "ringing" | "accepted" | "declined" | "missed" | "ended";

export interface Call {
  id: string;
  tenant_id: string;
  caller_id: string | null;
  callee_id: string | null;
  caller_name: string;
  callee_name: string;
  video: boolean;
  status: CallStatus;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  ended_by: string | null;
}

export interface LiveClass {
  id: string;
  tenant_id: string;
  class_id: string;
  subject_id: string | null;
  title: string;
  started_by: string | null;
  learners_may_publish: boolean;
  started_at: string;
  ended_at: string | null;
}

/** "host" teaches the class (or is the office), "learner" is in it, "family" is a parent of someone in it. */
export type LiveClassRole = "host" | "learner" | "family";

/** Someone the signed-in person may call: my_contacts(). */
export interface Contact {
  id: string;
  full_name: string;
  role: string;
  staff_title: string | null;
  avatar_url: string | null;
}

/** Where to connect and with what: one room, one person. */
export interface RoomPass {
  url: string;
  token: string;
}

/** How long a call rings before it's missed. Matches call_ring_expired() in the migration. */
export const CALL_RING_SECONDS = 45;

const TOKEN_TIMEOUT_MS = 15_000;

/** A ringing call nobody answered in time counts as missed, whatever its row still says. */
export function isRingExpired(call: Pick<Call, "status" | "created_at">, now: Date = new Date()): boolean {
  return call.status === "ringing" && now.getTime() - new Date(call.created_at).getTime() > CALL_RING_SECONDS * 1000;
}

/** "4:07" / "1:02:30" for an answered call; null when it never connected. */
export function callDuration(call: Pick<Call, "answered_at" | "ended_at">, now: Date = new Date()): string | null {
  if (!call.answered_at) return null;
  const end = call.ended_at ? new Date(call.ended_at) : now;
  const total = Math.max(0, Math.floor((end.getTime() - new Date(call.answered_at).getTime()) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The other person on a call, from one side of it. */
export function otherParty(call: Pick<Call, "caller_id" | "caller_name" | "callee_name">, myId: string): string {
  return call.caller_id === myId ? call.callee_name : call.caller_name;
}

/** "Mathematics" -> "Form 2 East · Mathematics": what the Join card and the room header say. */
export function liveClassTitle(className: string, subjectName?: string | null): string {
  return subjectName ? `${className} · ${subjectName}` : className;
}

// ---------------------------------------------------------------- data access

export async function fetchMyContacts(): Promise<Contact[]> {
  const { data, error } = await supabase().rpc("my_contacts");
  if (error) throw new Error(error.message);
  return (data ?? []) as Contact[];
}

/** Rings someone. Throws the function's own words when calls aren't set up or the pairing isn't allowed. */
export async function startCall(calleeId: string, video: boolean): Promise<RoomPass & { call: Call }> {
  return await invokeEdge("call-token", { action: "call", callee_id: calleeId, video }, { timeoutMs: TOKEN_TIMEOUT_MS });
}

export async function joinCall(callId: string): Promise<RoomPass & { call: Call }> {
  return await invokeEdge("call-token", { action: "join_call", call_id: callId }, { timeoutMs: TOKEN_TIMEOUT_MS });
}

/** accepted / declined (the callee), missed (the caller giving up), ended (either). */
export async function setCallStatus(callId: string, status: Exclude<CallStatus, "ringing">): Promise<Call> {
  const { data, error } = await supabase().rpc("set_call_status", { p_call_id: callId, p_status: status });
  if (error) throw new Error(error.message);
  return data as Call;
}

/** Calls this person made or got, newest first. */
export async function fetchCallLog(profileId: string, limit = 30): Promise<Call[]> {
  const { data, error } = await supabase()
    .from("calls").select("*").or(`caller_id.eq.${profileId},callee_id.eq.${profileId}`)
    .order("created_at", { ascending: false }).limit(limit).returns<Call[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Every new or changed call involving this person, as it happens. Realtime
 * applies calls_read, so only their own calls arrive (an admin's would also
 * see the school's, hence the filter on their id).
 */
export function subscribeMyCalls(profileId: string, onChange: (call: Call) => void): () => void {
  const sb = supabase();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const channel = sb.channel(`calls-${profileId}-${tag}`);
  for (const col of ["caller_id", "callee_id"]) {
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "calls", filter: `${col}=eq.${profileId}` },
      (payload) => { if (payload.new && "id" in payload.new) onChange(payload.new as Call); },
    );
  }
  channel.subscribe();
  return () => { void sb.removeChannel(channel); };
}

/** Live classes running now in some classes (a learner's one, a parent's children's). */
export async function fetchRunningLiveClasses(classIds?: string[]): Promise<LiveClass[]> {
  if (classIds && classIds.length === 0) return [];
  let q = supabase().from("live_classes").select("*").is("ended_at", null);
  if (classIds) q = q.in("class_id", classIds);
  const { data, error } = await q.order("started_at", { ascending: false }).returns<LiveClass[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Any live class starting or ending in this school. */
export function subscribeLiveClasses(tenantId: string, onChange: () => void): () => void {
  const sb = supabase();
  const channel = sb
    .channel(`live-classes-${tenantId}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "live_classes", filter: `tenant_id=eq.${tenantId}` }, () => onChange())
    .subscribe();
  return () => { void sb.removeChannel(channel); };
}

export async function startLiveClass(input: {
  classId: string; subjectId: string | null; title: string; learnersMayPublish: boolean;
}): Promise<RoomPass & { live_class: LiveClass; role: LiveClassRole }> {
  return await invokeEdge("call-token", {
    action: "start_class", class_id: input.classId, subject_id: input.subjectId, title: input.title,
    learners_may_publish: input.learnersMayPublish,
  }, { timeoutMs: TOKEN_TIMEOUT_MS });
}

export async function joinLiveClass(liveClassId: string): Promise<RoomPass & { live_class: LiveClass; role: LiveClassRole }> {
  return await invokeEdge("call-token", { action: "join_class", live_class_id: liveClassId }, { timeoutMs: TOKEN_TIMEOUT_MS });
}

export async function muteAllLearners(liveClassId: string): Promise<{ muted: number }> {
  return await invokeEdge("call-token", { action: "mute_all", live_class_id: liveClassId }, { timeoutMs: TOKEN_TIMEOUT_MS });
}

export async function setLearnersMayPublish(liveClassId: string, allow: boolean): Promise<void> {
  await invokeEdge("call-token", { action: "learners_may_publish", live_class_id: liveClassId, allow }, { timeoutMs: TOKEN_TIMEOUT_MS });
}

export async function endLiveClass(liveClassId: string): Promise<void> {
  await invokeEdge("call-token", { action: "end_class", live_class_id: liveClassId }, { timeoutMs: TOKEN_TIMEOUT_MS });
}
