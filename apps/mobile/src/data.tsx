import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadParentData, markMessageRead, subscribeAnnouncements, type ChildInfo, type ChildSubject, type ClassLevel, type FeeItem, type MessageInfo, type ParentData, type Receipt } from "@figbloom/shared";
import { accentFor, t } from "./theme";

/**
 * Real parent data — one Supabase query (shared with web), cached to
 * AsyncStorage so the last-known balance and results stay readable with no
 * network. The cached copy is shown immediately; a fresh fetch replaces it
 * (and the cache) the moment it lands.
 */

/** Suffixed with the profile id: a second account on this phone must never see the first one's figures while its own loads. */
const CACHE_KEY = "figbloom.parentData.v1";

interface Child {
  id: string;
  name: string;
  first: string;
  cls: string;
  adm: string;
  balance: number;
  billed: number;
  dueOn: string | null;
  boarding: boolean;
  formLevel: number;
  classLevel: ClassLevel;
  receipts: Receipt[];
  /** null = no register taken yet — nothing to report, not 100% and not absent. */
  attendance: number | null;
  /** Dates (YYYY-MM-DD, oldest first) the register marked absent this term. */
  absentDates: string[];
  /** null = no mark published yet — no mean, not zero achievement. */
  mean: number | null;
  /** The published exam the mean and subjects come from. */
  examName: string | null;
}

function toChild(c: ChildInfo): Child {
  return {
    id: c.id, name: c.name, first: c.first, cls: c.cls, adm: c.adm,
    balance: c.balance, billed: c.billed, dueOn: c.dueOn,
    boarding: c.boarding, formLevel: c.formLevel, classLevel: c.classLevel, receipts: c.receipts,
    attendance: c.attendancePct,
    absentDates: c.absentDates ?? [], // a cache written by an older build may not carry it
    mean: c.mean,
    examName: c.examName,
  };
}

interface Ctx {
  children: Child[];
  messages: MessageInfo[];
  markMessageRead: (id: string) => void;
  feeItems: ParentData["feeItems"];
  termLabel: string | null;
  subjectsFor: (childId: string) => ChildSubject[];
  index: number;
  setIndex: (i: number) => void;
  accent: string;
  country: string;
  tenantId: string;
}

const ParentDataCtx = createContext<Ctx | null>(null);

export function ParentDataProvider({ profileId, accent, country, tenantId, children }: { profileId: string; accent: string; country: string; tenantId: string; children: ReactNode }) {
  const [data, setData] = useState<ParentData | null>(null);
  const [index, setIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;

    (async () => {
      const cached = await AsyncStorage.getItem(`${CACHE_KEY}.${profileId}`).catch(() => null);
      if (cached && alive) {
        try { setData(JSON.parse(cached) as ParentData); } catch { /* corrupt cache, ignore */ }
      }
      try {
        const fresh = await loadParentData(profileId);
        if (!alive) return;
        setData(fresh);
        await AsyncStorage.setItem(`${CACHE_KEY}.${profileId}`, JSON.stringify(fresh)).catch(() => {});
      } catch {
        // Offline or the query failed — whatever the cache gave us stays on screen.
      }
    })();

    return () => { alive = false; };
  }, [profileId, reloadKey]);

  // Re-loads the moment a new announcement lands — same pattern as web's
  // parentContext.tsx — so a new message shows up without a manual reload.
  useEffect(() => subscribeAnnouncements(tenantId, () => setReloadKey((k) => k + 1)), [tenantId]);

  /** Optimistic local update (so the Inbox screen and the tab badge — both
   *  reading from this same state — agree immediately) plus the real write,
   *  same split web's ParentInbox.tsx does. Previously this only ever
   *  happened in ParentInbox's own local state, so the badge (reading from
   *  here) never budged and the "read" mark didn't survive leaving Inbox. */
  function markRead(id: string) {
    setData((d) => {
      if (!d) return d;
      const target = d.messages.find((m) => m.id === id);
      if (!target?.unread) return d;
      return { ...d, messages: d.messages.map((m) => (m.id === id ? { ...m, unread: false } : m)) };
    });
    void markMessageRead(profileId, id).catch(() => {});
  }

  if (!data) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.appSurface.page }}>
        <ActivityIndicator size="large" color={accentFor(accent).deep} />
      </View>
    );
  }

  if (data.children.length === 0) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: t.appSurface.page }}>
        <Text style={{ fontSize: 15, fontWeight: "600", textAlign: "center" }}>No students linked to this account yet</Text>
        <Text style={{ fontSize: 13, color: t.appSurface.inkMuted, textAlign: "center", marginTop: 8 }}>
          Contact the school office to link your child.
        </Text>
      </View>
    );
  }

  const value: Ctx = {
    children: data.children.map(toChild),
    messages: data.messages,
    markMessageRead: markRead,
    feeItems: data.feeItems,
    termLabel: data.termLabel,
    subjectsFor: (childId) => data.children.find((c) => c.id === childId)?.subjects ?? [],
    index,
    setIndex,
    accent,
    country,
    tenantId,
  };

  return <ParentDataCtx.Provider value={value}>{children}</ParentDataCtx.Provider>;
}

function useParentData(): Ctx {
  const ctx = useContext(ParentDataCtx);
  if (!ctx) throw new Error("useChild()/useChildren()/useMessages() must be used inside ParentDataProvider");
  return ctx;
}

export function useChild() {
  const { children, index, setIndex, accent, country } = useParentData();
  return { child: children[index] ?? children[0]!, index, setIndex, accent, country };
}

/** The school's id, for Realtime subscriptions scoped to it (the Bus tab's live updates). */
export function useTenantId(): string {
  return useParentData().tenantId;
}

export function useChildren(): Child[] {
  return useParentData().children;
}

export function useMessages(): MessageInfo[] {
  return useParentData().messages;
}

/** Marks a message read for real — updates the badge and the shared list
 *  immediately, and persists it server-side so it stays read next launch. */
export function useMarkMessageRead(): (id: string) => void {
  return useParentData().markMessageRead;
}

/** The selected child's subjects in the latest published exam, each with its real class mean (null when unavailable). */
export function useSubjects(): ChildSubject[] {
  const { children, index, subjectsFor } = useParentData();
  const child = children[index] ?? children[0]!;
  return subjectsFor(child.id);
}

/** Raw term fee items — filter with itemsForStudent(items, child, child.formLevel, child.classLevel) for one child. */
export function useFeeItems(): FeeItem[] {
  return useParentData().feeItems as unknown as FeeItem[];
}

export function useTermLabel(): string | null {
  return useParentData().termLabel;
}
