import { useState } from "react";
import { supabase, type Subject } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

interface TeacherOption { id: string; full_name: string }
interface SubjectRow { subject: Subject; teacherId: string | null }
interface ClassSubjectsData { rows: SubjectRow[]; qualifiedTeacherIdsBySubject: Map<string, Set<string>> }

async function fetchClassSubjects(tenantId: string, classId: string): Promise<ClassSubjectsData> {
  const sb = supabase();
  const [{ data: subjects, error: e1 }, { data: assignments, error: e2 }, { data: specializations, error: e3 }] = await Promise.all([
    sb.from("subjects").select("*").eq("tenant_id", tenantId).order("name").returns<Subject[]>(),
    sb.from("teaching_assignments").select("subject_id, teacher_id").eq("class_id", classId)
      .returns<{ subject_id: string; teacher_id: string }[]>(),
    sb.from("teacher_subjects").select("subject_id, teacher_id").eq("tenant_id", tenantId).returns<{ subject_id: string; teacher_id: string }[]>(),
  ]);
  if (e1) throw new Error(e1.message);
  if (e2) throw new Error(e2.message);
  if (e3) throw new Error(e3.message);

  const teacherBySubject = new Map((assignments ?? []).map((a) => [a.subject_id, a.teacher_id]));
  const rows = (subjects ?? []).map((s) => ({ subject: s, teacherId: teacherBySubject.get(s.id) ?? null }));

  const qualifiedTeacherIdsBySubject = new Map<string, Set<string>>();
  for (const row of specializations ?? []) {
    const ids = qualifiedTeacherIdsBySubject.get(row.subject_id) ?? new Set<string>();
    ids.add(row.teacher_id);
    qualifiedTeacherIdsBySubject.set(row.subject_id, ids);
  }

  return { rows, qualifiedTeacherIdsBySubject };
}

/**
 * Who teaches what, in this one class. This is the only place teaching_assignments
 * rows get created — a teacher's "My classes" (subjects column) and their ability
 * to enter marks in Gradebook both come from what's set here, not from the
 * class's timetable (which is just free-text period labels, unrelated data).
 */
