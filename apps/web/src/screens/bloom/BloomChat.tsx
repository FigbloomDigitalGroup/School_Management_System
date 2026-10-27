import { useEffect, useRef, useState, type RefObject } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  askBloomChat, chatTitleFrom, createAiChat, deleteAiChat, deleteAiChatMessage, EdgeError, fetchAiChatMessages, fetchAiChats,
  homeRouteFor, renameAiChat, saveAiChatTurns, setAiChatWebSearch, sourceHost, CHAT_MESSAGE_MAX, type AiChat, type AiChatSource, type AiChatTurn,
} from "@figbloom/shared";
import type { BloomChatState, BloomConsole } from "../../components/BloomFab";
import { Markdown } from "../../components/Markdown";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { useAiStatus } from "../../lib/useAi";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { replyTables } from "../../../../../packages/shared/src/bloomExport";

/**
 * A turn on screen; saved ones carry their row id (Regenerate removes the
 * last answer by it). An answer from a web search carries its sources.
 */
interface Turn extends AiChatTurn { id?: string; created_at?: string; sources?: AiChatSource[] }

const STARTERS = [
  "Draft a circular to parents about half term",
  "Plan a 40-minute Grade 7 lesson on fractions",
  "Explain the CBE assessment rubric levels simply",
  "Translate this notice into Kiswahili:",
];

/**
 * Bloom chat: a general AI assistant for the office and teachers, opened from
 * the floating button on every console page. Replies come from the
 * ai-assist edge function ("chat" task), metered against the school's
 * allowance like every Bloom task; the conversation is saved in the person's
 * own ai_chats, which nobody else can read. Back returns to the page the
 * button was pressed on.
 *
 * Bloom may search the web for an answer while the composer's "Search the
 * web" toggle is on (the default, remembered per chat) and the school allows
 * it; the toggle is hidden when it doesn't. The sources show under the
 * answer, numbered to match the markers in its text.
 *
 * An answer, or the whole chat, downloads as PDF or Word, and an answer's
 * tables as Excel or CSV (lib/bloomExport.ts, loaded only when asked for).
 */
