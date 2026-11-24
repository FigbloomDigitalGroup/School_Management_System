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
  /** "Invite guardians" from the selected learners (parents' sign-in accounts, made with a login ID and password). */
  inviteGuardians: boolean;
  /** API only: invite a guardian record to sign in (one invitation per guardian and learner, by e-mail or SMS), send it again, cancel it. */
  guardianInvitations: boolean;
  /** API only: invite a staff member to sign in by e-mail, and issue a one-time password-reset link for a staff member who has a sign-in. */
  staffSignIn: boolean;
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
  deleteLearner: true, learnerLogins: true, inviteGuardians: true, guardianInvitations: false, staffSignIn: false, guardianColumn: true, learnerFees: true, bulkChangeClass: true, bulkExport: true,
  learnerHome: true, learnerHealth: true, bioData: true, learnerDocuments: true, learnerEarlySignOuts: true, learnerActivities: true,
  photos: true, passwordResets: true, staffAccounts: true, staffSubjects: true, staffCalls: true, staffArchive: false, guardianContactForm: false,
  importByAreaHolders: true, learnerWithoutClass: false, unassignClass: true,
};

const PEOPLE_ON_API: PeopleCapabilities = {
  deleteLearner: false, learnerLogins: false, inviteGuardians: false, guardianInvitations: true, staffSignIn: true, guardianColumn: false, learnerFees: false, bulkChangeClass: false, bulkExport: false,
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

/** The account pages (admin/account, teacher/account; later staff/account and parent/settings). */
export interface AccountCapabilities {
  /** Change your own name, phone and second phone (the API has no endpoint for it). */
  editProfile: boolean;
  /** Upload your own photo (waits on file storage, A5 / FIG-1873). */
  photo: boolean;
  /** Voice and video calls from the account page (not on the API: C13). */
  calls: boolean;
  /** API only: change the password (asking for the current one) and manage two-step verification on the account page. */
  security: boolean;
  /** API only: real choices for how the school reaches you, saved on the server. */
  notificationChoices: boolean;
}

const ACCOUNT_ON_SUPABASE: AccountCapabilities = { editProfile: true, photo: true, calls: true, security: false, notificationChoices: false };
const ACCOUNT_ON_API: AccountCapabilities = { editProfile: false, photo: false, calls: false, security: true, notificationChoices: true };

export function accountCapabilities(): AccountCapabilities {
  return onApi() ? ACCOUNT_ON_API : ACCOUNT_ON_SUPABASE;
}

/** The Access & roles screen (admin/access). */
export interface AccessCapabilities {
  /** The school's own named roles ("Exams officer"): the API has no write path for them, so only areas given one by one exist. */
  schoolRoles: boolean;
  /** API only: who holds which admin areas, edited per person (needs `GET /v1/rbac/staff-areas`). */
  perPersonAreas: boolean;
}

const ACCESS_ON_SUPABASE: AccessCapabilities = { schoolRoles: true, perPersonAreas: false };
const ACCESS_ON_API: AccessCapabilities = { schoolRoles: false, perPersonAreas: true };

export function accessCapabilities(): AccessCapabilities {
  return onApi() ? ACCESS_ON_API : ACCESS_ON_SUPABASE;
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

/** The Report cards screens (admin/report-cards, teacher/report-cards). */
export interface ReportCardsCapabilities {
  /** Choose which exams count and configure optional sections (attendance, fees, activities, position, next term date). On the API, publishing always uses every published assessment for the class and term. */
  selectExamsAndOptions: boolean;
  /** Draft, send-to-families, and withdraw workflow (POST /report-cards publishes immediately with no draft or withdraw endpoint). */
  draftWorkflow: boolean;
  /** Per-learner class teacher and principal comments (not stored on the API's report_card_publications yet). */
  comments: boolean;
  /** Signing report cards and printing signatures on PDFs (waits on C12 / FIG-1880). */
  signatures: boolean;
  /** Bloom AI comment drafting (calls a Supabase edge function). */
  aiComments: boolean;
  /** Clearing a competency rating back to unrated (the API has no DELETE /competency-ratings endpoint yet). */
  clearCompetencyRating: boolean;
}

const REPORT_CARDS_ON_SUPABASE: ReportCardsCapabilities = {
  selectExamsAndOptions: true, draftWorkflow: true, comments: true, signatures: true, aiComments: true, clearCompetencyRating: true,
};

const REPORT_CARDS_ON_API: ReportCardsCapabilities = {
  selectExamsAndOptions: false, draftWorkflow: false, comments: false, signatures: false, aiComments: false, clearCompetencyRating: false,
};

export function reportCardsCapabilities(): ReportCardsCapabilities {
  return onApi() ? REPORT_CARDS_ON_API : REPORT_CARDS_ON_SUPABASE;
}

/** The admin Inventory screen (admin/inventory). */
export interface InventoryCapabilities {
  /** Editing an existing inventory item (no PATCH /inventory/items/{itemId} endpoint on API). */
  editItem: boolean;
  /** Putting a written-off item back on the register (no unretire endpoint; GET /inventory/items lists active items only). */
  unretireItem: boolean;
  /** Purchase date, unit cost, and item notes (not stored on the API's InventoryItem schema). */
  itemCostAndNotes: boolean;
  /** Closed-issue history tab and Lost counter (GET /inventory/issues lists open issues only). */
  issueHistory: boolean;
  /** Adding a note when issuing an item (POST /inventory/issues accepts no note; closing an issue does). */
  issueNote: boolean;
  /** Charging a learner's fees for lost or damaged items (waits on closed-issue history and charge-by-issue lookup). */
  chargeToFees: boolean;
}

const INVENTORY_ON_SUPABASE: InventoryCapabilities = {
  editItem: true,
  unretireItem: true,
  itemCostAndNotes: true,
  issueHistory: true,
  issueNote: true,
  chargeToFees: true,
};

const INVENTORY_ON_API: InventoryCapabilities = {
  editItem: false,
  unretireItem: false,
  itemCostAndNotes: false,
  issueHistory: false,
  issueNote: false,
  chargeToFees: false,
};

export function inventoryCapabilities(): InventoryCapabilities {
  return onApi() ? INVENTORY_ON_API : INVENTORY_ON_SUPABASE;
}

/** The chat screens (admin/chats, teacher/chats, staff/chats and the parent and learner ones that share them). */
export interface ChatCapabilities {
  /** Sending and opening files in a chat (waits on API file storage, A5 / FIG-1873; chat messages are text only). */
  attachments: boolean;
  /** Voice and video calls from a chat, and the school's call log (not in the API contract, C13). */
  calls: boolean;
  /** The office reading every chat in the school (the API shows a person only the chats they are in). */
  oversight: boolean;
  /** Unread counts: the menu badge, a bold name, the count on a chat (the API does not say what a person has read). */
  unreadCounts: boolean;
}

const CHAT_ON_SUPABASE: ChatCapabilities = { attachments: true, calls: true, oversight: true, unreadCounts: true };
const CHAT_ON_API: ChatCapabilities = { attachments: false, calls: false, oversight: false, unreadCounts: false };

export function chatCapabilities(): ChatCapabilities {
  return onApi() ? CHAT_ON_API : CHAT_ON_SUPABASE;
}

/** The notices inbox (teacher/notices, staff/notices). */
export interface NoticesCapabilities {
  /** Which notices a person has opened: the orange dot, the bold subject and the menu badge (the inbox does not say). */
  readState: boolean;
}

export function noticesCapabilities(): NoticesCapabilities {
  return { readState: !onApi() };
}

/**
 * Whether a teacher may send a message to one of their classes (teacher/messages). On Supabase every teacher may. On the
 * API a notice is written by whoever holds `resource.announcement.write`: the school office and anyone with the
 * Communication area, not a teacher by being a teacher.
 */
export function canMessageClasses(adminAreas: readonly string[]): boolean {
  return !onApi() || adminAreas.includes("communication");
}

/** Exams and marks: the admin Exams page, the teacher Gradebook, Performance and Reports. */
export interface GradesCapabilities {
  /** Rename an exam (the API has no change for an assessment's title). */
  renameExam: boolean;
  /** Delete an exam (the API has no delete for an assessment). */
  deleteExam: boolean;
  /** "Marks entered" on each exam of the Exams page (an assessment carries no mark count). */
  examMarkCounts: boolean;
  /** Take published marks back to draft (on the API a publication is final). */
  withdrawResults: boolean;
  /** Change a mark after it was published (the API takes a recorded correction with a reason instead). */
  editPublishedMarks: boolean;
  /** The CBE strand gradebook (a subject has no learning area on the API, so its strands cannot be found). */
  cbeGradebook: boolean;
  /** The higher-education gradebook (a section's assessments and marks; the API has one final grade per enrolment). */
  gpaGradebook: boolean;
  /** The CBE rubric charts and band tables of Performance and Reports. */
  cbeReports: boolean;
  /** API only: an exam is made of one paper per class and subject, each with its own status; the Exams page lists them and publishes them. */
  examPapers: boolean;
  /** API only: a mark may have decimals (the exam's `max_score` is a number, up to 10,000). */
  fractionalMarks: boolean;
}

const GRADES_ON_SUPABASE: GradesCapabilities = {
  renameExam: true, deleteExam: true, examMarkCounts: true, withdrawResults: true, editPublishedMarks: true,
  cbeGradebook: true, gpaGradebook: true, cbeReports: true, examPapers: false, fractionalMarks: false,
};

const GRADES_ON_API: GradesCapabilities = {
  renameExam: false, deleteExam: false, examMarkCounts: false, withdrawResults: false, editPublishedMarks: false,
  cbeGradebook: false, gpaGradebook: false, cbeReports: false, examPapers: true, fractionalMarks: true,
};

export function gradesCapabilities(): GradesCapabilities {
  return onApi() ? GRADES_ON_API : GRADES_ON_SUPABASE;
}

/**
 * What the signed-in person may do with grades on this backend, from what the API lets them read (a plain teacher reads far less
 * than a school admin). On Supabase everyone may do everything the screens offer.
 */
export interface GradesAccess {
  /** The Gradebook needs the school's terms, subjects, learners and the class's assessments. */
  gradebook: boolean;
  /** Said to the person when `gradebook` is false. */
  gradebookReason: string | null;
  /** Publish and close an exam's papers (the API holds this to the Academics area). */
  publish: boolean;
}

export const FULL_GRADES_ACCESS: GradesAccess = { gradebook: true, gradebookReason: null, publish: true };
