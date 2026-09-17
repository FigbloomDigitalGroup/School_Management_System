import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { loadParentData, subscribeAnnouncements, type ChildInfo, type ParentData } from "@figbloom/shared";
import { useAsync } from "./useAsync";
import { useTenantSession } from "./sessionContext";

interface ParentCtxValue {
  data: ParentData | null;
  loading: boolean;
  error: Error | null;
  children: ChildInfo[];
  child: ChildInfo | null;
  childId: string | null;
  setChildId: (id: string) => void;
}

const ParentCtx = createContext<ParentCtxValue | null>(null);

/**
 * Loads a parent's whole picture once — every desktop screen (Home, Fees,
 * Results, Inbox, Account) reads from here instead of re-querying, and the
 * selected child survives a refresh because it lives in the URL, not state.
 * Re-loads on any new tenant announcement (subscribeAnnouncements) so the
 * Inbox's message list reacts the moment one arrives, not just on refresh.
 */
export function ParentDataProvider({ children: kids }: { children: ReactNode }) {
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => loadParentData(profile.id), [profile.id, reloadKey]);
  const [params, setParams] = useSearchParams();

  useEffect(() => subscribeAnnouncements(tenant.id, () => setReloadKey((k) => k + 1)), [tenant.id]);

  const list = useMemo(() => data?.children ?? [], [data]);
  const childId = params.get("child") ?? list[0]?.id ?? null;
  const child = list.find((c) => c.id === childId) ?? list[0] ?? null;

  const setChildId = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("child", id);
    setParams(next, { replace: true });
  };

  const value: ParentCtxValue = { data, loading, error, children: list, child, childId, setChildId };
  return <ParentCtx.Provider value={value}>{kids}</ParentCtx.Provider>;
}

export function useParentData(): ParentCtxValue {
  const ctx = useContext(ParentCtx);
  if (!ctx) throw new Error("useParentData() must be used inside <ParentDataProvider>");
  return ctx;
}
