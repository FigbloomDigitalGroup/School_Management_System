import { createContext, useContext } from "react";
import type { OrgSession } from "./useOrgSession";

/** Mirrors sessionContext.tsx's SessionCtx/useTenantSession, one layer up for /org/* routes. */
export const OrgSessionCtx = createContext<OrgSession | null>(null);

export function useOrgSessionCtx(): OrgSession & { profile: NonNullable<OrgSession["profile"]>; organization: NonNullable<OrgSession["organization"]> } {
  const session = useContext(OrgSessionCtx);
  if (!session || !session.profile || !session.organization) {
    throw new Error("useOrgSessionCtx() must be used inside an authenticated OrgRoutes subtree");
  }
  return session as never;
}
