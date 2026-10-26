import {
  ACTIVITY_CATEGORY_LABEL, EVENT_KIND_LABEL, EVENT_LEVEL_LABEL, achievementLabel, formatEventWhen, loadLearnerActivities,
} from "@figbloom/shared";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/DataTable";
import { Skeleton } from "../ui/Skeleton";
import { useAsync } from "../../lib/useAsync";

/**
 * One learner's clubs and teams, what's coming up for them, and what they've
 * won. The student's and parent's Sports & activities pages show it in full;
 * the office sees the same, compact, on the learner's record in People.
 */
export function LearnerActivitiesView({ tenantId, studentId, first, compact = false }: {
  tenantId: string;
  studentId: string;
  /** "Amani", or null for the learner themselves ("You're not in ...") */
  first: string | null;
  compact?: boolean;
}) {
  const { data, loading, error } = useAsync(() => loadLearnerActivities(tenantId, studentId), [tenantId, studentId]);

  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load activities: {error.message}
      </p>
    );
  }
  if (loading && !data) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-16 rounded-lg" />
        {!compact && <Skeleton className="h-16 rounded-lg" />}
      </div>
    );
  }
  if (!data) return null;

  const nothing = !data.clubs.length && !data.upcoming.length && !data.achievements.length;
  if (nothing) {
    const body = first
      ? `${first} isn't in any club, team or society yet. The patron adds members; ask at school if ${first} has joined one.`
      : "You aren't in any club, team or society yet. Ask the teacher who runs it to add you.";
    return compact
      ? <p className="text-[12.5px] text-ink-muted">Not in any activity yet.</p>
      : <div className="rounded-lg border border-line bg-white"><EmptyState title="No activities yet" body={body} /></div>;
  }

  return (
    <div className={compact ? "grid gap-4" : "grid max-w-[860px] gap-6"}>
      <section>
        <h2 className="mb-2.5 font-mono text-micro tracking-[0.12em] text-ink-faint">CLUBS AND TEAMS · {data.clubs.length}</h2>
        {data.clubs.length === 0 ? (
          <p className="text-[12.5px] text-ink-muted">Not a member of any yet.</p>
        ) : (
          <div className="grid gap-2.5" style={compact ? undefined : { gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {data.clubs.map(({ activity, role }) => (
              <article key={activity.id} className="rounded-lg border border-line bg-white px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[14px] font-semibold">{activity.name}</span>
                  {role && <Badge tone="info">{role}</Badge>}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-faint">{ACTIVITY_CATEGORY_LABEL[activity.category]}{activity.active ? "" : " · closed"}</div>
                {!compact && activity.meetingSchedule && <div className="mt-1.5 text-[12.5px]">Meets {activity.meetingSchedule}</div>}
                {!compact && activity.patrons.length > 0 && (
                  <div className="mt-0.5 text-[12px] text-ink-muted">Patron: {activity.patrons.map((p) => p.name).join(", ")}</div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {!compact && (
        <section>
          <h2 className="mb-2.5 font-mono text-micro tracking-[0.12em] text-ink-faint">COMING UP · {data.upcoming.length}</h2>
          {data.upcoming.length === 0 ? (
            <p className="text-[12.5px] text-ink-muted">No fixtures, competitions or trips coming up.</p>
          ) : (
            <div className="grid gap-2.5">
              {data.upcoming.map((e) => (
                <article key={e.id} className="rounded-lg border border-line bg-white px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="text-[14px] font-semibold">{e.title}</span>
                    {e.takingPart && <Badge tone="ok">{first ? `${first} is taking part` : "You're taking part"}</Badge>}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-faint">
                    {[e.activityName, EVENT_KIND_LABEL[e.kind], e.level ? EVENT_LEVEL_LABEL[e.level] : ""].filter(Boolean).join(" · ")}
                  </div>
                  <div className="mt-1.5 text-[13px]">{formatEventWhen(e)}{e.venue ? ` · ${e.venue}` : ""}</div>
                  {e.opponent && <div className="text-[12.5px] text-ink-muted">Against / hosted by {e.opponent}</div>}
                  {e.notes && <p className="mt-1.5 whitespace-pre-line text-[12.5px] leading-relaxed">{e.notes}</p>}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2.5 font-mono text-micro tracking-[0.12em] text-ink-faint">ACHIEVEMENTS · {data.achievements.length}</h2>
        {data.achievements.length === 0 ? (
          <p className="text-[12.5px] text-ink-muted">No medals or awards recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line-soft rounded-lg border border-line bg-white">
            {data.achievements.map((a) => (
              <li key={a.event.id} className="flex items-center gap-3 px-4 py-2.5">
                <span aria-hidden className="text-[16px] text-orange">★</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold">{achievementLabel(a)}</span>
                  <span className="block text-[12px] text-ink-faint">
                    {[a.event.title, a.activityName, a.event.level ? EVENT_LEVEL_LABEL[a.event.level] : "",
                      new Date(a.event.startsAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
