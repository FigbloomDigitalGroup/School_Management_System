import {
  AI_HELPER_BILLING_AVAILABLE, fetchAiHelperRoster, formatMoney, rosterSummary, type AiHelperRosterRow,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Cell, DataTable, type Column } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

/**
 * The office's view of the Bloom study helper (full admins and the fees
 * area, 20261101100000_ai_helper_optin.sql): which learners have it on and
 * which parent or guardian turned it on, and how much each used it this
 * month. Only counts are kept, never the conversations. The charge column
 * appears once the helper can be billed (AI_HELPER_BILLING_AVAILABLE).
 * Changing who may use it is in School settings, for full admins.
 */
export function AdminStudyHelper() {
  const { tenant } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchAiHelperRoster(tenant.id), [tenant.id]);
  const optIn = tenant.ai_tutor_access === "opt_in";
  const summary = rosterSummary(data ?? []);

  const columns: Column<AiHelperRosterRow>[] = [
    { key: "learner", header: "Learner", width: "1.6fr", render: (r) => <Cell sub={[r.admissionNo, r.className].filter(Boolean).join(" · ")}>{r.fullName}</Cell> },
    { key: "status", header: "Study helper", width: "0.8fr", render: (r) => (
      <span className={`text-[12.5px] ${r.optInActive || !optIn ? "text-ok-ink" : "text-ink-faint"}`}>
        {!optIn ? "Every learner" : r.optInActive ? "On" : "Off"}
      </span>
    ) },
    { key: "by", header: "Turned on by", width: "1.4fr", render: (r) => (
      r.turnedOnBy
        ? <Cell sub={when(r.turnedOnAt)}>{r.turnedOnBy}</Cell>
        : <span className="text-[12.5px] text-ink-faint">{optIn ? "Not turned on" : ""}</span>
    ) },
    { key: "changed", header: "Last change", width: "1.2fr", render: (r) => (
      r.changedBy ? <Cell sub={when(r.changedAt)}>{r.changedBy}</Cell> : <span className="text-[12.5px] text-ink-faint"></span>
    ) },
    { key: "questions", header: "Questions this month", width: "0.9fr", align: "right", render: (r) => (
      <span className="font-mono text-[12.5px]">{r.questionsThisMonth.toLocaleString()}</span>
    ) },
    { key: "tokens", header: "Tokens", width: "0.8fr", align: "right", render: (r) => (
      <span className="font-mono text-[12px] text-ink-muted">{r.tokensThisMonth.toLocaleString()}</span>
    ) },
    { key: "last", header: "Last used", width: "0.9fr", render: (r) => (
      <span className="text-[12.5px] text-ink-muted">{r.lastUsedAt ? when(r.lastUsedAt) : "Not this month"}</span>
    ) },
    ...(AI_HELPER_BILLING_AVAILABLE ? [{ key: "charge", header: "This term's charge", width: "0.9fr", align: "right" as const, render: (r: AiHelperRosterRow) => (
      <span className="font-mono text-[12.5px]">{r.chargeCents != null ? formatMoney(r.chargeCents, tenant.country) : ""}</span>
    ) }] : []),
  ];

  return (
    <>
      <PageHead
        eyebrow="Bloom"
        title="Bloom study helper"
        blurb={optIn
          ? "Learners whose parent or guardian has turned on the study helper, who turned it on, and how much each used it this month. Only counts are kept, never the conversations."
          : "Every learner at the school may use the study helper. These are the learners who used it this month. Only counts are kept, never the conversations."}
      />
      <div className="px-7 py-6">
        {!tenant.ai_enabled || !tenant.ai_tutor_enabled ? (
          <p className="mb-4 max-w-[620px] rounded-lg border border-line bg-white px-4 py-3 text-[12.5px] text-ink-muted">
            The study helper is turned off for learners. A full admin can turn it on in School settings, under Bloom (AI assist).
          </p>
        ) : null}
        {error ? (
          <p className="text-[12.5px] text-warn-ink">Could not load the study helper list: {error.message}</p>
        ) : loading || !data ? (
          <TableSkeleton rows={4} />
        ) : (
          <>
            <p className="mb-3 text-[12.5px] text-ink-muted">
              {optIn && `${summary.on.toLocaleString()} ${summary.on === 1 ? "learner has" : "learners have"} it on. `}
              {summary.questions.toLocaleString()} {summary.questions === 1 ? "question" : "questions"} asked this month.
            </p>
            <DataTable
              columns={columns}
              rows={data}
              rowKey={(r) => r.studentId}
              empty={{
                title: optIn ? "No learner has it on yet" : "Nobody has used it this month",
                body: optIn
                  ? "Parents and guardians turn it on for their own children under Bloom study helper in their Figbloom app."
                  : "Learners find it under Ask Bloom in their Figbloom app.",
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
