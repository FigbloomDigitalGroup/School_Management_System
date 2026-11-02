import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { endLoginEvenOffline, signOutCleanly, supabase, unsentWarning, type SignOutParts } from "@figbloom/shared";
import { queue } from "../storage";
import { forgetPushToken } from "../pushNotifications";
import { storedLoginKeys, storedUserId } from "./storedLogin";

const parts: SignOutParts = {
  userId: storedUserId,
  queue,
  forgetDevice: forgetPushToken,
  // This app keeps no copy of school data on the phone, only the unsent writes the queue holds.
  forgetCachedData: async () => {},
  endSession: () => endLoginEvenOffline({
    signOut: () => supabase().auth.signOut({ scope: "local" }),
    removeStoredLogin: async () => { await AsyncStorage.multiRemove(await storedLoginKeys()); },
  }),
};

/**
 * Every "Sign out" in this app goes through here (FIG-1489): ending the login alone left the phone's
 * notification token on the teacher's account and their unsent registers and marks on the phone.
 * Anything saved on the phone that has not been sent yet is sent first; if it cannot be, the teacher is
 * asked before it is thrown away.
 */
export async function signOutOfThisPhone(): Promise<void> {
  const first = await signOutCleanly(parts);
  if (first.done) return;

  const warning = unsentWarning(first.unsent);
  const lose = await new Promise<boolean>((resolve) => {
    Alert.alert(
      warning.title,
      warning.message,
      [
        { text: warning.stay, style: "cancel", onPress: () => resolve(false) },
        { text: warning.leave, style: "destructive", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
  if (lose) await signOutCleanly(parts, { discardUnsent: true });
}
