import { Linking, Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import ReactNativeBiometrics from "react-native-biometrics";

/** Per signed-in profile, so a second person on the same phone starts with it off. */
const KEY = "figbloom.fingerprintUnlock.v1";

/** Strong biometrics only (a real fingerprint match), no phone-PIN fallback: the person asked for the fingerprint. */
const biometrics = new ReactNativeBiometrics();

/** "ready": a fingerprint is enrolled and the app may ask for it. */
export type FingerprintSupport = "ready" | "not_enrolled" | "unavailable";

export async function fingerprintSupport(): Promise<FingerprintSupport> {
  try {
    const { available, error } = await biometrics.isSensorAvailable();
    if (available) return "ready";
    // Android says BIOMETRIC_ERROR_NONE_ENROLLED; iOS puts "Biometry is not enrolled" in the text.
    if (error && /NONE_ENROLLED|not enrolled/i.test(error)) return "not_enrolled";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Shows the system fingerprint prompt. False for a cancel, a lock-out after too many wrong
 * touches, or the prompt being closed by the system — the callers all treat those the same.
 */
export async function confirmFingerprint(promptMessage: string): Promise<boolean> {
  try {
    const { success } = await biometrics.simplePrompt({ promptMessage, cancelButtonText: "Cancel" });
    return success;
  } catch {
    return false;
  }
}

export async function readFingerprintUnlock(profileId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(`${KEY}.${profileId}`)) === "on";
  } catch {
    return false;
  }
}

export async function saveFingerprintUnlock(profileId: string): Promise<void> {
  await AsyncStorage.setItem(`${KEY}.${profileId}`, "on");
}

export async function forgetFingerprintUnlock(profileId: string): Promise<void> {
  await AsyncStorage.removeItem(`${KEY}.${profileId}`).catch(() => {});
}

/** Takes the person to where a fingerprint is enrolled; the app cannot enrol one itself. */
export async function openFingerprintSettings(): Promise<void> {
  try {
    if (Platform.OS === "android") await Linking.sendIntent("android.settings.SECURITY_SETTINGS");
    else await Linking.openSettings();
  } catch {
    await Linking.openSettings().catch(() => {});
  }
}
