import { CalendarOff, CalendarPlus, ClipboardCheck, Eye, Megaphone, MessageSquare, Phone, Wallet, type LucideIcon } from "lucide-react-native";
import { mayOpenAdminPage, showsLeaveToApprove, showsStaffLeave, type AdminAccess, type HrLeaveAccess } from "@figbloom/shared";
import type { StaffSession } from "./lib/staffSession";

/** What Figbloom HR says about this person's leave (hr_leave_access), for the screens that follow its answer instead of an admin area. */
export interface HrScreens {
  /** They approve leave in HR, at a school whose leave runs there. */
  approver?: boolean;
  /**
   * They apply for their own leave through HR. Only other staff: a teacher has their own Leave screen, and a school
   * admin has My HR on the web (the web console gives neither a Leave page here either).
   */
  staffLeave?: boolean;
}

/** HR's answer about this person (null while it is being asked), as the screens it decides. */
export function hrScreensFor(role: StaffSession["role"], hr: HrLeaveAccess | null): HrScreens {
  return { approver: showsLeaveToApprove(hr), staffLeave: role === "staff" && showsStaffLeave(hr) };
}

/** The admin screens listed under More. `page` is the web console page it mirrors: its area decides who sees it (mayOpenAdminPage). */
export interface AdminScreen {
  to: "Fees" | "Announcements" | "Chats" | "SchoolChats" | "CallLog" | "Leave" | "LeaveToApprove" | "MyLeave";
  label: string;
  blurb: string;
  page: string;
  icon: LucideIcon;
  /** Listed only when Figbloom HR says so (see HrScreens): their areas alone do not decide it. */
  needs?: "hrApprover" | "hrStaffLeave";
}

/** Each admin screen the phone has, in the order they are listed. A screen is added here, and to the stack in adminNavigation.tsx, as it lands. */
export const ADMIN_SCREENS: readonly AdminScreen[] = [
  { to: "Fees", label: "Fees", blurb: "How the term is going, record a payment, review proofs", page: "admin/fees", icon: Wallet },
  { to: "Announcements", label: "Announcements", blurb: "Send a notice to the school, a year group or a class", page: "admin/announcements", icon: Megaphone },
  { to: "Chats", label: "Chats", blurb: "Your chats with parents and staff, and call them", page: "admin/chats", icon: MessageSquare },
  { to: "SchoolChats", label: "All school chats", blurb: "Read every chat in the school. You can't join them", page: "admin/chats", icon: Eye },
  { to: "CallLog", label: "Call log", blurb: "Who called whom, and for how long", page: "admin/chats", icon: Phone },
  { to: "Leave", label: "Leave requests", blurb: "Approve or reject teachers' time off", page: "admin/leave", icon: CalendarOff },
  { to: "LeaveToApprove", label: "Leave to approve", blurb: "Staff leave waiting on you in Figbloom HR", page: "admin/leave-to-approve", icon: ClipboardCheck, needs: "hrApprover" },
  // The page "admin" is the console's own front page, open to anyone with the console: who gets this row is HR's answer.
  { to: "MyLeave", label: "My leave", blurb: "Apply for leave in Figbloom HR and follow it", page: "admin", icon: CalendarPlus, needs: "hrStaffLeave" },
];

/**
 * The screens this person's admin access opens: a full admin all of them, someone with areas those their areas cover.
 * "Leave to approve" and "My leave" are the exceptions: they follow HR's answer (`hr`, from useHrLeaveAccess), at the
 * schools whose leave runs there.
 */
export function adminScreensFor(access: AdminAccess | null, hr: HrScreens = {}): AdminScreen[] {
  const hrAllows = (screen: AdminScreen) => screen.needs === undefined || (screen.needs === "hrApprover" ? !!hr.approver : !!hr.staffLeave);
  return access ? ADMIN_SCREENS.filter((screen) => mayOpenAdminPage(access, screen.page) && hrAllows(screen)) : [];
}
