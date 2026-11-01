import { useCallback, useState } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { loadStudentPapers, type StudentPaper } from "@figbloom/shared";
import { useStudentData } from "../studentData";

export type PapersState =
  | { kind: "loading" }
  | { kind: "failed" }
  /** The learner is not in a class, so there is nothing to show. */
  | { kind: "none" }
  | { kind: "ready"; papers: StudentPaper[] };

/**
 * The learner's exam papers and where they stand on each, read again every
 * time the screen comes back into view (sitting a paper happens on a screen
 * above this one). A failed re-read never blanks what is already shown.
 */
export function useStudentPapers(): { state: PapersState; retry: () => void } {
  const { data } = useStudentData();
  const { classId, studentId } = data;
  const [state, setState] = useState<PapersState>({ kind: "loading" });

  const read = useCallback(() => {
    if (!classId) { setState({ kind: "none" }); return; }
    let alive = true;
    loadStudentPapers(classId, studentId)
      .then((papers) => { if (alive) setState({ kind: "ready", papers }); })
      .catch(() => { if (alive) setState((s) => (s.kind === "ready" ? s : { kind: "failed" })); });
    return () => { alive = false; };
  }, [classId, studentId]);
  useFocusEffect(read);

  return { state, retry: () => { setState({ kind: "loading" }); read(); } };
}
