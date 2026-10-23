import { useState } from "react";
import { fetchExamSubjects, type ExamSubject, type PublishedExam } from "@figbloom/shared";
import { useAsync } from "./useAsync";

interface Learner {
  id: string;
  classId: string | null;
  /** The newest exam with results out, which the loader has already fetched `subjects` for. */
  examId: string | null;
  exams: PublishedExam[];
  subjects: ExamSubject[];
}

/**
 * Which exam a Results screen is showing: the newest one the loader fetched, or
 * one the viewer picked. Only picking another exam costs a request.
 */
export function useExamView(learner: Learner | null) {
  // A pick belongs to one learner: moving to a sibling must not carry it over.
  const [picked, setPicked] = useState<{ learnerId: string; examId: string } | null>(null);
  const pickedId = learner && picked?.learnerId === learner.id && learner.exams.some((e) => e.id === picked.examId) ? picked.examId : null;
  const examId = pickedId ?? learner?.examId ?? null;
  const other = learner !== null && pickedId !== null && pickedId !== learner.examId;

  const fetched = useAsync(
    () => (other && learner ? fetchExamSubjects(learner.id, learner.classId, pickedId) : Promise.resolve(null)),
    [learner?.id, other ? pickedId : null],
  );

  return {
    examId,
    examName: learner?.exams.find((e) => e.id === examId)?.name ?? null,
    subjects: other ? fetched.data ?? [] : learner?.subjects ?? [],
    loading: other && fetched.loading,
    error: other ? fetched.error : null,
    pick: (id: string) => { if (learner) setPicked({ learnerId: learner.id, examId: id }); },
  };
}
