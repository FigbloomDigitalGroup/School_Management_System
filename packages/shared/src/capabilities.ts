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

/** The People screen: learners, staff and guardians. A flag is true where that backend offers the control. */
export interface PeopleCapabilities {
  /** Delete a learner for good (the API archives only). */
  deleteLearner: boolean;
  /** Learners' sign-in accounts: the Login column, "Create logins", a learner's password reset. */
  learnerLogins: boolean;
  /** "Invite guardians" from the selected learners (parents' sign-in accounts). */
  inviteGuardians: boolean;
  /** The Guardian column (a placeholder on Supabase; guardians are read from a learner's own card on the API). */
  guardianColumn: boolean;
  /** Each learner's fee status. */
  learnerFees: boolean;
  /** The bulk "Change class" and "Export" buttons (toast-only stubs on Supabase; not offered on the API until they work). */
  bulkChangeClass: boolean;
  bulkExport: boolean;
  /** Home address and bus route, health details, bio data and its approval requests, documents, early sign-outs, activities. */
  learnerHome: boolean;
  learnerHealth: boolean;
  bioData: boolean;
  learnerDocuments: boolean;
  learnerEarlySignOuts: boolean;
  learnerActivities: boolean;
  /** Photos: uploading one, and an admin's review of a changed staff photo. */
  photos: boolean;
  /** Password reset requests and resets. */
  passwordResets: boolean;
  /** Staff as sign-in accounts: Add staff makes a login, Remove staff deletes it, admin access, a login column. */
  staffAccounts: boolean;
  /** The subjects a teacher teaches. */
  staffSubjects: boolean;
  /** Calling a member of staff from the app. */
  staffCalls: boolean;
  /** API only: staff are directory records that can be archived and restored (an Archived view on the Staff tab). */
  staffArchive: boolean;
  /** API only: add a guardian's contact details to a learner. */
  guardianContactForm: boolean;
  /** Import learners from a spreadsheet as a holder of the People area (on the API only a full administrator may). */
  importByAreaHolders: boolean;
  /** API only: a learner can be added with no class yet (placing one needs the Academics area, which People alone does not give). */
  learnerWithoutClass: boolean;
  /**
   * Take a learner out of their class ("Unassigned"). Not on the API: a class a learner has left cannot be given back to them that
   * year (the API keeps an ended membership as a block), so taking one away would be a trap.
   */
  unassignClass: boolean;
}

const PEOPLE_ON_SUPABASE: PeopleCapabilities = {
  deleteLearner: true, learnerLogins: true, inviteGuardians: true, guardianColumn: true, learnerFees: true, bulkChangeClass: true, bulkExport: true,
  learnerHome: true, learnerHealth: true, bioData: true, learnerDocuments: true, learnerEarlySignOuts: true, learnerActivities: true,
  photos: true, passwordResets: true, staffAccounts: true, staffSubjects: true, staffCalls: true, staffArchive: false, guardianContactForm: false,
  importByAreaHolders: true, learnerWithoutClass: false, unassignClass: true,
};

const PEOPLE_ON_API: PeopleCapabilities = {
  deleteLearner: false, learnerLogins: false, inviteGuardians: false, guardianColumn: false, learnerFees: false, bulkChangeClass: false, bulkExport: false,
  learnerHome: false, learnerHealth: false, bioData: false, learnerDocuments: false, learnerEarlySignOuts: false, learnerActivities: false,
  photos: false, passwordResets: false, staffAccounts: false, staffSubjects: false, staffCalls: false, staffArchive: true, guardianContactForm: true,
  importByAreaHolders: false, learnerWithoutClass: true, unassignClass: false,
};

export function peopleCapabilities(): PeopleCapabilities {
  return onApi() ? PEOPLE_ON_API : PEOPLE_ON_SUPABASE;
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

/** The admin Fees screen (admin/fees): fee items, billing runs, recording payments, and reviewing proofs. */
export interface FeesCapabilities {
  /** Signing term invoices and viewing signed term receipts (waits on C12 / FIG-1880). */
  invoiceSignatures: boolean;
  /** Opening uploaded proof files from object storage (API proofs carry file metadata only until A5 / FIG-1873). */
  proofFiles: boolean;
}

const FEES_ON_SUPABASE: FeesCapabilities = { invoiceSignatures: true, proofFiles: true };
const FEES_ON_API: FeesCapabilities = { invoiceSignatures: false, proofFiles: false };

export function feesCapabilities(): FeesCapabilities {
  return onApi() ? FEES_ON_API : FEES_ON_SUPABASE;
}

/** The Leave screens (admin/leave, teacher/leave). */
export interface LeaveCapabilities {
  /** Figbloom HR leave handoff ("Leave to approve" and HR-backed applications; blocked on C13). */
  hrLeave: boolean;
  /** Submitting a leave request without a reason (the API requires at least 3 characters). */
  optionalReason: boolean;
}

const LEAVE_ON_SUPABASE: LeaveCapabilities = { hrLeave: true, optionalReason: true };
const LEAVE_ON_API: LeaveCapabilities = { hrLeave: false, optionalReason: false };

export function leaveCapabilities(): LeaveCapabilities {
  return onApi() ? LEAVE_ON_API : LEAVE_ON_SUPABASE;
}

/** The timetable screens: teacher/timetable, and the Timetable window of a class on admin/classes. */
export interface TimetableCapabilities {
  /** The week-grid editor that saves a class's whole timetable at once (the API can only add a period). */
  classTimetableEditor: boolean;
  /** API only: a class's periods listed, with an "Add a period" form. */
  classPeriods: boolean;
  /** The "Live classes" panel on a teacher's timetable (calls are not in the API). */
  liveClasses: boolean;
  /** "Needs cover" and "Covered by" on a teacher's timetable: leave worked out against the week (the API's attendance cover is by class and day, not by period). */
  coverageFlags: boolean;
}

const TIMETABLE_ON_SUPABASE: TimetableCapabilities = { classTimetableEditor: true, classPeriods: false, liveClasses: true, coverageFlags: true };
const TIMETABLE_ON_API: TimetableCapabilities = { classTimetableEditor: false, classPeriods: true, liveClasses: false, coverageFlags: false };

export function timetableCapabilities(): TimetableCapabilities {
  return onApi() ? TIMETABLE_ON_API : TIMETABLE_ON_SUPABASE;
}

/** The higher-education screens: admin/courses and teacher/sections. */
export interface CoursesCapabilities {
  /** A course's department (the API's course is a code, a title and credit hours). */
  courseDepartment: boolean;
  /** Naming a section's instructor (a section has none in the API). */
  sectionInstructor: boolean;
  /** A section's room and capacity. */
  sectionRoomAndCapacity: boolean;
  /** A section's weekly schedule. */
  sectionSchedule: boolean;
  /** Dropping a student from a section (an enrolment can be made, not ended). */
  dropEnrolment: boolean;
  /** "My sections" for a lecturer: needs the instructor of a section. */
  mySections: boolean;
}

const COURSES_ON_SUPABASE: CoursesCapabilities = {
  courseDepartment: true, sectionInstructor: true, sectionRoomAndCapacity: true, sectionSchedule: true, dropEnrolment: true, mySections: true,
};
const COURSES_ON_API: CoursesCapabilities = {
  courseDepartment: false, sectionInstructor: false, sectionRoomAndCapacity: false, sectionSchedule: false, dropEnrolment: false, mySections: false,
};

export function coursesCapabilities(): CoursesCapabilities {
  return onApi() ? COURSES_ON_API : COURSES_ON_SUPABASE;
}
