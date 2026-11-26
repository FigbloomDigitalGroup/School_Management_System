import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  FLAG_KIND_LABEL, FLAG_WINDOW_WEEKS, fetchStockInsights, flagCountsByStore, formatShortDate, groupFlags, severityCounts, STORES, storeOf,
  type ConsumptionFlag, type FlagSeverity, type StockInsights,
} from "@figbloom/shared";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Pagination } from "../../components/ui/Pagination";
import { SectionError } from "../../components/ui/SectionError";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { usePaging } from "../../components/ui/usePaging";

/**
 * "Worth a look" (the database's flags, grouped and ordered so the big ones
 * lead) and Bloom's briefing on them, laid out as sections.
 */

export const SEVERITY_LABEL: Record<FlagSeverity, string> = { high: "High", medium: "Medium", low: "Low" };
const SEVERITY_TONE: Record<FlagSeverity, Tone> = { high: "warn", medium: "info", low: "muted" };
const SEVERITY_MARK: Record<FlagSeverity, string> = { high: "▲", medium: "●", low: "○" };

/** Severity as words and a shape, never colour alone. */
export function SeverityBadge({ severity, count }: { severity: FlagSeverity; count?: number }) {
  return (
    <Badge tone={SEVERITY_TONE[severity]}>
      <span aria-hidden className="mr-1">{SEVERITY_MARK[severity]}</span>
      {count != null ? `${count} ${SEVERITY_LABEL[severity].toLowerCase()}` : SEVERITY_LABEL[severity]}
    </Badge>
  );
}

const storeLabel = (s: string) => STORES.find((x) => x.key === s)?.label ?? "Other";

function FlagRow({ f }: { f: ConsumptionFlag }) {
  return (
    <li className="grid gap-1 border-b border-line-soft py-2.5 last:border-0 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-start sm:gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {f.explained ? <Badge tone="ok">✓ Explained</Badge> : <SeverityBadge severity={f.severity} />}
        <Badge>{FLAG_KIND_LABEL[f.kind]}</Badge>
      </div>
      <div className="min-w-0 text-[13px]">
        <span className="font-medium">{f.item_name}</span>
        <span className="text-ink-muted"> · {f.reason}</span>
      </div>
      <span className="whitespace-nowrap font-mono text-[11px] text-ink-faint">{formatShortDate(f.occurred_on)}</span>
    </li>
  );
}

