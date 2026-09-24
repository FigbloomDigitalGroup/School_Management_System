import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/** "error" is for anything that didn't happen (a failed save, a blocked form) — everything else is the default. */
export type ToastTone = "default" | "error";
export type ToastFn = (msg: string, tone?: ToastTone) => void;

const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

/**
 * Confirmation, not decoration. Every destructive or remote action says what
 * actually happened — "Reminder sent to the bursar", not "Success".
 *
 * The default toast wears the school's accent (the deep shade the sidebar
 * uses), since it's a brand surface like the header. Errors are a status
 * colour and never themed: the same warn ink and ✕ as a field error, in
 * every school, so a failure never looks like a confirmation.
 */
export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; tone: ToastTone; id: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const fire = useCallback<ToastFn>((msg, tone = "default") => {
    // A new toast replaces the old one outright — without clearing the old
    // timer it would dismiss the new message early.
    window.clearTimeout(timer.current);
    setToast({ msg, tone, id: Date.now() });
    timer.current = window.setTimeout(() => setToast(null), tone === "error" ? 6000 : 3600);
  }, []);

  const error = toast?.tone === "error";

  return (
    <ToastCtx.Provider value={fire}>
      {children}
      {toast && (
        <div
          key={toast.id}
          role={error ? "alert" : "status"}
          aria-live={error ? "assertive" : "polite"}
          className={`animate-rise fixed bottom-6 left-1/2 z-[60] flex max-w-[min(560px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-lg px-4.5 py-3 text-[13px] text-white ${error ? "bg-warn-ink" : "bg-accent-deep"}`}
          style={{ paddingLeft: 18, paddingRight: 18 }}
        >
          {error ? (
            <span className="shrink-0 font-semibold" aria-hidden>✕</span>
          ) : (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange" aria-hidden />
          )}
          {toast.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