export function SubjectsEditor({ classId, className, tenantId, teachers, onClose }: {
  classId: string; className: string; tenantId: string;
  teachers: TeacherOption[];
  onClose: () => void;
}) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchClassSubjects(tenantId, classId), [tenantId, classId, reloadKey]);
  const rows = data?.rows;
  const reload = () => setReloadKey((k) => k + 1);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkCreating, setBulkCreating] = useState(false);

  async function createSubject() {
    if (!name.trim() || !code.trim()) { toast("Give the subject a name and a short code."); return; }
    setCreating(true);
    try {
      const { error: err } = await supabase().from("subjects").insert({
        tenant_id: tenantId, name: name.trim(), code: code.trim().toUpperCase(), is_core: true,
      });
      if (err) throw err;
      toast(`${name.trim()} added.`);
      setName("");
      setCode("");
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not add the subject: ${err.message}` : "Could not add the subject.");
    } finally {
      setCreating(false);
    }
  }

  /** One subject per line, "Name" or "Name,CODE" — for the common case of
   *  keying in a school's whole subject list at once instead of the single
   *  form eight or ten times over. A code left out is generated from the
   *  name's letters, de-duplicated against both this batch and what's
   *  already on file (subjects.code is unique per school). */
  async function createBulkSubjects() {
    const takenCodes = new Set((rows ?? []).map((r) => r.subject.code.toUpperCase()));
    const takenNames = new Set((rows ?? []).map((r) => r.subject.name.trim().toLowerCase()));
    const uniqueCode = (base: string) => {
      const stem = base.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) || "SUBJ";
      let candidate = stem;
      let n = 2;
      while (takenCodes.has(candidate)) { candidate = `${stem}${n}`; n++; }
      takenCodes.add(candidate);
      return candidate;
    };

    const toCreate: { name: string; code: string }[] = [];
    for (const raw of bulkText.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const [rawName, rawCode] = line.split(",").map((p) => p.trim());
      const subjName = rawName ?? "";
      if (!subjName || takenNames.has(subjName.toLowerCase())) continue;
      takenNames.add(subjName.toLowerCase());
      toCreate.push({ name: subjName, code: rawCode ? uniqueCode(rawCode) : uniqueCode(subjName) });
    }
    if (toCreate.length === 0) { toast("Nothing new to add — check the names aren't already on file."); return; }

    setBulkCreating(true);
    try {
      const { error: err } = await supabase().from("subjects").insert(
        toCreate.map((s) => ({ tenant_id: tenantId, name: s.name, code: s.code, is_core: true })),
      );
      if (err) throw err;
      toast(`${toCreate.length} subject${toCreate.length === 1 ? "" : "s"} added.`);
      setBulkText("");
      setBulkOpen(false);
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not add those subjects: ${err.message}` : "Could not add those subjects.");
    } finally {
      setBulkCreating(false);
    }
  }

  async function setTeacher(subjectId: string, teacherId: string) {
    try {
      if (!teacherId) {
        const { error: err } = await supabase().from("teaching_assignments")
          .delete().eq("class_id", classId).eq("subject_id", subjectId);
        if (err) throw err;
      } else {
        const { error: err } = await supabase().from("teaching_assignments").upsert(
          { tenant_id: tenantId, class_id: classId, subject_id: subjectId, teacher_id: teacherId },
          { onConflict: "class_id,subject_id" },
        );
        if (err) throw err;
      }
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not update that assignment: ${err.message}` : "Could not update that assignment.");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Subjects"
      title={`Subjects · ${className}`}
      blurb="Pick who teaches each subject here — this is what shows on a teacher's own 'My classes' page, and what lets them enter marks in Gradebook."
      actions={<Button onClick={onClose}>Done</Button>}
    >
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load subjects: {error.message}</p>
      ) : loading || !rows ? (
        <TableSkeleton rows={5} />
      ) : (
        <div className="grid gap-3">
          {rows.length === 0 ? (
            <p className="text-[12.5px] text-ink-muted">No subjects yet — add the school's first one below.</p>
          ) : (
            <ul className="grid gap-1.5">
              {rows.map((r) => {
                const qualifiedIds = data?.qualifiedTeacherIdsBySubject.get(r.subject.id);
                const qualified = qualifiedIds ? teachers.filter((t) => qualifiedIds.has(t.id)) : [];
                const others = qualifiedIds ? teachers.filter((t) => !qualifiedIds.has(t.id)) : teachers;
                return (
                  <li key={r.subject.id} className="flex items-center gap-3 rounded-lg border border-line-soft px-3 py-2">
                    <SubjectFields subject={r.subject} onSaved={reload} toast={toast} />
                    <select
                      value={r.teacherId ?? ""}
                      onChange={(e) => void setTeacher(r.subject.id, e.target.value)}
                      aria-label={`Teacher for ${r.subject.name}`}
                      className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
                    >
                      <option value="">Unassigned</option>
                      {qualified.length > 0 ? (
                        <>
                          <optgroup label={`Teaches ${r.subject.name}`}>
                            {qualified.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                          </optgroup>
                          <optgroup label="Other teachers">
                            {others.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                          </optgroup>
                        </>
                      ) : (
                        others.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)
                      )}
                    </select>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex items-end gap-2 border-t border-line-soft pt-3">
            <label className="block flex-1">
              <span className="mb-1.5 block text-[11.5px] font-semibold">New subject</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Chemistry"
                className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none"
              />
            </label>
            <label className="block w-24">
              <span className="mb-1.5 block text-[11.5px] font-semibold">Code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="CHEM"
                className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 font-mono text-[13px] outline-none"
              />
            </label>
            <Button onClick={() => void createSubject()} disabled={creating}>
              {creating ? "Adding…" : "Add subject"}
            </Button>
          </div>

          <button
            type="button"
            onClick={() => setBulkOpen((v) => !v)}
            className="justify-self-start text-[12px] font-semibold text-leaf hover:underline"
          >
            {bulkOpen ? "Hide bulk add" : "Bulk add multiple subjects"}
          </button>

          {bulkOpen && (
            <div className="grid gap-2 rounded-lg border border-line-soft bg-white p-3">
              <label className="block">
                <span className="mb-1.5 block text-[11.5px] font-semibold">One subject per line</span>
                <textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={"Chemistry\nHistory,HIST\nBusiness Studies"}
                  rows={5}
                  className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none"
                />
                <span className="mt-1 block text-[11px] text-ink-faint">
                  Just the name, or "Name,CODE" if you want to pick the code yourself — otherwise one's generated from the name.
                </span>
              </label>
              <Button variant="primary" className="justify-self-start" onClick={() => void createBulkSubjects()} disabled={bulkCreating || !bulkText.trim()}>
                {bulkCreating ? "Adding…" : "Add these subjects"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Name and code were display-only once created — an auto-generated code
 *  (e.g. "CHRI" for Christian Religious Education, instead of the standard
 *  "CRE") had no way to be fixed afterward. */
function SubjectFields({ subject, onSaved, toast }: {
  subject: Subject;
  onSaved: () => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState(subject.name);
  const [code, setCode] = useState(subject.code);
  const [saving, setSaving] = useState(false);
  const dirty = name.trim() !== subject.name || code.trim().toUpperCase() !== subject.code;

  async function save() {
    if (!name.trim() || !code.trim()) { toast("A subject needs both a name and a code."); return; }
    setSaving(true);
    try {
      const { error: err } = await supabase().from("subjects")
        .update({ name: name.trim(), code: code.trim().toUpperCase() }).eq("id", subject.id);
      if (err) throw err;
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Subject name"
        className="min-w-0 flex-1 rounded-md border border-transparent px-1.5 py-1 text-[13px] font-medium outline-none hover:border-[#D3DAD5] focus:border-[#D3DAD5]"
      />
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-label="Subject code"
        className="w-16 rounded-md border border-transparent px-1.5 py-1 font-mono text-[11px] uppercase text-ink-faint outline-none hover:border-[#D3DAD5] focus:border-[#D3DAD5]"
      />
      {dirty && (
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="text-[11.5px] font-semibold text-leaf hover:underline disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      )}
    </>
  );
}
