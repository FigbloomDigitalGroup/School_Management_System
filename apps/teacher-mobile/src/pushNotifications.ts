import { PermissionsAndroid, Platform } from "react-native";
import { AuthorizationStatus, getMessaging, getToken, onTokenRefresh, requestPermission } from "@react-native-firebase/messaging";
import { supabase } from "@figbloom/shared";

/**
 * Registers this device for push and keeps device_tokens current, as the
 * parent/student/driver app does (apps/mobile/src/pushNotifications.ts). Android
 * only for now: iOS needs Apple push credentials that don't exist yet (FIG-293).
 * Every failure is swallowed: a teacher who declines the notification
 * permission, is offline, or has a build with no google-services.json still gets
 * the rest of the app working normally. Push is additive, never a gate.
 */
export async function registerPushToken(): Promise<void> {
  if (Platform.OS !== "android") return;

  try {
    if (Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS");
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return;
    }

    const messaging = getMessaging();
    const authStatus = await requestPermission(messaging);
    const enabled = authStatus === AuthorizationStatus.AUTHORIZED || authStatus === AuthorizationStatus.PROVISIONAL;
    if (!enabled) return;

    const token = await getToken(messaging);
    await saveToken(token);
    onTokenRefresh(messaging, (next: string) => { void saveToken(next); });
  } catch {
    // No FCM on this build (no google-services.json), no Play Services on this
    // device or emulator, permission dismissed some other way, offline:
    // push just doesn't register.
  }
}

async function saveToken(token: string): Promise<void> {
  const { data: { user } } = await supabase().auth.getUser();
  if (!user) return;
  await supabase().from("device_tokens").upsert(
    { profile_id: user.id, token, platform: "android" },
    { onConflict: "token" },
  );
}
