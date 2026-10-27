import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { archiveLearners, deleteLearners, fetchArchivedLearners, learnerCount, restoreLearners, STAFF_TITLE_SUGGESTIONS, supabase } from "@figbloom/shared";
import type { ArchivedLearner, ClassGroup, Profile, Student, Subject } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Avatar, AvatarEditor } from "../../components/Avatar";
import { Badge, RoleBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Pagination } from "../../components/ui/Pagination";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast, type ToastFn } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { PasswordResetRequests, ResetPasswordSection } from "../../components/PasswordReset";
import { useAsync } from "../../lib/useAsync";
import { LearnerDocumentSignatures } from "../../components/signatures/LearnerDocumentSignatures";
import { listStudentDocuments, privateDocUrl, uploadStudentDocument, type StudentDocument } from "../../lib/uploads";
import { downloadCsvTemplate, importStudents, parseStudentCsv, type ImportRow } from "../../lib/studentImport";
import { deleteAccount, inviteStaff, provisionGuardian, provisionStudent, type InviteStaffInput, type InviteStaffResult, type ProvisionGuardianResult, type ProvisionStudentResult } from "../../lib/platformAdmin";
import { EMPTY_HOME_BUS, HomeAndBusEditor, HomeAndBusFields, planBus, saveBus, useSchoolRoutes, type HomeBusValue } from "../../components/learners/HomeAndBus";
import { HealthEditor, OptionalHealthSection } from "../../components/learners/Health";
import { LearnerActivitiesView } from "../../components/learners/Activities";
import { BioDataEditor, BioRequestsPanel, GuardianContacts } from "../../components/learners/BioData";
import { emptyHealth, isHealthEmpty, saveStudentHealth, type StudentHealthInput } from "@figbloom/shared";
import { CallButton } from "../../components/calls/CallButton";

type StudentRow = Pick<Student, "id" | "admission_no" | "full_name" | "class_id" | "boarding" | "gender"> & { avatar_url: string | null; profile_id: string | null; login_id: string | null; archived_at?: string | null };
type StaffRow = Pick<Profile, "id" | "full_name" | "role" | "staff_title" | "email" | "phone" | "login_id" | "photo_changed_at" | "handles_visitors"> & { avatar_url: string | null };

const DOC_TYPES: { value: string; label: string }[] = [
  { value: "birth_certificate", label: "Birth certificate" },
  { value: "kcpe_certificate", label: "KCPE certificate" },
  { value: "medical_form", label: "Medical form" },
  { value: "transfer_letter", label: "Transfer letter" },
  { value: "other", label: "Other" },
];

interface PeopleData {
  classes: Pick<ClassGroup, "id" | "name">[];
  students: StudentRow[];
  staff: StaffRow[];
  feeByStudent: Map<string, { total: number; paid: number }>;
  subjects: Subject[];
  subjectIdsByTeacher: Map<string, string[]>;
}

async function fetchPeople(tenantId: string): Promise<PeopleData> {
  const sb = supabase();
  const { data: term } = await sb.from("terms").select("id").eq("tenant_id", tenantId).eq("is_current", true).maybeSingle<{ id: string }>();

  const [{ data: classRows }, { data: studentRows }, { data: staffRows }, invoicesRes, { data: subjectRows }, { data: teacherSubjectRows }, { data: studentProfileRows }] = await Promise.all([
    sb.from("classes").select("id,name").eq("tenant_id", tenantId).order("name").returns<Pick<ClassGroup, "id" | "name">[]>(),
    sb.from("students").select("id,admission_no,full_name,gender,class_id,boarding,avatar_url,profile_id").eq("tenant_id", tenantId).eq("active", true).order("full_name").returns<Omit<StudentRow, "login_id">[]>(),
    sb.from("profiles").select("id,full_name,role,staff_title,email,phone,login_id,avatar_url,photo_changed_at,handles_visitors").eq("tenant_id", tenantId).in("role", ["school_admin", "teacher", "driver", "staff"]).order("full_name").returns<StaffRow[]>(),
    term
      ? sb.from("fee_invoices").select("student_id,total_cents,paid_cents").eq("tenant_id", tenantId).eq("term_id", term.id).returns<{ student_id: string; total_cents: number; paid_cents: number }[]>()
      : Promise.resolve({ data: [] as { student_id: string; total_cents: number; paid_cents: number }[] }),
    sb.from("subjects").select("*").eq("tenant_id", tenantId).order("name").returns<Subject[]>(),
    sb.from("teacher_subjects").select("teacher_id, subject_id").eq("tenant_id", tenantId).returns<{ teacher_id: string; subject_id: string }[]>(),
    sb.from("profiles").select("id,login_id").eq("tenant_id", tenantId).eq("role", "student").returns<{ id: string; login_id: string | null }[]>(),
  ]);

  const feeByStudent = new Map<string, { total: number; paid: number }>();
  for (const inv of invoicesRes.data ?? []) feeByStudent.set(inv.student_id, { total: inv.total_cents, paid: inv.paid_cents });

  const loginIdByProfile = new Map<string, string | null>();
  for (const p of studentProfileRows ?? []) loginIdByProfile.set(p.id, p.login_id);

  const subjectIdsByTeacher = new Map<string, string[]>();
  for (const row of teacherSubjectRows ?? []) {
    const ids = subjectIdsByTeacher.get(row.teacher_id) ?? [];
    ids.push(row.subject_id);
    subjectIdsByTeacher.set(row.teacher_id, ids);
  }

  return {
    classes: classRows ?? [],
    students: (studentRows ?? []).map((s) => ({ ...s, login_id: s.profile_id ? loginIdByProfile.get(s.profile_id) ?? null : null })),
    staff: staffRows ?? [],
    feeByStudent,
    subjects: subjectRows ?? [],
    subjectIdsByTeacher,
  };
}

/**
 * Bulk actions matter more than search here — an admin's real job is moving
 * forty learners at once, not finding one. Selection is sticky across filtering
 * so a class change can be built up in two passes.
 */
