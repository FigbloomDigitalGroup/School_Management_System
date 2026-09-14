import { createContext, useContext, type ReactNode } from "react";
import { loadStudentData, type StudentData } from "@figbloom/shared";
import { useAsync } from "./useAsync";
import { useTenantSession } from "./sessionContext";

interface StudentCtxValue {
  data: StudentData | null;
  loading: boolean;
  error: Error | null;
}

const StudentCtx = createContext<StudentCtxValue | null>(null);

/** Loads a student's whole picture once — every desktop screen reads from here. */
export function StudentDataProvider({ children }: { children: ReactNode }) {
  const { profile } = useTenantSession();
  const { data, loading, error } = useAsync(() => loadStudentData(profile.id), [profile.id]);
  return <StudentCtx.Provider value={{ data, loading, error }}>{children}</StudentCtx.Provider>;
}

export function useStudentData(): StudentCtxValue {
  const ctx = useContext(StudentCtx);
  if (!ctx) throw new Error("useStudentData() must be used inside <StudentDataProvider>");
  return ctx;
}
