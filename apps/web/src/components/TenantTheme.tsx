import { createContext, useContext, useEffect, type ReactNode } from "react";
import { accentFor, type Tenant } from "@figbloom/shared";

const TenantCtx = createContext<Tenant | null>(null);
export const useTenant = () => useContext(TenantCtx);

/**
 * A school's accent enters the system as two CSS variables and nothing else.
 * Layout, type and spacing never change per tenant — support staff must be able
 * to navigate any of 248 schools without relearning the interface.
 */
export function TenantTheme({ tenant, children }: { tenant: Tenant | null; children: ReactNode }) {
  useEffect(() => {
    const a = accentFor(tenant?.accent ?? "#1B4D2E");
    document.documentElement.style.setProperty("--accent", a.hex);
    document.documentElement.style.setProperty("--accent-deep", a.deep);
  }, [tenant?.accent]);

  return <TenantCtx.Provider value={tenant}>{children}</TenantCtx.Provider>;
}
