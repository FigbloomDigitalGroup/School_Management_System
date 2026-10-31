import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, AppState, Modal, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  CALL_RING_SECONDS, endLiveClass, fetchCallLog, isRingExpired, joinCall, joinLiveClass, liveClassNotice, liveClassSubtitle,
  muteAllLearners, ringLeftMs, setCallStatus, setLearnersMayPublish, startCall, startLiveClass, subscribeMyCalls,
  type Call, type LiveClass, type LiveClassRole, type RoomPass,
} from "@figbloom/shared";
import { CallRoom } from "./CallRoom";
import { ensureCallPermissions } from "./callPermissions";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

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

/** Only valid under CallProvider, which the navigation mounts for every signed-in parent, learner and teacher. */
export function useCalls(): Calls {
  const ctx = useContext(CallsCtx);
  if (!ctx) throw new Error("useCalls() must be used inside CallProvider");
  return ctx;
}

/**
 * In-app calls and live classes for one signed-in person (the website's
 * CallHost, on a phone): listens for their calls over Realtime, shows the
 * incoming-call card over whatever screen they are on, and owns the one room that
 * can be open at a time. A phone adds two things the website does not need: it
 * asks for the microphone (and camera) before a call, and it looks for a call
 * that is already ringing when the app opens or comes back to the front, because
 * a push that opened the app arrives while the Realtime connection was asleep.
 */
