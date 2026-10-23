import { useEffect, useState } from "react";
import { fetchExamSubjects, type ExamSubject, type PublishedExam } from "@figbloom/shared";

interface Learner {
  id: string;
  classId: string | null;
  /** The newest exam with results out, which the loader has already fetched `subjects` for. */
  examId: string | null;
  examName: string | null;
  exams: PublishedExam[];
  subjects: ExamSubject[];
}

/**
 * Which exam a Results screen is showing: the newest one the loader fetched, or
 * one the viewer picked. Only picking another exam costs a request, and that
 * one needs a connection: the cached copy only ever holds the newest exam.
 */
export function useExamView(learner: Learner) {
  // A pick belongs to one learner: moving to a sibling must not carry it over.
  const [picked, setPicked] = useState<{ learnerId: string; examId: string } | null>(null);
  // Bumped on every tap, so tapping the exam that just failed tries again.
  const [attempt, setAttempt] = useState(0);
  const pickedId = picked?.learnerId === learner.id && learner.exams.some((e) => e.id === picked.examId) ? picked.examId : null;
  const examId = pickedId ?? learner.examId;
  const other = pickedId !== null && pickedId !== learner.examId;
  const key = other ? `${learner.id}|${pickedId}|${attempt}` : null;

  const [fetched, setFetched] = useState<{ key: string; subjects: ExamSubject[] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !pickedId) return;
    let alive = true;
    fetchExamSubjects(learner.id, learner.classId, pickedId)
      .then((subjects) => { if (alive) setFetched({ key, subjects }); })
      .catch(() => { if (alive) setFailedKey(key); });
    return () => { alive = false; };
  }, [key, pickedId, learner.id, learner.classId]);

  const ready = key !== null && fetched?.key === key;
  return {
    examId,
    examName: learner.exams.find((e) => e.id === examId)?.name ?? (examId === learner.examId ? learner.examName : null),
    subjects: other ? (ready ? fetched.subjects : []) : learner.subjects,
    loading: other && !ready && failedKey !== key,
    failed: other && failedKey === key,
    pick: (id: string) => { setPicked({ learnerId: learner.id, examId: id }); setAttempt((n) => n + 1); },
  };
}
