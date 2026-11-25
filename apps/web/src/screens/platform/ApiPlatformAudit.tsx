import { useEffect, useState } from "react";
import {
  apiFetchPlatformAuditEvents,
  apiFetchPlatformSchools,
  userMessage,
  type PlatformAuditEventItem,
} from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { useAsync } from "../../lib/useAsync";
import { Badge, Cell, Mono, RecordsPage, type RecordsSpec } from "./RecordsPage";

const DOMAIN_PREFIXES = [
  { value: "", label: "All domains" },
  { value: "platform.", label: "Platform" },
  { value: "auth.", label: "Auth & MFA" },
  { value: "rbac.", label: "RBAC & access" },
  { value: "account.", label: "Accounts" },
  { value: "finance.", label: "Finance" },
  { value: "directory.", label: "Directory" },
  { value: "academics.", label: "Academics" },
  { value: "transport.", label: "Transport" },
] as const;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function eventDomain(eventType: string): string {
  return eventType.split(".")[0] ?? "platform";
}

/**
 * Platform Audit trail on the new API (`GET /v1/platform/audit-events`, slice P5 of PLATFORM-CONSOLE.md).
 *
 * Shows newest-first security audit events across all schools (never IP addresses or free-text detail).
 * Reading the platform audit log is itself audited (`platform.audit.read`). Retention policy is pending Q5.
 */
export function ApiPlatformAudit() {
  const { data: schools } = useAsync(() => apiFetchPlatformSchools(), []);
  const [schoolId, setSchoolId] = useState("");
  const [eventPrefix, setEventPrefix] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [events, setEvents] = useState<PlatformAuditEventItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void apiFetchPlatformAuditEvents({
      schoolId: schoolId || undefined,
      eventPrefix: eventPrefix || undefined,
      limit: 100,
    })
      .then((res) => {
        if (!alive) return;
        setEvents(res.items);
        setNextCursor(res.nextCursor);
        setLoading(false);
      })
      .catch((err) => {
        if (!alive) return;
        setError(userMessage(err));
        setLoading(false);
      });
    return () => { alive = false; };
  }, [schoolId, eventPrefix, reloadKey]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await apiFetchPlatformAuditEvents({
        schoolId: schoolId || undefined,
        eventPrefix: eventPrefix || undefined,
        limit: 100,
        cursor: nextCursor,
      });
      setEvents((prev) => [...prev, ...res.items]);
      setNextCursor(res.nextCursor);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const emptySpec: RecordsSpec = {
    eyebrow: "Platform · security",
    title: "Audit trail",
    blurb: "Security audit events across all schools. Reading this log is itself audited.",
    stats: [],
    columns: [],
    rows: [],
  };

  if (loading && events.length === 0) return <RecordsPage spec={emptySpec} loading />;
  if (error && events.length === 0) return <RecordsPage spec={emptySpec} error={error} />;

  const uniqueSchools = new Set(events.map((e) => e.schoolId).filter(Boolean)).size;
  const platformScoped = events.filter((e) => !e.schoolId).length;
  const denials = events.filter((e) => /[._]denied$/.test(e.eventType)).length;

  const spec: RecordsSpec = {
    eyebrow: "Platform · security",
    title: "Audit trail",
    blurb:
      "Newest-first audit events from GET /v1/platform/audit-events (event type, time, school and actor only — " +
      "IP addresses and detail payloads are never returned). Each read is audited.",
    actions: [{ label: loading ? "Refreshing…" : "Refresh", primary: true, onClick: () => setReloadKey((k) => k + 1) }],
    stats: [
      { label: "Loaded events", value: String(events.length), sub: nextCursor ? "more available" : "end of range" },
      { label: "Schools in view", value: String(uniqueSchools), sub: `${platformScoped} platform-wide events` },
      { label: "Permission denials", value: String(denials), sub: "in loaded window", alarming: denials > 0 },
    ],
    extra: (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-white px-4 py-3">
        <label className="flex items-center gap-2 text-small">
          <span className="text-ink-muted">School</span>
          <select
            value={schoolId}
            onChange={(e) => setSchoolId(e.target.value)}
            aria-label="Filter by school"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
          >
            <option value="">All schools</option>
            {(schools ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-small">
          <span className="text-ink-muted">Domain</span>
          <select
            value={eventPrefix}
            onChange={(e) => setEventPrefix(e.target.value)}
            aria-label="Filter by event domain"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
          >
            {DOMAIN_PREFIXES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        {nextCursor && (
          <div className="ml-auto">
            <Button onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load older events"}
            </Button>
          </div>
        )}
      </div>
    ),
    columns: [
      { key: "when", header: "When", width: "1.1fr" },
      { key: "domain", header: "Domain", width: "0.8fr" },
      { key: "event", header: "Event", width: "1.8fr" },
      { key: "school", header: "School", width: "1.2fr" },
      { key: "actor", header: "Actor", width: "1.2fr" },
    ],
    minWidth: "780px",
    empty: {
      title: "No audit events match these filters",
      body: "Clear the school or domain filter to see all recorded events.",
    },
    rows: events.map((e) => {
      const domain = eventDomain(e.eventType);
      const isDenial = /[._]denied$/.test(e.eventType);
      return {
        id: e.id,
        tags: [domain],
        cells: [
          <Mono key="t">{formatTimestamp(e.occurredAt)}</Mono>,
          <Badge key="d" tone={isDenial ? "warn" : "muted"}>{domain}</Badge>,
          <Mono key="ev">{e.eventType}</Mono>,
          <Cell key="sc">{e.schoolName ?? "Platform"}</Cell>,
          <Cell key="ac">{e.actorName ?? e.actorUserId ?? "System"}</Cell>,
        ],
      };
    }),
  };

  return <RecordsPage spec={spec} />;
}