export function CallProvider({ profileId, children }: { profileId: string; children: ReactNode }) {
  const { t, s } = useTheme();
  const insets = useSafeAreaInsets();
  const [active, setActive] = useState<Active | null>(null);
  const [incoming, setIncoming] = useState<Call | null>(null);
  const [answering, setAnswering] = useState(false);
  const [banner, setBanner] = useState<{ text: string; bad: boolean } | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const say = useCallback((text: string, bad = false) => setBanner({ text, bad }), []);
  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(null), 6_000);
    return () => clearTimeout(id);
  }, [banner]);

  // One place every way of leaving a room ends up (the Leave button, the other
  // side hanging up, the teacher ending the class), and LiveKit's own disconnect
  // fires once more as the room closes: only the first counts.
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
        say(c.status === "declined" ? `${c.callee_name} can't take the call right now.`
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
      // answered on another phone, or the caller gave up: stop ringing here
      setIncoming((prev) => (prev?.id === c.id ? null : prev));
    }
  }), [profileId, say]);

  // A call already ringing when the app opens or comes forward (the push that opened
  // it arrived while Realtime was asleep).
  const checkRinging = useCallback(() => {
    fetchCallLog(profileId, 5).then((log) => {
      const ringing = log.find((c) => c.callee_id === profileId && c.status === "ringing" && !isRingExpired(c));
      if (ringing && !activeRef.current) setIncoming((prev) => prev ?? ringing);
    }).catch(() => {});
  }, [profileId]);
  useEffect(() => {
    checkRinging();
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") checkRinging(); });
    return () => sub.remove();
  }, [checkRinging]);

  // The caller stops ringing after CALL_RING_SECONDS; the callee's card goes away
  // at the same point, even if the caller's phone lost signal without saying so.
  const ringingCallId = active?.kind === "call" && active.call.status === "ringing" ? active.call.id : null;
  useEffect(() => {
    if (!ringingCallId) return;
    const id = setTimeout(() => {
      const current = activeRef.current;
      if (current?.kind === "call" && current.call.id === ringingCallId) {
        say(`${current.call.callee_name} didn't answer.`);
        leave();
      }
    }, CALL_RING_SECONDS * 1000);
    return () => clearTimeout(id);
  }, [ringingCallId, leave, say]);

  useEffect(() => {
    if (!incoming) return;
    const id = setTimeout(() => setIncoming((prev) => (prev?.id === incoming.id ? null : prev)), ringLeftMs(incoming));
    return () => clearTimeout(id);
  }, [incoming]);

  const fail = useCallback((err: unknown) => {
    say(err instanceof Error ? err.message : "That didn't work. Try again.", true);
  }, [say]);

  const call = useCallback(async (calleeId: string, video: boolean) => {
    if (activeRef.current) return;
    const denied = await ensureCallPermissions(video);
    if (denied) { say(denied, true); return; }
    try {
      const { call: c, url, token } = await startCall(calleeId, video);
      setActive({ kind: "call", call: c, pass: { url, token } });
    } catch (err) { fail(err); }
  }, [fail, say]);

  const goLive = useCallback<Calls["goLive"]>(async (input) => {
    if (activeRef.current) return;
    const denied = await ensureCallPermissions(true);
    if (denied) { say(denied, true); return; }
    try {
      const { live_class, role, url, token } = await startLiveClass(input);
      setActive({ kind: "class", live: live_class, role, pass: { url, token } });
    } catch (err) { fail(err); }
  }, [fail, say]);

  // Joining a class to watch needs no permission; a learner asks for the mic when they unmute.
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
      const denied = await ensureCallPermissions(c.video);
      // The card stays: allow it in settings and answer again, or decline.
      if (denied) { say(denied, true); return; }
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
      <View style={{ flex: 1 }}>
        {children}
        {!!banner && (
          <View pointerEvents="none" style={{ position: "absolute", left: 16, right: 16, bottom: 96 }}>
            <Text accessibilityLiveRegion="polite" style={{ padding: 12, borderRadius: 12, overflow: "hidden", textAlign: "center", fontSize: 13, color: "#fff", backgroundColor: banner.bad ? t.status.warnInk : "#222" }}>
              {banner.text}
            </Text>
          </View>
        )}
      </View>
      {incoming && (
        <Modal transparent visible animationType="fade" onRequestClose={() => void answer(false)}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", paddingTop: insets.top + 24, paddingHorizontal: 16 }}>
            <View accessibilityRole="alert" accessibilityLabel={`${incoming.caller_name} is calling`} style={[s.card, { padding: 18, gap: 4 }]}>
              <Text style={s.eyebrow}>{incoming.video ? "VIDEO CALL" : "VOICE CALL"}</Text>
              <Text style={{ fontSize: 19, fontWeight: "700", color: t.appSurface.ink }}>{incoming.caller_name} is calling</Text>
              <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                <Tap accessibilityRole="button" disabled={answering} onPress={() => void answer(true)} style={{ flex: 1, minHeight: 52, borderRadius: 14, backgroundColor: "#1E7A43", alignItems: "center", justifyContent: "center", opacity: answering ? 0.6 : 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>Answer</Text>
                </Tap>
                <Tap accessibilityRole="button" disabled={answering} onPress={() => void answer(false)} style={{ flex: 1, minHeight: 52, borderRadius: 14, backgroundColor: t.status.warnInk, alignItems: "center", justifyContent: "center", opacity: answering ? 0.6 : 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#fff" }}>Decline</Text>
                </Tap>
              </View>
            </View>
          </View>
        </Modal>
      )}
      {active && (active.kind === "call" ? (
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
          subtitle={liveClassSubtitle(active.role)}
          audio={active.role === "host"}
          video={active.role === "host"}
          notice={liveClassNotice(active.role, active.live.learners_may_publish)}
          toolbar={active.role === "host" ? (
            <HostControls
              live={active.live}
              onChange={(live) => setActive((a) => (a?.kind === "class" ? { ...a, live } : a))}
              onEnded={leave}
            />
          ) : undefined}
          onLeave={leave}
        />
      ))}
    </CallsCtx.Provider>
  );
}

/** The teacher's controls in a live class: mute everyone, let learners speak, end it for all. */
function HostControls({ live, onChange, onEnded }: { live: LiveClass; onChange: (live: LiveClass) => void; onEnded: () => void }) {
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    setNote(null);
    try { await fn(); } catch (err) { setNote(err instanceof Error ? err.message : "That didn't work."); } finally { setWorking(false); }
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <HostButton label="Mute all" disabled={working} onPress={() => void run(async () => {
          const { muted } = await muteAllLearners(live.id);
          setNote(muted ? `Muted ${muted} mic${muted === 1 ? "" : "s"}.` : "Nobody else had their mic on.");
        })} />
        <HostButton label={live.learners_may_publish ? "Lock learners' mics" : "Let learners speak"} pressed={live.learners_may_publish} disabled={working} onPress={() => void run(async () => {
          const allow = !live.learners_may_publish;
          await setLearnersMayPublish(live.id, allow);
          onChange({ ...live, learners_may_publish: allow });
          setNote(allow ? "Learners can now unmute and turn on their cameras." : "Learners' mics and cameras are locked off.");
        })} />
        <HostButton label="End class" disabled={working} onPress={() => {
          Alert.alert("End the class for everyone?", "Learners and parents will be disconnected.", [
            { text: "Cancel", style: "cancel" },
            { text: "End class", style: "destructive", onPress: () => { void run(async () => { await endLiveClass(live.id); onEnded(); }); } },
          ]);
        }} />
      </View>
      {!!note && <Text style={{ fontSize: 12.5, color: "rgba(255,255,255,0.8)" }}>{note}</Text>}
    </View>
  );
}

function HostButton({ label, pressed, disabled, onPress }: { label: string; pressed?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Tap
      accessibilityRole="button"
      accessibilityState={{ selected: !!pressed, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)", backgroundColor: pressed ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center", opacity: disabled ? 0.5 : 1 }}
    >
      <Text style={{ fontSize: 12.5, fontWeight: "600", color: "#fff" }}>{label}</Text>
    </Tap>
  );
}