export function People() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [tab, setTab] = useState<"students" | "staff">("students");
  const [query, setQuery] = useState("");
  const [classId, setClassId] = useState("all");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Just the id, not a snapshot of the row — a saved edit bumps reloadKey
  // and refetches `data`, but a captured row object would never pick that
  // up, leaving the still-open modal (its title especially) stuck showing
  // whatever was there before the edit.
  const [manage, setManage] = useState<{ kind: "students" | "staff"; id: string } | null>(null);
  const [avatarOverrides, setAvatarOverrides] = useState<Record<string, string>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addStaffOpen, setAddStaffOpen] = useState(false);
  const [inviteGuardiansOpen, setInviteGuardiansOpen] = useState(false);
  const [createLoginsOpen, setCreateLoginsOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [deletingStaff, setDeletingStaff] = useState(false);
  // Learners who have left are archived, not deleted: one switch between the current roll and them.
  const [view, setView] = useState<"current" | "archived">("current");
  const [working, setWorking] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const { data, loading, error } = useAsync(() => fetchPeople(tenant.id), [tenant.id, reloadKey]);
  const { data: archivedData, loading: archivedLoading } = useAsync(
    () => (view === "archived" ? fetchArchivedLearners(tenant.id) : Promise.resolve([] as ArchivedLearner[])),
    [tenant.id, view, reloadKey],
  );
  const archivedRows = useMemo<StudentRow[]>(() => (archivedData ?? []).map((a) => ({ ...a, class_id: a.class_id as string, gender: a.gender as StudentRow["gender"], login_id: null })), [archivedData]);
  // A reloadKey refetch keeps what's already on screen; switching to a different school's
  // data must not show the previous one's meanwhile — skeleton for those only.
  const [loadedFor, setLoadedFor] = useState(tenant.id);
  if (!loading && loadedFor !== tenant.id) setLoadedFor(tenant.id);
  const pending = loading && (!data || loadedFor !== tenant.id);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (view === "archived" ? archivedRows : data?.students ?? [])
      .filter((s) => classId === "all" || s.class_id === classId)
      .filter((s) => !q || s.full_name.toLowerCase().includes(q) || s.admission_no.includes(q));
  }, [data, archivedRows, view, query, classId]);

  const staffRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.staff ?? []).filter((s) => !q || s.full_name.toLowerCase().includes(q));
  }, [data, query]);

  // Whichever list is on screen right now — the one the page/page-size
  // controls actually act on.
  const activeTotal = tab === "students" ? rows.length : staffRows.length;
  const pageCount = Math.max(1, Math.ceil(activeTotal / pageSize));
  // Filtering down to fewer results than the current page can hold (or
  // switching tabs) shouldn't leave the view stuck on a now-empty page —
  // clamp instead of resetting to 1, so paging through and then narrowing
  // the search stays roughly where you were.
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [pageCount, page]);
  useEffect(() => { setPage(1); }, [tab, query, classId, pageSize, view]);

  const pagedRows = useMemo(() => rows.slice((page - 1) * pageSize, page * pageSize), [rows, page, pageSize]);
  const pagedStaffRows = useMemo(() => staffRows.slice((page - 1) * pageSize, page * pageSize), [staffRows, page, pageSize]);

  const classesById = useMemo(() => new Map((data?.classes ?? []).map((c) => [c.id, c.name])), [data]);
  const subjectsById = useMemo(() => new Map((data?.subjects ?? []).map((s) => [s.id, s])), [data]);

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

  const switchTab = (t: "students" | "staff") => { setTab(t); setPicked(new Set()); };
  const switchView = (v: "current" | "archived") => { setView(v); setPicked(new Set()); setManage(null); };

  /** Runs one change to some learners, then reloads. `done` is the toast on success. */
  async function changeLearners(ids: string[], run: () => Promise<unknown>, done: string, failed: string) {
    setWorking(true);
    try {
      await run();
      toast(done);
      setManage(null);
      setPicked((p) => { const n = new Set(p); for (const id of ids) n.delete(id); return n; });
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(`${failed}: ${err instanceof Error ? err.message : "something went wrong"}`, "error");
    } finally {
      setWorking(false);
    }
  }

  async function archiveStudents(ids: string[], who: string) {
    if (!window.confirm(`Archive ${who}? They leave class lists, attendance and billing. Their marks, fees and records are all kept, and you can restore them under "Archived".`)) return;
    await changeLearners(ids, () => archiveLearners(ids), `${who} archived. Find them under "Archived".`, "Could not archive");
  }

  async function restoreStudents(ids: string[], who: string) {
    await changeLearners(ids, () => restoreLearners(ids), `${who} restored.`, "Could not restore");
  }

  async function deleteStudents(ids: string[], who: string) {
    if (!window.confirm(`Delete ${who} for good? This is only possible for someone with no attendance, marks or fee records (a learner added by mistake, or a bad import). If they have any, you'll be told, and should archive them instead.`)) return;
    await changeLearners(ids, () => deleteLearners(ids), `${who} deleted.`, "Not deleted");
  }

  async function deleteStaff(staff: Pick<StaffRow, "id" | "full_name">) {
    if (!window.confirm(`Remove ${staff.full_name}? This deletes their login and cannot be undone.`)) return;
    setDeletingStaff(true);
    try {
      const r = await deleteAccount({ tenant_id: tenant.id, profile_id: staff.id });
      toast(r.warning ?? `${staff.full_name} removed.`);
      setManage(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not remove ${staff.full_name}: ${err.message}` : `Could not remove ${staff.full_name}.`, "error");
    } finally {
      setDeletingStaff(false);
    }
  }

  const openManage = (kind: "students" | "staff", row: StudentRow | StaffRow) => setManage({ kind, id: row.id });
  const manageRow: StudentRow | StaffRow | null = manage
    ? (manage.kind === "students" ? [...(data?.students ?? []), ...archivedRows].find((s) => s.id === manage.id) : data?.staff.find((s) => s.id === manage.id)) ?? null
    : null;
  const manageArchived = manage?.kind === "students" && archivedRows.some((s) => s.id === manage.id);

  return (
    <>
      <PageHead
        eyebrow="School · people"
        title="Students & staff"
        blurb={
          data
            ? `${data.students.length.toLocaleString()} learners and ${data.staff.length.toLocaleString()} staff. Import from a spreadsheet at the start of a term; after that, add one at a time.`
            : "Loading the roster…"
        }
        actions={
          tab === "students" ? (
            <>
              <Button onClick={() => setImportOpen(true)}>Import from CSV</Button>
              <Button variant="accent" onClick={() => setAddOpen(true)}>Add a learner</Button>
            </>
          ) : (
            <Button variant="accent" onClick={() => setAddStaffOpen(true)}>+ Add staff</Button>
          )
        }
      />

      <PasswordResetRequests tenantId={tenant.id} schoolName={tenant.name} />

      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-page px-7 py-3">
        <div className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
          {(["students", "staff"] as const).map((t) => (
            <button key={t} onClick={() => switchTab(t)} className="rounded px-3 py-1.5 text-small capitalize"
              style={tab === t ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
              {t}
            </button>
          ))}
        </div>
        {tab === "students" && (
          <div role="group" aria-label="Which learners" className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
            {(["current", "archived"] as const).map((v) => (
              <button key={v} type="button" aria-pressed={view === v} onClick={() => switchView(v)} className="rounded px-3 py-1.5 text-small capitalize"
                style={view === v ? { background: "#17402A", color: "#fff", fontWeight: 600 } : {}}>
                {v}
              </button>
            ))}
          </div>
        )}
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name or admission number"
          aria-label="Search people"
          className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small outline-none" />
        {tab === "students" && (
          <select value={classId} onChange={(e) => setClassId(e.target.value)} aria-label="Class"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
            <option value="all">Every class</option>
            {(data?.classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {tab === "students" && pagedRows.length > 0 && (
          <label className="flex items-center gap-1.5 text-small font-medium text-leaf">
            <input
              type="checkbox"
              checked={pagedRows.every((s) => picked.has(s.id))}
              onChange={(e) => setPicked((p) => {
                const next = new Set(p);
                for (const s of pagedRows) { if (e.target.checked) next.add(s.id); else next.delete(s.id); }
                return next;
              })}
              style={{ accentColor: "#17402A" }}
            />
            Select all shown
          </label>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {pending ? "…" : `${activeTotal.toLocaleString()} total`}
        </span>
      </div>

      {tab === "students" && picked.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-sunken px-7 py-2.5">
          <span className="text-small font-semibold">{picked.size} selected</span>
          {view === "current" ? (
            <>
              <Button onClick={() => toast(`Moved ${picked.size} learners to another class`)}>Change class</Button>
              <Button onClick={() => setInviteGuardiansOpen(true)}>Invite guardians</Button>
              {(data?.students ?? []).some((s) => picked.has(s.id) && !s.login_id) && (
                <Button onClick={() => setCreateLoginsOpen(true)}>Create logins</Button>
              )}
              <Button onClick={() => toast(`Exported ${picked.size} records`)}>Export</Button>
              <Button disabled={working} onClick={() => void archiveStudents([...picked], learnerCount(picked.size))}>Archive</Button>
            </>
          ) : (
            <Button disabled={working} onClick={() => void restoreStudents([...picked], learnerCount(picked.size))}>Restore</Button>
          )}
          <Button variant="danger" disabled={working} onClick={() => void deleteStudents([...picked], learnerCount(picked.size))}>Delete…</Button>
          <button onClick={() => setPicked(new Set())} className="text-small font-semibold text-leaf">Clear</button>
        </div>
      )}

      <div className="px-7 py-6">
        {tab === "students" && (
          <BioRequestsPanel tenantId={tenant.id} toast={toast} reloadKey={reloadKey} onOpenLearner={(id) => setManage({ kind: "students", id })} />
        )}
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load people: {error.message}
          </p>
        ) : pending || !data || (tab === "students" && view === "archived" && archivedLoading && !archivedData) ? (
          <TableSkeleton rows={8} />
        ) : tab === "students" ? (
          <DataTable
            columns={[
              {
                key: "pick", header: "", width: "40px",
                render: (s) => (
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${s.full_name}`} style={{ accentColor: "#17402A" }} />
                ),
              },
              { key: "name", header: "Learner", width: "1.8fr", render: (s) => (
                <div className="flex items-center gap-2.5">
                  <Avatar id={s.id} name={s.full_name} url={avatarOverrides[s.id] ?? s.avatar_url} />
                  <Cell sub={`ADM ${s.admission_no}`}>{s.full_name}</Cell>
                </div>
              ) },
              { key: "class", header: "Class", render: (s) => <span className="text-[13px]">{s.class_id ? classesById.get(s.class_id) : "—"}</span> },
              { key: "gender", header: "Gender", render: (s) => s.gender ? <span className="text-[13px] capitalize">{s.gender}</span> : <Badge tone="warn">Not set</Badge> },
              { key: "board", header: "Residence", render: (s) => <Badge tone="muted">{s.boarding ? "Boarder" : "Day"}</Badge> },
              { key: "guardian", header: "Guardian", width: "1.2fr", render: () => <Mono>+254 7·· ··· ···</Mono> },
              { key: "login", header: "Login", render: (s) => s.login_id ? <Mono>{s.login_id}</Mono> : <Badge tone="muted">No login</Badge> },
              { key: "fees", header: view === "archived" ? "Archived" : "Fees", align: "right", render: (s) => {
                if (view === "archived") return <span className="text-[12.5px] text-ink-muted">{s.archived_at ? new Date(s.archived_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}</span>;
                const inv = data.feeByStudent.get(s.id);
                if (!inv) return <Badge tone="muted">No invoice</Badge>;
                const owes = inv.paid < inv.total;
                return <Badge tone={owes ? "warn" : "ok"}>{owes ? "Balance due" : "Cleared"}</Badge>;
              } },
            ]}
            rows={pagedRows}
            rowKey={(s) => s.id}
            onRowClick={(s) => openManage("students", s)}
            minWidth="880px"
            empty={view === "archived" ? {
              title: "No archived learners",
              body: "Learners you archive when they leave the school appear here. Nothing is deleted: you can restore them at any time.",
            } : {
              title: "No learner matches that",
              body: "Try the admission number instead. If they were admitted this week, an import may still be running.",
              action: <Button variant="primary" onClick={() => setAddOpen(true)}>Add a learner</Button>,
            }}
          />
        ) : (
          <DataTable
            columns={[
              { key: "name", header: "Staff", width: "1.8fr", render: (s: StaffRow) => (
                <div className="flex items-center gap-2.5">
                  <Avatar id={s.id} name={s.full_name} url={avatarOverrides[s.id] ?? s.avatar_url} />
                  <Cell sub={[s.staff_title, s.handles_visitors ? "Visitor log" : null].filter(Boolean).join(" · ") || undefined}>{s.full_name}</Cell>
                  {s.photo_changed_at && (
                    <span className="shrink-0 rounded-full bg-warn-bg px-2 py-0.5 text-[11px] font-semibold text-warn-ink">New photo</span>
                  )}
                  {s.id !== profile.id && <CallButton profileId={s.id} name={s.full_name} className="ml-auto" />}
                </div>
              ) },
              { key: "role", header: "Role", render: (s: StaffRow) => <RoleBadge role={s.role} tenant={tenant} /> },
              {
                key: "subjects", header: "Subjects", width: "1.4fr",
                render: (s: StaffRow) => {
                  if (s.role !== "teacher") return <span className="text-[12.5px] text-ink-faint">—</span>;
                  const names = (data.subjectIdsByTeacher.get(s.id) ?? [])
                    .map((id) => subjectsById.get(id)?.name)
                    .filter((n): n is string => Boolean(n));
                  return names.length
                    ? <span className="text-[13px]">{names.join(", ")}</span>
                    : <span className="text-[12.5px] text-ink-faint">None set</span>;
                },
              },
              { key: "login", header: "Login", width: "1.2fr", render: (s: StaffRow) => <Mono>{s.login_id ?? s.email ?? "—"}</Mono> },
              { key: "phone", header: "Phone", render: (s: StaffRow) => <Mono>{s.phone ?? "—"}</Mono> },
            ]}
            rows={pagedStaffRows}
            rowKey={(s) => s.id}
            onRowClick={(s) => openManage("staff", s)}
            minWidth="920px"
            empty={{
              title: "No staff match that",
              body: "Admins and teachers appear here once their accounts are created.",
            }}
          />
        )}
        {!error && !pending && data && activeTotal > 0 && (
          <Pagination page={page} pageSize={pageSize} total={activeTotal} onPageChange={setPage} onPageSizeChange={setPageSize} />
        )}
      </div>

      {manage && manageRow && (
        <Modal
          key={manageRow.id}
          open
          onClose={() => setManage(null)}
          eyebrow={manage.kind === "students" ? "Learner" : "Staff"}
          title={`Manage ${manageRow.full_name}`}
          blurb={manage.kind === "students" ? "Details, photo, and records for this learner." : "Details and photo for this staff member."}
          actions={
            <>
              {manage.kind === "students" && (
                <>
                  <Button variant="danger" disabled={working} onClick={() => void deleteStudents([manageRow.id], manageRow.full_name)}>Delete…</Button>
                  {manageArchived ? (
                    <Button disabled={working} onClick={() => void restoreStudents([manageRow.id], manageRow.full_name)}>Restore learner</Button>
                  ) : (
                    <Button disabled={working} onClick={() => void archiveStudents([manageRow.id], manageRow.full_name)}>Archive learner</Button>
                  )}
                </>
              )}
              {manage.kind === "staff" && manageRow.id !== profile.id && (
                <Button variant="danger" disabled={deletingStaff} onClick={() => void deleteStaff(manageRow)}>
                  {deletingStaff ? "Removing…" : "Remove staff"}
                </Button>
              )}
              <Button variant="primary" onClick={() => setManage(null)}>Done</Button>
            </>
          }
        >
          {manage.kind === "students" ? (
            <StudentProfileEditor
              student={manageRow as StudentRow}
              classes={data?.classes ?? []}
              onSaved={() => setReloadKey((k) => k + 1)}
              toast={toast}
            />
          ) : (
            <StaffProfileEditor
              staff={manageRow as StaffRow}
              onSaved={() => setReloadKey((k) => k + 1)}
              toast={toast}
            />
          )}
          <AvatarEditor
            id={manageRow.id}
            name={manageRow.full_name}
            kind={manage.kind}
            tenantId={tenant.id}
            url={avatarOverrides[manageRow.id] ?? manageRow.avatar_url}
            onUploaded={(url) => setAvatarOverrides((m) => ({ ...m, [manageRow.id]: url }))}
            toast={toast}
          />
          {manage.kind === "staff" && (manageRow as StaffRow).photo_changed_at && (
            <PhotoReview
              staff={manageRow as StaffRow}
              onDone={(removed) => {
                if (removed) setAvatarOverrides((m) => ({ ...m, [manageRow.id]: "" }));
                setReloadKey((k) => k + 1);
              }}
              toast={toast}
            />
          )}
          {manage.kind === "students" && (
            <div className="mt-5">
              <HomeAndBusEditor tenantId={tenant.id} studentId={manageRow.id} childName={manageRow.full_name} toast={toast} />
              <BioDataEditor studentId={manageRow.id} toast={toast} mode="admin" onRequestDecided={() => setReloadKey((k) => k + 1)} />
              <GuardianContacts studentId={manageRow.id} />
              <HealthEditor tenantId={tenant.id} studentId={manageRow.id} toast={toast} />
            </div>
          )}
          {manage.kind === "students" && (
            <StudentDocuments tenantId={tenant.id} uploaderId={profile.id} studentId={manageRow.id} toast={toast} />
          )}
          {manage.kind === "students" && (
            <section className="mt-5">
              <h3 className="mb-2 text-small font-semibold">Sports & activities</h3>
              <LearnerActivitiesView tenantId={tenant.id} studentId={manageRow.id} first={manageRow.full_name.split(" ")[0] ?? null} compact />
            </section>
          )}
          {manage.kind === "staff" && (manageRow as StaffRow).role === "teacher" && data && (
            <TeacherSubjectsEditor
              teacherId={manageRow.id}
              tenantId={tenant.id}
              subjects={data.subjects}
              selectedIds={new Set(data.subjectIdsByTeacher.get(manageRow.id) ?? [])}
              onChange={() => setReloadKey((k) => k + 1)}
              toast={toast}
            />
          )}
          {/* forgotten passwords: learners with a login, and every staff member but yourself */}
          {(manage.kind === "students" ? (manageRow as StudentRow).profile_id : manageRow.id !== profile.id ? manageRow.id : null) && (
            <ResetPasswordSection
              profileId={manage.kind === "students" ? (manageRow as StudentRow).profile_id! : manageRow.id}
              name={manageRow.full_name}
              email={manage.kind === "staff" ? (manageRow as StaffRow).email : null}
              schoolName={tenant.name}
            />
          )}
        </Modal>
      )}

      {addOpen && data && (
        <AddStudentModal
          tenantId={tenant.id}
          classes={data.classes}
          existingAdmissionNos={new Set(data.students.map((s) => s.admission_no))}
          onClose={() => setAddOpen(false)}
          onAdded={(name) => {
            setAddOpen(false);
            setReloadKey((k) => k + 1);
            toast(`${name} added.`);
          }}
          toast={toast}
        />
      )}

      {importOpen && data && (
        <ImportStudentsModal
          tenantId={tenant.id}
          classes={data.classes}
          existingAdmissionNos={new Set(data.students.map((s) => s.admission_no))}
          onClose={() => setImportOpen(false)}
          onImported={(count) => {
            setImportOpen(false);
            setReloadKey((k) => k + 1);
            toast(`Imported ${count} learner${count === 1 ? "" : "s"}.`);
          }}
          toast={toast}
        />
      )}

      {addStaffOpen && (
        <AddStaffModal
          tenantId={tenant.id}
          onClose={() => setAddStaffOpen(false)}
          onAdded={() => setReloadKey((k) => k + 1)}
          toast={toast}
        />
      )}

      {inviteGuardiansOpen && data && (
        <InviteGuardiansModal
          tenantId={tenant.id}
          students={data.students.filter((s) => picked.has(s.id)).map((s) => ({ id: s.id, name: s.full_name }))}
          onClose={() => setInviteGuardiansOpen(false)}
          onInvited={() => { setPicked(new Set()); setReloadKey((k) => k + 1); }}
          toast={toast}
        />
      )}

      {createLoginsOpen && data && (
        <CreateStudentLoginsModal
          tenantId={tenant.id}
          students={data.students.filter((s) => picked.has(s.id) && !s.login_id).map((s) => ({ id: s.id, name: s.full_name }))}
          onClose={() => setCreateLoginsOpen(false)}
          onCreated={() => { setPicked(new Set()); setReloadKey((k) => k + 1); }}
          toast={toast}
        />
      )}
    </>
  );
}