export function BloomChat({ console }: { console: BloomConsole }) {
  const toast = useToast();
  const nav = useNavigate();
  const location = useLocation();
  const { tenant, actingForTenant } = useTenantSession();
  const ai = useAiStatus();

  const [chatsKey, setChatsKey] = useState(0);
  const { data: chats, loading: chatsLoading } = useAsync(() => fetchAiChats(), [chatsKey]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loadingTurns, setLoadingTurns] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [webSearch, setWebSearch] = useState(true);
  const [exporting, setExporting] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [turns, busy]);
  // Leaving the page mid-answer stops waiting for it.
  useEffect(() => () => abort.current?.abort(), []);

  function back() {
    const from = (location.state as BloomChatState | null)?.from;
    // The browser's own Back when there's an entry to return to, so the page comes back as it was left.
    if (from && (window.history.state?.idx ?? 0) > 0) nav(-1);
    else nav(from ?? (console === "admin" ? homeRouteFor("school_admin", tenant.slug) : homeRouteFor("teacher", tenant.slug, tenant.institution_type)), { replace: true });
  }

  async function open(chat: AiChat) {
    if (busy || chat.id === activeId) return;
    setActiveId(chat.id);
    setTurns([]);
    setError("");
    setSidebarOpen(false);
    setWebSearch(chat.web_search !== false);
    setLoadingTurns(true);
    try {
      setTurns(await fetchAiChatMessages(chat.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that chat.");
    } finally {
      setLoadingTurns(false);
    }
  }

  function newChat() {
    if (busy) return;
    setActiveId(null);
    setTurns([]);
    setError("");
    setDraft("");
    setSidebarOpen(false);
    setWebSearch(true);
    input.current?.focus();
  }

  /** Takes effect from the next question; remembered with the chat once there is one. */
  function toggleWebSearch(on: boolean) {
    setWebSearch(on);
    if (!activeId) return;
    setAiChatWebSearch(activeId, on)
      .then(() => setChatsKey((k) => k + 1))
      .catch((err) => toast(err instanceof Error ? err.message : "Could not save that setting.", "error"));
  }

  /**
   * Asks Bloom with `history` (ending on the question) and saves the answer,
   * plus the question when it's new. On failure or Stop the screen goes back
   * to `before`, and a new question goes back into the box.
   */
  async function ask(history: Turn[], before: Turn[], question: Turn | null) {
    setTurns(history);
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abort.current = controller;
    let chatId = activeId;
    let created = false;
    try {
      if (!chatId) {
        const chat = await createAiChat(tenant.id, chatTitleFrom(question?.content ?? ""), webSearch);
        chatId = chat.id;
        created = true;
        setActiveId(chat.id);
        setChatsKey((k) => k + 1);
      }
      const reply = await askBloomChat(history.map(({ role, content }) => ({ role, content })), {
        tenantId: actingForTenant ? tenant.id : undefined,
        signal: controller.signal,
        webSearch,
      });
      const answer: Turn = { role: "assistant", content: reply.text || "(Bloom gave an empty answer. Try again.)", sources: reply.sources };
      setTurns([...history, answer]);
      try {
        const saved = await saveAiChatTurns(chatId, question ? [question, answer] : [answer]);
        setTurns([...history.slice(0, question ? -1 : undefined), ...saved]);
        setChatsKey((k) => k + 1);
      } catch {
        toast("Bloom answered, but the chat couldn't be saved. Copy anything you need.", "error");
      }
    } catch (err) {
      setTurns(before);
      if (question) setDraft(question.content);
      if (created && chatId) {
        // Nothing was said in it: don't leave an empty chat in the list.
        await deleteAiChat(chatId).catch(() => {});
        setActiveId(null);
        setChatsKey((k) => k + 1);
      }
      if (!(err instanceof EdgeError && err.cancelled)) setError(err instanceof Error ? err.message : "Bloom didn't answer. Try again.");
    } finally {
      abort.current = null;
      setBusy(false);
    }
  }

  function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const question: Turn = { role: "user", content: content.slice(0, CHAT_MESSAGE_MAX) };
    setDraft("");
    void ask([...turns, question], turns, question);
  }

  async function regenerate() {
    const last = turns[turns.length - 1];
    if (busy || last?.role !== "assistant") return;
    const history = turns.slice(0, -1);
    if (last.id) {
      try { await deleteAiChatMessage(last.id); } catch (err) {
        toast(err instanceof Error ? err.message : "Could not regenerate.", "error");
        return;
      }
    }
    void ask(history, history, null);
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.");
    } catch {
      toast("Your browser blocked copying. Select the text instead.", "error");
    }
  }

  const activeTitle = chats?.find((c) => c.id === activeId)?.title ?? null;

  /** Runs one download, with the export code fetched on first use. */
  async function download(fn: (lib: typeof import("../../lib/bloomExport")) => Promise<void>) {
    if (exporting) return;
    setExporting(true);
    try {
      await fn(await import("../../lib/bloomExport"));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not prepare the download.", "error");
    } finally {
      setExporting(false);
    }
  }

  function exportChat(format: "pdf" | "docx") {
    void download((lib) => lib.downloadBloomExport({ format, chatTitle: activeTitle, schoolName: tenant.name, turns, wholeChat: true }));
  }

  /** The download choices for answer i: the answer itself, then any tables in it. */
  function replyItems(i: number): MenuItem[] {
    const t = turns[i]!;
    const common = { chatTitle: activeTitle, schoolName: tenant.name, context: turns };
    const items: MenuItem[] = [
      { label: "Download as PDF", run: () => void download((lib) => lib.downloadBloomExport({ ...common, format: "pdf", turns: [t], wholeChat: false })) },
      { label: "Download as Word", run: () => void download((lib) => lib.downloadBloomExport({ ...common, format: "docx", turns: [t], wholeChat: false })) },
    ];
    const tables = replyTables(t.content);
    tables.forEach((table, k) => {
      const name = tables.length > 1 ? `${table.name}: ` : "Table: ";
      items.push(
        { label: `${name}Download as Excel (.xlsx)`, divider: k === 0, run: () => void download((lib) => lib.downloadTableExport({ ...common, format: "xlsx", content: t.content, index: k })) },
        { label: `${name}Download as CSV`, run: () => void download((lib) => lib.downloadTableExport({ ...common, format: "csv", content: t.content, index: k })) },
      );
    });
    if (tables.length > 1) {
      items.push({ label: "All tables: Excel, a sheet each", divider: true, run: () => void download((lib) => lib.downloadTableExport({ ...common, format: "xlsx", content: t.content })) });
    }
    return items;
  }

  async function saveRename() {
    if (!renaming) return;
    try {
      await renameAiChat(renaming.id, renaming.title);
      setRenaming(null);
      setChatsKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not rename.", "error");
    }
  }

  async function remove(chat: AiChat) {
    if (!window.confirm(`Delete "${chat.title}"? This cannot be undone.`)) return;
    try {
      await deleteAiChat(chat.id);
      if (chat.id === activeId) newChat();
      setChatsKey((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete.", "error");
    }
  }

  const off = ai !== null && !ai.aiEnabled;
  // The school's switch; while it's loading the toggle stays hidden, and the edge function decides anyway.
  const searchAllowed = ai?.webSearchEnabled === true;
  const lastIsAnswer = turns[turns.length - 1]?.role === "assistant";

  const sidebar = (
    <nav aria-label="Your Bloom chats" className="flex min-h-0 flex-1 flex-col">
      <div className="p-3">
        <Button variant="primary" className="w-full" onClick={newChat} disabled={busy}>+ New chat</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {chatsLoading && !chats && <p className="px-2 py-1 text-[12px] text-ink-faint">Loading…</p>}
        {chats && chats.length === 0 && <p className="px-2 py-1 text-[12px] text-ink-faint">Your chats appear here. Only you can see them.</p>}
        <ul className="flex flex-col gap-0.5">
          {(chats ?? []).map((c) => (
            <li key={c.id} className={`group flex items-center gap-1 rounded-md ${c.id === activeId ? "bg-sunken" : "hover:bg-sunken/60"}`}>
              {renaming?.id === c.id ? (
                <form className="flex min-w-0 flex-1 gap-1 p-1" onSubmit={(e) => { e.preventDefault(); void saveRename(); }}>
                  <label htmlFor={`rename-${c.id}`} className="sr-only">Chat name</label>
                  <input
                    id={`rename-${c.id}`}
                    autoFocus
                    maxLength={120}
                    value={renaming.title}
                    onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }}
                    className="min-w-0 flex-1 rounded border border-[#D3DAD5] bg-white px-2 py-1 text-[12.5px] outline-none focus:border-accent"
                  />
                  <button type="submit" className="rounded px-1.5 text-[12px] font-semibold text-forest">Save</button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => void open(c)}
                    aria-current={c.id === activeId ? "true" : undefined}
                    className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[12.5px]"
                    title={c.title}
                  >
                    {c.title}
                  </button>
                  <button type="button" onClick={() => setRenaming({ id: c.id, title: c.title })} aria-label={`Rename ${c.title}`}
                    className="rounded px-1 py-1 text-[12px] text-ink-faint opacity-0 hover:text-ink focus:opacity-100 group-hover:opacity-100">✎</button>
                  <button type="button" onClick={() => void remove(c)} aria-label={`Delete ${c.title}`}
                    className="mr-1 rounded px-1 py-1 text-[12px] text-ink-faint opacity-0 hover:text-warn-ink focus:opacity-100 group-hover:opacity-100">✕</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-page">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-white px-4 py-3 sm:px-6">
        <Button onClick={back} aria-label="Back to the page you were on">‹ Back</Button>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">BLOOM</div>
          <h1 className="truncate text-[16px] font-semibold tracking-tight">
            {activeTitle ?? "New chat"}
          </h1>
        </div>
        {turns.length > 0 && (
          <ExportMenu
            label={exporting ? "Preparing…" : "Export whole chat"}
            menuLabel="Export whole chat"
            disabled={busy || exporting}
            align="right"
            buttonClassName="rounded-md border border-[#D3DAD5] bg-white px-3.5 py-2 text-[12.5px] hover:bg-page disabled:cursor-not-allowed disabled:opacity-50"
            items={() => [
              { label: "Download as PDF", run: () => exportChat("pdf") },
              { label: "Download as Word", run: () => exportChat("docx") },
            ]}
          />
        )}
        <Button className="md:hidden" onClick={() => setSidebarOpen((o) => !o)} aria-expanded={sidebarOpen}>Chats</Button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <aside className={`${sidebarOpen ? "absolute inset-y-0 left-0 z-10 flex shadow-lg" : "hidden"} w-[260px] shrink-0 flex-col border-r border-line bg-[#FAFBFA] md:static md:flex md:shadow-none`}>
          {sidebar}
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-4 py-6 sm:px-6">
              {off ? (
                <p className="rounded-lg border border-line bg-white px-4 py-4 text-[13px] text-ink-muted">
                  Bloom is turned off for this school. The school office can turn it on in School settings.
                </p>
              ) : turns.length === 0 && !loadingTurns ? (
                <div className="flex flex-col items-center gap-4 pt-10 text-center">
                  <span aria-hidden className="grid h-12 w-12 place-items-center rounded-full bg-forest text-[20px] text-white">✦</span>
                  <div>
                    <h2 className="text-[18px] font-semibold tracking-tight">How can Bloom help?</h2>
                    <p className="mt-1 max-w-[460px] text-[13px] text-ink-muted">
                      Write, plan lessons, explain, translate, work through maths, or anything else. Bloom can't see your school's records.
                    </p>
                  </div>
                  <div className="flex max-w-[620px] flex-wrap justify-center gap-2">
                    {STARTERS.map((s) => (
                      <button key={s} type="button" disabled={busy}
                        onClick={() => { if (s.endsWith(":")) { setDraft(`${s}\n`); input.current?.focus(); } else send(s); }}
                        className="rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] text-ink-soft hover:border-accent">
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {loadingTurns && <p className="text-[12.5px] text-ink-faint">Opening chat…</p>}

              <div className="flex flex-col gap-4" aria-live="polite">
                {turns.map((t, i) => t.role === "user" ? (
                  <div key={t.id ?? `u${i}`} className="max-w-[85%] self-end whitespace-pre-wrap rounded-2xl bg-forest px-3.5 py-2.5 text-[13.5px] leading-relaxed text-white">
                    {t.content}
                  </div>
                ) : (
                  <div key={t.id ?? `a${i}`} className="flex gap-2.5">
                    <span aria-hidden className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-forest text-[11px] text-white">✦</span>
                    <div className="min-w-0 flex-1">
                      <span className="sr-only">Bloom said:</span>
                      <Markdown source={t.content} sources={t.sources} />
                      {!!t.sources?.some((s) => s.url) && <Sources sources={t.sources ?? []} />}
                      <div className="mt-1.5 flex gap-1 text-[11.5px] text-ink-faint">
                        <button type="button" onClick={() => void copy(t.content)} className="rounded px-1.5 py-0.5 hover:bg-sunken hover:text-ink">Copy</button>
                        <ExportMenu
                          label="Export"
                          menuLabel="Export this answer"
                          disabled={exporting}
                          buttonClassName="rounded px-1.5 py-0.5 hover:bg-sunken hover:text-ink disabled:opacity-50"
                          items={() => replyItems(i)}
                        />
                        {i === turns.length - 1 && lastIsAnswer && (
                          <button type="button" onClick={() => void regenerate()} disabled={busy} className="rounded px-1.5 py-0.5 hover:bg-sunken hover:text-ink">Regenerate</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {busy && (
                  <div className="flex items-center gap-2.5 text-[13px] text-ink-faint" role="status">
                    <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full bg-forest text-[11px] text-white">✦</span>
                    <span className="animate-pulse">Bloom is thinking…</span>
                  </div>
                )}
                <div ref={end} />
              </div>

              {error && <p className="text-[12.5px] text-warn-ink" role="alert">{error}</p>}
            </div>
          </div>

          <form
            className="shrink-0 border-t border-line bg-white px-4 py-3 sm:px-6"
            onSubmit={(e) => { e.preventDefault(); send(draft); }}
          >
            <div className="mx-auto flex max-w-[820px] items-end gap-2">
              <label htmlFor="bloom-input" className="sr-only">Message Bloom</label>
              <textarea
                id="bloom-input"
                ref={input}
                rows={2}
                maxLength={CHAT_MESSAGE_MAX}
                value={draft}
                disabled={off}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(draft); } }}
                placeholder="Message Bloom… (Shift+Enter for a new line)"
                className="max-h-[40vh] min-w-0 flex-1 resize-y rounded-lg border border-[#D3DAD5] bg-white px-3 py-2 text-[13.5px] outline-none focus:border-accent"
              />
              {busy
                ? <Button type="button" onClick={() => abort.current?.abort()}>Stop</Button>
                : <Button variant="accent" disabled={!draft.trim() || off}>Send</Button>}
            </div>
            <div className="mx-auto mt-1.5 flex max-w-[820px] flex-wrap items-center gap-x-4 gap-y-1">
              {searchAllowed && (
                <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-muted" title="Bloom searches when an answer needs current facts, and lists its sources">
                  <input type="checkbox" checked={webSearch} disabled={off} onChange={(e) => toggleWebSearch(e.target.checked)} style={{ accentColor: "#17402A" }} />
                  Search the web
                </label>
              )}
              <p className="min-w-0 flex-1 text-[11px] text-ink-faint">
                Bloom is an AI and can get things wrong. Check before you use it. Your chats are saved for you only.
              </p>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

interface MenuItem { label: string; run: () => void; divider?: boolean }

/**
 * A button that opens a short menu of downloads. The items are worked out on
 * opening, so an answer's tables are only looked for when someone asks.
 */
function ExportMenu({ label, menuLabel, items, disabled, align = "left", buttonClassName }: {
  label: string; menuLabel: string; items: () => MenuItem[]; disabled?: boolean; align?: "left" | "right"; buttonClassName: string;
}) {
  const [open, setOpen] = useState<MenuItem[] | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative">
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={!!open}
        disabled={disabled}
        onClick={() => setOpen((o) => (o ? null : items()))}
        className={buttonClassName}
      >
        {label} ▾
      </button>
      {open && <ExportMenuList items={open} label={menuLabel} anchor={anchor} align={align} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ExportMenuList({ items, label, anchor, align, onClose }: {
  items: MenuItem[]; label: string; anchor: RefObject<HTMLButtonElement>; align: "left" | "right"; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const list = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    list()[0]?.focus();
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !anchor.current?.contains(t)) onCloseRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); onCloseRef.current(); anchor.current?.focus(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const all = list();
      const i = all.indexOf(document.activeElement as HTMLElement);
      all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey, { capture: true });
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey, { capture: true }); };
  }, [anchor]);

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      className={`absolute top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-white py-1 text-[12.5px] text-ink shadow-lg ${align === "right" ? "right-0" : "left-0"}`}
    >
      {items.map((it, i) => (
        <div key={i}>
          {it.divider && <div className="my-1 border-t border-line-soft" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => { onClose(); it.run(); }}
            className="block w-full px-3 py-2 text-left hover:bg-page focus:bg-page focus:outline-none"
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/** An answer's sources as numbered chips, matching the [^n] markers in its text; each opens in a new tab. */
function Sources({ sources }: { sources: AiChatSource[] }) {
  return (
    <div className="mt-2.5">
      <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">SOURCES</div>
      <ol className="mt-1 flex flex-wrap gap-1.5">
        {sources.map((s, i) => !s.url ? null : (
          <li key={i} className="min-w-0 max-w-full">
            <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}
              className="flex max-w-[280px] items-center gap-1.5 rounded-full border border-line bg-white py-1 pl-1 pr-2.5 text-[11.5px] text-ink-soft hover:border-accent">
              <span className="grid h-4 min-w-[16px] place-items-center rounded-full bg-sunken px-1 text-[10px] font-semibold text-ink-muted">{i + 1}</span>
              <span className="truncate">{s.title}</span>
              <span className="shrink-0 text-ink-faint">{sourceHost(s.url)}</span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
