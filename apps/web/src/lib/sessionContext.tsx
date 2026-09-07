import { createContext, useContext } from "react";
import type { Session } from "./useSession";

/**
 * TenantRoutes (App.tsx) fetches the session once via useSession and provides
 * it here — every screen underneath reads the same {profile, tenant} instead
 * of each doing its own auth.getUser() round trip.
 */
export const SessionCtx = createContext<Session | null>(null);

/** Only valid inside TenantRoutes, where profile and tenant are already resolved. */
export function useTenantSession(): Session & { profile: NonNullable<Session["profile"]>; tenant: NonNullable<Session["tenant"]> } {
  const session = useContext(SessionCtx);
  if (!session || !session.profile || !session.tenant) {
    throw new Error("useTenantSession() must be used inside an authenticated TenantRoutes subtree");
  }
  return session as never;
}
