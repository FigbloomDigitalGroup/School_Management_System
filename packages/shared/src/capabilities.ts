import { onApi } from "./backend";

/**
 * What an area can do on the backend this build talks to (FIG-1890). On Supabase everything the screens offer works. On the
 * new API a screen can only offer what the API has an endpoint for: where it has none, the control is not shown, and the
 * shared function behind it throws NotOnApiError so a stray call fails loudly instead of doing nothing.
 *
 * Each flag is one missing endpoint (apps/api/openapi/openapi.yaml). When the API gains it, the flag turns true for the
 * API build, the shared function is given its API branch, and the screen needs no change.
 */

/** Thrown by a shared function that the API cannot do yet. Its message is written for the person using the app. */
export class NotOnApiError extends Error {
  constructor(what: string) {
    super(`${what} is not on the new system yet.`);
    this.name = "NotOnApiError";
  }
}

export function isNotOnApiError(err: unknown): err is NotOnApiError {
  return err instanceof NotOnApiError;
}

/** The school-setup screens: School settings, Classes, Subjects. */
export interface SetupCapabilities {
  /** Change a class's teacher after the class was made (the API takes it at creation only). */
  changeClassTeacher: boolean;
  /** Remove a class (the API archives nothing yet). */
  deleteClass: boolean;
  /** A class's room (the API has no such field). */
  classRoom: boolean;
  /** Promote a class's learners at the year's end. */
  promoteClass: boolean;
  /** A class's weekly timetable. */
  classTimetable: boolean;
  /** Edit a subject once made. */
  editSubject: boolean;
  /** A subject's level and year range, its core flag, and adding from the KICD catalogue (the API's subject is a code and a name). */
  subjectDetails: boolean;
  /** Change or clear who teaches a subject in a class once one is set. */
  changeSubjectTeacher: boolean;
  /** The fee structure step of the setup checklist, and the payment methods form. */
  feeSetup: boolean;
  /** Upload the school's crest. */
  schoolCrest: boolean;
  /** The AI settings panel. */
  aiSettings: boolean;
}

const EVERYTHING: SetupCapabilities = {
  changeClassTeacher: true, deleteClass: true, classRoom: true, promoteClass: true, classTimetable: true,
  editSubject: true, subjectDetails: true, changeSubjectTeacher: true, feeSetup: true, schoolCrest: true, aiSettings: true,
};

const NOTHING_YET: SetupCapabilities = {
  changeClassTeacher: false, deleteClass: false, classRoom: false, promoteClass: false, classTimetable: false,
  editSubject: false, subjectDetails: false, changeSubjectTeacher: false, feeSetup: false, schoolCrest: false, aiSettings: false,
};

export function setupCapabilities(): SetupCapabilities {
  return onApi() ? NOTHING_YET : EVERYTHING;
}

/** The announcements composer screen (admin/announcements). */
export interface AnnouncementsCapabilities {
  /** Per-audience recipient headcounts and SMS cost preview (the API has no account-reach count endpoint yet). */
  reachCounts: boolean;
  /** Attaching files to an announcement (waits on API file storage, A5 / FIG-1873). */
  attachments: boolean;
  /** Requiring guardian signatures on announcement attachments and showing signature status (waits on C12 / FIG-1880). */
  signatures: boolean;
  /** AI writing helper (calls a Supabase edge function). */
  aiHelper: boolean;
  /** SMS and email delivery channels (deferred on the API until B8 / FIG-1876). */
  smsAndEmail: boolean;
}

const ALL_ANNOUNCEMENTS: AnnouncementsCapabilities = {
  reachCounts: true, attachments: true, signatures: true, aiHelper: true, smsAndEmail: true,
};

const API_ANNOUNCEMENTS: AnnouncementsCapabilities = {
  reachCounts: false, attachments: false, signatures: false, aiHelper: false, smsAndEmail: false,
};

export function announcementsCapabilities(): AnnouncementsCapabilities {
  return onApi() ? API_ANNOUNCEMENTS : ALL_ANNOUNCEMENTS;
}
