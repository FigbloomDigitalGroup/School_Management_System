import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Keyboard, Modal, Text, View } from "react-native";
import { Fingerprint } from "lucide-react-native";
import { supabase } from "@figbloom/shared";
import {
  confirmFingerprint, fingerprintSupport, forgetFingerprintUnlock, openFingerprintSettings, readFingerprintUnlock, saveFingerprintUnlock,
} from "../lib/fingerprintUnlock";
import { accentFor, HIT } from "../theme";
import { signOutOfThisPhone } from "../lib/signOut";
import { RIPPLE_ON_DARK } from "../ui/color";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

/** How long the app can sit in the background before it asks for the fingerprint again. */
const GRACE_MS = 30_000;

interface FingerprintLockValue {
  /** The person's own choice. */
  enabled: boolean;
  /** The screens on show always ask for the fingerprint (the admin screens), whatever the person chose. */
  required: boolean;
  /** Turns the lock on or off for the signed-in person. Does not check the fingerprint: the caller has. */
  setEnabled: (on: boolean) => Promise<void>;
}

const Ctx = createContext<FingerprintLockValue | null>(null);

export function useFingerprintLock(): FingerprintLockValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useFingerprintLock must be used inside <FingerprintLock>");
  return value;
}

interface Props {
  profileId: string;
  accent: string;
  /** Runs before the lock screen's "Sign out" — the driver's GPS service has to stop first. */
  beforeSignOut?: () => Promise<void>;
  /**
   * The screens on show are the admin ones: the lock is on whatever the person chose, and turning it on asks
   * for the fingerprint afresh. A phone with no fingerprint to ask for cannot open them.
   */
  required?: boolean;
  /** A way out of a required lock to the person's own screens, for a teacher who switched to admin. */
  onLeave?: { label: string; run: () => void };
  children: ReactNode;
}

/**
 * Fingerprint lock over the signed-in app: the person's choice, or always when `required`. The session itself stays on the phone; this
 * only decides whether the screens are usable: on a cold start, and on coming back after the app
 * has been in the background for GRACE_MS. The app underneath stays mounted while locked, so a
 * half-written message or a running trip is still there after unlocking.
 *
 * The choice is per profile and is dropped on sign-out, so signing in again starts with it off.
 */
export function FingerprintLock({ profileId, accent, beforeSignOut, required = false, onLeave, children }: Props) {
  const { t } = useTheme();
  // null until the saved choice has been read: rendering the app before then would flash it on a locked phone.
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(true);
  const on = required || !!enabled;

  // Switching to the admin screens is not covered by an earlier unlock: the fingerprint is asked for again.
  const wasRequired = useRef(required);
  useEffect(() => {
    if (required && !wasRequired.current) setLocked(true);
    wasRequired.current = required;
  }, [required]);

  useEffect(() => {
    let alive = true;
    readFingerprintUnlock(profileId).then((on) => { if (alive) setEnabledState(on); });
    return () => { alive = false; };
  }, [profileId]);

  useEffect(() => {
    if (!on) return;
    let leftAt: number | null = null;
    // iOS shows "inactive" while its own Face ID prompt is up, so only "background" starts the clock.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") { leftAt = Date.now(); return; }
      if (state !== "active" || leftAt === null) return;
      if (Date.now() - leftAt >= GRACE_MS) { Keyboard.dismiss(); setLocked(true); }
      leftAt = null;
    });
    return () => sub.remove();
  }, [on]);

  useEffect(() => {
    // An expired session ends up here too: whoever signs in next sets their own choice.
    const { data: sub } = supabase().auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") void forgetFingerprintUnlock(profileId);
    });
    return () => sub.subscription.unsubscribe();
  }, [profileId]);

  const setEnabled = useCallback(async (on: boolean) => {
    if (on) await saveFingerprintUnlock(profileId);
    else await forgetFingerprintUnlock(profileId);
    setEnabledState(on);
    // The person has just proved themselves to change this; don't lock them out of the screen they are on.
    setLocked(false);
  }, [profileId]);

  const unlock = useCallback(() => setLocked(false), []);
  const value = useMemo(() => ({ enabled: !!enabled, required, setEnabled }), [enabled, required, setEnabled]);

  if (enabled === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.appSurface.card }}>
        <ActivityIndicator size="large" color={accentFor(accent).deep} />
      </View>
    );
  }

  return (
    <Ctx.Provider value={value}>
      {children}
      {on && locked && <LockScreen accent={accent} required={required} onLeave={onLeave} onUnlocked={unlock} beforeSignOut={beforeSignOut} />}
    </Ctx.Provider>
  );
}

