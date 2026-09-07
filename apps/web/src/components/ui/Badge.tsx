import { status } from "@figbloom/shared";
import type { ReactNode } from "react";

export type Tone = "ok" | "warn" | "info" | "muted";

const TONE: Record<Tone, { background: string; color: string }> = {
  ok: { background: status.okBg, color: status.okInk },
  warn: { background: status.warnBg, color: status.warnInk },
  info: { background: status.infoBg, color: status.infoInk },
  muted: { background: status.mutedBg, color: status.mutedInk },
};

/** Status colours are system-owned — never the tenant accent. Red means the
 *  same thing in every school. */
export function Badge({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className="inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold whitespace-nowrap"
      style={TONE[tone]}
    >
      {children}
    </span>
  );
}

const ROLE_TONE = {
  super_admin: "info", school_admin: "info", teacher: "ok", parent: "muted", student: "muted", driver: "ok",
} as const;

const ROLE_LABEL = {
  super_admin: "Platform", school_admin: "Admin", teacher: "Teacher", parent: "Parent", student: "Student", driver: "Driver",
} as const;

export function RoleBadge({ role }: { role: keyof typeof ROLE_LABEL }) {
  return <Badge tone={ROLE_TONE[role]}>{ROLE_LABEL[role]}</Badge>;
}
