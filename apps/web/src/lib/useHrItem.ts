import { useCallback, useEffect, useState } from "react";
import { fetchHrHandoffStatus, HR_ITEM_LABEL, mayOfferHr, requestHrLink, showsHrItem, type HrHandoffStatus } from "@figbloom/shared";
import type { Session } from "./useSession";
import { openInNewTab } from "./openInNewTab";
import { useToast } from "../components/ui/Toast";
import type { ShellAction } from "../components/ConsoleShell";

/** The last answer per person and school, so moving between pages (each mounts its shell again) doesn't ask every time. */
const CACHE_MS = 60_000;
const cache = new Map<string, { status: HrHandoffStatus; at: number }>();

/**
 * The sidebar's "HR & Payroll" item (SCHOOLS_HR_HANDOFF_CONTRACT.md section 3), for a console shell's `actions`:
 * an empty list unless this person may have it at this school and hr_handoff_status() says it's available. A click
 * opens a tab at once and sends it to open-hr's one-time HR link; a refusal closes it, says why, and asks the
 * database again (after the platform says HR isn't on for the school, the item hides for an hour).
 */
export function useHrItem(session: Pick<Session, "profile" | "tenant" | "adminAreas" | "actingForTenant">): ShellAction[] {
  const toast = useToast();
  const tenantId = session.tenant?.id ?? null;
  const eligible = !!session.profile && !!tenantId && mayOfferHr(session.profile.role, session.adminAreas, session.actingForTenant);
  const key = tenantId && session.profile ? `${session.profile.id}:${tenantId}` : null;
  const cached = key ? cache.get(key) : undefined;
  const [status, setStatus] = useState<HrHandoffStatus | null>(cached && Date.now() - cached.at < CACHE_MS ? cached.status : null);
  const [busy, setBusy] = useState(false);

  const load = useCallback((fresh: boolean) => {
    if (!eligible || !tenantId || !key) { setStatus(null); return () => {}; }
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) { setStatus(hit.status); return () => {}; }
    let alive = true;
    fetchHrHandoffStatus(tenantId)
      .then((s) => { cache.set(key, { status: s, at: Date.now() }); if (alive) setStatus(s); })
      .catch((err: unknown) => { console.error(err); if (alive) setStatus(null); });
    return () => { alive = false; };
  }, [eligible, tenantId, key]);

  useEffect(() => load(false), [load]);

  if (!showsHrItem(eligible, status) || !tenantId) return [];
  return [{
    key: "hr",
    label: HR_ITEM_LABEL,
    icon: "external",
    title: "Open Figbloom HR & Payroll in a new tab, signed in",
    busy,
    onClick: () => {
      if (busy) return;
      setBusy(true);
      openInNewTab(async () => (await requestHrLink(tenantId)).url, `Opening ${HR_ITEM_LABEL}…`)
        .catch((err: unknown) => {
          toast(err instanceof Error ? err.message : `Could not open ${HR_ITEM_LABEL}.`, "error");
          load(true);
        })
        .finally(() => setBusy(false));
    },
  }];
}
