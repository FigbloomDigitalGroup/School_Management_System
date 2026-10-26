import { useRef, useState } from "react";
import {
  fetchAllPages, formatMoney, STAFF_ROLES, publishAnnouncement, removeAttachmentFilesFor, supabase, yearGroupKey, yearGroupsOf, yearLabel,
  type Audience, type ClassGroup, type YearGroup,
} from "@figbloom/shared";
import { AiWriteHelper } from "../../components/AiWriteHelper";
import { AttachmentPicker } from "../../components/AttachmentPicker";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { TextArea, TextField } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { saveAttachments, UploadCancelled, type AttachmentBatch, type BatchProgress, type WebMediaDraft } from "../../lib/resumableUpload";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

/** The composer's choices. Each maps to one Audience; the database decides who it reaches (20261026030000). */
type AudienceChoice = "whole_school" | "parents" | "students" | "teachers" | "staff" | "year" | "class";
type Recipients = "both" | "guardians" | "students";

const AUDIENCE_META: { id: AudienceChoice; label: string; hint?: string }[] = [
  { id: "whole_school", label: "Whole school", hint: "Staff, parents and students" },
  { id: "parents", label: "All parents" },
  { id: "students", label: "All students", hint: "Learners with their own login" },
  { id: "teachers", label: "All teachers" },
  { id: "staff", label: "All staff", hint: "Office, teachers and drivers" },
  { id: "year", label: "One year group" },
  { id: "class", label: "One class" },
];

const RECIPIENT_OPTIONS: { value: Recipients; label: string }[] = [
  { value: "both", label: "Parents and students" },
  { value: "guardians", label: "Parents only" },
  { value: "students", label: "Students only" },
];

interface RecentAnnouncement {
  id: string;
  subject: string;
  published_at: string | null;
}

/** How many people, per side, a class or year group reaches. */
interface Reach { guardians: number; students: number; both: number }

interface AnnouncementsData {
  classes: Pick<ClassGroup, "id" | "name" | "level" | "form_level">[];
  /** Accounts at the school, by role. */
  byRole: { everyone: number; parents: number; students: number; teachers: number; staff: number };
  /** Keyed by yearGroupKey(level, form_level) — Grade 1 and Form 1 are both form_level 1. */
  reachByYear: Map<string, Reach>;
  /** Year groups that actually have classes, youngest first. */
  years: YearGroup[];
  reachByClass: Map<string, Reach>;
  recent: RecentAnnouncement[];
}

/** Distinct parent and learner accounts behind a set of learners. */
function reachOf(students: { id: string; profile_id: string | null }[], parentsOf: Map<string, string[]>): Reach {
  const learners = new Set(students.map((s) => s.profile_id).filter((p): p is string => !!p));
  const parents = new Set(students.flatMap((s) => parentsOf.get(s.id) ?? []));
  return { guardians: parents.size, students: learners.size, both: parents.size + learners.size };
}

async function fetchAnnouncementsData(tenantId: string): Promise<AnnouncementsData> {
  const sb = supabase();
  const count = (roles: string[]) =>
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).in("role", roles);

  const [{ data: classRows }, students, guardians, everyone, parents, learners, teachers, staff, { data: recent }] = await Promise.all([
    sb.from("classes").select("id,name,level,form_level").eq("tenant_id", tenantId).order("form_level").order("name").returns<Pick<ClassGroup, "id" | "name" | "level" | "form_level">[]>(),
    fetchAllPages<{ id: string; class_id: string; profile_id: string | null }>((from, to) =>
      sb.from("students").select("id,class_id,profile_id").eq("tenant_id", tenantId).eq("active", true).order("id").range(from, to)
        .returns<{ id: string; class_id: string; profile_id: string | null }[]>()),
    fetchAllPages<{ profile_id: string; student_id: string }>((from, to) =>
      sb.from("guardians").select("profile_id,student_id").eq("tenant_id", tenantId).order("id").range(from, to)
        .returns<{ profile_id: string; student_id: string }[]>()),
    sb.from("profiles").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    count(["parent"]),
    count(["student"]),
    count(["teacher"]),
    count(STAFF_ROLES),
    sb.from("announcements").select("id,subject,published_at").eq("tenant_id", tenantId).not("published_at", "is", null)
      .order("published_at", { ascending: false }).limit(5).returns<RecentAnnouncement[]>(),
  ]);

  const classes = classRows ?? [];
  const classById = new Map(classes.map((c) => [c.id, c]));
  const parentsOf = new Map<string, string[]>();
  for (const g of guardians) parentsOf.set(g.student_id, [...(parentsOf.get(g.student_id) ?? []), g.profile_id]);

  const byClass = new Map<string, typeof students>();
  const byYear = new Map<string, typeof students>();
  for (const s of students) {
    byClass.set(s.class_id, [...(byClass.get(s.class_id) ?? []), s]);
    const cls = classById.get(s.class_id);
    if (cls) { const k = yearGroupKey(cls.level, cls.form_level); byYear.set(k, [...(byYear.get(k) ?? []), s]); }
  }

  return {
    classes,
    byRole: {
      everyone: everyone.count ?? 0, parents: parents.count ?? 0, students: learners.count ?? 0,
      teachers: teachers.count ?? 0, staff: staff.count ?? 0,
    },
    reachByYear: new Map([...byYear.entries()].map(([k, list]) => [k, reachOf(list, parentsOf)])),
    years: yearGroupsOf(classRows ?? []),
    reachByClass: new Map([...byClass.entries()].map(([k, list]) => [k, reachOf(list, parentsOf)])),
    recent: recent ?? [],
  };
}

