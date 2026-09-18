import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@figbloom/shared";
import type { ClassGroup, Profile, Term } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { uploadTenantLogo } from "../../lib/uploads";

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
  const navigate = useNavigate();
  const { tenant } = useTenantSession();
  const [open, setOpen] = useState<string | null>("teachers");
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchTermSetup(), [reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);

  const [schoolName, setSchoolName] = useState(tenant.name);
  const [schoolCounty, setSchoolCounty] = useState(tenant.county);
  const [schoolMoe, setSchoolMoe] = useState(tenant.moe_registration ?? "");
  const [savingDetails, setSavingDetails] = useState(false);

  async function handleSaveDetails(e: FormEvent) {
    e.preventDefault();
    if (!schoolName.trim()) { toast("The school needs a name."); return; }
    setSavingDetails(true);
    try {
      const { error: rpcError } = await supabase().rpc("set_school_details", {
        p_tenant_id: tenant.id,
        p_name: schoolName,
        p_county: schoolCounty,
        p_moe_registration: schoolMoe,
      });
      if (rpcError) throw rpcError;
      toast("School details saved — this page picks it up immediately; the sidebar and other screens pick it up next time they load.");
    } catch (err) {
      toast(err instanceof Error ? `Could not save school details: ${err.message}` : "Could not save school details.");
    } finally {
      setSavingDetails(false);
    }
  }

  const [paybill, setPaybill] = useState(tenant.payment_paybill ?? "");
  const [till, setTill] = useState(tenant.payment_till ?? "");
  const [bankDetails, setBankDetails] = useState(tenant.payment_bank_details ?? "");
  const [paymentNotes, setPaymentNotes] = useState(tenant.payment_notes ?? "");
  const [paymentSet, setPaymentSet] = useState(
    Boolean(tenant.payment_paybill || tenant.payment_till || tenant.payment_bank_details),
  );
  const [savingPayment, setSavingPayment] = useState(false);

  async function handleSavePayment(e: FormEvent) {
    e.preventDefault();
    setSavingPayment(true);
    try {
      const { error: rpcError } = await supabase().rpc("set_school_payment_methods", {
        p_tenant_id: tenant.id,
        p_paybill: paybill,
        p_till: till,
        p_bank_details: bankDetails,
        p_notes: paymentNotes,
      });
      if (rpcError) throw rpcError;
      setPaymentSet(Boolean(paybill.trim() || till.trim() || bankDetails.trim()));
      toast("Payment methods saved — parents will see these on the Fees screen.");
    } catch (err) {
      toast(err instanceof Error ? `Could not save payment methods: ${err.message}` : "Could not save payment methods.");
    } finally {
      setSavingPayment(false);
    }
  }

  const [logoUrl, setLogoUrl] = useState(tenant.logo_url);
  const [crestFile, setCrestFile] = useState<File | null>(null);
  const [savingCrest, setSavingCrest] = useState(false);

  async function handleSaveCrest(e: FormEvent) {
    e.preventDefault();
    if (!crestFile) return;
    setSavingCrest(true);
    try {
      const url = await uploadTenantLogo(tenant.id, crestFile);
      const { error: rpcError } = await supabase().rpc("set_school_logo", { p_tenant_id: tenant.id, p_logo_url: url });
      if (rpcError) throw rpcError;
      // Cache-bust: the path is stable (logo.<ext>), so a browser that already fetched it
      // needs a new URL to notice the replacement.
      setLogoUrl(`${url}?v=${Date.now()}`);
      setCrestFile(null);
      toast("Crest updated. It appears here immediately; other screens pick it up next time they load.");
    } catch (err) {
      toast(err instanceof Error ? `Could not update the crest: ${err.message}` : "Could not update the crest.");
    } finally {
      setSavingCrest(false);
    }
  }

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
          id: "branding", label: "School crest", done: Boolean(logoUrl),
          note: logoUrl ? "A crest is set. Replace it any time." : "No crest uploaded yet — the school's initials are shown instead.",
        },
        {
          id: "payment", label: "Payment methods", done: paymentSet,
          note: paymentSet
            ? "Parents see these on the Fees screen and pay externally, then upload proof."
            : "No paybill, till, or bank details set up yet — parents can't see how to pay.",
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
        <div className="mb-5 overflow-hidden rounded-xl border border-line">
          <header className="border-b border-line-soft px-4 py-3">
            <h2 className="text-[13px] font-semibold">School details</h2>
          </header>
          <form onSubmit={handleSaveDetails} className="grid gap-3 px-4 py-3.5">
            <div className="grid gap-3" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-semibold">School name</span>
                <input
                  value={schoolName}
                  onChange={(e) => setSchoolName(e.target.value)}
                  className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-[12px] font-semibold">County</span>
                <input
                  value={schoolCounty}
                  onChange={(e) => setSchoolCounty(e.target.value)}
                  className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
                />
              </label>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-[12px] font-semibold">MOE registration (optional)</span>
              <input
                value={schoolMoe}
                onChange={(e) => setSchoolMoe(e.target.value)}
                placeholder="e.g. MOE/SEC/1234"
                className="w-full max-w-[280px] rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none"
              />
            </label>
            <div>
              <Button type="submit" variant="primary" disabled={savingDetails}>
                {savingDetails ? "Saving…" : "Save school details"}
              </Button>
            </div>
          </form>
        </div>

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
                        {s.id === "branding" ? (
                          <form onSubmit={handleSaveCrest} className="flex flex-wrap items-end gap-3">
                            <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-line bg-white">
                              {logoUrl ? (
                                <img src={logoUrl} alt="School crest" className="h-full w-full object-contain" />
                              ) : (
                                <span className="text-[11px] text-ink-faint">No crest</span>
                              )}
                            </div>
                            <label className="block min-w-[200px] flex-1">
                              <span className="mb-1.5 block text-[12px] font-semibold">Replace crest</span>
                              <input
                                key={crestFile ? "has-file" : "no-file"}
                                type="file"
                                accept="image/*"
                                onChange={(e) => setCrestFile(e.target.files?.[0] ?? null)}
                                className="block text-[12.5px]"
                              />
                            </label>
                            <Button type="submit" variant="primary" disabled={!crestFile || savingCrest}>
                              {savingCrest ? "Uploading…" : "Save crest"}
                            </Button>
                          </form>
                        ) : s.id === "payment" ? (
                          <form onSubmit={handleSavePayment} className="grid gap-3">
                            <p className="text-[12px] leading-relaxed text-ink-muted">
                              {tenant.country === "KE"
                                ? "Real-time M-Pesa auto-pay isn't wired up yet — for now, parents pay to whichever of these the school uses and upload proof for the bursar to confirm."
                                : "Automated payment isn't wired up yet — for now, parents pay to whichever of these the school uses and upload proof for the bursar to confirm."}
                            </p>
                            <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
                              <label className="block">
                                {/* "Paybill"/"Till" are Safaricom-specific terms — the columns
                                    themselves are plain free text, so a non-Kenyan school gets
                                    a generic label over the same field rather than confusing
                                    M-Pesa terminology. */}
                                <span className="mb-1.5 block text-[12px] font-semibold">{tenant.country === "KE" ? "Paybill number" : "Payment reference 1"}</span>
                                <input
                                  value={paybill}
                                  onChange={(e) => setPaybill(e.target.value)}
                                  placeholder={tenant.country === "KE" ? "e.g. 522533" : "e.g. account or reference number"}
                                  className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none"
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1.5 block text-[12px] font-semibold">{tenant.country === "KE" ? "Till number" : "Payment reference 2"}</span>
                                <input
                                  value={till}
                                  onChange={(e) => setTill(e.target.value)}
                                  placeholder={tenant.country === "KE" ? "e.g. 5028417" : "e.g. a second reference number"}
                                  className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 font-mono text-[13px] outline-none"
                                />
                              </label>
                            </div>
                            <label className="block">
                              <span className="mb-1.5 block text-[12px] font-semibold">Bank details</span>
                              <input
                                value={bankDetails}
                                onChange={(e) => setBankDetails(e.target.value)}
                                placeholder="e.g. Equity Bank, Acc 0123456789"
                                className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
                              />
                            </label>
                            <label className="block">
                              <span className="mb-1.5 block text-[12px] font-semibold">Notes for parents (optional)</span>
                              <input
                                value={paymentNotes}
                                onChange={(e) => setPaymentNotes(e.target.value)}
                                placeholder="e.g. Use your child's admission number as the account reference"
                                className="w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none"
                              />
                            </label>
                            <div>
                              <Button type="submit" variant="primary" disabled={savingPayment}>
                                {savingPayment ? "Saving…" : "Save payment methods"}
                              </Button>
                            </div>
                          </form>
                        ) : s.id === "teachers" ? (
                          unassigned.length === 0 ? (
                            <p className="text-[12.5px] leading-relaxed text-ink-muted">Every class already has a class teacher assigned.</p>
                          ) : (
                            <div className="grid gap-2">
                              {unassigned.map((c) => (
                                <ClassTeacherRow key={c.id} classId={c.id} className={c.name} teachers={data.teacherOptions} toast={toast} onAssigned={reload} />
                              ))}
                              <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                                A class with no teacher cannot have attendance taken, which is why this blocks the first day
                                rather than the fee structure.
                              </p>
                            </div>
                          )
                        ) : s.id === "subjects" ? (
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="max-w-[420px] text-[12.5px] leading-relaxed text-ink-muted">
                              Subjects, and who teaches which one in each class, are set up per class — under Classes, next to that
                              class's Timetable link.
                            </p>
                            <Button variant="primary" onClick={() => navigate("../admin/classes")}>Go to Classes</Button>
                          </div>
                        ) : s.id === "roll" ? (
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="max-w-[420px] text-[12.5px] leading-relaxed text-ink-muted">
                              There's no blanket "bump everyone" — each class teacher reviews their own roster and picks who's
                              promoted, who repeats, and who's leaving. Under Classes, next to that class's Timetable link.
                            </p>
                            <Button variant="primary" onClick={() => navigate("../admin/classes")}>Go to Classes</Button>
                          </div>
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

function ClassTeacherRow({ classId, className, teachers, toast, onAssigned }: {
  classId: string; className: string;
  teachers: Pick<Profile, "id" | "full_name">[];
  toast: (m: string) => void;
  onAssigned: () => void;
}) {
  const [teacherId, setTeacherId] = useState("");
  const [saving, setSaving] = useState(false);

  async function assign() {
    if (!teacherId) { toast("Choose a teacher first."); return; }
    setSaving(true);
    try {
      const { error } = await supabase().from("classes").update({ class_teacher_id: teacherId }).eq("id", classId);
      if (error) throw error;
      toast(`Class teacher assigned for ${className}.`);
      onAssigned();
    } catch (err) {
      toast(err instanceof Error ? `Could not assign a class teacher: ${err.message}` : "Could not assign a class teacher.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-lg bg-white px-3.5 py-2.5">
      <span className="min-w-0 flex-1 text-[13px] font-medium">{className}</span>
      <select
        value={teacherId}
        onChange={(e) => setTeacherId(e.target.value)}
        aria-label={`Class teacher for ${className}`}
        className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
      >
        <option value="">Choose a teacher</option>
        {teachers.map((t) => <option key={t.id} value={t.id}>{t.full_name}</option>)}
      </select>
      <Button variant="primary" disabled={saving} onClick={() => void assign()}>{saving ? "Assigning…" : "Assign"}</Button>
    </div>
  );
}
