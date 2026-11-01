import { getInitialNotification, getMessaging, onNotificationOpenedApp } from "@react-native-firebase/messaging";
import { pushTargetFrom, type PushTarget } from "@figbloom/shared";

/**
 * Hears the person tapping a push notification and says where it should take
 * them (pushTargetFrom): the tap that opened the app from nothing
 * (getInitialNotification, which answers once) and the tap that brought it back
 * from the background (onNotificationOpenedApp). A push whose data names no
 * destination just opens the app, as before. Android only, like registering for
 * push; any failure (no Firebase on this phone, no config) means there are no
 * taps to hear, never a crash. Returns the function that stops listening.
 */
export function listenForPushTaps(onTarget: (target: PushTarget) => void): () => void {
  let stop: () => void = () => {};
  try {
    const messaging = getMessaging();
    getInitialNotification(messaging)
      .then((message) => { const target = pushTargetFrom(message?.data); if (target) onTarget(target); })
      .catch(() => {});
    stop = onNotificationOpenedApp(messaging, (message) => { const target = pushTargetFrom(message.data); if (target) onTarget(target); });
  } catch {
    // Firebase isn't set up here: nothing can be tapped.
  }
  return () => stop();
}
