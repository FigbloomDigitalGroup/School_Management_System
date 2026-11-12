import {
  REGISTER_TABLE, SESSION_LABEL, sessionAt, sessionsOffered, toRecords,
  type AttendanceSession, type AttendanceSettings, type Register,
} from "@figbloom/shared";

/** FIG-1514 helpers for the teacher's register screen (pure, so they can be tested without rendering). */

/**
 * The session to open: the one for the school's clock, but only if the school takes it
 * (never the afternoon while the afternoon register is off).
 */
export function defaultSession(settings: AttendanceSettings, timeZone: string, now: Date = new Date()): AttendanceSession {
  const wanted = sessionAt(settings.afternoon_enabled, timeZone, now);
  return sessionsOffered(settings).includes(wanted) ? wanted : "morning";
}

/** The switch is shown only when there is more than one session to pick. */
export function sessionChoices(settings: AttendanceSettings): { id: AttendanceSession; name: string }[] {
  const offered = sessionsOffered(settings);
  return offered.length > 1 ? offered.map((id) => ({ id, name: SESSION_LABEL[id] })) : [];
}

/** If the school turns the afternoon off while the screen is open, an afternoon choice falls back to the morning. */
export function validSession(session: AttendanceSession, settings: AttendanceSettings): AttendanceSession {
  return sessionsOffered(settings).includes(session) ? session : "morning";
}

/** What an offline save queues: the session's table and the same rows as the online write. The morning is exactly `attendance`. */
export function queuedRegister(reg: Register, tenantId: string, takenBy: string, session: AttendanceSession) {
  return { table: REGISTER_TABLE[session], rows: toRecords(reg, tenantId, takenBy) };
}

/** "Morning register is in" style title; with only one session offered the title stays as it always was. */
export function registerInTitle(className: string, session: AttendanceSession, settings: AttendanceSettings): string {
  return sessionsOffered(settings).length > 1
    ? `${SESSION_LABEL[session]} register is in · ${className}`
    : `${className} register is in`;
}
