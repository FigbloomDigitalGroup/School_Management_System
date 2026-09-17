import { createContext, useContext } from "react";

/**
 * Lets the Notices screen decrement the sidebar's unread badge the instant a
 * notice is opened, rather than waiting for the next full navigation — that's
 * the only other time TeacherShell (which owns the badge count) remounts and
 * refetches it from the database.
 */
const TeacherNoticesCtx = createContext<(() => void) | null>(null);

export const TeacherNoticesProvider = TeacherNoticesCtx.Provider;

export function useNoticeRead(): () => void {
  return useContext(TeacherNoticesCtx) ?? (() => {});
}
