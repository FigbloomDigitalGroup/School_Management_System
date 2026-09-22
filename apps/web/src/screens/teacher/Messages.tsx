import { useMemo, useState } from "react";
import { fetchTeacherClasses, supabase, type Announcement } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

type Recipients = "guardians" | "students" | "both";

function recipientsLabel(r?: Recipients): string {
  if (r === "students") return "students";
  if (r === "both") return "parents and students";
  return "parents";
}

async function fetchSentByMe(teacherId: string): Promise<Announcement[]> {
  const { data, error } = await supabase()
    .from("announcements").select("*").eq("author_id", teacherId)
    .order("created_at", { ascending: false }).limit(20);
  if (error) throw error;
  return (data ?? []) as Announcement[];
}

/**
 * A teacher's own reach is one class at a time, not the whole-school/SMS
 * targeting admin's Announcements composer has — so this is a lighter form
 * over the same announcements table, always in-app only.
 */
export function TeacherMessages() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);

  const { data: classes, loading: classesLoading } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const { data: sent, loading: sentLoading } = useAsync(() => fetchSentByMe(profile.id), [profile.id, reloadKey]);

  const classById = useMemo(() => new Map((classes ?? []).map((c) => [c.id, c])), [classes]);

  const [classId, setClassId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipients, setRecipients] = useState<Recipients>("guardians");
  const [sending, setSending] = useState(false);

  const effectiveClassId = classId || classes?.[0]?.id || "";

  async function send() {
    if (!effectiveClassId || !subject.trim() || !body.trim()) return;
    setSending(true);
    try {
      const { error } = await supabase().from("announcements").insert({
        tenant_id: tenant.id,
        author_id: profile.id,
        subject: subject.trim(),
        body: body.trim(),
        audience: { kind: "class", class_id: effectiveClassId, recipients },
        channels: ["in_app"],
        published_at: new Date().toISOString(),
      });
      if (error) throw error;
      const className = classById.get(effectiveClassId)?.name ?? "the class";
      toast(`Sent to ${recipientsLabel(recipients)} of ${className}.`);
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
        eyebrow="Teaching"
        title="Messages"
        blurb="Send a note to one of your classes — to its parents, its students, or both."
      />

      <div className="grid gap-5 px-7 py-6" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)" }}>
        <div className="grid content-start gap-3.5 rounded-lg border border-line bg-white p-4">
          {classesLoading ? (
            <TableSkeleton rows={3} />
          ) : !classes || classes.length === 0 ? (
            <EmptyState title="No classes yet." body="You need a class assigned before you can message its parents or students." />
          ) : (
            <>
              <label className="block">
                <span className="mb-1.5 block text-[12.5px] font-semibold">Class</span>
                <select
                  value={effectiveClassId}
                  onChange={(e) => setClassId(e.target.value)}
                  className="w-full rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px]"
                >
                  {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>

              <SelectField
                id="recipients" label="To" value={recipients}
                onChange={(e) => setRecipients(e.target.value as Recipients)}
                options={[
                  { value: "guardians", label: "Parents" },
                  { value: "students", label: "Students" },
                  { value: "both", label: "Parents and students" },
                ]}
              />

              <TextField id="subject" label="Subject" placeholder="e.g. CAT results out Friday"
                value={subject} onChange={(e) => setSubject(e.target.value)} />

              <TextArea id="body" label="Message" value={body} onChange={(e) => setBody(e.target.value)}
                placeholder="Plain language, one instruction per paragraph."
                hint={`This goes to this class's ${recipientsLabel(recipients)}, in-app only.`} />

              <Button variant="accent" disabled={!subject.trim() || !body.trim() || sending} onClick={() => void send()}>
                {sending ? "Sending…" : "Send"}
              </Button>
            </>
          )}
        </div>

        <div className="overflow-hidden rounded-lg border border-line bg-white">
          <header className="border-b border-line px-4 py-3">
            <h2 className="text-body font-semibold">Sent by you</h2>
          </header>
          <div>
            {sentLoading ? (
              <div className="p-4"><TableSkeleton rows={4} /></div>
            ) : !sent || sent.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">Nothing sent yet.</div>
            ) : (
              sent.map((a) => {
                const className = a.audience.kind === "class" ? classById.get(a.audience.class_id)?.name ?? "a class" : "—";
                const who = a.audience.kind === "class" ? recipientsLabel(a.audience.recipients) : "parents";
                return (
                  <div key={a.id} className="border-b border-line-soft px-4 py-3 last:border-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{a.subject}</span>
                      <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
                        {a.published_at ? new Date(a.published_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "Draft"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-ink-faint">To {who} of {className}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </>
  );
}
