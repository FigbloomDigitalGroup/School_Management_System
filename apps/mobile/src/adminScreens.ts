import { Megaphone, type LucideIcon } from "lucide-react-native";
import { mayOpenAdminPage, type AdminAccess } from "@figbloom/shared";

/** The admin screens listed under More. `page` is the web console page it mirrors: its area decides who sees it (mayOpenAdminPage). */
export interface AdminScreen {
  to: "Announcements";
  label: string;
  blurb: string;
  page: string;
  icon: LucideIcon;
}

/** Each admin screen the phone has, in the order they are listed. A screen is added here, and to the stack in adminNavigation.tsx, as it lands. */
export const ADMIN_SCREENS: readonly AdminScreen[] = [
  { to: "Announcements", label: "Announcements", blurb: "Send a notice to the school, a year group or a class", page: "admin/announcements", icon: Megaphone },
];

/** The screens this person's admin access opens: a full admin all of them, someone with areas those their areas cover. */
export function adminScreensFor(access: AdminAccess | null): AdminScreen[] {
  return access ? ADMIN_SCREENS.filter((screen) => mayOpenAdminPage(access, screen.page)) : [];
}
