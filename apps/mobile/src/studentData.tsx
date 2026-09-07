import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchClassTimetable, loadStudentData, type StudentData, type Weekday } from "@figbloom/shared";
import { accentFor, t } from "./theme";

/**
 * Real student data — the same query web's student screens use, plus the
 * class timetable, cached to AsyncStorage so Timetable/Results/Notices stay
 * readable with no network. Today.tsx and Work.tsx are unaffected; they keep
 * their own placeholder data until a separate pass wires them up too.
 */

const CACHE_KEY = "figbloom.studentData.v1";

interface Cached {
  data: StudentData;
  timetable: Record<Weekday, [string, string, string][]>;
}

interface Ctx {
  data: StudentData;
  timetable: Record<Weekday, [string, string, string][]>;
  accent: string;
}

type State =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "ready"; cached: Cached };

const StudentDataCtx = createContext<Ctx | null>(null);

export function StudentDataProvider({ profileId, accent, children }: { profileId: string; accent: string; children: ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let alive = true;

    (async () => {
      const raw = await AsyncStorage.getItem(CACHE_KEY).catch(() => null);
      if (raw && alive) {
        try { setState({ status: "ready", cached: JSON.parse(raw) as Cached }); } catch { /* corrupt cache, ignore */ }
      }
      try {
        const data = await loadStudentData(profileId);
        if (!alive) return;
        if (!data) { setState({ status: "empty" }); return; }
        const timetable = await fetchClassTimetable(data.classId);
        if (!alive) return;
        const fresh: Cached = { data, timetable };
        setState({ status: "ready", cached: fresh });
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(fresh)).catch(() => {});
      } catch {
        // Offline or the query failed — whatever the cache gave us (if any) stays on screen.
      }
    })();

    return () => { alive = false; };
  }, [profileId]);

  if (state.status === "loading") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.appSurface.page }}>
        <ActivityIndicator size="large" color={accentFor(accent).deep} />
      </View>
    );
  }

  if (state.status === "empty") {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: t.appSurface.page }}>
        <Text style={{ fontSize: 15, fontWeight: "600", textAlign: "center" }}>No learner record linked to this account yet</Text>
        <Text style={{ fontSize: 13, color: t.appSurface.inkMuted, textAlign: "center", marginTop: 8 }}>
          Contact the school office.
        </Text>
      </View>
    );
  }

  return (
    <StudentDataCtx.Provider value={{ data: state.cached.data, timetable: state.cached.timetable, accent }}>
      {children}
    </StudentDataCtx.Provider>
  );
}

export function useStudentData(): Ctx {
  const ctx = useContext(StudentDataCtx);
  if (!ctx) throw new Error("useStudentData() must be used inside StudentDataProvider");
  return ctx;
}
