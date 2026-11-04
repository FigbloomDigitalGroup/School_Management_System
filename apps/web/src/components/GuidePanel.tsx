import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  applySetupPlan, askGuide, containsPhoneNumber, fetchSetupExisting, guidePages, planSetup,
  type GuideLink, type PlanItem, type PlanResult, type Role, type Tenant,
} from "@figbloom/shared";
import { Markdown } from "./Markdown";
import { Button } from "./ui/Button";
import { useAsync } from "../lib/useAsync";

/** What a console tells its guide. Absent on a console with no guide. */
export interface GuideOptions {
  /** An org admin acting inside a member school: the school, so the guide counts against it. */
  tenantId?: string;
  /** The organization console: the organization, since there is no school. */
  organizationId?: string;
  /** A teacher or other staff member in the admin console with some areas. */
  adminAreas?: boolean;
  /** A full school admin: the guide may plan the school's structure. */
  setup?: { tenantId: string; schoolLevel: Tenant["level"] };
}

type Turn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; links: GuideLink[]; actions: unknown[]; results?: PlanResult[]; dismissed?: boolean };

/**
 * Kept per browser tab, so the conversation, and whether the panel is open,
 * survive moving between pages (each page mounts its own console shell).
 */
const turnsKey = (userId: string) => `figbloom-guide:${userId}`;
const openKey = (userId: string) => `figbloom-guide-open:${userId}`;

function loadTurns(userId: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(turnsKey(userId));
    if (raw) return JSON.parse(raw) as Turn[];
  } catch { /* storage blocked or unreadable: start fresh */ }
  return [];
}

function store(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* storage blocked: the guide still works on this page */ }
}

export function guideWasOpen(userId: string): boolean {
  try { return sessionStorage.getItem(openKey(userId)) === "1"; } catch { return false; }
}

export function rememberGuideOpen(userId: string, open: boolean) {
  store(openKey(userId), open ? "1" : "0");
}

/** Turns of history sent with each question. */
const HISTORY_TURNS = 16;
const MESSAGE_MAX = 2000;

const SUGGESTIONS: Partial<Record<Role, string[]>> = {
  school_admin: ["Set up our classes for this year", "How do I bill learners for this term?", "Give the bursar access to Fees only", "What should I set up first?"],
  teacher: ["How do I take the register?", "How do I enter and publish marks?", "How do I set homework?"],
  staff: ["What can I do here?", "How do I ask for a staff loan?", "Where do I see the school's notices?"],
  org_admin: ["How do I add a school?", "How do I work inside one of my schools?", "How do I add another admin?"],
};

const SETUP_INTRO = "Ask how to do anything in the school's console. I can also set up classes, subjects, a term, exams and fee items for you: you check the plan and confirm it before anything is created.";
const ORG_INTRO = "Ask how to do anything in the organization console or in your schools.";

/** Everything the guide needs from the console it's in. */
export interface GuideHost {
  role: Role;
  userId: string;
  /** The sidebar as this person sees it. */
  items: { to: string; label: string }[];
  /** The `to` of the page they're on, or "". */
  here: string;
  hrefFor: (to: string) => string;
  options: GuideOptions;
}

/**
 * Navigation state for a page opened from the School assistant, so the page
 * shows a way back (ConsoleShell's back bar). Carried by react-router's
 * location state, so it lasts for that page only.
 */
export interface GuideBack { to: string; label: string }
export const BACK_TO_ASSISTANT: { guideBack: GuideBack } = { guideBack: { to: "admin/assistant", label: "School assistant" } };

/** Set by ConsoleShell when its console has a guide, so a page (School assistant) can host the chat itself. */
export const GuideHostContext = createContext<GuideHost | null>(null);
export const useGuideHost = () => useContext(GuideHostContext);

/**
 * The Figbloom guide as a side panel in every console: it answers "how do
 * I…" with steps and links to the person's own pages, and for a full school
 * admin can plan the school's structure (packages/shared guide.ts).
 */
export function GuidePanel({ host, onClose }: { host: GuideHost; onClose: () => void }) {
  return (
    <aside
      aria-label="Figbloom guide"
      className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-white shadow-[-8px_0_28px_rgba(12,26,18,0.14)] sm:w-[400px] print:hidden"
    >
      <header className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[9px] tracking-[0.12em] text-ink-faint">FIGBLOOM</div>
          <h2 className="text-[15px] font-semibold tracking-tight">Guide</h2>
        </div>
        <button type="button" onClick={onClose} title="Close the guide" className="hit grid h-7 w-7 place-items-center rounded-md text-ink-soft hover:bg-page">
          <span aria-hidden>✕</span><span className="sr-only">Close the guide</span>
        </button>
      </header>
      {/* on a narrow screen the panel would cover the page a link opens */}
      <GuideChat host={host} onNavigate={() => { if (window.innerWidth < 900) onClose(); }} />
    </aside>
  );
}