function AddStudentModal({ tenantId, classes, existingAdmissionNos, onClose, onAdded, toast }: {
  tenantId: string;
  classes: Pick<ClassGroup, "id" | "name">[];
  existingAdmissionNos: Set<string>;
  onClose: () => void;
  onAdded: (name: string) => void;
  toast: ToastFn;
}) {
  const [admissionNo, setAdmissionNo] = useState("");
  const [fullName, setFullName] = useState("");
  const [gender, setGender] = useState<"male" | "female" | "">("");
  const [classId, setClassId] = useState(classes[0]?.id ?? "");
  const [boarding, setBoarding] = useState(false);
  const [dob, setDob] = useState("");
  const [homeBus, setHomeBus] = useState<HomeBusValue>(EMPTY_HOME_BUS);
  const [health, setHealth] = useState<StudentHealthInput>(emptyHealth);
  const { data: routes } = useSchoolRoutes(tenantId);
  const [saving, setSaving] = useState(false);

  async function handleAdd() {
    if (!admissionNo.trim() || !fullName.trim() || !classId || !gender) {
      toast("Admission number, name, gender and class are all required.", "error");
      return;
    }
    if (existingAdmissionNos.has(admissionNo.trim())) {
      toast(`Admission ${admissionNo.trim()} is already on the roster.`, "error");
      return;
    }
    setSaving(true);
    try {
      const { data: created, error } = await supabase().from("students").insert({
        tenant_id: tenantId,
        admission_no: admissionNo.trim(),
        full_name: fullName.trim(),
        gender,
        class_id: classId,
        boarding,
        date_of_birth: dob || null,
        active: true,
        home_address: homeBus.address.trim() || null,
        home_landmark: homeBus.landmark.trim() || null,
        home_lat: homeBus.pin?.lat ?? null,
        home_lng: homeBus.pin?.lng ?? null,
      }).select("id").single<{ id: string }>();
      if (error) throw error;
      // The learner exists now; a bus or health hiccup shouldn't read as "not added".
      const later: string[] = [];
      if (!boarding && routes) {
        const plan = planBus(homeBus, routes, fullName.trim());
        if (plan) await saveBus(created.id, plan).catch(() => later.push("bus route"));
      }
      if (!isHealthEmpty(health)) await saveStudentHealth(tenantId, created.id, health).catch(() => later.push("health details"));
      if (later.length) toast(`${fullName.trim()} was added, but the ${later.join(" and ")} didn't save. Open Manage to try again.`, "error");
      onAdded(fullName.trim());
    } catch (err) {
      toast(err instanceof Error ? `Could not add the learner: ${err.message}` : "Could not add the learner.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Students"
      title="Add a learner"
      width={720}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void handleAdd()} disabled={saving}>
            {saving ? "Adding…" : "Add learner"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Admission number</span>
            <input
              value={admissionNo}
              onChange={(e) => setAdmissionNo(e.target.value)}
              placeholder="e.g. 4501"
              autoFocus
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Class</span>
            <select
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              {classes.length === 0 && <option value="">No classes yet</option>}
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Full name</span>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Wanjiku Kamau"
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Gender</span>
            <select
              value={gender}
              onChange={(e) => setGender(e.target.value as "male" | "female" | "")}
              className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
            >
              <option value="">Choose…</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </label>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <label className="block">
            <span className="mb-1.5 block text-[12.5px] font-semibold">Date of birth (optional)</span>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
            />
          </label>
          <label className="mt-6 flex items-center gap-2">
            <input type="checkbox" checked={boarding} onChange={(e) => setBoarding(e.target.checked)} style={{ accentColor: "#17402A" }} />
            <span className="text-[13px]">Boarder</span>
          </label>
        </div>
        <div className="border-t border-line-soft pt-3">
          <h3 className="mb-2 text-[13px] font-semibold">Home and bus</h3>
          <HomeAndBusFields value={homeBus} onChange={setHomeBus} routes={routes ?? []} boarding={boarding} childName={fullName} />
        </div>
        <OptionalHealthSection value={health} onChange={setHealth} />
      </div>
    </Modal>
  );
}

function ImportStudentsModal({ tenantId, classes, existingAdmissionNos, onClose, onImported, toast }: {
  tenantId: string;
  classes: Pick<ClassGroup, "id" | "name">[];
  existingAdmissionNos: Set<string>;
  onClose: () => void;
  onImported: (count: number) => void;
  toast: ToastFn;
}) {
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);

  const classIdByName = useMemo(
    () => new Map(classes.map((c) => [c.name.trim().toLowerCase(), c.id])),
    [classes],
  );

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setRows(parseStudentCsv(text, { classIdByName, existingAdmissionNos }));
    };
    reader.readAsText(file);
  }

  const validRows = rows?.filter((r) => r.errors.length === 0) ?? [];
  const validCount = validRows.length;
  const errorCount = (rows?.length ?? 0) - validCount;
  const maleCount = validRows.filter((r) => r.gender === "male").length;
  const femaleCount = validRows.filter((r) => r.gender === "female").length;
  const unpinned = validRows.filter((r) => (r.home_address || r.home_landmark) && r.home_lat == null).length;

  async function handleImport() {
    if (!rows) return;
    setImporting(true);
    try {
      const count = await importStudents(tenantId, classIdByName, rows);
      onImported(count);
    } catch (err) {
      toast(err instanceof Error ? `Import failed: ${err.message}` : "Import failed.", "error");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Students"
      title="Import from CSV"
      blurb="Columns: admission_no, full_name, gender, class, boarding, date_of_birth, and optionally home_address, home_landmark, allergies, medical_conditions. Class must match one of this school's existing classes. Homes come in as text: pin each one on the map from Manage before the bus can be planned."
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void handleImport()} disabled={!rows || validCount === 0 || importing}>
            {importing ? "Importing…" : `Import ${validCount || ""} learner${validCount === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={downloadCsvTemplate}>Download template</Button>
          <label className="text-small font-medium text-leaf">
            <span className="hit inline-block cursor-pointer rounded-md border border-[#D3DAD5] bg-white px-3 py-1.5 hover:bg-page">
              {fileName || "Choose CSV file"}
            </span>
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} aria-label="CSV file" />
          </label>
        </div>

        {rows && (
          <>
            <p className="text-[12.5px] text-ink-muted">
              {validCount} of {rows.length} row{rows.length === 1 ? "" : "s"} ready to import
              {validCount > 0 ? ` — ${maleCount} male, ${femaleCount} female` : ""}
              {errorCount > 0 ? ` · ${errorCount} need fixing (fix the file and re-upload)` : ""}.
              {unpinned > 0 ? ` ${unpinned} ha${unpinned === 1 ? "s" : "ve"} an address but no map pin: pin ${unpinned === 1 ? "it" : "them"} from Manage so the bus can be planned.` : ""}
            </p>
            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-line">
              {rows.map((r) => (
                <div key={r.line} className="flex items-start gap-3 border-b border-line-soft px-3 py-2 last:border-0">
                  <span className="w-8 shrink-0 font-mono text-[11px] text-ink-faint">L{r.line}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium">
                      {r.full_name || "—"} <span className="text-ink-faint">· ADM {r.admission_no || "—"} · {r.gender ?? "—"} · {r.className || "—"}</span>
                      {(r.home_address || r.home_landmark) && r.home_lat == null && <span className="ml-1.5"><Badge tone="info">No map pin</Badge></span>}
                      {r.allergies.length > 0 && <span className="ml-1.5"><Badge tone="warn">Allergy</Badge></span>}
                    </div>
                    {r.errors.length > 0 && (
                      <ul className="mt-0.5 text-[11.5px] leading-relaxed text-warn-ink">
                        {r.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </div>
                  <Badge tone={r.errors.length === 0 ? "ok" : "warn"}>{r.errors.length === 0 ? "Ready" : "Fix"}</Badge>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * A driver changed their own photo. It's already live, because parents
 * recognise drivers by it, so it shouldn't wait on an admin, but an admin
 * should see it once: keep it, or take it down if it isn't them.
 */
function PhotoReview({ staff, onDone, toast }: { staff: StaffRow; onDone: (removed: boolean) => void; toast: ToastFn }) {
  const [busy, setBusy] = useState(false);
  async function review(remove: boolean) {
    setBusy(true);
    try {
      // Removing the photo clears the flag too (guard_profile_self_edit).
      const { error } = await supabase().from("profiles")
        .update(remove ? { avatar_url: null } : { photo_changed_at: null }).eq("id", staff.id);
      if (error) throw error;
      toast(remove ? `Removed ${staff.full_name}'s photo` : "Photo kept");
      onDone(remove);
    } catch (err) {
      toast("Could not save: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warn-bg px-3 py-2.5">
      <p className="text-[12.5px] text-warn-ink">
        {staff.full_name.split(" ")[0]} changed this photo on {new Date(staff.photo_changed_at!).toLocaleDateString()}. Parents already see it.
      </p>
      <div className="flex gap-2">
        <Button onClick={() => void review(true)} disabled={busy}>Remove</Button>
        <Button variant="primary" onClick={() => void review(false)} disabled={busy}>Keep</Button>
      </div>
    </div>
  );
}

const STAFF_ROLE_OPTIONS = [
  { value: "teacher", label: "Teacher" },
  { value: "driver", label: "Driver" },
  { value: "staff", label: "Other staff (librarian, matron, guard, …)" },
];

/** The titles offered for other staff; any other can be typed. One list, shared by every title input on this page. */
function StaffTitleSuggestions() {
  return (
    <datalist id="staff-title-suggestions">
      {STAFF_TITLE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
    </datalist>
  );
}

/** Adds a teacher, driver or other staff member (FIG-398/400) — no email, an assigned login_id
 *  (e.g. "TC-0001") instead, shown once on success the same way every other
 *  credential-reveal modal in this app works. */
function AddStaffModal({ tenantId, onClose, onAdded, toast }: {
  tenantId: string; onClose: () => void; onAdded: () => void; toast: ToastFn;
}) {
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<InviteStaffInput["role"]>("teacher");
  const [staffTitle, setStaffTitle] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<InviteStaffResult | null>(null);
  const other = role === "staff";

  async function add() {
    if (!fullName.trim()) { toast("A name is required.", "error"); return; }
    // for other staff the title is the job: it's all that says what they do
    if (other && !staffTitle.trim()) { toast("Give them a title, e.g. Librarian.", "error"); return; }
    setSaving(true);
    try {
      const r = await inviteStaff({
        tenant_id: tenantId, full_name: fullName.trim(), role, staff_title: staffTitle.trim() || undefined, phone: phone.trim() || undefined,
      });
      setResult(r);
      onAdded();
    } catch (err) {
      toast(err instanceof Error ? `Could not add staff: ${err.message}` : "Could not add staff.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Staff"
      title={result ? "Staff added" : "Add staff"}
      actions={result ? <Button variant="accent" onClick={onClose}>Done</Button> : (
        <><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void add()} disabled={saving}>{saving ? "Adding…" : "Add"}</Button></>
      )}
    >
      {result ? (
        <div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            Nothing was sent — hand these to them directly. The password only works until they first sign in, when they'll choose their own, and it won't be shown again.
          </p>
          <div className="rounded-lg border border-line bg-page p-3.5">
            {[["Login ID", result.login_id], ["Password", result.password]].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line-soft py-2 text-[12.5px] last:border-0">
                <span className="text-ink-muted">{k}</span><span className="font-mono font-medium">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3.5">
          <TextField id="staff-name" label="Full name" placeholder="e.g. Otieno Ouma" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <SelectField id="staff-role" label="Role" value={role} onChange={(e) => setRole(e.target.value as InviteStaffInput["role"])} options={STAFF_ROLE_OPTIONS} />
          {other ? (
            <>
              <TextField id="staff-title" label="Title" placeholder="e.g. Librarian" list="staff-title-suggestions" hint="Pick one or type their own." value={staffTitle} onChange={(e) => setStaffTitle(e.target.value)} />
              <StaffTitleSuggestions />
            </>
          ) : (
            <TextField id="staff-title" label="Title (optional)" placeholder="e.g. Class teacher" value={staffTitle} onChange={(e) => setStaffTitle(e.target.value)} />
          )}
          <TextField id="staff-phone" label="Phone (optional)" placeholder="e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
          {role !== "driver" && (
            <p className="text-[12px] leading-relaxed text-ink-faint">
              A deputy, bursar, secretary or receptionist? Once they're added, open their card and give them admin access there.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Turns "Invite guardians" from a stub into a real provisioning flow
 *  (FIG-399/400) — links one new guardian account to every learner selected
 *  on the roster, with an assigned login_id instead of email/phone OTP. */
function InviteGuardiansModal({ tenantId, students, onClose, onInvited, toast }: {
  tenantId: string; students: { id: string; name: string }[]; onClose: () => void; onInvited: () => void; toast: ToastFn;
}) {
  const [fullName, setFullName] = useState("");
  const [relationship, setRelationship] = useState<"mother" | "father" | "guardian">("guardian");
  const [isPrimaryPayer, setIsPrimaryPayer] = useState(true);
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ProvisionGuardianResult | null>(null);

  async function invite() {
    if (!fullName.trim()) { toast("A name is required.", "error"); return; }
    setSaving(true);
    try {
      const r = await provisionGuardian({
        tenant_id: tenantId,
        full_name: fullName.trim(),
        students: students.map((s) => ({ student_id: s.id, relationship, is_primary_payer: isPrimaryPayer })),
        phone: phone.trim() || undefined,
      });
      setResult(r);
      onInvited();
    } catch (err) {
      toast(err instanceof Error ? `Could not add the guardian: ${err.message}` : "Could not add the guardian.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Guardians"
      title={result ? "Guardian added" : "Invite a guardian"}
      blurb={result ? undefined : `Linked to ${students.map((s) => s.name).join(", ")}.`}
      actions={result ? <Button variant="accent" onClick={onClose}>Done</Button> : (
        <><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void invite()} disabled={saving}>{saving ? "Adding…" : "Invite"}</Button></>
      )}
    >
      {result ? (
        <div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            Nothing was sent — hand these to them directly. The password only works until they first sign in, when they'll choose their own, and it won't be shown again.
          </p>
          <div className="rounded-lg border border-line bg-page p-3.5">
            {[["Login ID", result.login_id], ["Password", result.password]].map(([k, v]) => (
              <div key={k} className="flex justify-between border-b border-line-soft py-2 text-[12.5px] last:border-0">
                <span className="text-ink-muted">{k}</span><span className="font-mono font-medium">{v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid gap-3.5">
          <TextField id="guardian-name" label="Full name" placeholder="e.g. Rose Achieng" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <SelectField
            id="guardian-relationship" label="Relationship" value={relationship}
            onChange={(e) => setRelationship(e.target.value as "mother" | "father" | "guardian")}
            options={[{ value: "mother", label: "Mother" }, { value: "father", label: "Father" }, { value: "guardian", label: "Guardian" }]}
          />
          <TextField id="guardian-phone" label="Phone (optional)" placeholder="e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={isPrimaryPayer} onChange={(e) => setIsPrimaryPayer(e.target.checked)} style={{ accentColor: "#17402A" }} />
            <span className="text-[13px]">Primary fee payer</span>
          </label>
        </div>
      )}
    </Modal>
  );
}

/** Gives each selected learner a sign-in (FIG-402) — until this existed, a
 *  learner had a `students` record but no way to ever log in themselves,
 *  student was the one role with no provisioning path at all. One call to
 *  provision-student per learner (each needs its own auth account/login_id),
 *  run in sequence so a failure partway through still shows what succeeded. */
function CreateStudentLoginsModal({ tenantId, students, onClose, onCreated, toast }: {
  tenantId: string; students: { id: string; name: string }[]; onClose: () => void; onCreated: () => void; toast: ToastFn;
}) {
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<{ name: string; login_id: string; password: string }[] | null>(null);

  async function createAll() {
    setSaving(true);
    const done: { name: string; login_id: string; password: string }[] = [];
    try {
      for (const s of students) {
        try {
          const r: ProvisionStudentResult = await provisionStudent({ tenant_id: tenantId, student_id: s.id });
          done.push({ name: s.name, login_id: r.login_id, password: r.password });
        } catch (err) {
          toast(err instanceof Error ? `${s.name}: ${err.message}` : `Could not create a login for ${s.name}.`, "error");
        }
      }
      setResults(done);
      if (done.length) onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Students"
      title={results ? "Logins created" : "Create student logins"}
      blurb={results ? undefined : `Gives ${students.map((s) => s.name).join(", ")} a login_id and password.`}
      actions={results ? <Button variant="accent" onClick={onClose}>Done</Button> : (
        <><Button onClick={onClose}>Cancel</Button><Button variant="accent" onClick={() => void createAll()} disabled={saving || students.length === 0}>{saving ? "Creating…" : "Create"}</Button></>
      )}
    >
      {results ? (
        <div>
          <p className="mb-3 text-[13px] leading-relaxed text-ink-muted">
            No email/SMS provider is configured locally, so nothing was sent — hand these credentials to each learner directly.
          </p>
          <div className="rounded-lg border border-line bg-page p-3.5">
            {results.map((r) => (
              <div key={r.login_id} className="border-b border-line-soft py-2 text-[12.5px] last:border-0">
                <div className="font-medium">{r.name}</div>
                <div className="flex justify-between text-ink-muted">
                  <span>{r.login_id}</span><span className="font-mono font-medium">{r.password}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Each learner gets their own login_id (e.g. "ST-0007") and a one-time password they replace at first
          sign-in — same scheme as teacher and guardian logins.
        </p>
      )}
    </Modal>
  );
}

/** The only place a learner's basic record (name, admission number, class,
 *  residence) can be corrected after admission — previously nowhere. */
function StudentProfileEditor({ student, classes, onSaved, toast }: {
  student: StudentRow;
  classes: Pick<ClassGroup, "id" | "name">[];
  onSaved: () => void;
  toast: ToastFn;
}) {
  const [fullName, setFullName] = useState(student.full_name);
  const [admissionNo, setAdmissionNo] = useState(student.admission_no);
  const [gender, setGender] = useState<"male" | "female" | "">(student.gender ?? "");
  const [classId, setClassId] = useState(student.class_id ?? "");
  const [boarding, setBoarding] = useState(student.boarding);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!fullName.trim() || !admissionNo.trim()) { toast("Name and admission number are required.", "error"); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("students").update({
        full_name: fullName.trim(),
        admission_no: admissionNo.trim(),
        gender: gender || null,
        class_id: classId || null,
        boarding,
      }).eq("id", student.id);
      if (error) throw error;
      toast("Details saved.");
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="mb-2 text-[13px] font-semibold">Details</h3>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Full name</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Admission number</span>
          <input value={admissionNo} onChange={(e) => setAdmissionNo(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 font-mono text-[13px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Gender</span>
          <select value={gender} onChange={(e) => setGender(e.target.value as "male" | "female" | "")}
            className="w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px]">
            <option value="">Not set</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Class</span>
          <select value={classId} onChange={(e) => setClassId(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px]">
            <option value="">Unassigned</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="mt-6 flex items-center gap-2">
          <input type="checkbox" checked={boarding} onChange={(e) => setBoarding(e.target.checked)} style={{ accentColor: "#17402A" }} />
          <span className="text-[13px]">Boarder</span>
        </label>
      </div>
      <Button variant="primary" className="mt-3" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save details"}
      </Button>
    </div>
  );
}

/** The only place a staff member's own record (name, title, phone) can be
 *  corrected after they're added — previously nowhere. Role and login_id
 *  are credentials, not editable here. */
function StaffProfileEditor({ staff, onSaved, toast }: {
  staff: StaffRow;
  onSaved: () => void;
  toast: ToastFn;
}) {
  const [fullName, setFullName] = useState(staff.full_name);
  const [staffTitle, setStaffTitle] = useState(staff.staff_title ?? "");
  const [phone, setPhone] = useState(staff.phone ?? "");
  const [saving, setSaving] = useState(false);
  const other = staff.role === "staff";

  async function save() {
    if (!fullName.trim()) { toast("A name is required.", "error"); return; }
    if (other && !staffTitle.trim()) { toast("Give them a title, e.g. Librarian.", "error"); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("profiles").update({
        full_name: fullName.trim(),
        staff_title: staffTitle.trim() || null,
        phone: phone.trim() || null,
      }).eq("id", staff.id);
      if (error) throw error;
      toast("Details saved.");
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="mb-2 text-[13px] font-semibold">Details</h3>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Full name</span>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)}
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Title</span>
          <input value={staffTitle} onChange={(e) => setStaffTitle(e.target.value)} placeholder={other ? "e.g. Librarian" : "e.g. Class teacher"}
            list={other ? "staff-title-suggestions" : undefined}
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
          {other && <StaffTitleSuggestions />}
        </label>
        <label className="block">
          <span className="mb-1 block text-[11.5px] font-semibold">Phone</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0712 345 678"
            className="w-full rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[13px] outline-none" />
        </label>
      </div>
      <Button variant="primary" className="mt-3" onClick={() => void save()} disabled={saving}>
        {saving ? "Saving…" : "Save details"}
      </Button>
    </div>
  );
}

function StudentDocuments({ tenantId, uploaderId, studentId, toast }: {
  tenantId: string; uploaderId: string; studentId: string; toast: ToastFn;
}) {
  const [docs, setDocs] = useState<StudentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [docType, setDocType] = useState("birth_certificate");
  const [uploading, setUploading] = useState(false);
  const [signing, setSigning] = useState<StudentDocument | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listStudentDocuments(studentId)
      .then((d) => { if (alive) setDocs(d); })
      .catch((err: Error) => { if (alive) toast("Could not load documents: " + err.message, "error"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  async function openDoc(doc: StudentDocument) {
    try {
      const url = await privateDocUrl(doc.file_path);
      window.open(url, "_blank");
    } catch (err) {
      toast("Could not open document: " + (err instanceof Error ? err.message : String(err)), "error");
    }
  }

  async function addDocument(e: FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadStudentDocument({ tenantId, studentId, uploadedBy: uploaderId, docType, file });
      setDocs(await listStudentDocuments(studentId));
      toast("Document added");
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      toast("Could not upload: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-5 border-t border-line-soft pt-4">
      <h3 className="text-[13px] font-semibold">Documents</h3>
      {loading ? (
        <p className="mt-2 text-small text-ink-faint">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="mt-2 text-small text-ink-faint">No documents on file yet.</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-1.5">
              <button type="button" onClick={() => openDoc(d)}
                className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md border border-line-soft bg-page px-3 py-2 text-left hover:bg-sunken">
                <span className="min-w-0 truncate text-small font-medium">{d.file_name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone="muted">{DOC_TYPES.find((t) => t.value === d.doc_type)?.label ?? d.doc_type}</Badge>
                  <span className="font-mono text-[10.5px] text-ink-faint">{new Date(d.uploaded_at).toLocaleDateString()}</span>
                </span>
              </button>
              <Button onClick={() => setSigning(d)} title="Sign it, or ask guardians or staff to sign">Signatures</Button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addDocument} className="mt-3 flex flex-wrap items-center gap-2">
        <select value={docType} onChange={(e) => setDocType(e.target.value)} aria-label="Document type"
          className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
          {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <input ref={fileRef} type="file" aria-label="Document file" className="text-small" />
        <Button type="submit" variant="primary" disabled={uploading}>{uploading ? "Uploading…" : "Add document"}</Button>
      </form>
      {signing && <LearnerDocumentSignatures doc={signing} studentId={studentId} onClose={() => setSigning(null)} />}
    </div>
  );
}

/**
 * What this teacher is qualified to teach, set once at hiring and rarely
 * touched again — separate from teaching_assignments (which class they're
 * actually teaching this term). Read by SubjectsEditor to surface qualified
 * teachers first when a class needs a subject assigned.
 */
function TeacherSubjectsEditor({ teacherId, tenantId, subjects, selectedIds, onChange, toast }: {
  teacherId: string;
  tenantId: string;
  subjects: Subject[];
  selectedIds: Set<string>;
  onChange: () => void;
  toast: ToastFn;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function toggle(subjectId: string, checked: boolean) {
    setBusyId(subjectId);
    try {
      if (checked) {
        const { error } = await supabase().from("teacher_subjects")
          .insert({ tenant_id: tenantId, teacher_id: teacherId, subject_id: subjectId });
        if (error) throw error;
      } else {
        const { error } = await supabase().from("teacher_subjects")
          .delete().eq("teacher_id", teacherId).eq("subject_id", subjectId);
        if (error) throw error;
      }
      onChange();
    } catch (err) {
      toast(err instanceof Error ? `Could not update: ${err.message}` : "Could not update.", "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-5 border-t border-line-soft pt-4">
      <h3 className="text-[13px] font-semibold">Subjects this teacher is qualified to teach</h3>
      {subjects.length === 0 ? (
        <p className="mt-2 text-small text-ink-faint">No subjects have been added yet — add some under Classes first.</p>
      ) : (
        <div className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          {subjects.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={selectedIds.has(s.id)}
                disabled={busyId === s.id}
                onChange={(e) => void toggle(s.id, e.target.checked)}
                style={{ accentColor: "#17402A" }}
              />
              {s.name}
            </label>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
        This doesn't assign them anywhere on its own — it just makes them easier to find when picking a subject teacher for a class.
      </p>
    </div>
  );
}
