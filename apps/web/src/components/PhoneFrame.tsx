import type { ReactNode } from "react";

/**
 * Phone chrome for previewing the parent and student apps in a browser.
 * The React Native apps in /android render the same screens without this.
 */
export function PhoneFrame({ children, accent }: { children: ReactNode; accent: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-app-shell p-6">
      <div className="rounded-[44px] p-3 shadow-2xl" style={{ width: 392, height: 812, background: "#151011" }}>
        <div className="flex h-full w-full flex-col overflow-hidden rounded-[34px] bg-app-page">
          <div className="flex items-center justify-between px-5 pt-3.5 font-mono text-[10px] text-white/70" style={{ background: accent }}>
            <span>09:42</span>
            <span>FIGBLOOM</span>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function TabBar({ items }: { items: { label: string; icon: string; active: boolean; onPress: () => void }[] }) {
  return (
    <nav className="flex shrink-0 border-t border-app-line bg-white px-1.5 pb-4 pt-2">
      {items.map((t) => (
        <button
          key={t.label}
          onClick={t.onPress}
          className="hit flex-1 py-1 text-center"
          style={{ color: t.active ? "var(--accent-deep)" : "#9A908E", fontWeight: t.active ? 700 : 500 }}
        >
          <div className="text-[17px]" aria-hidden>{t.icon}</div>
          <div className="mt-0.5 text-[10.5px]">{t.label}</div>
        </button>
      ))}
    </nav>
  );
}
