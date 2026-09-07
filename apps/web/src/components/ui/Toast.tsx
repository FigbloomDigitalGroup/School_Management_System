import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

/**
 * Confirmation, not decoration. Every destructive or remote action says what
 * actually happened — "Reminder sent to the bursar", not "Success".
 */
export function ToastHost({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);

  const fire = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg(null), 3600);
  }, []);

  return (
    <ToastCtx.Provider value={fire}>
      {children}
      {msg && (
        <div
          role="status"
          aria-live="polite"
          className="animate-rise fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-lg bg-forest px-4.5 py-3 text-[13px] text-white"
          style={{ paddingLeft: 18, paddingRight: 18 }}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-orange" aria-hidden />
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}
