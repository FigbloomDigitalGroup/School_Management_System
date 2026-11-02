import AsyncStorage from "@react-native-async-storage/async-storage";
import { isStoredLoginKey, userIdFromStoredLogin } from "@figbloom/shared";

/** The keys under which the login library keeps the session on this phone. */
export const storedLoginKeys = async (): Promise<string[]> => (await AsyncStorage.getAllKeys()).filter(isStoredLoginKey);

/** Who is signed in on this phone, read from storage with no network (see userIdFromStoredLogin). */
export async function storedUserId(): Promise<string | null> {
  const tokenKey = (await storedLoginKeys()).find((key) => key.endsWith("-auth-token"));
  return userIdFromStoredLogin(tokenKey ? await AsyncStorage.getItem(tokenKey) : null);
}
