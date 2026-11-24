import type { ReactNode } from "react";

/** One block of an account page: a heading, a line saying what it is for, and the controls. */
export function AccountCard({ title, lead, children, id }: { title: string; lead?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title} className="max-w-[480px] overflow-hidden rounded-lg border border-line bg-white">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">{title}</h2>
        {lead && <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{lead}</p>}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}
