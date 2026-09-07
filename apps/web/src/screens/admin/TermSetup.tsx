import { useState } from "react";
import { supabase } from "@figbloom/shared";
import type { ClassGroup, Profile, Term } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

type ClassRow = Pick<ClassGroup, "id" | "name" | "form_level" | "class_teacher_id">;

interface TermSetupData {
  term: Term | null;
  classes: ClassRow[];
  subjectsCount: number;
  feeItemsCount: number;
  teacherOptions: Pick<Profile, "id" | "full_name">[];
  activeStudents: number;
}

async function fetchTermSetup(): Promise<TermSetupData> {
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("*").eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const [{ data: classRows }, { count: subjectsCount }, feeItemsRes, { data: teacherRows }, { count: studentsCount }] = await Promise.all([
    sb.from("classes").select("id,name,form_level,class_teacher_id").order("form_level").order("name").returns<ClassRow[]>(),
    sb.from("subjects").select("id", { count: "exact", head: true }),
    termId
      ? sb.from("fee_items").select("id", { count: "exact", head: true }).eq("term_id", termId)
      : Promise.resolve({ count: 0 }),
    sb.from("profiles").select("id,full_name").eq("role", "teacher").order("full_name").returns<Pick<Profile, "id" | "full_name">[]>(),
    sb.from("students").select("id", { count: "exact", head: true }).eq("active", true),
  ]);

  return {
    term: term ?? null,
    classes: classRows ?? [],
    subjectsCount: subjectsCount ?? 0,
    feeItemsCount: feeItemsRes.count ?? 0,
    teacherOptions: teacherRows ?? [],
    activeStudents: studentsCount ?? 0,
  };
}

const fmtDay = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

/**
 * A blank school to a working one. Shown as a checklist rather than a wizard
 * because setup happens over a fortnight, by several people, in no fixed order —
 * a modal wizard would lose that work.
 */
export function TermSetup() {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>("teachers");
  const { data, loading, error } = useAsync(() => fetchTermSetup(), []);

  const unassigned = data ? data.classes.filter((c) => !c.class_teacher_id) : [];
  const assignedCount = data ? data.classes.length - unassigned.length : 0;
  const formLevels = data && data.classes.length > 0 ? data.classes.map((c) => c.form_level) : [];
  const minForm = formLevels.length ? Math.min(...formLevels) : 1;
  const maxForm = formLevels.length ? Math.max(...formLevels) : 4;

  const steps = data
    ? [
        {
          id: "term", label: "Term dates", done: !!data.term,
          note: data.term
            ? `${data.term.name} runs ${fmtDay(data.term.starts_on)} to ${fmtDay(data.term.ends_on)} ${data.term.year}.`
            : "No current term has been set up yet.",
        },
        {
          id: "classes", label: "Classes and streams", done: data.classes.length > 0,
          note: `${data.classes.length} classes across Forms ${minForm} to ${maxForm}.`,
        },
        {
          id: "subjects", label: "Subjects and grading", done: data.subjectsCount > 0,
          note: `${data.subjectsCount} subjects, 12-point KCSE scale.`,
        },
        {
          id: "teachers", label: "Assign class teachers", done: unassigned.length === 0,
          note: unassigned.length === 0
            ? `All ${data.classes.length} classes have a class teacher.`
            : `${assignedCount} of ${data.classes.length} assigned. ${unassigned.map((c) => c.name).join(" and ")} ${unassigned.length === 1 ? "is" : "are"} open.`,
        },
        {
          id: "fees", label: "Fee structure", done: data.feeItemsCount > 0,
          note: data.feeItemsCount > 0
            ? `${data.feeItemsCount} fee items set up for ${data.term?.name ?? "this term"}.`
            : "No fee items have been set up for this term yet.",
        },
        {
          id: "roll", label: "Roll learners forward", done: false,
          note: `${data.activeStudents.toLocaleString()} learners are enrolled and ready to move up a form next term.`,
        },
      ]
    : [];
  const done = steps.filter((s) => s.done).length;

  return (
    <>
      <PageHead
        eyebrow="School settings"
        title={data?.term ? `Set up ${data.term.name}` : "Set up this term"}
        blurb="Do these in any order and come back as often as you need. Nothing here is visible to parents until the fee structure is published."
      />

      <div className="max-w-[720px] px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load term setup: {error.message}
          </p>
        ) : loading || !data ? (
          <>
            <div className="mb-5 flex items-center gap-3">
              <Skeleton className="h-2 flex-1" />
              <Skeleton className="h-3 w-12" />
            </div>
            <div className="grid gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="overflow-hidden rounded-xl border border-line-soft px-4 py-3.5">
                  <Skeleton className="h-3.5 w-48" />
                  <Skeleton className="mt-2 h-3 w-64" />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="mb-5 flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded bg-sunken">
                <div className="h-2 rounded bg-ok-dot transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
              </div>
              <span className="font-mono text-[12px] text-ink-muted">{done} of {steps.length}</span>
            </div>

            <ol className="grid gap-2">
              {steps.map((s) => {
                const expanded = open === s.id;
                return (
                  <li key={s.id} className="overflow-hidden rounded-xl border" style={{ borderColor: expanded ? "var(--accent)" : "#E2E6E2" }}>
                    <button onClick={() => setOpen(expanded ? null : s.id)} aria-expanded={expanded}
                      className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-bold"
                        style={s.done ? { background: "#E3EFE7", color: "#1B4D2E" } : { background: "#F1F4F1", color: "#9AA69E" }}>
                        {s.done ? "✓" : ""}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-semibold">{s.label}</span>
                        <span className="mt-0.5 block text-[12.5px] text-ink-muted">{s.note}</span>
                      </span>
                      <span aria-hidden className="text-ink-faint">{expanded ? "−" : "+"}</span>
                    </button>

                    {expanded && (
                      <div className="border-t border-line-soft bg-page px-4 py-3.5">
                        {s.id === "teachers" ? (
                          unassigned.length === 0 ? (
                            <p className="text-[12.5px] leading-relaxed text-ink-muted">Every class already has a class teacher assigned.</p>
                          ) : (
                            <div className="grid gap-2">
                              {unassigned.map((c) => (
                                <div key={c.id} className="flex flex-wrap items-center gap-2.5 rounded-lg bg-white px-3.5 py-2.5">
                                  <span className="min-w-0 flex-1 text-[13px] font-medium">{c.name}</span>
                                  <select aria-label={`Class teacher for ${c.name}`} className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
                                    <option>Choose a teacher</option>
                                    {data.teacherOptions.map((t) => <option key={t.id}>{t.full_name}</option>)}
                                  </select>
                                  <Button variant="primary" onClick={() => toast(`Class teacher assigned for ${c.name}`)}>Assign</Button>
                                </div>
                              ))}
                              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                                A class with no teacher cannot have attendance taken, which is why this blocks the first day
                                rather than the fee structure.
                              </p>
                            </div>
                          )
                        ) : (
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="max-w-[420px] text-[12.5px] leading-relaxed text-ink-muted">{s.note}</p>
                            <Button variant="primary" onClick={() => toast(`Opening ${s.label.toLowerCase()}`)}>
                              {s.done ? "Review" : "Set up"}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}

        <div className="mt-5 rounded-xl bg-sunken p-4">
          <h2 className="text-[13px] font-semibold">When you publish the fee structure</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            Every parent gets an invoice in the app and an SMS with the balance. It cannot be unsent, so the composer
            shows the total billed and the number of parents before it goes.
          </p>
        </div>
      </div>
    </>
  );
}
