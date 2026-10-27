/**
 * Who a visit is pushed to, and what it says. Pure, so it's tested without
 * a database. The web consoles pop up the same words from the visit row
 * itself (packages/shared/src/visitors.ts visitAlert) -- edge functions can't
 * import the workspace's packages, so keep the two in step by hand.
 */

export interface VisitRow {
  id: string;
  visitor_name: string;
  purpose: string;
  host_kind: "office" | "principal" | "teacher" | "learner";
  host_id: string | null;
  student_name: string | null;
  escalated: boolean;
  status: "expected" | "at_reception" | "with_host" | "left";
  host_pushed_at: string | null;
  escalation_pushed_at: string | null;
}

export interface Push {
  /** The visits column that remembers this push went out. */
  marker: "host_pushed_at" | "escalation_pushed_at";
  profileIds: string[];
  title: string;
  body: string;
}

function where(v: VisitRow): string {
  return v.status === "expected" ? "At the gate, on the way to the office." : "At the office.";
}

function about(v: VisitRow): string {
  return v.host_kind === "learner" && v.student_name ? ` about ${v.student_name}` : "";
}

/** The pushes still owed for this visit: its own host, and the school's admins once it's escalated. */
export function plan(v: VisitRow, adminIds: string[]): Push[] {
  if (v.status === "left") return [];
  const out: Push[] = [];
  if (v.host_id && !v.host_pushed_at) {
    out.push({
      marker: "host_pushed_at",
      profileIds: [v.host_id],
      title: `${v.visitor_name} is here to see you`,
      body: `${where(v)} ${v.purpose}`,
    });
  }
  // The host is told once already, as host: an admin who is also the host isn't pushed twice.
  const admins = adminIds.filter((id) => id !== v.host_id);
  if (v.escalated && !v.escalation_pushed_at && admins.length) {
    out.push({
      marker: "escalation_pushed_at",
      profileIds: admins,
      title: v.host_kind === "principal" ? `${v.visitor_name} is here to see the principal` : `Visitor escalated: ${v.visitor_name}${about(v)}`,
      body: `${where(v)} ${v.purpose}`,
    });
  }
  return out;
}
