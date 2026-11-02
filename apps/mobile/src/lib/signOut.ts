import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  endLoginEvenOffline, isStoredLoginKey, signOutCleanly, supabase, unsentWarning, userIdFromStoredLogin, type SignOutParts,
} from "@figbloom/shared";
import { queue } from "../storage";
import { forgetPushToken } from "../pushNotifications";
import { CACHE_KEYS } from "./cacheKeys";

/**
 * Deletes every cached copy of family and learner data on this phone, whoever it belongs to: the cache is
 * only there to show the last-known figures with no signal, and signing in again needs signal.
 */
export async function forgetCachedData(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  await AsyncStorage.multiRemove(keys.filter((key) => CACHE_KEYS.some((prefix) => key.startsWith(`${prefix}.`))));
}

const storedLoginKeys = async () => (await AsyncStorage.getAllKeys()).filter(isStoredLoginKey);

const parts: SignOutParts = {
  userId: async () => {
    const tokenKey = (await storedLoginKeys()).find((key) => key.endsWith("-auth-token"));
    return userIdFromStoredLogin(tokenKey ? await AsyncStorage.getItem(tokenKey) : null);
  },
  queue,
  forgetDevice: forgetPushToken,
  forgetCachedData,
  endSession: () => endLoginEvenOffline({
    signOut: () => supabase().auth.signOut({ scope: "local" }),
    removeStoredLogin: async () => { await AsyncStorage.multiRemove(await storedLoginKeys()); },
  }),
};

/**
 * Every "Sign out" in this app goes through here (FIG-1489): ending the login alone left the phone's
 * notification token on the person's account and their data on the phone. Anything saved on the phone that
 * has not been sent yet is sent first; if it cannot be, the person is asked before it is thrown away.
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
