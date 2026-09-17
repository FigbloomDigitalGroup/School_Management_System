import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { loadParentData, type ChildInfo, type ClassLevel, type FeeItem, type MessageInfo, type ParentData, type Receipt } from "@figbloom/shared";
import { accentFor, t } from "./theme";

/**
 * Real parent data — one Supabase query (shared with web), cached to
 * AsyncStorage so the last-known balance and results stay readable with no
 * network. The cached copy is shown immediately; a fresh fetch replaces it
 * (and the cache) the moment it lands.
 */

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
  /** No register taken yet reads as nothing to report, not as absent. */
  attendance: number;
  /** No mark published yet reads as no mean, not as zero achievement. */
  mean: number;
}

function toChild(c: ChildInfo): Child {
  return {
    id: c.id, name: c.name, first: c.first, cls: c.cls, adm: c.adm,
    balance: c.balance, billed: c.billed, dueOn: c.dueOn,
    boarding: c.boarding, formLevel: c.formLevel, classLevel: c.classLevel, receipts: c.receipts,
    attendance: c.attendancePct ?? 100,
    mean: c.mean ?? 0,
  };
}

interface Ctx {
  children: Child[];
  messages: MessageInfo[];
  feeItems: ParentData["feeItems"];
  termLabel: string | null;
  subjectsFor: (childId: string) => [string, number][];
  index: number;
  setIndex: (i: number) => void;
  accent: string;
  country: string;
}

const ParentDataCtx = createContext<Ctx | null>(null);

export function ParentDataProvider({ profileId, accent, country, children }: { profileId: string; accent: string; country: string; children: ReactNode }) {
  const [data, setData] = useState<ParentData | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let alive = true;

    (async () => {
      const cached = await AsyncStorage.getItem(CACHE_KEY).catch(() => null);
      if (cached && alive) {
        try { setData(JSON.parse(cached) as ParentData); } catch { /* corrupt cache, ignore */ }
      }
      try {
        const fresh = await loadParentData(profileId);
        if (!alive) return;
        setData(fresh);
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(fresh)).catch(() => {});
      } catch {
        // Offline or the query failed — whatever the cache gave us stays on screen.
      }
    })();

    return () => { alive = false; };
  }, [profileId]);

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
    feeItems: data.feeItems,
    termLabel: data.termLabel,
    subjectsFor: (childId) => (data.children.find((c) => c.id === childId)?.subjects ?? []).map((s) => [s.name, s.score]),
    index,
    setIndex,
    accent,
    country,
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

export function useChildren(): Child[] {
  return useParentData().children;
}

export function useMessages(): MessageInfo[] {
  return useParentData().messages;
}

export function useSubjects(): [string, number][] {
  const { children, index, subjectsFor } = useParentData();
  const child = children[index] ?? children[0]!;
  return subjectsFor(child.id);
}

/** Raw term fee items — filter with itemsForStudent(items, child, child.formLevel) for one child. */
export function useFeeItems(): FeeItem[] {
  return useParentData().feeItems as unknown as FeeItem[];
}

export function useTermLabel(): string | null {
  return useParentData().termLabel;
}
