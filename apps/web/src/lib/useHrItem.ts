import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchHrStatus, HR_ITEM_LABEL, hrItemMode, hrLaunchUrl, hrPagePath, mayOfferHr, type HrStatus } from "@figbloom/shared";
import type { Session } from "./useSession";
import { openHrLaunchTab } from "./hrLaunch";
import type { ShellAction } from "../components/ConsoleShell";

type HrSession = Pick<Session, "profile" | "tenant" | "adminAreas" | "actingForTenant" | "delegatedOrgConsole">;

/** The last answer per person and school, so moving between pages (each mounts its shell again) doesn't ask every time. */
const CACHE_MS = 60_000;
const cache = new Map<string, { status: HrStatus; at: number }>();
/** One question at a time per person and school (the shell, the HR & Payroll page and Leave to approve all ask). */
const inflight = new Map<string, Promise<HrStatus>>();
/** Every mounted hook hears a new answer, so the sidebar follows the page's "Check again" and "Request". */
const listeners = new Set<(key: string, status: HrStatus) => void>();

const freshAnswer = (key: string | null) => {
  const hit = key ? cache.get(key) : undefined;
  return hit && Date.now() - hit.at < CACHE_MS ? hit.status : null;
};

export interface HrStatusState {
  /** This person may have HR & Payroll at this school (mayOfferHr): only they are asked. */
  eligible: boolean;
  /** open-hr's answer (HR_STATUS_HIDDEN when switched off or refused), or null until it's in. */
  status: HrStatus | null;
  /** The last question failed (the item stays hidden; the page says so). */
  failed: boolean;
  /** Ask again now, past the minute's cache (the open-hr side keeps its own minute too). */
  reload: () => Promise<void>;
}

/**
 * Whether Figbloom HR is there for this person's school (open-hr {action: "status"}, HR_CONNECT_SPEC.md), for the
 * sidebar item and the HR & Payroll page. Nobody else is asked.
 */
export function useHrStatus(session: HrSession): HrStatusState {
  const tenantId = session.tenant?.id ?? null;
  const eligible = !!session.profile && !!tenantId && mayOfferHr(session.profile.role, session.adminAreas, session.actingForTenant, session.delegatedOrgConsole);
  const key = eligible && session.profile ? `${session.profile.id}:${tenantId}` : null;
  const [status, setStatus] = useState<HrStatus | null>(() => freshAnswer(key));
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setStatus(freshAnswer(key));
    if (!key) return;
    const hear = (k: string, s: HrStatus) => { if (k === key) { setStatus(s); setFailed(false); } };
    listeners.add(hear);
    return () => { listeners.delete(hear); };
  }, [key]);

  const load = useCallback(async (force: boolean) => {
    if (!key || !tenantId) return;
    if (!force && freshAnswer(key)) return;
    let ask = inflight.get(key);
    if (!ask) {
      ask = fetchHrStatus(tenantId);
      inflight.set(key, ask);
    }
    try {
      const s = await ask;
      cache.set(key, { status: s, at: Date.now() });
      for (const hear of listeners) hear(key, s);
    } catch (err) {
      console.error(err);
      setFailed(true);
    } finally {
      if (inflight.get(key) === ask) inflight.delete(key);
    }
  }, [key, tenantId]);

  useEffect(() => { void load(false); }, [load]);

  return { eligible, status, failed, reload: useCallback(() => load(true), [load]) };
}

/**
 * The sidebar's "HR & Payroll" item (HR_CONNECT_SPEC.md), for a console shell's `sideActions`: there for people who
 * may have it whenever HR handoff is switched on. HR there (or not checkable): a click opens the launch tab at once
 * (external-link mark); otherwise it goes to the HR & Payroll page, where the school can ask Figbloom for it ("+").
 */
export function useHrItem(session: HrSession): ShellAction[] {
  const nav = useNavigate();
  const { eligible, status } = useHrStatus(session);
  const tenantId = session.tenant?.id;
  const slug = session.tenant?.slug;
  const mode = hrItemMode(eligible, status);
  if (!mode || !tenantId || !slug) return [];
  if (mode === "launch") {
    return [{
      key: "hr",
      label: HR_ITEM_LABEL,
      icon: "people",
      mark: "external",
      title: "Open Figbloom HR & Payroll in a new tab, signed in",
      onClick: () => { openHrLaunchTab(hrLaunchUrl(tenantId, slug)); },
    }];
  }
  const to = hrPagePath(slug);
  return [{
    key: "hr",
    label: HR_ITEM_LABEL,
    icon: "people",
    mark: "connect",
    to,
    title: "Connect Figbloom HR & Payroll",
    onClick: () => nav(to),
  }];
}
