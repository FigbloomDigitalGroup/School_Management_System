/**
 * What a parent's phone is told when their child is signed out early. Pure, so it is tested without a database. The web and phone
 * apps show the same facts from the sign-out row (packages/shared/src/earlySignOut.ts signOutPushText) -- edge functions can't
 * import the workspace's packages, so keep the two in step by hand.
 *
 * The collector's ID number and phone are never in a push: only the name and how they are related, which the parent may see.
 */

export interface SignOutRow {
  id: string;
  tenant_id: string;
  student_id: string;
  student_name: string;
  /** The wall-clock time at the school, "HH:MM:SS". */
  signed_out_local: string;
  collected_by_name: string;
  collected_by_relationship: string;
  recorded_by: string | null;
  voided_at: string | null;
  parent_pushed_at: string | null;
}

export interface Push {
  title: string;
  body: string;
}

/** The first name of the learner, or "Your child" when there is none. */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || "Your child";
}

/** The push still owed for this sign-out, or null when it was voided or the parents were already told. */
export function pushFor(row: SignOutRow): Push | null {
  if (row.voided_at || row.parent_pushed_at) return null;
  return {
    title: `${firstName(row.student_name)} was signed out early`,
    body: `Signed out at ${row.signed_out_local.slice(0, 5)}, collected by ${row.collected_by_name} (${row.collected_by_relationship}).`,
  };
}
