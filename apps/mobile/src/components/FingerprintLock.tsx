import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, Keyboard, Modal, Text, View } from "react-native";
import { Fingerprint } from "lucide-react-native";
import { supabase } from "@figbloom/shared";
import {
  confirmFingerprint, fingerprintSupport, forgetFingerprintUnlock, readFingerprintUnlock, saveFingerprintUnlock,
} from "../lib/fingerprintUnlock";
import { accentFor, HIT } from "../theme";
import { RIPPLE_ON_DARK } from "../ui/color";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

/** How long the app can sit in the background before it asks for the fingerprint again. */
const GRACE_MS = 30_000;

interface FingerprintLockValue {
  enabled: boolean;
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
  children: ReactNode;
}

/**
 * Optional fingerprint lock over the signed-in app. The session itself stays on the phone; this
 * only decides whether the screens are usable: on a cold start, and on coming back after the app
 * has been in the background for GRACE_MS. The app underneath stays mounted while locked, so a
 * half-written message or a running trip is still there after unlocking.
 *
 * The choice is per profile and is dropped on sign-out, so signing in again starts with it off.
 */
export function FingerprintLock({ profileId, accent, beforeSignOut, children }: Props) {
  const { t } = useTheme();
  // null until the saved choice has been read: rendering the app before then would flash it on a locked phone.
  const [enabled, setEnabledState] = useState<boolean | null>(null);
  const [locked, setLocked] = useState(true);

  useEffect(() => {
    let alive = true;
    readFingerprintUnlock(profileId).then((on) => { if (alive) setEnabledState(on); });
    return () => { alive = false; };
  }, [profileId]);

  useEffect(() => {
    if (!enabled) return;
    let leftAt: number | null = null;
    // iOS shows "inactive" while its own Face ID prompt is up, so only "background" starts the clock.
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") { leftAt = Date.now(); return; }
      if (state !== "active" || leftAt === null) return;
      if (Date.now() - leftAt >= GRACE_MS) { Keyboard.dismiss(); setLocked(true); }
      leftAt = null;
    });
    return () => sub.remove();
  }, [enabled]);

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
  const value = useMemo(() => ({ enabled: !!enabled, setEnabled }), [enabled, setEnabled]);

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
      {enabled && locked && <LockScreen accent={accent} onUnlocked={unlock} beforeSignOut={beforeSignOut} />}
    </Ctx.Provider>
  );
}

/**
 * A Modal, not an absolutely-positioned View: on iOS a native-stack modal (the Pay screen) is
 * presented above the root view, and would sit over a lock drawn there.
 */
function LockScreen({ accent, onUnlocked, beforeSignOut }: { accent: string; onUnlocked: () => void; beforeSignOut?: () => Promise<void> }) {
  const a = accentFor(accent);
  const [state, setState] = useState<"asking" | "retry" | "unavailable">("asking");
  const [signingOut, setSigningOut] = useState(false);
  const asking = useRef(false);

  const ask = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    setState("asking");
    try {
      if ((await fingerprintSupport()) !== "ready") { setState("unavailable"); return; }
      if (await confirmFingerprint("Unlock Figbloom")) onUnlocked();
      else setState("retry");
    } finally {
      asking.current = false;
    }
  }, [onUnlocked]);

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
      await supabase().auth.signOut({ scope: "local" });
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
        <Text style={{ fontSize: 22, fontWeight: "600", color: "#fff", marginTop: 24 }}>
          {state === "unavailable" ? "Fingerprint unavailable" : "Figbloom is locked"}
        </Text>
        <Text style={{ fontSize: 13.5, lineHeight: 20, color: "rgba(255,255,255,0.8)", textAlign: "center", marginTop: 8 }}>
          {state === "unavailable"
            ? "This phone no longer has a fingerprint set up for the app. Sign out, then sign in with your password."
            : state === "retry"
              ? "That didn't unlock it. Tap the button to try again."
              : "Touch the fingerprint sensor to continue."}
        </Text>

        {state !== "unavailable" && (
          <Tap
            accessibilityRole="button"
            disabled={state === "asking"}
            onPress={() => void ask()}
            style={{ ...HIT, marginTop: 28, paddingHorizontal: 24, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: "#fff", opacity: state === "asking" ? 0.6 : 1 }}
          >
            <Text style={{ fontSize: 15, fontWeight: "600", color: a.deep }}>Unlock with fingerprint</Text>
          </Tap>
        )}

        <Tap
          accessibilityRole="button"
          disabled={signingOut}
          onPress={() => void signOut()}
          ripple={RIPPLE_ON_DARK}
          style={{ ...HIT, marginTop: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", opacity: signingOut ? 0.6 : 1 }}
        >
          <Text style={{ fontSize: 13.5, fontWeight: "600", color: "rgba(255,255,255,0.85)" }}>{signingOut ? "Signing out…" : "Sign out"}</Text>
        </Tap>
      </View>
    </Modal>
  );
}
