import { useState } from "react";

/**
 * Demo state for the mobile scaffold. Replace `useChild` with a Supabase query
 * plus the offline cache — the screens do not change when you do.
 */

export const CHILDREN = [
  { id: "faith", name: "Faith Achieng", first: "Faith", cls: "Form 2 West", adm: "4102", balance: 1_240_000, billed: 3_050_000, attendance: 88, mean: 74 },
  { id: "samuel", name: "Samuel Achieng", first: "Samuel", cls: "Form 4 East", adm: "3781", balance: 0, billed: 3_400_000, attendance: 96, mean: 68 },
];

export const MESSAGES = [
  { id: "m1", who: "school", from: "School office", subject: "Half-term closing Friday 12 September", when: "08:20", unread: true,
    body: "School closes for half-term on Friday 12 September at 12:30pm.\n\nBoarders travelling upcountry should collect travel passes from the deputy's office on Thursday." },
  { id: "m2", who: "teacher", from: "Mr Otieno · Chemistry", subject: "Faith's practical work", when: "Yesterday", unread: true,
    body: "Faith has been doing well in the practicals but missed the last two write-ups. Could you check she is bringing her exercise book to the lab?" },
  { id: "m3", who: "school", from: "Bursar", subject: "Term 3 fee balance", when: "29 Aug", unread: false,
    body: "Your balance for Term 3 is KSh 12,400. Part payment is fine — many families pay across the term." },
];

export const SUBJECTS: [string, number][] = [
  ["Mathematics", 78], ["English", 71], ["Kiswahili", 66], ["Chemistry", 82],
  ["Physics", 74], ["Biology", 88], ["Geography", 69], ["History", 63], ["CRE", 75],
];

/** School accent arrives with the session at sign-in. */
const SCHOOL_ACCENT = "#7A1F2B";

let sharedIndex = 0;

export function useChild() {
  const [index, setIndex] = useState(sharedIndex);
  return {
    child: CHILDREN[index]!,
    index,
    setIndex: (i: number) => { sharedIndex = i; setIndex(i); },
    accent: SCHOOL_ACCENT,
  };
}
