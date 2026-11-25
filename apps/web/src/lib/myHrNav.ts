/**
 * Which sidebar entries are "My HR" (`teacher/my-hr`, `staff/my-hr`, `admin/my-hr`: one screen, three consoles), and when one shows
 * on the API build. The Supabase shells (App.tsx) decide this for themselves; the API build's shells list their pages statically
 * (api/ApiConsole.tsx), so ConsoleShell hides these entries until the API's status says "available" (docs/web-on-api/my-hr.md).
 */
export const isMyHrNav = (to: string): boolean => /(^|\/)my-hr$/.test(to);

/**
 * Whether one My HR entry shows. `available` is showsMyHr(status). In the admin console it shows only for the school's own
 * administrator (not for a teacher or other staff member who holds admin areas, who have their own console's entry, and not for an
 * organisation administrator acting for the school), as on the Supabase build.
 */
export function showsMyHrEntry(input: { to: string; available: boolean; role: string | null | undefined; acting: boolean }): boolean {
  if (!input.available) return false;
  if (input.to === "admin/my-hr") return input.role === "school_admin" && !input.acting;
  return true;
}
