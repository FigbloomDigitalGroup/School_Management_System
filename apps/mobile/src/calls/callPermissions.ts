import { PermissionsAndroid, Platform, type Permission } from "react-native";

/**
 * Asks for what a call needs before it starts: the microphone, the camera for a
 * video call, and (Android 12 and later) Bluetooth, so a headset can carry the
 * call. iOS asks for the camera and microphone itself, the first time they are
 * used, from the reasons in Info.plist. Returns null when the call can go ahead,
 * or the words to show when it can not. Bluetooth is a nicety: refused, the
 * phone's own speaker and earpiece still work.
 */
export async function ensureCallPermissions(video: boolean): Promise<string | null> {
  if (Platform.OS !== "android") return null;
  const wanted: Permission[] = ["android.permission.RECORD_AUDIO"];
  if (video) wanted.push("android.permission.CAMERA");
  if (Platform.Version >= 31) wanted.push("android.permission.BLUETOOTH_CONNECT");
  const result = await PermissionsAndroid.requestMultiple(wanted);
  if (result["android.permission.RECORD_AUDIO"] !== PermissionsAndroid.RESULTS.GRANTED) {
    return "Allow the microphone in your phone's settings to make or take calls.";
  }
  if (video && result["android.permission.CAMERA"] !== PermissionsAndroid.RESULTS.GRANTED) {
    return "Allow the camera in your phone's settings for video, or make a voice call.";
  }
  return null;
}
