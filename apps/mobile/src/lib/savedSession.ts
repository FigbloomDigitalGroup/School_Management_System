import AsyncStorage from "@react-native-async-storage/async-storage";
import { SAVED_SESSION_KEY } from "@figbloom/shared";

/**
 * Role and school come from the signed-in profile, not a baked-in constant: mobile has no path to read a
 * tenant slug from, so it is resolved when the app opens (and again on every auth state change).
 */
export type AppSession =
  | { role: "parent"; accent: string; profileId: string; country: string; tenantId: string }
  | { role: "student"; accent: string; profileId: string; country: string; tenantId: string }
  | { role: "driver"; accent: string; profileId: string; tenantId: string; fullName: string }
  | { role: "teacher"; accent: string; profileId: string; tenantId: string; fullName: string; country: string };

const filled = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A saved identity is only trusted if it is whole and belongs to the person it was read for. */
function isAppSession(value: unknown, userId: string): value is AppSession {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return false;
  if (o.profileId !== userId || !filled(o.accent) || !filled(o.tenantId)) return false;
  if (o.role === "driver") return filled(o.fullName);
  if (o.role === "teacher") return filled(o.fullName) && filled(o.country);
  return (o.role === "parent" || o.role === "student") && filled(o.country);
}

/**
 * Who the phone last opened as, saved so the app can open with no signal (FIG-1487). Only the identity: the
 * family's figures are kept by data.tsx / studentData.tsx. Deleted on sign-out (lib/cacheKeys.ts).
 */
export async function readSavedSession(userId: string): Promise<AppSession | null> {
  try {
    const raw = await AsyncStorage.getItem(`${SAVED_SESSION_KEY}.${userId}`);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isAppSession(value, userId) ? value : null;
  } catch {
    return null;
  }
}

export async function saveSession(userId: string, session: AppSession): Promise<void> {
  await AsyncStorage.setItem(`${SAVED_SESSION_KEY}.${userId}`, JSON.stringify(session));
}
