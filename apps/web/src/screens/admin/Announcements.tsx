import { useRef, useState } from "react";
import {
  announcementAudience, announcementReach, AUDIENCE_CHOICES, CHANNEL_OPTIONS, DEFAULT_CHANNELS, fetchAnnouncementsData, formatMoney,
  insertAnnouncement, publishAnnouncement, RECIPIENT_OPTIONS, removeAttachmentFilesFor, requireAttachmentSignatures, sendAnnouncementPush, smsCostCents,
  supabase, yearLabel,
  type AudienceChoice, type AudienceRecipients, type ChannelFlags,
} from "@figbloom/shared";
import { AiWriteHelper } from "../../components/AiWriteHelper";
import { AttachmentPicker } from "../../components/AttachmentPicker";
import { MessageSignatureStatus, NeedsSignatureToggle } from "../../components/signatures/SignatureStatus";
import { PageHead } from "../../components/ConsoleShell";
import { Button } from "../../components/ui/Button";
import { TextArea, TextField } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { saveAttachments, UploadCancelled, type AttachmentBatch, type BatchProgress, type WebMediaDraft } from "../../lib/resumableUpload";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

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
  const [recipients, setRecipients] = useState<AudienceRecipients>("both");
  const [pickedYear, setPickedYear] = useState<string | null>(null);
  const yearGroup = data ? (data.years.find((y) => y.key === pickedYear) ?? data.years[0] ?? null) : null;
  const formLevel = yearGroup?.key ?? "";
  const [classId, setClassId] = useState("");
  const [channels, setChannels] = useState<ChannelFlags>(DEFAULT_CHANNELS);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [drafts, setDrafts] = useState<WebMediaDraft[]>([]);
  const [needsSignature, setNeedsSignature] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const batch = useRef<AttachmentBatch | null>(null);

  const effectiveClassId = classId || data?.classes[0]?.id || "";
  const reachFor = (id: AudienceChoice): number => (data ? announcementReach(data, id, recipients, formLevel, effectiveClassId) : 0);
  const reach = reachFor(audienceId);

  const smsCost = channels.sms ? smsCostCents(reach) : 0;

  async function submit(publish: boolean) {
    if (!subject.trim() || !body.trim()) return;
    if (audienceId === "class" && !effectiveClassId) { toast("Pick a class first.", "error"); return; }
    setSending(true);
    // With files, the notice goes in as a draft, the files go up, and only
    // then is it published: nobody gets a notice whose attachments are missing.
    const withFiles = drafts.length > 0;
    let createdId: string | null = null;
    try {
      const announcementId = await insertAnnouncement(
        tenant.id,
        profile.id,
        { subject, body, audience: announcementAudience(audienceId, recipients, yearGroup, effectiveClassId), channels },
        publish && !withFiles,
      );
      createdId = announcementId;
      if (withFiles) {
        batch.current = saveAttachments(tenant.id, "announcement", announcementId, drafts, setProgress);
        await batch.current.done;
        // before it goes out: sending is what asks the families to sign
        if (needsSignature) await requireAttachmentSignatures(announcementId);
        if (publish) await publishAnnouncement(announcementId);
      }
      createdId = null;
      toast(publish ? `Sent to ${reach.toLocaleString()} people` : "Saved as a draft");

      if (publish && channels.push) {
        await sendAnnouncementPush(announcementId).catch((pushErr: Error) => toast(`Sent, but push notifications failed: ${pushErr.message}`, "error"));
      }

      setSubject("");
      setBody("");
      setDrafts([]);
      setNeedsSignature(false);
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
              {AUDIENCE_CHOICES.map((a) => {
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
              return AUDIENCE_CHOICES.find((a) => a.id === audienceId)?.label.toLowerCase() ?? "the whole school";
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
          {drafts.some((d) => d.type === "file") && <NeedsSignatureToggle checked={needsSignature} onChange={setNeedsSignature} disabled={sending} />}
        </div>

        <aside className="grid content-start gap-4">
          <fieldset className="rounded-xl border border-line p-4">
            <legend className="px-1 text-small font-semibold">How it goes out</legend>
            {CHANNEL_OPTIONS.map(({ key, label, note }) => (
              <label key={key} className="flex items-start gap-2.5 border-b border-line-soft py-2.5 last:border-0">
                <input type="checkbox" checked={channels[key]}
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
              <div className="flex justify-between"><dt className="text-ink-muted">SMS cost</dt><dd className="font-mono">{channels.sms && loading && !data ? <Skeleton className="h-3 w-16" /> : formatMoney(smsCost, tenant.country)}</dd></div>
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
                    <MessageSignatureStatus announcementId={a.id} />
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
