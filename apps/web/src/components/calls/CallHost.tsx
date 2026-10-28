import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CALL_RING_SECONDS, endLiveClass, isRingExpired, joinCall, joinLiveClass, muteAllLearners, setCallStatus, setLearnersMayPublish,
  startCall, startLiveClass, subscribeMyCalls,
  type Call, type LiveClass, type LiveClassRole, type RoomPass,
} from "@figbloom/shared";
import { useToast } from "../ui/Toast";
import { confirmDialog } from "../ui/Confirm";

const CallRoom = lazy(() => import("./CallRoom"));

type Active =
  | { kind: "call"; call: Call; pass: RoomPass }
  | { kind: "class"; live: LiveClass; role: LiveClassRole; pass: RoomPass };

interface Calls {
  /** Rings someone and opens the call. */
  call: (profileId: string, video: boolean) => Promise<void>;
  /** A teacher going live (or rejoining their running class). */
  goLive: (input: { classId: string; subjectId: string | null; title: string; learnersMayPublish: boolean }) => Promise<void>;
  /** A learner, parent or teacher joining a running class. */
  joinClass: (liveClassId: string) => Promise<void>;
  /** Whether a room is open right now: a second call can't start on top of it. */
  busy: boolean;
}

const CallsCtx = createContext<Calls | null>(null);

/** Only valid under CallHost, which TenantRoutes mounts for every signed-in school user. */
export function useCalls(): Calls {
  const ctx = useContext(CallsCtx);
  if (!ctx) throw new Error("useCalls() must be used inside CallHost");
  return ctx;
}

/**
 * In-app calls and live classes for one signed-in person, mounted once for
 * the whole school console: listens for their calls over Realtime, shows
 * the incoming-call card wherever they are in the app, and owns the one
 * room that can be open at a time.
 */