/**
 * The guide's conversation and composer, shared by the side panel and the
 * School assistant page. `ask` sends a question from outside (a checklist
 * step's "Ask the assistant"); a new `id` sends it again.
 */
export function GuideChat({ host, onNavigate, ask, onApplied, linkState }: {
  host: GuideHost;
  onNavigate?: () => void;
  /** Location state for the pages its links open, e.g. BACK_TO_ASSISTANT. */
  linkState?: unknown;
  ask?: { text: string; id: number } | null;
  /** After a setup plan has been applied, e.g. to refresh a checklist. */
  onApplied?: () => void;
}) {
  const { role, userId, items, here, hrefFor, options } = host;
  const [turnList, setTurnList] = useState<Turn[]>(() => loadTurns(userId));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => store(turnsKey(userId), JSON.stringify(turnList)), [userId, turnList]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [turnList.length, busy]);

  const setTurns = (f: (turns: Turn[]) => Turn[]) => setTurnList(f);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    if (containsPhoneNumber(question)) {
      setError("Leave phone numbers out. The guide can't see or add people, so it never needs them.");
      return;
    }
    setError(null);
    setDraft("");
    const turns: Turn[] = [...turnList, { role: "user", content: question }];
    setTurns(() => turns);
    setBusy(true);
    abort.current = new AbortController();
    try {
      const answer = await askGuide(
        turns.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.content })),
        {
          pages: guidePages(items), here, adminAreas: options.adminAreas,
          tenantId: options.tenantId, organizationId: options.organizationId, signal: abort.current.signal,
        },
      );
      setTurns((t) => [...t, { role: "assistant", content: answer.reply, links: answer.links, actions: options.setup ? answer.actions : [] }]);
    } catch (err) {
      const cancelled = (err as { cancelled?: boolean }).cancelled;
      // put the question back so it can be sent again
      setTurns((t) => t.slice(0, -1));
      if (!cancelled) {
        setDraft(question);
        setError(err instanceof Error ? err.message : "The guide didn't answer. Please try again.");
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function go(link: GuideLink) {
    navigate(hrefFor(link.to), linkState ? { state: linkState } : undefined);
    onNavigate?.();
  }

  // a question sent from outside the chat, once per id
  const asked = useRef<number | null>(null);
  useEffect(() => {
    if (!ask || asked.current === ask.id) return;
    asked.current = ask.id;
    void send(ask.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new ask should send
  }, [ask?.id]);

  const lastAssistant = turnList.reduce((n, t, i) => (t.role === "assistant" ? i : n), -1);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {turnList.length > 0 && (
          <div className="-mt-1 mb-2 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => { setTurns(() => []); setError(null); }}
              className="hit rounded-md px-2 py-1 text-[12px] text-ink-soft hover:bg-page disabled:opacity-50"
            >
              New chat
            </button>
          </div>
        )}
        {turnList.length === 0 && (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px] leading-relaxed text-ink-soft">
              {options.setup ? SETUP_INTRO : role === "org_admin" ? ORG_INTRO : "Ask how to do anything in Figbloom, and I'll show you where to go."}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(role === "school_admin" && !options.setup ? ["What can I do here?"] : SUGGESTIONS[role] ?? []).map((s) => (
                <button key={s} type="button" onClick={() => void send(s)} className="rounded-full border border-line bg-white px-3 py-1.5 text-left text-[12.5px] text-ink-soft hover:border-accent hover:text-forest">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-4">
          {turnList.map((t, i) => t.role === "user" ? (
            <div key={i} className="max-w-[88%] self-end whitespace-pre-wrap rounded-2xl bg-forest px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white">{t.content}</div>
          ) : (
            <div key={i} className="flex flex-col gap-2.5">
              {t.content && <Markdown source={t.content} />}
              {t.links.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.links.map((l) => (
                    <button key={l.to} type="button" onClick={() => go(l)} className="rounded-md border border-accent/40 bg-accent/5 px-2.5 py-1 text-[12.5px] font-semibold text-forest hover:bg-accent/10">
                      {l.label} →
                    </button>
                  ))}
                </div>
              )}
              {options.setup && t.actions.length > 0 && (
                <SetupPlan
                  turn={t}
                  live={i === lastAssistant}
                  setup={options.setup}
                  onDone={(results) => { setTurns((all) => all.map((x, j) => (j === i && x.role === "assistant" ? { ...x, results } : x))); onApplied?.(); }}
                  onDismiss={() => setTurns((all) => all.map((x, j) => (j === i && x.role === "assistant" ? { ...x, dismissed: true } : x)))}
                />
              )}
            </div>
          ))}
          {busy && <p className="text-[12.5px] text-ink-muted">The guide is thinking…</p>}
        </div>
        <div ref={end} />
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-line px-4 pb-3 pt-2.5">
        {error && <p role="alert" className="mb-2 rounded-md border border-warn-ink/30 bg-warn-ink/5 px-2.5 py-1.5 text-[12px] text-warn-ink">{error}</p>}
        <div className="flex items-end gap-2">
          <label htmlFor="guide-input" className="sr-only">Ask the guide</label>
          <textarea
            id="guide-input"
            rows={2}
            maxLength={MESSAGE_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }}
            placeholder="How do I…?"
            className="max-h-[30vh] min-w-0 flex-1 resize-y rounded-lg border border-[#D3DAD5] bg-white px-3 py-2 text-[13.5px] outline-none focus:border-accent"
          />
          {busy
            ? <Button type="button" onClick={() => abort.current?.abort()}>Stop</Button>
            : <Button variant="accent" disabled={!draft.trim()}>Ask</Button>}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-ink-faint">
          The guide is an AI and can be wrong. It never sees or adds people, so leave names and phone numbers out.
        </p>
      </form>
    </div>
  );
}

/**
 * A plan the guide proposed: each step, or why it's left out, then Create /
 * Not now. Only the newest answer's plan can be confirmed; an older one shows
 * what became of it.
 */
function SetupPlan({ turn, live, setup, onDone, onDismiss }: {
  turn: Extract<Turn, { role: "assistant" }>;
  live: boolean;
  setup: NonNullable<GuideOptions["setup"]>;
  onDone: (results: PlanResult[]) => void;
  onDismiss: () => void;
}) {
  const settled = !!turn.results || !!turn.dismissed || !live;
  const { data, loading, error } = useAsync(async () => {
    if (settled) return null;
    const existing = await fetchSetupExisting(setup.tenantId);
    return { existing, items: planSetup(turn.actions, existing, setup.schoolLevel) };
  }, [settled, setup.tenantId]);
  const [applying, setApplying] = useState(false);

  if (turn.results) {
    const failed = turn.results.filter((r) => !r.ok);
    return (
      <div className="rounded-lg border border-line bg-[#FAFBFA] px-3 py-2.5 text-[12.5px]">
        <p className="mb-1.5 font-semibold">{failed.length ? `Done, with ${failed.length} not created` : "Done"}</p>
        <ul className="flex flex-col gap-1">
          {turn.results.map((r, k) => (
            <li key={k} className={r.ok ? "text-ink-soft" : "text-warn-ink"}>
              <span aria-hidden>{r.ok ? "✓ " : "✕ "}</span>{r.label}{r.ok ? "" : `: ${r.message}`}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (turn.dismissed) return <p className="text-[12px] text-ink-faint">Plan not used.</p>;
  if (!live) return <p className="text-[12px] text-ink-faint">An earlier plan. Ask again to use it.</p>;
  if (error) return <p className="text-[12px] text-warn-ink">Couldn't check the plan: {error.message}</p>;
  if (loading || !data) return <p className="text-[12px] text-ink-muted">Checking the plan…</p>;

  const toDo = data.items.filter((it: PlanItem) => it.action);
  async function apply() {
    setApplying(true);
    try {
      onDone(await applySetupPlan(setup.tenantId, toDo, data!.existing.currentTermId));
    } catch (err) {
      onDone([{ label: "The plan", ok: false, message: err instanceof Error ? err.message : "It couldn't be applied." }]);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5 text-[12.5px]">
      <p className="mb-1.5 font-semibold">{toDo.length ? `The plan: ${toDo.length} to create` : "Nothing new to create"}</p>
      <ul className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
        {data.items.map((it: PlanItem, k: number) => (
          <li key={k} className={it.action ? "text-ink" : "text-ink-faint"}>
            <span aria-hidden>{it.action ? "+ " : "– "}</span>{it.label}{it.skip ? ` (left out: ${it.skip})` : ""}
          </li>
        ))}
      </ul>
      <div className="mt-2.5 flex gap-2">
        {toDo.length > 0 && (
          <Button variant="accent" disabled={applying} onClick={() => void apply()}>
            {applying ? "Creating…" : `Create ${toDo.length}`}
          </Button>
        )}
        <Button disabled={applying} onClick={onDismiss}>Not now</Button>
      </div>
    </div>
  );
}
