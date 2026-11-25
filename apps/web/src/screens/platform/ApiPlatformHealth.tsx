import { useState } from "react";
import { apiFetchPlatformOpsStatus, userMessage, type OpsWorkerStatus } from "@figbloom/shared";
import { useAsync } from "../../lib/useAsync";
import { Badge, Cell, Mono, RecordsPage, type RecordsSpec, type Tone } from "./RecordsPage";

const WORKER_STALE_SECONDS = 120;

function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m ago`;
}

function workerTone(w: OpsWorkerStatus): { label: string; tone: Tone; tag: string } {
  if (w.lastCycleOutcome && /error|fail/i.test(w.lastCycleOutcome)) {
    return { label: "Error", tone: "warn", tag: "attention" };
  }
  if (w.lastSeenAgeSeconds === null || w.lastSeenAgeSeconds > WORKER_STALE_SECONDS) {
    return { label: "Stale", tone: "warn", tag: "attention" };
  }
  return { label: "Healthy", tone: "ok", tag: "ok" };
}

/**
 * Platform System health on the new API (`GET /v1/platform/ops/status`, slice P2 of PLATFORM-CONSOLE.md).
 *
 * Shows live worker heartbeats, background job queue depth/lag, finance reconciliation backlog and unmatched
 * M-Pesa callback counts. Live external provider checks (M-Pesa, email, storage, Bloom) are Q7.
 */
export function ApiPlatformHealth() {
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => apiFetchPlatformOpsStatus(), [reloadKey]);

  const emptySpec: RecordsSpec = {
    eyebrow: "Platform · operations",
    title: "System health",
    blurb: "Worker heartbeats, job queue depth and finance reconciliation counters from the API.",
    stats: [],
    columns: [],
    rows: [],
  };

  if (loading && !data) return <RecordsPage spec={emptySpec} loading />;
  if (error) return <RecordsPage spec={emptySpec} error={userMessage(error)} />;
  if (!data) return <RecordsPage spec={emptySpec} loading />;

  const unhealthyWorkers = data.workers.filter((w) => workerTone(w).tag !== "ok");
  const queueAlert = data.queue.dead > 0 || (data.queue.oldestDueLagSeconds ?? 0) > WORKER_STALE_SECONDS;
  const reconAlert = data.reconciliation.escalatedOpen > 0 || data.reconciliation.openCases > 0;
  const unmatchedOpen = data.unmatchedCases ? data.unmatchedCases.open : data.unmatchedCallbacks;

  const spec: RecordsSpec = {
    eyebrow: "Platform · operations",
    title: "System health",
    blurb:
      "Live worker heartbeats, background job queue and reconciliation counters from GET /v1/platform/ops/status. " +
      "Counts and ages only — no payloads or personal data.",
    actions: [{ label: loading ? "Refreshing…" : "Refresh", primary: true, onClick: () => setReloadKey((k) => k + 1) }],
    stats: [
      {
        label: "Workers",
        value: String(data.workers.length),
        sub: data.workers.length === 0
          ? "no worker heartbeat yet"
          : unhealthyWorkers.length > 0
            ? `${unhealthyWorkers.length} stale or failing`
            : "all reporting",
        alarming: data.workers.length === 0 || unhealthyWorkers.length > 0,
      },
      {
        label: "Queue due",
        value: String(data.queue.queuedDue),
        sub: `${data.queue.dead} dead · ${data.queue.retrying} retrying · lag ${formatAge(data.queue.oldestDueLagSeconds)}`,
        alarming: queueAlert,
      },
      {
        label: "Reconciliation cases",
        value: String(data.reconciliation.openCases),
        sub: `${data.reconciliation.escalatedOpen} escalated · ${data.reconciliation.unassignedOpen} unassigned`,
        alarming: reconAlert,
      },
      {
        label: "Unmatched callbacks",
        value: String(unmatchedOpen),
        sub: data.unmatchedCases
          ? `${data.unmatchedCases.escalatedOpen} escalated · ${data.unmatchedCases.unassignedOpen} unassigned`
          : `${data.unmatchedCallbacks} recorded`,
        alarming: unmatchedOpen > 0,
      },
    ],
    extra: (
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-lg border border-line bg-white p-4">
          <h2 className="text-body font-semibold">Job queue</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-small">
            <div>
              <dt className="text-ink-faint">Due now</dt>
              <dd className="font-mono font-medium">{data.queue.queuedDue}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Scheduled future</dt>
              <dd className="font-mono font-medium">{data.queue.queuedFuture}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Leased (running)</dt>
              <dd className="font-mono font-medium">{data.queue.leased}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Retrying</dt>
              <dd className="font-mono font-medium">{data.queue.retrying}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Dead</dt>
              <dd className="font-mono font-medium">{data.queue.dead}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Oldest due lag</dt>
              <dd className="font-mono font-medium">{formatAge(data.queue.oldestDueLagSeconds)}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-white p-4">
          <h2 className="text-body font-semibold">Finance operations</h2>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-small">
            <div>
              <dt className="text-ink-faint">Open reconciliation</dt>
              <dd className="font-mono font-medium">{data.reconciliation.openCases}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Oldest reconciliation</dt>
              <dd className="font-mono font-medium">{formatAge(data.reconciliation.oldestOpenAgeSeconds)}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Unmatched callbacks</dt>
              <dd className="font-mono font-medium">{data.unmatchedCallbacks}</dd>
            </div>
            <div>
              <dt className="text-ink-faint">Oldest unmatched case</dt>
              <dd className="font-mono font-medium">{formatAge(data.unmatchedCases?.oldestOpenAgeSeconds ?? null)}</dd>
            </div>
          </dl>
        </section>
      </div>
    ),
    columns: [
      { key: "worker", header: "Worker", width: "1.5fr" },
      { key: "status", header: "Status", width: "0.9fr" },
      { key: "seen", header: "Last seen", align: "right" },
      { key: "sweep", header: "Last sweep", align: "right" },
      { key: "outcome", header: "Last cycle outcome", width: "1.4fr" },
    ],
    minWidth: "680px",
    empty: {
      title: "No worker heartbeats recorded",
      body: "Start the background worker process to see live heartbeat and sweep status here.",
    },
    rows: data.workers.map((w) => {
      const state = workerTone(w);
      return {
        id: w.worker,
        tags: [state.tag],
        cells: [
          <Cell key="w">{w.worker}</Cell>,
          <Badge key="s" tone={state.tone}>{state.label}</Badge>,
          <Mono key="seen">{formatAge(w.lastSeenAgeSeconds)}</Mono>,
          <Mono key="sweep">{formatAge(w.lastSweepAgeSeconds)}</Mono>,
          <Mono key="out">{w.lastCycleOutcome ?? "—"}</Mono>,
        ],
      };
    }),
  };

  return <RecordsPage spec={spec} />;
}
