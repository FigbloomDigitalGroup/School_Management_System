import { useState } from "react";
import {
  daysFromToday, doneByWords, dueWords, fetchAttachments, HAND_IN_PARENT_LABEL, loadParentHomework, minutesWords, setHomeworkDone,
  splitHomework, type HomeworkItem, type MediaItem,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { MediaList } from "../../components/Media";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useParentData } from "../../lib/parentContext";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { ChildSwitcher } from "./ChildSwitcher";

/**
 * The selected child's homework from the last three weeks: what's overdue,
 * what's coming up, what's done. Each piece shows the teacher's note for
 * parents (what it's about, what the child needs, how to help, what to
 * avoid, how long). A parent of a PP1–Grade 3 learner can tick it done for
 * them; an older learner ticks their own, so a parent only sees the status.
 */
export function ParentHomework() {
  const toast = useToast();
  const { profile } = useTenantSession();
  const { children, child, loading: kidsLoading } = useParentData();
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const ids = children.map((c) => c.id);
  const { data, loading, error } = useAsync(() => loadParentHomework(profile.id, ids), [profile.id, ids.join(","), reloadKey]);

  const mine = child ? data?.[child.id] : undefined;
  // Worksheets and videos the teacher attached, for every card on screen in one query.
  const itemIds = (mine?.items ?? []).map((i) => i.id);
  const { data: files } = useAsync(() => fetchAttachments("homework", itemIds), [itemIds.join(",")]);
  const groups = splitHomework(mine?.items ?? []);

  async function mark(item: HomeworkItem, done: boolean) {
    if (!child) return;
    setBusy(item.id);
    try {
      await setHomeworkDone(item.id, child.id, done);
      toast(done ? `Marked done. ${item.teacher} can see it.` : "No longer marked done.");
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not save that: ${err.message}` : "Could not save that.", "error");
    } finally {
      setBusy(null);
    }
  }

  const total = groups.overdue.length + groups.upcoming.length;

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Homework"}
        title={child ? `${child.first}'s homework` : "Homework"}
        blurb={
          child && mine
            ? `${total === 0 ? "Nothing to do right now." : `${total} still to do.`} ${mine.parentMarksDone ? `You can mark work done for ${child.first}.` : `${child.first} marks their own work done.`}`
            : undefined
        }
        actions={<ChildSwitcher />}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load homework: {error.message}
          </p>
        ) : kidsLoading || (loading && !data) ? (
          <div className="grid gap-3">
            <Skeleton className="h-28 rounded-lg" />
            <Skeleton className="h-28 rounded-lg" />
          </div>
        ) : !child ? (
          <EmptyState title="No child linked" body="This account is not yet linked to a learner. Contact the school office." />
        ) : !mine || mine.items.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState title="No homework yet" body={`Homework ${child.first}'s teachers set will show here, with a note on how you can help.`} />
          </div>
        ) : (
          <div className="grid max-w-[760px] gap-6">
            {([
              ["Overdue", groups.overdue],
              ["Coming up", groups.upcoming],
              ["Done", groups.done],
            ] as const).map(([label, items]) => items.length > 0 && (
              <section key={label}>
                <h2 className="mb-2.5 font-mono text-micro tracking-[0.12em] text-ink-faint">{label.toUpperCase()} · {items.length}</h2>
                <div className="grid gap-3">
                  {items.map((item) => (
                    <HomeworkCard
                      key={item.id}
                      item={item}
                      files={files?.get(item.id) ?? []}
                      childFirst={child.first}
                      canMark={mine.parentMarksDone}
                      busy={busy === item.id}
                      onMark={(done) => void mark(item, done)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function HomeworkCard({ item, files, childFirst, canMark, busy, onMark }: {
  item: HomeworkItem;
  files: MediaItem[];
  childFirst: string;
  canMark: boolean;
  busy: boolean;
  onMark: (done: boolean) => void;
}) {
  const g = item.guide;
  const overdue = !item.done && daysFromToday(item.dueOn) < 0;
  const time = minutesWords(g?.minutes);

  return (
    <article className="rounded-lg border border-line bg-white p-5" style={{ borderColor: overdue ? "#F0C9AE" : undefined }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold leading-snug tracking-tight">{item.title}</h3>
          <div className="mt-0.5 text-[12.5px] text-ink-faint">{item.subject} · {item.teacher}</div>
        </div>
        {item.done ? <Badge tone="ok">Done</Badge> : <Badge tone={overdue ? "warn" : "muted"}>{dueWords(item.dueOn)}</Badge>}
      </div>

      {item.body && <p className="mt-3 whitespace-pre-line text-[13px] leading-relaxed text-ink">{item.body}</p>}

      {files.length > 0 && <div className="mt-3"><MediaList items={files} heading="From the teacher" /></div>}

      {g && (
        <dl className="mt-4 grid gap-3 rounded-lg border border-line-soft bg-page px-4 py-3.5 text-[13px] leading-relaxed">
          {g.about && <GuideLine label="What it's about">{g.about}</GuideLine>}
          {g.needs.length > 0 && <GuideLine label="Your child will need">{g.needs.join(", ")}</GuideLine>}
          {g.help && <GuideLine label="How you can help">{g.help}</GuideLine>}
          {g.avoid && <GuideLine label="Please avoid">{g.avoid}</GuideLine>}
          {time && <GuideLine label="Time">{time}</GuideLine>}
        </dl>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-ink-faint">{HAND_IN_PARENT_LABEL[item.handIn]}</span>
        {item.done ? (
          <div className="flex items-center gap-3">
            <span className="text-[12.5px] text-ok-ink">{doneByWords(item.doneBy, childFirst)}</span>
            {/* Only what this parent ticked can be unticked here, and never one with a file attached. */}
            {canMark && item.doneBy === "you" && !item.hasFile && (
              <Button disabled={busy} onClick={() => onMark(false)}>{busy ? "Saving…" : "Undo"}</Button>
            )}
          </div>
        ) : canMark ? (
          <Button variant="accent" disabled={busy} onClick={() => onMark(true)}>{busy ? "Saving…" : "Mark done"}</Button>
        ) : (
          <span className="text-[12px] text-ink-faint">{childFirst} marks it done when it's finished.</span>
        )}
      </div>
    </article>
  );
}

function GuideLine({ label, children }: { label: string; children: string }) {
  return (
    <div>
      <dt className="font-mono text-micro tracking-[0.1em] text-ink-faint">{label.toUpperCase()}</dt>
      <dd className="mt-0.5 whitespace-pre-line text-ink">{children}</dd>
    </div>
  );
}
