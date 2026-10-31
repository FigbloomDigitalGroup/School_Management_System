import { useMemo, useState } from "react";
import {
  ACTIVITY_CATEGORY_LABEL, AWARD_LABEL, EVENT_KIND_LABEL, EVENT_LEVEL_LABEL, EVENT_STATUS_LABEL, OUTCOME_LABEL,
  addActivityMembers, createActivity, deleteActivity, deleteActivityEvent, eventResultLabel, eventToForm,
  fetchActiveLearners, fetchActivities, fetchActivityEvents, fetchActivityMembers, fetchEventParticipants, fetchMemberCounts,
  fetchMyPatronActivityIds, fetchTeachers, formatEventWhen, notifyEventFamilies, removeActivityMember, saveActivityEvent,
  saveParticipantResult, setActivityPatrons, setEventParticipants, setMemberRole, splitEvents, updateActivity,
  validateActivity, validateEvent,
  type ActivityCategory, type ActivityEventRow, type ActivityRow, type Award, type EventForm, type EventKind,
  type EventLevel, type EventOutcome, type EventStatus, type LearnerOption, type ParticipantRow,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { confirmDialog } from "../../components/ui/Confirm";

const options = <K extends string>(labels: Record<K, string>) =>
  (Object.keys(labels) as K[]).map((k) => ({ value: k, label: labels[k] }));

/**
 * Sports, clubs, societies, music and drama. The office keeps the list of
 * activities and picks their patrons; a patron (admin=false) sees only the
 * activities they run and keeps the members, the fixtures and competitions,
 * and the results. Learners and parents see theirs under Sports & activities.
 */
export function Activities({ admin = false }: { admin?: boolean }) {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);
  const [editingActivity, setEditingActivity] = useState<{ activity?: ActivityRow } | null>(null);
  const [editingEvent, setEditingEvent] = useState<{ event?: ActivityEventRow } | null>(null);
  const [results, setResults] = useState<ActivityEventRow | null>(null);
  const [filter, setFilter] = useState("");

  const { data, loading, error } = useAsync(async () => {
    const [activities, events, counts, mine] = await Promise.all([
      fetchActivities(tenant.id),
      fetchActivityEvents(tenant.id),
      fetchMemberCounts(tenant.id),
      admin ? Promise.resolve(null) : fetchMyPatronActivityIds(profile.id),
    ]);
    const visible = mine ? activities.filter((a) => mine.has(a.id)) : activities;
    const ids = new Set(visible.map((a) => a.id));
    return { activities: visible, events: events.filter((e) => ids.has(e.activityId)), counts };
  }, [tenant.id, profile.id, admin, reloadKey]);

  const activities = useMemo(() => data?.activities ?? [], [data]);
  const byId = useMemo(() => new Map(activities.map((a) => [a.id, a])), [activities]);
  const { upcoming, past } = useMemo(
    () => splitEvents((data?.events ?? []).filter((e) => !filter || e.activityId === filter)),
    [data, filter],
  );
  const running = activities.filter((a) => a.active);

  async function removeEvent(e: ActivityEventRow) {
    if (!(await confirmDialog({ title: `Delete "${e.title}"?`, body: "Its participants and results go with it.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await deleteActivityEvent(e.id);
      toast("Event deleted");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete it.", "error");
    }
  }

  async function notify(e: ActivityEventRow) {
    const name = byId.get(e.activityId)?.name ?? "Activity";
    if (e.notifiedAt && !(await confirmDialog({ title: "Tell the families again?", body: "They were already told about this event.", confirmLabel: "Send again" }))) return;
    try {
      const { reached, pushError } = await notifyEventFamilies({ tenantId: tenant.id, authorId: profile.id, event: e, activityName: name });
      if (!reached) toast("Nobody to tell yet. Add the learners taking part first.", "error");
      else if (pushError) toast(`Sent to ${reached} in their inbox, but the phone notification failed: ${pushError}`, "error");
      else toast(`Sent to ${reached} ${reached === 1 ? "person" : "people"}: the learners taking part and their parents.`);
      reload();
    } catch (err) {
      toast(err instanceof Error ? `Could not send: ${err.message}` : "Could not send.", "error");
    }
  }

  const eventColumns = (withResult: boolean) => [
    { key: "event", header: "Event", width: "2fr", render: (e: ActivityEventRow) => (
      <Cell sub={[byId.get(e.activityId)?.name, EVENT_KIND_LABEL[e.kind], e.level ? EVENT_LEVEL_LABEL[e.level] : ""].filter(Boolean).join(" · ")}>{e.title}</Cell>
    ) },
    { key: "when", header: "When and where", width: "1.6fr", render: (e: ActivityEventRow) => (
      <Cell sub={[e.venue, e.opponent && `vs ${e.opponent}`].filter(Boolean).join(" · ") || undefined}>{formatEventWhen(e)}</Cell>
    ) },
    withResult
      ? { key: "result", header: "Result", width: "1fr", render: (e: ActivityEventRow) => (
          e.status === "cancelled" ? <Badge tone="muted">Cancelled</Badge>
            : e.status === "completed" ? <Mono>{eventResultLabel(e) || "Done"}</Mono>
            : <Badge tone="warn">No result yet</Badge>
        ) }
      : { key: "told", header: "Families", width: "0.9fr", render: (e: ActivityEventRow) => (
          e.notifiedAt ? <Badge tone="ok">Told</Badge> : <Badge tone="muted">Not told</Badge>
        ) },
    { key: "actions", header: "", align: "right" as const, width: "2.3fr", render: (e: ActivityEventRow) => (
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={() => setEditingEvent({ event: e })}>Edit</Button>
        <Button onClick={() => setResults(e)}>{withResult ? "Results" : "Who's going"}</Button>
        {!withResult && <Button onClick={() => void notify(e)}>Tell families</Button>}
        <Button onClick={() => void removeEvent(e)}>Delete</Button>
      </div>
    ) },
  ];

  return (
    <>
      <PageHead
        eyebrow="Sports & activities"
        title="Sports & activities"
        blurb={admin
          ? "Clubs, teams, societies, music and drama: who runs them, who's in them, their fixtures and competitions, and what they won."
          : "The activities you're patron of: members, fixtures and competitions, and results. The office adds activities and patrons."}
        actions={
          <>
            {admin && <Button onClick={() => setEditingActivity({})}>Add activity</Button>}
            <Button variant="accent" disabled={!running.length} onClick={() => setEditingEvent({})}>Add event</Button>
          </>
        }
      />

      <div className="grid gap-6 px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the activities: {error.message}
          </p>
        ) : loading && !data ? (
          <TableSkeleton rows={4} />
        ) : activities.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState
              title="No activities yet"
              body={admin
                ? "Add the school's clubs, teams and societies, and pick a patron for each. Patrons can then run them from their own console."
                : "You aren't the patron of any activity yet. The school office adds activities and their patrons."}
              action={admin ? <Button variant="accent" onClick={() => setEditingActivity({})}>Add activity</Button> : undefined}
            />
          </div>
        ) : (
          <>
            <DataTable
              title={admin ? "Activities" : "My activities"}
              columns={[
                { key: "name", header: "Activity", width: "1.6fr", render: (a: ActivityRow) => <Cell sub={ACTIVITY_CATEGORY_LABEL[a.category]}>{a.name}</Cell> },
                { key: "patrons", header: "Patrons", width: "1.4fr", render: (a: ActivityRow) => (
                  <span className="text-[13px]">{a.patrons.map((p) => p.name).join(", ") || <span className="text-ink-faint">None yet</span>}</span>
                ) },
                { key: "members", header: "Members", width: "0.7fr", render: (a: ActivityRow) => <Mono>{data?.counts.get(a.id) ?? 0}</Mono> },
                { key: "meets", header: "Meets", width: "1.4fr", render: (a: ActivityRow) => <span className="text-[12.5px] text-ink-muted">{a.meetingSchedule || "Not set"}</span> },
                { key: "state", header: "", width: "0.7fr", render: (a: ActivityRow) => (a.active ? <Badge tone="ok">Running</Badge> : <Badge tone="muted">Closed</Badge>) },
                { key: "actions", header: "", align: "right", width: "0.8fr", render: (a: ActivityRow) => <Button onClick={() => setEditingActivity({ activity: a })}>Manage</Button> },
              ]}
              rows={activities}
              rowKey={(a) => a.id}
              minWidth="900px"
              empty={{ title: "No activities yet", body: "Add the first one." }}
            />

            <DataTable
              title="Coming up"
              filters={activities.length > 1 ? (
                <select aria-label="Show events for" value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border border-[#D3DAD5] px-2.5 py-1.5 text-[12.5px]">
                  <option value="">All activities</option>
                  {activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              ) : undefined}
              columns={eventColumns(false)}
              rows={upcoming}
              rowKey={(e) => e.id}
              minWidth="980px"
              empty={{ title: "Nothing coming up", body: "Add a fixture, competition, trip or performance, then tell the families of the learners taking part." }}
            />

            <DataTable
              title="Results and past events"
              columns={eventColumns(true)}
              rows={past}
              rowKey={(e) => e.id}
              minWidth="980px"
              empty={{ title: "No past events", body: "Once an event has happened, record the result and what each learner won here." }}
            />
          </>
        )}
      </div>

      {editingActivity && (
        <ActivityEditor
          admin={admin}
          activity={editingActivity.activity}
          onClose={() => { setEditingActivity(null); reload(); }}
          onSaved={(msg) => { toast(msg); reload(); }}
        />
      )}
      {editingEvent && (
        <EventEditor
          event={editingEvent.event}
          activities={editingEvent.event ? activities : running}
          onClose={() => setEditingEvent(null)}
          onSaved={(msg, saved) => {
            toast(msg);
            setEditingEvent(null);
            reload();
            // a new event goes straight on to who's taking part
            if (saved) setResults(saved);
          }}
        />
      )}
      {results && (
        <ParticipantsEditor
          event={results}
          activityName={byId.get(results.activityId)?.name ?? "Activity"}
          onClose={() => { setResults(null); reload(); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- activity

function ActivityEditor({ admin, activity, onClose, onSaved }: {
  admin: boolean;
  activity?: ActivityRow;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [name, setName] = useState(activity?.name ?? "");
  const [category, setCategory] = useState<ActivityCategory>(activity?.category ?? "sport");
  const [description, setDescription] = useState(activity?.description ?? "");
  const [meetingSchedule, setMeetingSchedule] = useState(activity?.meetingSchedule ?? "");
  const [patronIds, setPatronIds] = useState<string[]>(activity?.patrons.map((p) => p.id) ?? []);
  // what's saved, so a second save in the same sitting diffs against it rather than the list it opened with
  const [savedPatronIds, setSavedPatronIds] = useState<string[]>(activity?.patrons.map((p) => p.id) ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const { data: teachers } = useAsync(() => (admin ? fetchTeachers(tenant.id) : Promise.resolve([])), [admin, tenant.id]);

  async function save() {
    const checked = validateActivity({ name, category, description, meetingSchedule });
    if (!checked.ok) { setError(checked.message); return; }
    setError("");
    setSaving(true);
    try {
      if (activity) {
        // a patron sends only what they may change; the database holds the rest to the office
        await updateActivity(activity.id, admin ? checked.value : { description: checked.value.description, meetingSchedule: checked.value.meetingSchedule });
        if (admin) {
          await setActivityPatrons(tenant.id, activity.id, savedPatronIds, patronIds);
          setSavedPatronIds(patronIds);
        }
        onSaved("Activity saved");
      } else {
        const id = await createActivity(tenant.id, checked.value);
        await setActivityPatrons(tenant.id, id, [], patronIds);
        onSaved(`${checked.value.name} added`);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!activity) return;
    if (activity.active && !(await confirmDialog({ title: `Close ${activity.name}?`, body: "It stays on learners' records but no new events can be added.", confirmLabel: "Close activity" }))) return;
    try {
      await updateActivity(activity.id, { active: !activity.active });
      toast(activity.active ? `${activity.name} closed` : `${activity.name} is running again`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change that.", "error");
    }
  }

  async function remove() {
    if (!activity || !(await confirmDialog({ title: `Delete ${activity.name} for good?`, body: "Its members, events and every learner's results from it are deleted too. To keep the record, close it instead.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await deleteActivity(activity.id);
      toast(`${activity.name} deleted`);
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete it.", "error");
    }
  }

  const togglePatron = (id: string) => setPatronIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={activity ? ACTIVITY_CATEGORY_LABEL[activity.category] : "Sports & activities"}
      title={activity ? activity.name : "Add activity"}
      width={720}
      actions={
        <>
          {activity && admin && <Button onClick={() => void remove()}>Delete</Button>}
          {activity && admin && <Button onClick={() => void toggleActive()}>{activity.active ? "Close activity" : "Reopen"}</Button>}
          <Button onClick={onClose}>{activity ? "Done" : "Cancel"}</Button>
          <Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : activity ? "Save details" : "Add activity"}</Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
          <TextField id="act-name" label="Name" placeholder="e.g. Football (boys), Drama club, Choir" value={name} disabled={saving || !admin} onChange={(e) => setName(e.target.value)} />
          <SelectField id="act-category" label="Kind" value={category} disabled={saving || !admin} onChange={(e) => setCategory(e.target.value as ActivityCategory)} options={options(ACTIVITY_CATEGORY_LABEL)} />
        </div>
        <TextField id="act-meets" label="When it meets (optional)" placeholder="e.g. Tuesdays and Thursdays, 4:10 to 5:30 pm, main field" value={meetingSchedule} disabled={saving} onChange={(e) => setMeetingSchedule(e.target.value)} />
        <TextArea id="act-description" label="About (optional)" placeholder="e.g. Open to Grades 7 to 9. Training kit provided." value={description} disabled={saving} onChange={(e) => setDescription(e.target.value)} />

        {admin && (
          <fieldset>
            <legend className="mb-1.5 block text-small font-semibold">Patrons</legend>
            {!teachers ? (
              <p className="text-[12px] text-ink-faint">Loading teachers…</p>
            ) : teachers.length === 0 ? (
              <p className="text-[12px] text-ink-faint">Add teachers under Students & staff first.</p>
            ) : (
              <div className="grid max-h-[180px] gap-1 overflow-y-auto rounded-lg border border-line-soft bg-page px-3 py-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
                {teachers.map((t) => (
                  <label key={t.id} className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" checked={patronIds.includes(t.id)} disabled={saving} onChange={() => togglePatron(t.id)} />
                    {t.name}
                  </label>
                ))}
              </div>
            )}
            <p className="mt-1.5 text-[11.5px] text-ink-faint">Patrons run the activity from their own console: members, events and results.</p>
          </fieldset>
        )}

        {error && <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>}

        {activity && <MembersEditor activity={activity} />}
      </div>
    </Modal>
  );
}

function MembersEditor({ activity }: { activity: ActivityRow }) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const { data: members, loading } = useAsync(() => fetchActivityMembers(activity.id), [activity.id, reloadKey]);
  const reload = () => setReloadKey((k) => k + 1);

  async function add(ids: string[]) {
    try {
      await addActivityMembers(tenant.id, activity.id, ids);
      toast(ids.length === 1 ? "Member added" : `${ids.length} members added`);
      setAdding(false);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add them.", "error");
    }
  }

  async function remove(m: { studentId: string; name: string }) {
    if (!(await confirmDialog({ title: `Take ${m.name} out of ${activity.name}?`, confirmLabel: "Remove" }))) return;
    try {
      await removeActivityMember(activity.id, m.studentId);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove them.", "error");
    }
  }

  async function changeRole(studentId: string, role: string, was: string | null) {
    if ((role.trim() || null) === was) return;
    try {
      await setMemberRole(activity.id, studentId, role);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the role.", "error");
    }
  }

  return (
    <section className="border-t border-line-soft pt-3.5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-small font-semibold">Members{members ? ` · ${members.length}` : ""}</h3>
        <Button onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "Add members"}</Button>
      </div>
      {adding && (
        <LearnerPicker
          exclude={new Set((members ?? []).map((m) => m.studentId))}
          confirmLabel="Add to activity"
          onConfirm={(ids) => void add(ids)}
        />
      )}
      {loading && !members ? (
        <p className="text-[12px] text-ink-faint">Loading members…</p>
      ) : !members?.length ? (
        <p className="text-[12.5px] text-ink-muted">No members yet.</p>
      ) : (
        <ul className="max-h-[260px] divide-y divide-line-soft overflow-y-auto rounded-lg border border-line-soft">
          {members.map((m) => (
            <li key={m.studentId} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{m.name}</span>
                <span className="block text-[11.5px] text-ink-faint">{m.className}</span>
              </span>
              <input
                aria-label={`${m.name}'s role`}
                defaultValue={m.role ?? ""}
                placeholder="Role, e.g. Captain"
                maxLength={60}
                onBlur={(e) => void changeRole(m.studentId, e.target.value, m.role)}
                className="w-[150px] rounded-md border border-[#D3DAD5] px-2 py-1 text-[12.5px]"
              />
              <Button onClick={() => void remove(m)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Search the school's learners by name, class or admission number and tick the ones to add. */
function LearnerPicker({ exclude, confirmLabel, onConfirm, suggest }: {
  exclude: Set<string>;
  confirmLabel: string;
  onConfirm: (ids: string[]) => void;
  /** e.g. the activity's members, offered with one tick-all */
  suggest?: { label: string; ids: string[] };
}) {
  const { tenant } = useTenantSession();
  const { data: learners } = useAsync(() => fetchActiveLearners(tenant.id), [tenant.id]);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (learners ?? []).filter((l) => !exclude.has(l.id));
    if (!needle) return list.slice(0, 40);
    return list.filter((l) => `${l.name} ${l.className} ${l.admissionNo}`.toLowerCase().includes(needle)).slice(0, 40);
  }, [learners, q, exclude]);

  const toggle = (l: LearnerOption) => setPicked((s) => {
    const next = new Set(s);
    if (next.has(l.id)) next.delete(l.id); else next.add(l.id);
    return next;
  });
  const suggested = (suggest?.ids ?? []).filter((id) => !exclude.has(id));

  return (
    <div className="mb-3 grid gap-2 rounded-lg border border-line-soft bg-page p-3">
      <TextField id="learner-search" label="Find learners" placeholder="Name, class or admission number" value={q} onChange={(e) => setQ(e.target.value)} />
      {suggest && suggested.length > 0 && (
        <button type="button" className="justify-self-start text-[12.5px] font-semibold text-forest hover:underline" onClick={() => setPicked((s) => new Set([...s, ...suggested]))}>
          {suggest.label} ({suggested.length})
        </button>
      )}
      {!learners ? (
        <p className="text-[12px] text-ink-faint">Loading learners…</p>
      ) : (
        <div className="grid max-h-[200px] gap-1 overflow-y-auto">
          {matches.map((l) => (
            <label key={l.id} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l)} />
              <span className="min-w-0 truncate">{l.name}</span>
              <span className="shrink-0 text-[11.5px] text-ink-faint">{l.className} · {l.admissionNo}</span>
            </label>
          ))}
          {matches.length === 0 && <p className="text-[12px] text-ink-faint">No learners match.</p>}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!picked.size} onClick={() => onConfirm([...picked])}>
          {confirmLabel}{picked.size ? ` (${picked.size})` : ""}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- event

const BLANK_EVENT = (activityId: string): EventForm => ({
  activityId, title: "", kind: "fixture", level: "", date: "", startTime: "", endTime: "", venue: "", opponent: "",
  status: "scheduled", score: "", outcome: "", position: "", notes: "",
});

function EventEditor({ event, activities, onClose, onSaved }: {
  event?: ActivityEventRow;
  activities: ActivityRow[];
  onClose: () => void;
  /** saved: the new event, to go on to who's taking part; null after an edit */
  onSaved: (message: string, saved: ActivityEventRow | null) => void;
}) {
  const { tenant } = useTenantSession();
  const [f, setF] = useState<EventForm>(event ? eventToForm(event) : BLANK_EVENT(activities[0]?.id ?? ""));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof EventForm>(k: K, v: EventForm[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    const checked = validateEvent(f);
    if (!checked.ok) { setError(checked.message); return; }
    setError("");
    setSaving(true);
    try {
      const id = await saveActivityEvent(tenant.id, checked.value, event?.id);
      if (event) onSaved("Event saved", null);
      else onSaved("Event added. Now pick the learners taking part.", { ...checked.value, id, notifiedAt: null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  const done = f.status === "completed";

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Sports & activities"
      title={event ? "Edit event" : "Add event"}
      width={700}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : event ? "Save" : "Add event"}</Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SelectField id="ev-activity" label="Activity" value={f.activityId} disabled={saving || !!event} onChange={(e) => set("activityId", e.target.value)}
            options={activities.map((a) => ({ value: a.id, label: a.name }))} />
          <SelectField id="ev-kind" label="Kind" value={f.kind} disabled={saving} onChange={(e) => set("kind", e.target.value as EventKind)} options={options(EVENT_KIND_LABEL)} />
        </div>
        <TextField id="ev-title" label="Title" placeholder="e.g. Football vs Kakamega School, County music festival" value={f.title} disabled={saving} onChange={(e) => set("title", e.target.value)} />
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1.2fr 1fr 1fr" }}>
          <TextField id="ev-date" label="Date" type="date" value={f.date} disabled={saving} onChange={(e) => set("date", e.target.value)} />
          <TextField id="ev-start" label="Starts" type="time" value={f.startTime} disabled={saving} onChange={(e) => set("startTime", e.target.value)} />
          <TextField id="ev-end" label="Ends (optional)" type="time" value={f.endTime} disabled={saving} onChange={(e) => set("endTime", e.target.value)} />
        </div>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <TextField id="ev-venue" label="Venue (optional)" placeholder="e.g. Bukhungu Stadium" value={f.venue} disabled={saving} onChange={(e) => set("venue", e.target.value)} />
          <TextField id="ev-opponent" label="Against or hosted by (optional)" placeholder="e.g. Kakamega School" value={f.opponent} disabled={saving} onChange={(e) => set("opponent", e.target.value)} />
        </div>
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SelectField id="ev-level" label="Level" value={f.level} disabled={saving} onChange={(e) => set("level", e.target.value as EventLevel | "")}
            options={[{ value: "", label: "Not applicable" }, ...options(EVENT_LEVEL_LABEL)]} />
          <SelectField id="ev-status" label="Status" value={f.status} disabled={saving} onChange={(e) => set("status", e.target.value as EventStatus)} options={options(EVENT_STATUS_LABEL)} />
        </div>
        {done && (
          <div className="grid gap-3.5 rounded-lg border border-line-soft bg-page p-3" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <SelectField id="ev-outcome" label="Outcome" value={f.outcome} disabled={saving} onChange={(e) => set("outcome", e.target.value as EventOutcome | "")}
              options={[{ value: "", label: "Not a match" }, ...options(OUTCOME_LABEL)]} />
            <TextField id="ev-score" label="Score (optional)" placeholder="e.g. 2-1, 45 points" value={f.score} disabled={saving} onChange={(e) => set("score", e.target.value)} />
            <TextField id="ev-position" label="Team's place (optional)" placeholder="e.g. 1" inputMode="numeric" value={f.position} disabled={saving} onChange={(e) => set("position", e.target.value)} />
          </div>
        )}
        <TextArea id="ev-notes" label="Notes (optional)" placeholder="e.g. Bus leaves at 12:30. Bring games kit and a packed lunch." value={f.notes} disabled={saving} onChange={(e) => set("notes", e.target.value)} />
        {error && <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- participants & results

function ParticipantsEditor({ event, activityName, onClose }: { event: ActivityEventRow; activityName: string; onClose: () => void }) {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const reload = () => setReloadKey((k) => k + 1);
  const { data: participants, loading } = useAsync(() => fetchEventParticipants(event.id), [event.id, reloadKey]);
  const { data: members } = useAsync(() => fetchActivityMembers(event.activityId), [event.activityId]);
  const done = event.status === "completed";

  async function add(ids: string[]) {
    try {
      const current = (participants ?? []).map((p) => p.studentId);
      await setEventParticipants(tenant.id, event.id, current, [...current, ...ids]);
      setAdding(false);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not add them.", "error");
    }
  }

  async function remove(p: ParticipantRow) {
    try {
      const current = (participants ?? []).map((x) => x.studentId);
      await setEventParticipants(tenant.id, event.id, current, current.filter((id) => id !== p.studentId));
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not remove them.", "error");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow={`${activityName} · ${formatEventWhen(event)}`}
      title={event.title}
      blurb={done
        ? "Who took part, and what each learner won. Medals, places and awards show on the learner's record for their family."
        : "Who's taking part. Use Tell families on the event to send the details to these learners and their parents."}
      width={760}
      actions={<Button variant="accent" onClick={onClose}>Done</Button>}
    >
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-small font-semibold">{done ? "Took part" : "Taking part"}{participants ? ` · ${participants.length}` : ""}</h3>
          <Button onClick={() => setAdding((a) => !a)}>{adding ? "Close" : "Add learners"}</Button>
        </div>
        {adding && (
          <LearnerPicker
            exclude={new Set((participants ?? []).map((p) => p.studentId))}
            confirmLabel="Add"
            suggest={members?.length ? { label: `Tick every member of ${activityName}`, ids: members.map((m) => m.studentId) } : undefined}
            onConfirm={(ids) => void add(ids)}
          />
        )}
        {loading && !participants ? (
          <p className="text-[12px] text-ink-faint">Loading…</p>
        ) : !participants?.length ? (
          <p className="text-[12.5px] text-ink-muted">No learners added yet.</p>
        ) : (
          <ul className="max-h-[380px] divide-y divide-line-soft overflow-y-auto rounded-lg border border-line-soft">
            {participants.map((p) => (
              <ParticipantLine key={p.studentId} eventId={event.id} p={p} withResult={done} onRemove={() => void remove(p)} onSaved={reload} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function ParticipantLine({ eventId, p, withResult, onRemove, onSaved }: {
  eventId: string; p: ParticipantRow; withResult: boolean; onRemove: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const [award, setAward] = useState<Award | "">(p.award ?? "");
  const [position, setPosition] = useState(p.position ? String(p.position) : "");
  const [achievement, setAchievement] = useState(p.achievement ?? "");
  const [saving, setSaving] = useState(false);
  const dirty = award !== (p.award ?? "") || position !== (p.position ? String(p.position) : "") || achievement !== (p.achievement ?? "");

  async function save() {
    const place = position.trim() ? Number(position.trim()) : null;
    if (place !== null && (!Number.isInteger(place) || place < 1 || place > 1000)) {
      toast("Place is a number like 1, 2 or 3.", "error");
      return;
    }
    setSaving(true);
    try {
      await saveParticipantResult(eventId, p.studentId, { award: award || null, position: place, achievement });
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="grid gap-2 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">{p.name}</span>
          <span className="block text-[11.5px] text-ink-faint">{p.className}</span>
        </span>
        <Button onClick={onRemove}>Remove</Button>
      </div>
      {withResult && (
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={`${p.name}'s award`} value={award} onChange={(e) => setAward(e.target.value as Award | "")} className="rounded-md border border-[#D3DAD5] px-2 py-1 text-[12.5px]">
            <option value="">No award</option>
            {options(AWARD_LABEL).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input aria-label={`${p.name}'s place`} inputMode="numeric" placeholder="Place" value={position} onChange={(e) => setPosition(e.target.value)}
            className="w-[70px] rounded-md border border-[#D3DAD5] px-2 py-1 text-[12.5px]" />
          <input aria-label={`${p.name}'s achievement`} placeholder="e.g. 400 m, Best actor, Top scorer" maxLength={160} value={achievement} onChange={(e) => setAchievement(e.target.value)}
            className="min-w-[180px] flex-1 rounded-md border border-[#D3DAD5] px-2 py-1 text-[12.5px]" />
          <Button disabled={!dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      )}
    </li>
  );
}