export function CallHost({ profileId, children }: { profileId: string; children: ReactNode }) {
  const toast = useToast();
  const [active, setActive] = useState<Active | null>(null);
  const [incoming, setIncoming] = useState<Call | null>(null);
  const [answering, setAnswering] = useState(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  // One place every way of leaving a room ends up (the Leave button, the
  // other side hanging up, the teacher ending the class), and LiveKit's own
  // disconnect fires once more as the room unmounts: only the first counts.
  const leave = useCallback(() => {
    const current = activeRef.current;
    if (!current) return;
    activeRef.current = null;
    setActive(null);
    if (current.kind === "call") {
      void setCallStatus(current.call.id, current.call.status === "ringing" ? "missed" : "ended").catch(() => {});
    }
  }, []);

  useEffect(() => subscribeMyCalls(profileId, (c) => {
    const current = activeRef.current;
    if (current?.kind === "call" && current.call.id === c.id) {
      if (c.status === "accepted") setActive({ ...current, call: c });
      else if (c.status !== "ringing") {
        toast(c.status === "declined" ? `${c.callee_name} can't take the call right now.`
          : c.status === "missed" && c.caller_id === profileId ? `${c.callee_name} didn't answer.`
          : "The call has ended.");
        activeRef.current = null;
        setActive(null);
      }
      return;
    }
    if (c.callee_id === profileId && c.status === "ringing" && !isRingExpired(c)) {
      setIncoming((prev) => prev ?? c);
    } else {
      // answered on another tab, or the caller gave up: stop ringing here
      setIncoming((prev) => (prev?.id === c.id ? null : prev));
    }
  }), [profileId, toast]);

  // The caller stops ringing after CALL_RING_SECONDS; the callee's card goes
  // away at the same point, even if the caller's tab closed without saying so.
  const ringingCallId = active?.kind === "call" && active.call.status === "ringing" ? active.call.id : null;
  useEffect(() => {
    if (!ringingCallId) return;
    const id = window.setTimeout(() => {
      if (activeRef.current?.kind === "call" && activeRef.current.call.id === ringingCallId) {
        toast(`${activeRef.current.call.callee_name} didn't answer.`);
        leave();
      }
    }, CALL_RING_SECONDS * 1000);
    return () => window.clearTimeout(id);
  }, [ringingCallId, leave, toast]);

  useEffect(() => {
    if (!incoming) return;
    const left = CALL_RING_SECONDS * 1000 - (Date.now() - new Date(incoming.created_at).getTime());
    const id = window.setTimeout(() => setIncoming((prev) => (prev?.id === incoming.id ? null : prev)), Math.max(0, left));
    return () => window.clearTimeout(id);
  }, [incoming]);

  const fail = useCallback((err: unknown) => {
    toast(err instanceof Error ? err.message : "That didn't work. Try again.", "error");
  }, [toast]);

  const call = useCallback(async (calleeId: string, video: boolean) => {
    if (activeRef.current) return;
    try {
      const { call: c, url, token } = await startCall(calleeId, video);
      setActive({ kind: "call", call: c, pass: { url, token } });
    } catch (err) { fail(err); }
  }, [fail]);

  const goLive = useCallback<Calls["goLive"]>(async (input) => {
    if (activeRef.current) return;
    try {
      const { live_class, role, url, token } = await startLiveClass(input);
      setActive({ kind: "class", live: live_class, role, pass: { url, token } });
    } catch (err) { fail(err); }
  }, [fail]);

  const joinClass = useCallback(async (liveClassId: string) => {
    if (activeRef.current) return;
    try {
      const { live_class, role, url, token } = await joinLiveClass(liveClassId);
      setActive({ kind: "class", live: live_class, role, pass: { url, token } });
    } catch (err) { fail(err); }
  }, [fail]);

  async function answer(accept: boolean) {
    const c = incoming;
    if (!c) return;
    setAnswering(true);
    try {
      if (!accept) {
        await setCallStatus(c.id, "declined");
        setIncoming(null);
        return;
      }
      if (activeRef.current) leave();
      const accepted = await setCallStatus(c.id, "accepted");
      const { url, token } = await joinCall(c.id);
      setIncoming(null);
      setActive({ kind: "call", call: accepted, pass: { url, token } });
    } catch (err) {
      setIncoming(null);
      fail(err);
    } finally {
      setAnswering(false);
    }
  }

  const value = useMemo<Calls>(() => ({ call, goLive, joinClass, busy: !!active }), [call, goLive, joinClass, active]);

  return (
    <CallsCtx.Provider value={value}>
      {children}
      {incoming && (
        <div
          role="alertdialog"
          aria-label={`${incoming.caller_name} is calling`}
          className="animate-rise fixed bottom-5 right-5 z-[70] w-[300px] max-w-[calc(100vw-32px)] rounded-xl border border-line bg-white p-4 shadow-lg"
        >
          <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">{incoming.video ? "VIDEO CALL" : "VOICE CALL"}</div>
          <div className="mt-1 text-[15px] font-semibold">{incoming.caller_name} is calling</div>
          <div className="mt-3 flex gap-2">
            <button
              type="button" disabled={answering} onClick={() => void answer(true)}
              className="flex-1 rounded-md border border-forest bg-forest px-3 py-2 text-[13px] font-semibold text-white hover:bg-forest-deep disabled:opacity-50"
            >
              Answer
            </button>
            <button
              type="button" disabled={answering} onClick={() => void answer(false)}
              className="flex-1 rounded-md border border-warn-ink bg-warn-ink px-3 py-2 text-[13px] font-semibold text-white hover:brightness-95 disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        </div>
      )}
      {active && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] grid place-items-center bg-[#111] text-[13px] text-white/70">Connecting…</div>}>
          {active.kind === "call" ? (
            <CallRoom
              pass={active.pass}
              title={active.call.caller_id === profileId ? active.call.callee_name : active.call.caller_name}
              subtitle={active.call.video ? "Video call" : "Voice call"}
              audio
              video={active.call.video}
              notice={active.call.status === "ringing" ? "Ringing…" : null}
              onLeave={leave}
            />
          ) : (
            <CallRoom
              pass={active.pass}
              title={active.live.title}
              subtitle={active.role === "host" ? "You're teaching this live class" : "Live class"}
              audio={active.role === "host"}
              video={active.role === "host"}
              notice={active.role === "learner" && !active.live.learners_may_publish
                ? "Your mic and camera stay off until the teacher lets learners speak."
                : active.role === "family" ? "You're watching. Only the teacher and learners can speak." : null}
              toolbar={active.role === "host" ? (
                <HostControls
                  live={active.live}
                  onChange={(live) => setActive((a) => (a?.kind === "class" ? { ...a, live } : a))}
                  onEnded={leave}
                  fail={fail}
                />
              ) : undefined}
              onLeave={leave}
            />
          )}
        </Suspense>
      )}
    </CallsCtx.Provider>
  );
}

/** The teacher's controls in a live class: mute everyone, let learners speak, end it for all. */
function HostControls({ live, onChange, onEnded, fail }: {
  live: LiveClass; onChange: (live: LiveClass) => void; onEnded: () => void; fail: (err: unknown) => void;
}) {
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    try { await fn(); } catch (err) { fail(err); } finally { setWorking(false); }
  };
  const btn = "rounded-md border border-white/25 bg-white/10 px-3 py-2 text-[12.5px] font-semibold text-white hover:bg-white/20 disabled:opacity-50";
  return (
    <>
      <button type="button" className={btn} disabled={working} onClick={() => void run(async () => {
        const { muted } = await muteAllLearners(live.id);
        toast(muted ? `Muted ${muted} mic${muted === 1 ? "" : "s"}.` : "Nobody else had their mic on.");
      })}>
        Mute all
      </button>
      <button type="button" className={btn} disabled={working} aria-pressed={live.learners_may_publish} onClick={() => void run(async () => {
        const allow = !live.learners_may_publish;
        await setLearnersMayPublish(live.id, allow);
        onChange({ ...live, learners_may_publish: allow });
        toast(allow ? "Learners can now unmute and turn on their cameras." : "Learners' mics and cameras are locked off.");
      })}>
        {live.learners_may_publish ? "Lock learners' mics" : "Let learners speak"}
      </button>
      <button type="button" className={btn} disabled={working} onClick={async () => {
        if (!(await confirmDialog({ title: "End the class for everyone?", body: "Learners and parents will be disconnected.", confirmLabel: "End class", danger: true }))) return;
        void run(async () => {
          await endLiveClass(live.id);
          onEnded();
        });
      }}>
        End class
      </button>
    </>
  );
}