/** Flags grouped under their store's heading, in the order given. */
function FlagList({ flags }: { flags: ConsumptionFlag[] }) {
  const order = STORES.map((s) => s.key as string);
  const stores = [...new Set(flags.map((f) => storeOf(f.category)))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return (
    <div className="grid gap-3">
      {stores.map((s) => (
        <div key={s}>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">{storeLabel(s)}</h3>
          <ul>{flags.filter((f) => storeOf(f.category) === s).map((f, i) => <FlagRow key={`${f.kind}-${f.item_id}-${f.occurred_on}-${f.purpose ?? ""}-${i}`} f={f} />)}</ul>
        </div>
      ))}
    </div>
  );
}

/** The compact summary on top: how many by severity, and by store. */
export function FlagSummary({ flags }: { flags: ConsumptionFlag[] }) {
  const { alarms } = groupFlags(flags);
  const c = severityCounts(alarms);
  const stores = flagCountsByStore(flags);
  if (alarms.length === 0) return null;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Flags by severity">
        {(["high", "medium", "low"] as const).map((s) => c[s] > 0 && <SeverityBadge key={s} severity={s} count={c[s]} />)}
      </div>
      <ul className="flex flex-wrap gap-1.5 text-[12px]" aria-label="Flags by store">
        {stores.map((s) => (
          <li key={s.store} className="rounded-md border border-line bg-page px-2 py-1">
            <span className="font-medium">{storeLabel(s.store)}</span>
            <span className="text-ink-muted">: {[s.counts.high && `${s.counts.high} high`, s.counts.medium && `${s.counts.medium} medium`, s.counts.low && `${s.counts.low} low`].filter(Boolean).join(", ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The database's flags: the biggest first, grouped by store. Sick-bay changes
 * on tiny counts sit behind "small changes"; rises that headcount explains
 * behind "explained". With `limit` it shows the top few and links to `moreTo`;
 * without, it pages.
 */
export function FlagsPanel({ flags, loading, error, onRetry, limit, moreTo, title = "Worth a look" }: {
  flags: ConsumptionFlag[]; loading: boolean; error: Error | null; onRetry: () => void; limit?: number; moreTo?: string; title?: string;
}) {
  const [showSmall, setShowSmall] = useState(false);
  const [showExplained, setShowExplained] = useState(false);
  const { alarms, small, explained } = groupFlags(flags);
  const shown = [...alarms, ...(showSmall ? small : []), ...(showExplained ? explained : [])];
  const paging = usePaging(shown.length, `${showSmall}-${showExplained}-${flags.length}`);
  const rows = limit ? shown.slice(0, limit) : paging.slice(shown);

  return (
    <section className="rounded-lg border border-line bg-white">
      <header className="grid gap-3 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-body font-semibold">{title}</h2>
            <p className="mt-0.5 max-w-[720px] text-[12.5px] text-ink-muted">Each item's use against its own usual (kitchen per head each day; other stores week by week), stock-takes, delivery prices and days of stock left. Biggest first.</p>
            <p className="mt-0.5 text-[12.5px] text-ink-faint">Flags look at the last {FLAG_WINDOW_WEEKS} weeks.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {small.length > 0 && <Button aria-pressed={showSmall} onClick={() => setShowSmall((v) => !v)}>{showSmall ? "Hide" : "Show"} {small.length} small clinic change{small.length === 1 ? "" : "s"}</Button>}
            {explained.length > 0 && <Button aria-pressed={showExplained} onClick={() => setShowExplained((v) => !v)}>{showExplained ? "Hide" : "Show"} {explained.length} explained</Button>}
          </div>
        </div>
        {!loading && !error && <FlagSummary flags={flags} />}
      </header>
      <div className="px-4 py-2">
        {error ? <SectionError what="work out the flags" error={error} onRetry={onRetry} />
          : loading ? <div className="py-2"><TableSkeleton rows={3} /></div>
          : shown.length === 0 ? (
            <p className="py-2 text-[13px] text-ink-muted">
              Nothing unusual in the last {FLAG_WINDOW_WEEKS} weeks.
              {small.length ? ` ${small.length} small sick-bay change${small.length === 1 ? "" : "s"} (under 10 units either way).` : ""}
              {explained.length ? " Some rises were matched by more people eating." : ""}
            </p>
          ) : <FlagList flags={rows} />}
      </div>
      {!loading && !error && (limit ? shown.length > limit && moreTo && (
        <div className="border-t border-line px-4 py-2.5 text-[13px]">
          <Link to={moreTo} className="font-medium underline-offset-2 hover:underline">See all {shown.length} flags →</Link>
        </div>
      ) : shown.length > paging.size && (
        <div className="px-4 pb-3"><Pagination {...paging.props} /></div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------- AI insights

function Glyph({ kind }: { kind: "headline" | "stands" | "questions" | "fine" | "suggest" }) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "headline": return <svg {...common}><path d="M8 1.8l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.2 4.3 13.3l.8-4.2L2 6.2l4.2-.5z" /></svg>;
    case "stands": return <svg {...common}><path d="M8 2l6.2 11H1.8z" /><path d="M8 6.5v3M8 11.6v.1" /></svg>;
    case "questions": return <svg {...common}><circle cx="8" cy="8" r="6.2" /><path d="M6.2 6.2a1.9 1.9 0 113 1.5c-.8.5-1.2.9-1.2 1.7M8 11.6v.1" /></svg>;
    case "fine": return <svg {...common}><circle cx="8" cy="8" r="6.2" /><path d="M5.2 8.2l1.9 1.9 3.8-4" /></svg>;
    case "suggest": return <svg {...common}><path d="M6 13.5h4M6.5 11.5h3M8 1.8a4.2 4.2 0 00-2.4 7.6c.5.4.9 1 .9 1.6V11h3v-.1c0-.6.4-1.2.9-1.6A4.2 4.2 0 008 1.8z" /></svg>;
  }
}

const SECTION_STYLE: Record<string, { tint: string; ink: string }> = {
  stands: { tint: "rgba(217,85,12,0.08)", ink: "#B8460A" },
  questions: { tint: "rgba(42,120,214,0.08)", ink: "#1C5CAB" },
  fine: { tint: "rgba(0,99,0,0.07)", ink: "#006300" },
  suggest: { tint: "rgba(23,64,42,0.06)", ink: "#17402A" },
};

function InsightSection({ kind, title, items }: { kind: "stands" | "questions" | "fine" | "suggest"; title: string; items: string[] | undefined }) {
  if (!items || items.length === 0) return null;
  const s = SECTION_STYLE[kind]!;
  return (
    <section className="rounded-lg border border-line p-3" aria-label={title}>
      <h3 className="flex items-center gap-2 text-[12.5px] font-semibold uppercase tracking-wide" style={{ color: s.ink }}>
        <span className="grid h-6 w-6 place-items-center rounded-md" style={{ background: s.tint }}><Glyph kind={kind} /></span>
        {title} <span className="font-mono text-[11px] font-normal text-ink-faint">{items.length}</span>
      </h3>
      <ul className="mt-2 grid gap-1.5 text-[13px]">
        {items.map((t, k) => <li key={k} className="flex gap-2"><span aria-hidden className="text-ink-faint">–</span><span className="min-w-0">{t}</span></li>)}
      </ul>
    </section>
  );
}

/** Bloom's briefing on the flags, on request. If AI is off or fails it says so; the flags don't depend on it. */
export function InsightsPanel({ from, to }: { from: string; to: string }) {
  const [state, setState] = useState<{ insights?: StockInsights; at?: Date; error?: string; busy?: boolean }>({});
  async function refresh() {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    try {
      const insights = await fetchStockInsights(from, to);
      setState({ insights, at: new Date() });
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : "Bloom didn't answer." }));
    }
  }
  const i = state.insights;
  let body: ReactNode;
  if (state.error) body = <p className="text-[12.5px] text-warn-ink">AI insights aren't available: {state.error.replace(/\.?$/, ".")} The flags are worked out without AI.</p>;
  else if (state.busy && !i) body = <div className="grid gap-2" aria-busy="true"><TableSkeleton rows={2} /></div>;
  else if (!i) body = <p className="text-[13px] text-ink-muted">Ask Bloom for a short briefing for the head teacher or bursar: a headline, what stands out, questions to ask, what looks fine, and suggestions.</p>;
  else body = (
    <div className="grid gap-3">
      <div className="flex items-start gap-2.5 rounded-lg p-3" style={{ background: "rgba(242,106,27,0.08)" }}>
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[#B8460A]" style={{ background: "rgba(242,106,27,0.14)" }}><Glyph kind="headline" /></span>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Headline</div>
          <p className="text-[14.5px] font-medium leading-snug">{i.headline}</p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <InsightSection kind="stands" title="What stands out" items={i.standsOut} />
        <InsightSection kind="questions" title="Questions to ask" items={i.questions} />
        <InsightSection kind="fine" title="Looks fine" items={i.looksFine} />
        <InsightSection kind="suggest" title="Suggestions" items={i.suggestions} />
      </div>
    </div>
  );
  return (
    <section className="rounded-lg border border-line bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-body font-semibold">AI insights</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-muted">
            {state.at ? `Generated ${state.at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}. ` : ""}
            Bloom reads the flags and stock levels (no one's name) and suggests what to ask. It can get things wrong.
          </p>
        </div>
        <Button variant="accent" onClick={() => void refresh()} disabled={state.busy}>{state.busy ? "Thinking…" : i ? "Refresh" : "Get insights"}</Button>
      </header>
      <div className="px-4 py-3">{body}</div>
    </section>
  );
}
