import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { showsMyHr } from "@figbloom/shared";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useTenantSession } from "../../lib/sessionContext";
import { useMyHrStatus } from "../../lib/useMyHr";

/**
 * My HR by address on the API build: the page opens only while the API's status for this person says "available". Until it is
 * known a skeleton shows; for any other answer (off, the school not linked, not staff, or the status could not be read) the
 * person goes back to their console's home, so the page is no more reachable than its menu entry (which ConsoleShell hides).
 */
export function MyHrGate({ home, children }: { home: "admin" | "teacher" | "staff"; children: ReactNode }) {
  const session = useTenantSession();
  const status = useMyHrStatus(session);
  if (status === null) return <div className="px-7 py-6"><TableSkeleton rows={4} /></div>;
  if (!showsMyHr(status)) return <Navigate to={`/s/${session.tenant.slug}/${home}`} replace />;
  return <>{children}</>;
}
