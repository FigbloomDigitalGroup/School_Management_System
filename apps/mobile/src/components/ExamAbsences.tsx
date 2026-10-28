import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { ABSENCE_LABEL, fetchExamAbsences, type MarkAbsence } from "@figbloom/shared";
import { s, t } from "../theme";

/**
 * Subjects of one exam a learner has no score in because they missed the
 * paper or were excused (marks.absence, 20261030100000_exam_extensions).
 * They are left out of the mean and the grade, never counted as 0, so this
 * says why they aren't in the list. Nothing when there are none, and nothing
 * if the read fails: it explains the list, it isn't part of it.
 */
export function ExamAbsences({ studentId, examId }: { studentId: string; examId: string | null }) {
  const [rows, setRows] = useState<{ name: string; absence: MarkAbsence }[]>([]);

  useEffect(() => {
    setRows([]);
    if (!examId) return;
    let alive = true;
    fetchExamAbsences(studentId, examId)
      .then((r) => { if (alive) setRows(r); })
      .catch(() => { /* the note is extra: leave it out rather than show a broken card */ });
    return () => { alive = false; };
  }, [studentId, examId]);

  if (!rows.length) return null;
  return (
    <View style={[s.card, { marginTop: 12, padding: 12, backgroundColor: t.appSurface.page }]}>
      <Text style={s.small}>
        <Text style={{ fontWeight: "700", color: t.appSurface.ink }}>No mark: </Text>
        {rows.map((a) => `${a.name} (${ABSENCE_LABEL[a.absence]})`).join(", ")}. Not counted as 0 and left out of the mean.
      </Text>
    </View>
  );
}