/**
 * A Modal, not an absolutely-positioned View: on iOS a native-stack modal (the Pay screen) is
 * presented above the root view, and would sit over a lock drawn there.
 */
function LockScreen({ accent, required, onLeave, onUnlocked, beforeSignOut }: {
  accent: string;
  required: boolean;
  onLeave?: { label: string; run: () => void };
  onUnlocked: () => void;
  beforeSignOut?: () => Promise<void>;
}) {
  const a = accentFor(accent);
  // "not_enrolled": a required lock on a phone with a sensor but no fingerprint saved, which the person can fix.
  const [state, setState] = useState<"asking" | "retry" | "unavailable" | "not_enrolled">("asking");
  const [signingOut, setSigningOut] = useState(false);
  const asking = useRef(false);

  const ask = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    setState("asking");
    try {
      const support = await fingerprintSupport();
      if (support !== "ready") { setState(required && support === "not_enrolled" ? "not_enrolled" : "unavailable"); return; }
      if (await confirmFingerprint("Unlock Figbloom")) onUnlocked();
      else setState("retry");
    } finally {
      asking.current = false;
    }
  }, [onUnlocked, required]);

  // Back in front after leaving the lock screen open: ask again rather than leave a dead screen.
  // Only after a real trip to the background — iOS flips to "inactive" and back around its own
  // prompt, and a cancel there must not bring the prompt straight back.
  useEffect(() => {
    let wasInBackground = false;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background") wasInBackground = true;
      else if (next === "active" && wasInBackground) { wasInBackground = false; void ask(); }
    });
    return () => sub.remove();
  }, [ask]);

  async function signOut() {
    setSigningOut(true);
    try {
      await beforeSignOut?.();
      await signOutOfThisPhone();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    // onShow, not on mount: the system prompt opened before this window exists would end up underneath it.
    <Modal visible animationType="none" statusBarTranslucent onRequestClose={() => {}} onShow={() => void ask()}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: a.deep }}>
        <View style={{ width: 84, height: 84, borderRadius: 42, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.16)" }}>
          <Fingerprint color="#fff" size={44} />
        </View>
        <Text style={{ fontSize: 22, fontWeight: "600", color: "#fff", marginTop: 24, textAlign: "center" }}>
          {state === "not_enrolled" ? "Set up a fingerprint"
            : state === "unavailable" ? (required ? "Admin screens need a fingerprint" : "Fingerprint unavailable")
            : "Figbloom is locked"}
        </Text>
        <Text style={{ fontSize: 13.5, lineHeight: 20, color: "rgba(255,255,255,0.8)", textAlign: "center", marginTop: 8 }}>
          {state === "not_enrolled"
            ? "The admin screens on this phone need your fingerprint, and none is saved on it yet. Add one in the phone's settings, then come back."
            : state === "unavailable"
              ? (required
                ? "This phone has no fingerprint sensor the app can use, so the admin screens cannot open here. Use the web console instead."
                : "This phone no longer has a fingerprint set up for the app. Sign out, then sign in with your password.")
              : state === "retry"
                ? "That didn't unlock it. Tap the button to try again."
                : "Touch the fingerprint sensor to continue."}
        </Text>

        {state === "not_enrolled" ? (
          <>
            <LockButton label="Open phone settings" color={a.deep} onPress={() => void openFingerprintSettings()} />
            <LockLink label="Check again" onPress={() => void ask()} />
          </>
        ) : state !== "unavailable" && (
          <LockButton label="Unlock with fingerprint" color={a.deep} disabled={state === "asking"} onPress={() => void ask()} />
        )}

        {onLeave && <LockLink label={onLeave.label} onPress={onLeave.run} />}
        <LockLink label={signingOut ? "Signing out…" : "Sign out"} disabled={signingOut} onPress={() => void signOut()} />
      </View>
    </Modal>
  );
}

/** The lock screen's one main action: a white pill. */
function LockButton({ label, color, disabled, onPress }: { label: string; color: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Tap
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={{ ...HIT, marginTop: 28, paddingHorizontal: 24, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "#fff", opacity: disabled ? 0.6 : 1 }}
    >
      <Text style={{ fontSize: 15, fontWeight: "600", color }}>{label}</Text>
    </Tap>
  );
}

/** Quieter actions under it: check again, back to the teacher screens, sign out. */
function LockLink({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Tap
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      ripple={RIPPLE_ON_DARK}
      style={{ ...HIT, marginTop: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.6 : 1 }}
    >
      <Text style={{ fontSize: 13.5, fontWeight: "600", color: "rgba(255,255,255,0.85)" }}>{label}</Text>
    </Tap>
  );
}
