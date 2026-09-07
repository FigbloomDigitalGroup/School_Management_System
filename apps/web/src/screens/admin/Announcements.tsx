import { useState } from "react";
import { supabase } from "@figbloom/shared";
import type { ClassGroup } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { TextArea, TextField } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

const AUDIENCE_META = [
  { id: "whole_school", label: "Whole school" },
  { id: "parents", label: "All parents" },
  { id: "form", label: "One form level (Form 2, as an example)" },
  { id: "class", label: "One class (Form 2 West, as an example)" },
] as const;

type AudienceId = (typeof AUDIENCE_META)[number]["id"];

interface AudienceCounts {
  whole_school: number;
  parents: number;
  form: number;
  class: number;
}

interface RecentAnnouncement {
  id: string;
  subject: string;
  published_at: string | null;
}

async function fetchAnnouncementsData(): Promise<{ counts: AudienceCounts; recent: RecentAnnouncement[] }> {
  const sb = supabase();

  const [{ data: classRows }, { data: studentRows }, { count: staffCount }, { data: guardianRows }, { data: recent }] = await Promise.all([
    sb.from("classes").select("id,name,form_level").returns<Pick<ClassGroup, "id" | "name" | "form_level">[]>(),
    sb.from("students").select("id,class_id").eq("active", true).returns<{ id: string; class_id: string }[]>(),
    sb.from("profiles").select("id", { count: "exact", head: true }).in("role", ["school_admin", "teacher"]),
    sb.from("guardians").select("profile_id").returns<{ profile_id: string }[]>(),
    sb.from("announcements").select("id,subject,published_at").not("published_at", "is", null)
      .order("published_at", { ascending: false }).limit(5).returns<RecentAnnouncement[]>(),
  ]);

  const classById = new Map((classRows ?? []).map((c) => [c.id, c]));
  const students = studentRows ?? [];
  const form2 = students.filter((s) => classById.get(s.class_id)?.form_level === 2).length;
  const form2West = (classRows ?? []).find((c) => c.name === "Form 2 West");
  const inForm2West = form2West ? students.filter((s) => s.class_id === form2West.id).length : 0;
  const parents = new Set((guardianRows ?? []).map((g) => g.profile_id)).size;

  return {
    counts: { whole_school: students.length + (staffCount ?? 0), parents, form: form2, class: inForm2West },
    recent: recent ?? [],
  };
}

/**
 * SMS costs real money per recipient, so the composer shows the reach and the
 * cost before the send button — an admin should never discover the bill after.
 */
export function Announcements() {
  const toast = useToast();
  const { data, loading } = useAsync(() => fetchAnnouncementsData(), []);
  const [audienceId, setAudienceId] = useState<AudienceId>("whole_school");
  const [channels, setChannels] = useState({ in_app: true, sms: false, email: false });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const counts: AudienceCounts = data?.counts ?? { whole_school: 0, parents: 0, form: 0, class: 0 };
  const audiences = AUDIENCE_META.map((m) => ({ ...m, count: counts[m.id] }));
  const audience = audiences.find((a) => a.id === audienceId)!;

  const smsCost = channels.sms ? (audience.count * 0.8).toFixed(0) : "0";

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
              {audiences.map((a) => (
                <button key={a.id} onClick={() => setAudienceId(a.id)}
                  className="flex items-center justify-between gap-3 rounded-xl border-[1.5px] px-4 py-3 text-left"
                  style={{ borderColor: audienceId === a.id ? "var(--accent)" : "#E2E6E2", background: audienceId === a.id ? "#FFF8F6" : "#fff" }}>
                  <span className="text-[13.5px] font-medium">{a.label}</span>
                  {loading ? <Skeleton className="h-3 w-16" /> : <span className="font-mono text-[12px] text-ink-muted">{a.count.toLocaleString()} people</span>}
                </button>
              ))}
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
              <div className="flex justify-between"><dt className="text-ink-muted">Reaches</dt><dd className="font-mono">{audience.count.toLocaleString()} people</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">SMS cost</dt><dd className="font-mono">KSh {smsCost}</dd></div>
              <div className="flex justify-between"><dt className="text-ink-muted">Cannot be unsent</dt><dd className="font-mono">correct</dd></div>
            </dl>
            <div className="mt-3.5 grid gap-2">
              <Button block onClick={() => toast("Saved as a draft")}>Save draft</Button>
              <Button variant="accent" block disabled={!subject.trim() || !body.trim()}
                onClick={() => toast(`Sent to ${audience.count.toLocaleString()} people`)}>
                Send now
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
