import { useState } from "react";
import { formatMoney, supabase, type Audience, type ClassGroup } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { TextArea, TextField } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

type AudienceKind = Audience["kind"];

const AUDIENCE_META: { id: AudienceKind; label: string }[] = [
  { id: "whole_school", label: "Whole school" },
  { id: "role", label: "All parents" },
  { id: "form_level", label: "One form level" },
  { id: "class", label: "One class" },
];

interface RecentAnnouncement {
  id: string;
  subject: string;
  published_at: string | null;
}

interface AnnouncementsData {
  classes: Pick<ClassGroup, "id" | "name" | "form_level">[];
  wholeSchoolCount: number;
  parentsCount: number;
  countByForm: Map<number, number>;
  countByClass: Map<string, number>;
  recent: RecentAnnouncement[];
}

async function fetchAnnouncementsData(): Promise<AnnouncementsData> {
  const sb = supabase();

  const [{ data: classRows }, { data: studentRows }, { count: staffCount }, { data: guardianRows }, { data: recent }] = await Promise.all([
    sb.from("classes").select("id,name,form_level").order("form_level").order("name").returns<Pick<ClassGroup, "id" | "name" | "form_level">[]>(),
    sb.from("students").select("id,class_id").eq("active", true).returns<{ id: string; class_id: string }[]>(),
    sb.from("profiles").select("id", { count: "exact", head: true }).in("role", ["school_admin", "teacher"]),
    sb.from("guardians").select("profile_id").returns<{ profile_id: string }[]>(),
    sb.from("announcements").select("id,subject,published_at").not("published_at", "is", null)
      .order("published_at", { ascending: false }).limit(5).returns<RecentAnnouncement[]>(),
  ]);

  const classes = classRows ?? [];
  const classById = new Map(classes.map((c) => [c.id, c]));
  const students = studentRows ?? [];

  const countByClass = new Map<string, number>();
  const countByForm = new Map<number, number>();
  for (const s of students) {
    countByClass.set(s.class_id, (countByClass.get(s.class_id) ?? 0) + 1);
    const form = classById.get(s.class_id)?.form_level;
    if (form != null) countByForm.set(form, (countByForm.get(form) ?? 0) + 1);
  }

  return {
    classes,
    wholeSchoolCount: students.length + (staffCount ?? 0),
    parentsCount: new Set((guardianRows ?? []).map((g) => g.profile_id)).size,
    countByForm,
    countByClass,
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
  const { data, loading } = useAsync(() => fetchAnnouncementsData(), [reloadKey]);
  const [audienceId, setAudienceId] = useState<AudienceKind>("whole_school");
  const [formLevel, setFormLevel] = useState(1);
  const [classId, setClassId] = useState("");
  const [channels, setChannels] = useState({ in_app: true, push: true, sms: false, email: false });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const effectiveClassId = classId || data?.classes[0]?.id || "";
  const reach = !data ? 0
    : audienceId === "whole_school" ? data.wholeSchoolCount
    : audienceId === "role" ? data.parentsCount
    : audienceId === "form_level" ? data.countByForm.get(formLevel) ?? 0
    : data.countByClass.get(effectiveClassId) ?? 0;

  const smsCostCents = channels.sms ? Math.round(reach * 0.8 * 100) : 0;

  function audienceValue(): Audience {
    switch (audienceId) {
      case "whole_school": return { kind: "whole_school" };
      case "role": return { kind: "role", role: "parent" };
      case "form_level": return { kind: "form_level", form_level: formLevel };
      case "class": return { kind: "class", class_id: effectiveClassId };
      case "user": throw new Error("The composer never selects a per-person audience.");
    }
  }

  async function submit(publish: boolean) {
    if (!subject.trim() || !body.trim()) return;
    if (audienceId === "class" && !effectiveClassId) { toast("Pick a class first."); return; }
    setSending(true);
    try {
      const activeChannels = (Object.keys(channels) as (keyof typeof channels)[]).filter((k) => channels[k]);
      const { data: created, error } = await supabase().from("announcements").insert({
        tenant_id: tenant.id,
        author_id: profile.id,
        subject: subject.trim(),
        body: body.trim(),
        audience: audienceValue(),
        channels: activeChannels,
        published_at: publish ? new Date().toISOString() : null,
      }).select("id").single();
      if (error) throw error;
      toast(publish ? `Sent to ${reach.toLocaleString()} people` : "Saved as a draft");

      if (publish && channels.push) {
        const { error: pushErr } = await supabase().functions.invoke("send-push", { body: { announcement_id: created.id } });
        if (pushErr) toast(`Sent, but push notifications failed: ${pushErr.message}`);
      }

      setSubject("");
      setBody("");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not send: ${err.message}` : "Could not send.");
    } finally {
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
                const count = !data ? null
                  : a.id === "whole_school" ? data.wholeSchoolCount
                  : a.id === "role" ? data.parentsCount
                  : a.id === "form_level" ? data.countByForm.get(formLevel) ?? 0
                  : data.countByClass.get(effectiveClassId) ?? 0;
                return (
                  <div key={a.id}>
                    <button onClick={() => setAudienceId(a.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border-[1.5px] px-4 py-3 text-left"
                      style={{ borderColor: audienceId === a.id ? "var(--accent)" : "#E2E6E2", background: audienceId === a.id ? "#FFF8F6" : "#fff" }}>
                      <span className="text-[13.5px] font-medium">{a.label}</span>
                      {loading || count === null ? <Skeleton className="h-3 w-16" /> : <span className="font-mono text-[12px] text-ink-muted">{count.toLocaleString()} people</span>}
                    </button>
                    {audienceId === a.id && a.id === "form_level" && (
                      <select value={formLevel} onChange={(e) => setFormLevel(Number(e.target.value))}
                        aria-label="Form level" className="mt-1.5 w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small">
                        {[1, 2, 3, 4].map((f) => <option key={f} value={f}>Form {f}</option>)}
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

          <TextField id="subject" label="Subject" placeholder="e.g. Half-term closing Friday 12 September"
            hint="This is all a parent sees in the notification, so put the date in it."
            value={subject} onChange={(e) => setSubject(e.target.value)} />

          <TextArea id="body" label="Message" value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="School closes for half-term on Friday 12 September at 12:30pm. Boarders travelling upcountry should collect travel passes from the deputy's office on Thursday."
            hint="Plain language, one instruction per paragraph. Most parents read this on a phone in the sun." />
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
              <div className="flex justify-between"><dt className="text-ink-muted">Reaches</dt><dd className="font-mono">{reach.toLocaleString()} people</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">SMS cost</dt><dd className="font-mono">{formatMoney(smsCostCents, tenant.country)}</dd></div>
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

          {!loading && data && data.recent.length > 0 && (
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