/**
 * SMS costs real money per recipient, so the composer shows the reach and the
 * cost before the send button — an admin should never discover the bill after.
 */
export function Announcements() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading } = useAsync(() => fetchAnnouncementsData(tenant.id), [tenant.id, reloadKey]);
  const [audienceId, setAudienceId] = useState<AudienceChoice>("whole_school");
  const [recipients, setRecipients] = useState<Recipients>("both");
  const [pickedYear, setPickedYear] = useState<string | null>(null);
  const yearGroup = data ? (data.years.find((y) => y.key === pickedYear) ?? data.years[0] ?? null) : null;
  const formLevel = yearGroup?.key ?? "";
  const [classId, setClassId] = useState("");
  const [channels, setChannels] = useState({ in_app: true, push: true, sms: false, email: false });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [drafts, setDrafts] = useState<WebMediaDraft[]>([]);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const batch = useRef<AttachmentBatch | null>(null);

  const effectiveClassId = classId || data?.classes[0]?.id || "";
  const reachFor = (id: AudienceChoice): number => {
    if (!data) return 0;
    switch (id) {
      case "whole_school": return data.byRole.everyone;
      case "parents": return data.byRole.parents;
      case "students": return data.byRole.students;
      case "teachers": return data.byRole.teachers;
      case "staff": return data.byRole.staff;
      case "year": return data.reachByYear.get(formLevel)?.[recipients] ?? 0;
      case "class": return data.reachByClass.get(effectiveClassId)?.[recipients] ?? 0;
    }
  };
  const reach = reachFor(audienceId);

  const smsCostCents = channels.sms ? Math.round(reach * 0.8 * 100) : 0;

  function audienceValue(): Audience {
    switch (audienceId) {
      case "whole_school": return { kind: "whole_school" };
      case "parents": return { kind: "role", role: "parent" };
      case "students": return { kind: "role", role: "student" };
      case "teachers": return { kind: "role", role: "teacher" };
      case "staff": return { kind: "roles", roles: STAFF_ROLES };
      case "year": return yearGroup
        ? { kind: "form_level", form_level: yearGroup.year, level: yearGroup.level, recipients }
        : { kind: "form_level", form_level: 1, recipients };
      case "class": return { kind: "class", class_id: effectiveClassId, recipients };
    }
  }

  async function submit(publish: boolean) {
    if (!subject.trim() || !body.trim()) return;
    if (audienceId === "class" && !effectiveClassId) { toast("Pick a class first.", "error"); return; }
    setSending(true);
    // With files, the notice goes in as a draft, the files go up, and only
    // then is it published: nobody gets a notice whose attachments are missing.
    const withFiles = drafts.length > 0;
    let createdId: string | null = null;
    try {
      const activeChannels = (Object.keys(channels) as (keyof typeof channels)[]).filter((k) => channels[k]);
      const { data: created, error } = await supabase().from("announcements").insert({
        tenant_id: tenant.id,
        author_id: profile.id,
        subject: subject.trim(),
        body: body.trim(),
        audience: audienceValue(),
        channels: activeChannels,
        published_at: publish && !withFiles ? new Date().toISOString() : null,
      }).select("id").single<{ id: string }>();
      if (error) throw error;
      createdId = created.id;
      if (withFiles) {
        batch.current = saveAttachments(tenant.id, "announcement", created.id, drafts, setProgress);
        await batch.current.done;
        if (publish) await publishAnnouncement(created.id);
      }
      createdId = null;
      toast(publish ? `Sent to ${reach.toLocaleString()} people` : "Saved as a draft");

      if (publish && channels.push) {
        const { error: pushErr } = await supabase().functions.invoke("send-push", { body: { announcement_id: created.id } });
        if (pushErr) toast(`Sent, but push notifications failed: ${pushErr.message}`, "error");
      }

      setSubject("");
      setBody("");
      setDrafts([]);
      setReloadKey((k) => k + 1);
    } catch (err) {
      // Half an announcement is worse than none: take it back out and keep the form as it was, to try again.
      if (createdId) {
        const id = createdId;
        await removeAttachmentFilesFor("announcement", id).catch(() => {});
        await supabase().from("announcements").delete().eq("id", id);
      }
      if (err instanceof UploadCancelled) toast("Upload cancelled. Nothing was sent; your message is still here.", "error");
      else toast(err instanceof Error ? `Could not send: ${err.message}` : "Could not send.", "error");
    } finally {
      batch.current = null;
      setProgress(null);
      setSending(false);
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Announcements"
        title="Compose an announcement"
        blurb="In-app always. Add SMS only when it genuinely cannot wait — parents who get texted about a bake sale stop reading the texts about fees."
      />

      <div className="grid gap-5 px-7 py-6" style={{ gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)" }}>
        <div className="grid gap-4">
          <fieldset>
            <legend className="mb-2 text-small font-semibold">Who should get this?</legend>
            <div className="grid gap-2">
              {AUDIENCE_META.map((a) => {
                const count = !data ? null : reachFor(a.id);
                return (
                  <div key={a.id}>
                    <button onClick={() => setAudienceId(a.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border-[1.5px] px-4 py-3 text-left"
                      style={{ borderColor: audienceId === a.id ? "var(--accent)" : "#E2E6E2", background: audienceId === a.id ? "#FFF8F6" : "#fff" }}>
                      <span className="min-w-0">
                        <span className="block text-[13.5px] font-medium">{a.label}</span>
                        {a.hint && <span className="block text-[11.5px] text-ink-faint">{a.hint}</span>}
                      </span>
                      {loading || count === null ? <Skeleton className="h-3 w-16" /> : <span className="font-mono text-[12px] text-ink-muted">{count.toLocaleString()} people</span>}
                    </button>
                    {audienceId === a.id && (a.id === "year" || a.id === "class") && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Send to">
                        {RECIPIENT_OPTIONS.map((r) => (
                          <button key={r.value} type="button" role="radio" aria-checked={recipients === r.value}
                            onClick={() => setRecipients(r.value)}
                            className="rounded-full border px-3 py-1 text-[12px] font-medium"
                            style={{ borderColor: recipients === r.value ? "var(--accent)" : "#D3DAD5", background: recipients === r.value ? "#FFF8F6" : "#fff" }}>
                            {r.label}
                          </button>
                        ))}
                      </div>
                    )}
                    {audienceId === a.id && a.id === "year" && (
                      <select value={formLevel} onChange={(e) => setPickedYear(e.target.value)}
                        aria-label="Year group" className="mt-1.5 w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
                        {(data?.years ?? []).map((y) => <option key={y.key} value={y.key}>{yearLabel(y.level, y.year)}</option>)}
                      </select>
                    )}
                    {audienceId === a.id && a.id === "class" && (
                      <select value={effectiveClassId} onChange={(e) => setClassId(e.target.value)}
                        aria-label="Class" className="mt-1.5 w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
                        {(data?.classes ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>

          <AiWriteHelper
            audience={(() => {
              const who = RECIPIENT_OPTIONS.find((r) => r.value === recipients)?.label.toLowerCase() ?? "parents and students";
              if (audienceId === "class") return `${who} of ${data?.classes.find((c) => c.id === effectiveClassId)?.name ?? "one class"}`;
              if (audienceId === "year") return `${who} of ${yearGroup ? yearLabel(yearGroup.level, yearGroup.year) : "one year group"}`;
              return AUDIENCE_META.find((a) => a.id === audienceId)?.label.toLowerCase() ?? "the whole school";
            })()}
            schoolName={tenant.name}
            subject={subject}
            body={body}
            disabled={sending}
            onUse={(d) => { setSubject(d.subject); setBody(d.body); }}
          />

          <TextField id="subject" label="Subject" placeholder="e.g. Half-term closing Friday 12 September"
            hint="This is all a parent sees in the notification, so put the date in it."
            value={subject} onChange={(e) => setSubject(e.target.value)} />

          <TextArea id="body" label="Message" value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="School closes for half-term on Friday 12 September at 12:30pm. Boarders travelling upcountry should collect travel passes from the deputy's office on Thursday."
            hint="Plain language, one instruction per paragraph. Most parents read this on a phone in the sun." />

          <AttachmentPicker drafts={drafts} onChange={setDrafts} progress={progress} onCancel={() => batch.current?.cancel()} disabled={sending} />
        </div>

        <aside className="grid content-start gap-4">
          <fieldset className="rounded-xl border border-line p-4">
            <legend className="px-1 text-small font-semibold">How it goes out</legend>
            {(
              [
                ["in_app", "In the app", "Free. Everyone with an account sees it."],
                ["push", "Push notification", "Free. Android only for now — reaches the phone even if the app is closed."],
                ["sms", "SMS", "Charged per recipient. Reaches parents with no smartphone."],
                ["email", "Email", "Free, but many parents have no working address."],
              ] as [keyof typeof channels, string, string][]
            ).map(([key, label, note]) => (
              <label key={key} className="flex items-start gap-2.5 border-b border-line-soft py-2.5 last:border-0">
                <input type="checkbox" checked={channels[key as keyof typeof channels]}
                  onChange={(e) => setChannels((c) => ({ ...c, [key]: e.target.checked }))}
                  disabled={key === "in_app"} style={{ accentColor: "#17402A", marginTop: 3 }} />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium">{label}</span>
                  <span className="block text-[11.5px] leading-snug text-ink-faint">{note}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="rounded-xl bg-sunken p-4">
            <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">BEFORE YOU SEND</div>
            <dl className="mt-2.5 grid gap-2 text-[12.5px]">
              {/* reach is 0 until the counts land — never show that as the answer. */}
              <div className="flex justify-between"><dt className="text-ink-muted">Reaches</dt><dd className="font-mono">{loading && !data ? <Skeleton className="h-3 w-16" /> : `${reach.toLocaleString()} people`}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">SMS cost</dt><dd className="font-mono">{channels.sms && loading && !data ? <Skeleton className="h-3 w-16" /> : formatMoney(smsCostCents, tenant.country)}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">Cannot be unsent</dt><dd className="font-mono">correct</dd></div>
            </dl>
            <div className="mt-3.5 grid gap-2">
              <Button block disabled={!subject.trim() || !body.trim() || sending} onClick={() => void submit(false)}>Save draft</Button>
              <Button variant="accent" block disabled={!subject.trim() || !body.trim() || sending}
                onClick={() => void submit(true)}>
                {sending ? "Sending…" : "Send now"}
              </Button>
            </div>
          </div>

          {loading && !data ? (
            <div className="rounded-xl border border-line p-4">
              <Skeleton className="h-2.5 w-28" />
              <div className="mt-2.5 grid gap-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i}>
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="mt-1 h-2.5 w-20" />
                  </div>
                ))}
              </div>
            </div>
          ) : data && data.recent.length > 0 && (
            <div className="rounded-xl border border-line p-4">
              <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">RECENTLY SENT</div>
              <ul className="mt-2.5 grid gap-2">
                {data.recent.map((a) => (
                  <li key={a.id} className="border-b border-line-soft pb-2 last:border-0 last:pb-0">
                    <div className="truncate text-[12.5px] font-medium">{a.subject}</div>
                    <div className="mt-0.5 font-mono text-[10.5px] text-ink-faint">
                      {a.published_at ? new Date(a.published_at).toLocaleDateString("en-KE", { day: "numeric", month: "short", year: "numeric" }) : "Draft"}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
