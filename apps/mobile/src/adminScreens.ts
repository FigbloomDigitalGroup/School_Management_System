import { Eye, Megaphone, MessageSquare, Phone, type LucideIcon } from "lucide-react-native";
import { mayOpenAdminPage, type AdminAccess } from "@figbloom/shared";

/** The admin screens listed under More. `page` is the web console page it mirrors: its area decides who sees it (mayOpenAdminPage). */
export interface AdminScreen {
  to: "Announcements" | "Chats" | "SchoolChats" | "CallLog";
  label: string;
  blurb: string;
  page: string;
  icon: LucideIcon;
}

/** Each admin screen the phone has, in the order they are listed. A screen is added here, and to the stack in adminNavigation.tsx, as it lands. */
export const ADMIN_SCREENS: readonly AdminScreen[] = [
  { to: "Announcements", label: "Announcements", blurb: "Send a notice to the school, a year group or a class", page: "admin/announcements", icon: Megaphone },
  { to: "Chats", label: "Chats", blurb: "Your chats with parents and staff, and call them", page: "admin/chats", icon: MessageSquare },
  { to: "SchoolChats", label: "All school chats", blurb: "Read every chat in the school. You can't join them", page: "admin/chats", icon: Eye },
  { to: "CallLog", label: "Call log", blurb: "Who called whom, and for how long", page: "admin/chats", icon: Phone },
];

/** The screens this person's admin access opens: a full admin all of them, someone with areas those their areas cover. */
export function adminScreensFor(access: AdminAccess | null): AdminScreen[] {
  return access ? ADMIN_SCREENS.filter((screen) => mayOpenAdminPage(access, screen.page)) : [];
}
