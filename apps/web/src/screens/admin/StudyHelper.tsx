import {
  AI_HELPER_BILLING_AVAILABLE, aiCapabilities, fetchAiHelperRoster, fetchAiHelperSettings, fetchAiStatus, formatMoney, onApi, rosterSummary, type AiHelperRosterRow,
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
  const caps = aiCapabilities();
  const { data, loading, error } = useAsync(() => fetchAiHelperRoster(tenant.id), [tenant.id]);
  // On the API build the school's switches are not on the session: the access mode and whether Bloom is on are read here.
  const { data: apiSettings, loading: settingsLoading } = useAsync(
    () => (onApi() ? fetchAiHelperSettings(tenant.id).catch(() => null) : Promise.resolve(null)),
    [tenant.id],
  );
  const { data: apiStatus, loading: statusLoading } = useAsync(
    () => (onApi() ? fetchAiStatus(tenant.id).catch(() => null) : Promise.resolve(null)),
    [tenant.id],
  );
  const optIn = onApi() ? apiSettings?.access === "opt_in" : tenant.ai_tutor_access === "opt_in";
  const helperOff = onApi()
    ? apiStatus !== null && (!apiStatus.aiEnabled || !apiStatus.tutorEnabled)
    : !tenant.ai_enabled || !tenant.ai_tutor_enabled;
  const waiting = loading || !data || (onApi() && (settingsLoading || statusLoading));
  // On the API build there is no usage to list: when every learner may use the helper, nobody's choice matters, so there is no table.
  const noList = !caps.studyHelperUsage && !optIn;
  const summary = rosterSummary(data ?? []);

  const columns: Column<AiHelperRosterRow>[] = [
    { key: "learner", header: "Learner", width: "1.6fr", render: (r) => <Cell sub={[r.admissionNo, r.className].filter(Boolean).join(" · ")}>{r.fullName}</Cell> },
    { key: "status", header: "Study helper", width: "0.8fr", render: (r) => (
      <span className={`text-[12.5px] ${r.optInActive || !optIn ? "text-ok-ink" : "text-ink-faint"}`}>
        {!optIn ? "Every learner" : r.optInActive ? "On" : "Off"}
      </span>
    ) },
    ...(caps.studyHelperUsage ? [{ key: "by", header: "Turned on by", width: "1.4fr", render: (r: AiHelperRosterRow) => (
      r.turnedOnBy
        ? <Cell sub={when(r.turnedOnAt)}>{r.turnedOnBy}</Cell>
        : <span className="text-[12.5px] text-ink-faint">{optIn ? "Not turned on" : ""}</span>
    ) }] : []),
    { key: "changed", header: "Last change", width: "1.2fr", render: (r) => (
      r.changedBy
        ? <Cell sub={when(r.changedAt)}>{r.changedBy}</Cell>
        : r.changedAt
          ? <span className="text-[12.5px] text-ink-muted">{when(r.changedAt)}</span>
          : <span className="text-[12.5px] text-ink-faint"></span>
    ) },
    ...(caps.studyHelperUsage ? [
      { key: "questions", header: "Questions this month", width: "0.9fr", align: "right" as const, render: (r: AiHelperRosterRow) => (
        <span className="font-mono text-[12.5px]">{r.questionsThisMonth.toLocaleString()}</span>
      ) },
      { key: "tokens", header: "Tokens", width: "0.8fr", align: "right" as const, render: (r: AiHelperRosterRow) => (
        <span className="font-mono text-[12px] text-ink-muted">{r.tokensThisMonth.toLocaleString()}</span>
      ) },
      { key: "last", header: "Last used", width: "0.9fr", render: (r: AiHelperRosterRow) => (
        <span className="text-[12.5px] text-ink-muted">{r.lastUsedAt ? when(r.lastUsedAt) : "Not this month"}</span>
      ) },
    ] : []),
    ...(AI_HELPER_BILLING_AVAILABLE ? [{ key: "charge", header: "This term's charge", width: "0.9fr", align: "right" as const, render: (r: AiHelperRosterRow) => (
      <span className="font-mono text-[12.5px]">{r.chargeCents != null ? formatMoney(r.chargeCents, tenant.country) : ""}</span>
    ) }] : []),
  ];

  return (
    <>
      <PageHead
        eyebrow="Bloom"
        title="Bloom study helper"
        blurb={caps.studyHelperUsage
          ? (optIn
            ? "Learners whose parent or guardian has turned on the study helper, who turned it on, and how much each used it this month. Only counts are kept, never the conversations."
            : "Every learner at the school may use the study helper. These are the learners who used it this month. Only counts are kept, never the conversations.")
          : (optIn
            ? "Learners whose parent or guardian has recorded a study helper choice for this term. Monthly usage counts are not on the new system yet."
            : "Study helper access is set to every learner. Monthly usage counts are not on the new system yet.")}
      />
      <div className="px-7 py-6">
        {helperOff ? (
          <p className="mb-4 max-w-[620px] rounded-lg border border-line bg-white px-4 py-3 text-[12.5px] text-ink-muted">
            {caps.schoolSwitch
              ? "The study helper is turned off for learners. A full admin can turn it on in School settings, under Bloom (AI assist)."
              : "The study helper is not turned on for this school yet. The new system has no switch for it yet."}
          </p>
        ) : null}
        {error ? (
          <p className="text-[12.5px] text-warn-ink">Could not load the study helper list: {error.message}</p>
        ) : waiting ? (
          <TableSkeleton rows={4} />
        ) : noList ? null : (
          <>
            <p className="mb-3 text-[12.5px] text-ink-muted">
              {optIn && `${summary.on.toLocaleString()} ${summary.on === 1 ? "learner has" : "learners have"} it on. `}
              {caps.studyHelperUsage
                ? `${summary.questions.toLocaleString()} ${summary.questions === 1 ? "question" : "questions"} asked this month.`
                : null}
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
