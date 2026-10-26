import { useLocation, useNavigate } from "react-router-dom";
import { useAiStatus } from "../lib/useAi";
import { useTenantSession } from "../lib/sessionContext";

export type BloomConsole = "admin" | "teacher";

export const bloomChatPath = (slug: string, console: BloomConsole) => `/s/${slug}/${console}/bloom`;

/** Where the chat page's Back button returns to: the page the button was pressed on. */
export interface BloomChatState { from?: string }

/**
 * Bloom chat's way in: a floating button on every page of the office and
 * teacher consoles. It remembers the page it was pressed on, so the chat's
 * Back button returns there. Hidden on the chat page itself, and while the
 * school has Bloom switched off.
 */
export function BloomFab({ console }: { console: BloomConsole }) {
  const { tenant } = useTenantSession();
  const location = useLocation();
  const nav = useNavigate();
  const ai = useAiStatus();
  const path = bloomChatPath(tenant.slug, console);

  if (!ai?.aiEnabled || location.pathname === path) return null;

  const from = `${location.pathname}${location.search}${location.hash}`;
  return (
    <button
      type="button"
      onClick={() => nav(path, { state: { from } satisfies BloomChatState })}
      aria-label="Open Bloom chat, the AI assistant"
      title="Ask Bloom"
      className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-forest bg-forest py-3 pl-3.5 pr-4 text-[13px] font-semibold text-white shadow-[0_8px_24px_rgba(12,26,18,0.28)] transition hover:bg-forest-deep focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange print:hidden"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      <span aria-hidden className="grid h-6 w-6 place-items-center rounded-full bg-orange text-[13px] leading-none">✦</span>
      <span className="max-sm:sr-only">Ask Bloom</span>
    </button>
  );
}
