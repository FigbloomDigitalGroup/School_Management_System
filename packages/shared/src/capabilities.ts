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

/**
 * The school-setup screens: School settings, Classes, Subjects. A flag is true where that backend offers the control. The API side is
 * `PATCH` and `POST .../archive` on classes, `PATCH` on subjects, and `PATCH` and `POST .../archive` on teaching assignments (migration
 * 101); all need the Academics area, which is what opens these pages, so nobody who sees a control here is refused for lack of it.
 * What the API refuses for other reasons (a 400 or 409) reaches the person in the API's own words.
 */
export interface SetupCapabilities {
  /** Change a class's teacher after it was made, in the Classes list and the setup checklist's "Assign class teachers" step. The new teacher must be an active member of staff (400 otherwise). */
  changeClassTeacher: boolean;
  /**
   * Take a class off the list. On Supabase it is deleted. On the API it is ARCHIVED (`POST .../classes/{classId}/archive`): refused with 409
   * while an active learner is in the class, its teaching assignments end, and there is no restore. The screen words it "Archive" on the API.
   */
  deleteClass: boolean;
  /** A class's room: the Room column of the Classes list, and the Room field when a class is made. */
  classRoom: boolean;
  /** API only: change a class's room after it was made, in the Classes list. Supabase never offered it. */
  editClassRoom: boolean;
  /** Promote a class's learners at the year's end. Not on the API: it has no bulk move that ends memberships and places learners in the next year's class. */
  promoteClass: boolean;
  /** A class's weekly timetable grid editor. Not on the API: a timetable slot can be made and listed (`Timetable.classPeriods`) but not changed or removed. */
  classTimetable: boolean;
  /** Edit a subject once made: its name, code and, where `subjectDetails` is on, its years. The API refuses a code another subject has (409) and changes nothing on an archived subject. */
  editSubject: boolean;
  /** A subject's level and year range, shown and entered when a subject is made, and its core flag read. */
  subjectDetails: boolean;
  /** API only: change a subject's level and its core flag once made, in the Subjects list. Supabase never offered either on a subject that was made. */
  editSubjectLevelAndCore: boolean;
  /** "Add from KICD": subjects made from the KICD catalogue, linked to a learning area. Not on the API: a subject there has no link to a learning area. */
  kicdCatalogue: boolean;
  /** Change or clear who teaches a subject in a class once one is set. The new teacher must be an active member of staff (400 otherwise). */
  changeSubjectTeacher: boolean;
  /** The fee structure step of the setup checklist, and the payment methods form. */
  feeSetup: boolean;
  /** Upload the school's crest. */
  schoolCrest: boolean;
  /** The AI settings panel. */
  aiSettings: boolean;
}

const SETUP_ON_SUPABASE: SetupCapabilities = {
  changeClassTeacher: true, deleteClass: true, classRoom: true, editClassRoom: false, promoteClass: true, classTimetable: true,
  editSubject: true, subjectDetails: true, editSubjectLevelAndCore: false, kicdCatalogue: true, changeSubjectTeacher: true,
  feeSetup: true, schoolCrest: true, aiSettings: true,
};

const SETUP_ON_API: SetupCapabilities = {
  changeClassTeacher: true, deleteClass: true, classRoom: true, editClassRoom: true, promoteClass: false, classTimetable: false,
  editSubject: true, subjectDetails: true, editSubjectLevelAndCore: true, kicdCatalogue: false, changeSubjectTeacher: true,
  feeSetup: false, schoolCrest: false, aiSettings: false,
};

export function setupCapabilities(): SetupCapabilities {
  return onApi() ? SETUP_ON_API : SETUP_ON_SUPABASE;
}

/** The People screen: learners, staff and guardians. A flag is true where that backend offers the control. */
export interface PeopleCapabilities {
  /** Delete a learner for good (the API archives only). */
  deleteLearner: boolean;
  /** Learner login IDs: the Login column and "Create logins"; password resets are a separate capability. */
  learnerLogins: boolean;
  /** "Invite guardians" from the selected learners (parents' sign-in accounts, made with a login ID and password). */
  inviteGuardians: boolean;
  /** API only: invite a guardian record to sign in (one invitation per guardian and learner, by e-mail or SMS), send it again, cancel it. */
  guardianInvitations: boolean;
  /** API only: invite a staff member to sign in by e-mail, and issue a one-time password-reset link for a staff member who has a sign-in. */
  staffSignIn: boolean;
  /** The Guardian column (a placeholder on Supabase; guardians are read from a learner's own card on the API). */
  guardianColumn: boolean;
  /** Each learner's current-term fee status (Finance and Academics reads are required on the API). */
  learnerFees: boolean;
  /** The bulk "Change class" and "Export" buttons (toast-only stubs on Supabase; not offered on the API until they work). */
  bulkChangeClass: boolean;
  bulkExport: boolean;
  /** Home address and bus route, health details, bio data and its approval requests, documents, early sign-outs, activities. */
  learnerHome: boolean;
  learnerHealth: boolean;
  bioData: boolean;
  learnerDocuments: boolean;
  /** A learner's early sign-outs. On the API this is limited to full administrators and Attendance area holders. */
  learnerEarlySignOuts: boolean;
  /** The learner's clubs and teams. On the API this is limited to full administrators and Activities area holders. */
  learnerActivities: boolean;
  /** A learner's behaviour entries on their record (the behaviour log: docs/web-on-api/behaviour.md). On for everyone now. */
  learnerBehaviour: boolean;
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
  /** Take a learner out of their current class ("Unassigned"): the API archives the active membership and allows a later return. */
  unassignClass: boolean;
}

const PEOPLE_ON_SUPABASE: PeopleCapabilities = {
  deleteLearner: true, learnerLogins: true, inviteGuardians: true, guardianInvitations: false, staffSignIn: false, guardianColumn: true, learnerFees: true, bulkChangeClass: true, bulkExport: true,
  learnerHome: true, learnerHealth: true, bioData: true, learnerDocuments: true, learnerEarlySignOuts: true, learnerActivities: true, learnerBehaviour: true,
  photos: true, passwordResets: true, staffAccounts: true, staffSubjects: true, staffCalls: true, staffArchive: false, guardianContactForm: false,
  importByAreaHolders: true, learnerWithoutClass: false, unassignClass: true,
};

const PEOPLE_ON_API: PeopleCapabilities = {
  deleteLearner: false, learnerLogins: true, inviteGuardians: false, guardianInvitations: true, staffSignIn: true, guardianColumn: false, learnerFees: true, bulkChangeClass: false, bulkExport: false,
  learnerHome: false, learnerHealth: false, bioData: false, learnerDocuments: false, learnerEarlySignOuts: true, learnerActivities: true, learnerBehaviour: true,
  photos: false, passwordResets: false, staffAccounts: false, staffSubjects: false, staffCalls: false, staffArchive: true, guardianContactForm: true,
  importByAreaHolders: false, learnerWithoutClass: true, unassignClass: true,
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
  /** Naming a section's instructor (a staff record; `PATCH /he-sections/{id}`, migration 107). */
  sectionInstructor: boolean;
  /** A section's room and capacity. */
  sectionRoomAndCapacity: boolean;
  /** A section's weekly schedule. */
  sectionSchedule: boolean;
  /** Dropping a student from a section (an enrolment can be made, not ended). */
  dropEnrolment: boolean;
  /** "My sections" for a lecturer (`GET /me/teaching/he-sections`, which needs the instructor of a section). */
  mySections: boolean;
}

const COURSES_ON_SUPABASE: CoursesCapabilities = {
  courseDepartment: true, sectionInstructor: true, sectionRoomAndCapacity: true, sectionSchedule: true, dropEnrolment: true, mySections: true,
};
const COURSES_ON_API: CoursesCapabilities = {
  courseDepartment: false, sectionInstructor: true, sectionRoomAndCapacity: false, sectionSchedule: false, dropEnrolment: false, mySections: true,
};

export function coursesCapabilities(): CoursesCapabilities {
  return onApi() ? COURSES_ON_API : COURSES_ON_SUPABASE;
}

/** The admin Inventory screen (admin/inventory). */
export interface InventoryCapabilities {
  /**
   * Editing an existing inventory item, including a stock line's unit, consumable flag and reorder level (no PATCH
   * /inventory/items/{itemId} endpoint on API: these can be set when the item is added, and not changed afterwards).
   */
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
  /**
   * Consumables, stock in and out (received, used, wasted, adjusted), the unit and reorder level when an item is added, the
   * "Stock & kitchen" tab and its reports (`/inventory/movements`, `/stock-levels`, `/reports/*`: apps/api/docs/INVENTORY-STOCK.md).
   */
  stockMovements: boolean;
  /** The AI briefing on the flags ("AI insights"): the `stock_insights` task is not in the API's Bloom contract (INVENTORY-STOCK.md, "stock_insights"). */
  stockInsights: boolean;
  /**
   * Medicine given in the sick bay coming off a Medical stock line by itself, and counting as use in the reports. The API's sick bay does
   * not take medicine from stock, so there every use is recorded by hand (INVENTORY-STOCK.md, "What differs", 3).
   */
  sickBayUsesStock: boolean;
  /**
   * The most days one report request may cover (ledger, usage, spend, cost per meal: 400; flags: 366), or null for no limit. The
   * screens' periods fit; a term longer than this is cut to its last days.
   */
  reportMaxDays: number | null;
  /**
   * The current term's dates (for the "This term" period) are read from `GET /academic-terms`, which needs the Academics area (or
   * teaching a class): a person with only Inventory is refused, so "This term" is left out when the dates are not known. On Supabase
   * a member of staff reads them, and the period is always offered.
   */
  termDatesNeedAcademics: boolean;
}

const INVENTORY_ON_SUPABASE: InventoryCapabilities = {
  editItem: true,
  unretireItem: true,
  itemCostAndNotes: true,
  issueHistory: true,
  issueNote: true,
  chargeToFees: true,
  stockMovements: true,
  stockInsights: true,
  sickBayUsesStock: true,
  reportMaxDays: null,
  termDatesNeedAcademics: false,
};

const INVENTORY_ON_API: InventoryCapabilities = {
  editItem: false,
  unretireItem: false,
  itemCostAndNotes: false,
  issueHistory: false,
  issueNote: false,
  chargeToFees: false,
  stockMovements: true,
  stockInsights: false,
  sickBayUsesStock: false,
  reportMaxDays: 366,
  termDatesNeedAcademics: true,
};

export function inventoryCapabilities(): InventoryCapabilities {
  return onApi() ? INVENTORY_ON_API : INVENTORY_ON_SUPABASE;
}

/**
 * Whether the signed-in person may read their own issued items (`teacher/items`, `staff/items`).
 * On `apps/api`, `GET /inventory/issues` requires `resource.inventory.read`, held by school admins
 * and holders of the Inventory area (finding 13 / `staff-1`).
 */
export function canReadMyItems(adminAreas: readonly string[], role?: string): boolean {
  return !onApi() || role === "school_admin" || adminAreas.includes("inventory");
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
  /** Change a mark after it was published: inline on Supabase; as a recorded correction on the API. */
  editPublishedMarks: boolean;
  /** API only: replace a published mark through the append-only correction endpoint, with a reason and Academics write access. */
  recordPublishedMarkCorrections: boolean;
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
  recordPublishedMarkCorrections: false,
  cbeGradebook: true, gpaGradebook: true, cbeReports: true, examPapers: false, fractionalMarks: false,
};

const GRADES_ON_API: GradesCapabilities = {
  renameExam: false, deleteExam: false, examMarkCounts: false, withdrawResults: false, editPublishedMarks: true,
  recordPublishedMarkCorrections: true,
  cbeGradebook: false, gpaGradebook: false, cbeReports: true, examPapers: true, fractionalMarks: true,
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

/** The parent pages (parent/*): what a parent can do on this backend. A flag is true where that backend offers the control. */
export interface ParentCapabilities {
  /** Messages from the school: Home's "From the school" card and the Inbox (the notices read is not wired into the parent pages yet). */
  inbox: boolean;
  /** Mark a child's homework done (the API records no homework hand-in or done state). */
  homeworkDone: boolean;
  /** Worksheets and videos a teacher attached to homework (file storage, A5 / FIG-1873). */
  homeworkFiles: boolean;
  /** Opening a learning material's file (file storage, A5 / FIG-1873: the API holds the title and note only). */
  materialFiles: boolean;
  /** The live-class banner on Home (online classes are not on the API: C13). */
  liveClasses: boolean;
  /** Documents to sign: Home's "to sign" list, invoice and receipt signatures (C12 / FIG-1880). */
  signatures: boolean;
  /** "Call the school" on Home (voice and video are not on the API: C13). */
  calls: boolean;
  /** The child's bio data, health details and home address on Home (the family read has none of them, and no way to change them). */
  childProfile: boolean;
  /** Published results over time from the family-scoped results read (up to 500 rows across terms). */
  progressOverTime: boolean;
  /** Online exam papers and tests under Results (not in the family read). */
  examPapers: boolean;
  /** Missed or excused papers under an exam (not in the family read). */
  examAbsences: boolean;
  /** Download a report card as a PDF (the family read gives a summary, not the subject rows). */
  reportCardPdf: boolean;
  /** API only: report cards shown as a summary list. */
  familyReportCards: boolean;
  /** Fixtures, trips and awards under Sports & activities (the family read has clubs and teams only). */
  activityEvents: boolean;
  /** Ask the nurse to give a medicine, and withdraw a request (parents have no such write on the API). */
  medicationRequests: boolean;
  /** Notices from the sick bay (never written by the API: finding 15). */
  sickBayNotices: boolean;
  /** API only: the health details on file and the medicines waiting for a guardian's consent. */
  medicationConsent: boolean;
  /** The guardian's own transport notifications and mark-read action. */
  busUpdates: boolean;
  /** Send a payment proof (a slip or the pasted message): the proof's file needs object storage that is not set up (A5). */
  paymentProofSubmit: boolean;
  /** The school's own paybill, till and bank details under "How to pay" (a parent cannot read the school profile). */
  schoolPaymentDetails: boolean;
  /** Reset a child's learner login password from the parent's account page (learners have no sign-in accounts on the API yet: A4). */
  childLogins: boolean;
}

const PARENT_ON_SUPABASE: ParentCapabilities = {
  inbox: true, homeworkDone: true, homeworkFiles: true, materialFiles: true, liveClasses: true, signatures: true, calls: true, childProfile: true,
  progressOverTime: true, examPapers: true, examAbsences: true, reportCardPdf: true, familyReportCards: false, activityEvents: true,
  medicationRequests: true, sickBayNotices: true, medicationConsent: false, busUpdates: true, paymentProofSubmit: true, schoolPaymentDetails: true,
  childLogins: true,
};

const PARENT_ON_API: ParentCapabilities = {
  inbox: true, homeworkDone: false, homeworkFiles: false, materialFiles: false, liveClasses: false, signatures: false, calls: false, childProfile: false,
  progressOverTime: true, examPapers: false, examAbsences: false, reportCardPdf: false, familyReportCards: true, activityEvents: false,
  medicationRequests: false, sickBayNotices: false, medicationConsent: true, busUpdates: true, paymentProofSubmit: false, schoolPaymentDetails: false,
  childLogins: false,
};

export function parentCapabilities(): ParentCapabilities {
  return onApi() ? PARENT_ON_API : PARENT_ON_SUPABASE;
}

/** Sports and co-curricular activities (admin/activities and teacher/activities). */
export interface ActivitiesCapabilities {
  /** Edit, close or reopen an activity (no PATCH /activities/{activityId} endpoint). */
  editActivity: boolean;
  /** Delete an activity (no DELETE /activities/{activityId} endpoint). */
  deleteActivity: boolean;
  /** List existing patrons or remove a patron (API only has POST /activities/{activityId}/patrons). */
  listPatrons: boolean;
  /** Change a member's role after they are added (no PATCH /activities/{activityId}/members/{learnerId}, B11). */
  editMemberRole: boolean;
  /** Remove a member from an activity (no DELETE /activities/{activityId}/members/{learnerId}, B11). */
  removeMember: boolean;
  /** Fixtures, competitions, trips, performances, participants, results and telling families (no /activity-events endpoints). */
  events: boolean;
}

const ACTIVITIES_ON_SUPABASE: ActivitiesCapabilities = {
  editActivity: true, deleteActivity: true, listPatrons: true, editMemberRole: true, removeMember: true, events: true,
};

const ACTIVITIES_ON_API: ActivitiesCapabilities = {
  editActivity: false, deleteActivity: false, listPatrons: false, editMemberRole: false, removeMember: false, events: false,
};

export function activitiesCapabilities(): ActivitiesCapabilities {
  return onApi() ? ACTIVITIES_ON_API : ACTIVITIES_ON_SUPABASE;
}

/** The sick bay and medical screen (admin/medical). */
export interface MedicalCapabilities {
  /** List visits in a date range, including discharged visits (GET /health/sick-bay/board returns open visits only). */
  visitHistory: boolean;
  /** Set or edit a visit's time_in (server-stamped on create, not patchable). */
  editVisitTimeIn: boolean;
  /** Log medicine given at a visit or deduct from medical stock (no visit_medications or medical_stock endpoints). */
  visitMedications: boolean;
  /** Mark a learner excused or absent in today's attendance register from a visit (no medical_mark_attendance endpoint). */
  markVisitAttendance: boolean;
  /** School-wide medication round, schedules, doses and overdue banner (no GET /health/medications/schedules or school-wide MAR list). */
  medicationRound: boolean;
  /** School-wide pending guardian medication requests list and review (no GET /health/medications/authorizations). */
  medicationRequests: boolean;
  /** Sick-bay and medication compliance reports (needs date-range visit, schedule and dose lists). */
  reports: boolean;
  /** Whether sick-bay notices are emitted to guardians (the API persists the policy but reports guardian_notices_available: false). */
  guardianNoticesEmitted: boolean;
  /** Whether opening a learner's medical record is written to the audit trail (the API's profile and dose-record reads write no audit event). */
  recordOpenAudited: boolean;
}

const MEDICAL_ON_SUPABASE: MedicalCapabilities = {
  visitHistory: true, editVisitTimeIn: true, visitMedications: true, markVisitAttendance: true,
  medicationRound: true, medicationRequests: true, reports: true, guardianNoticesEmitted: true, recordOpenAudited: true,
};

const MEDICAL_ON_API: MedicalCapabilities = {
  visitHistory: false, editVisitTimeIn: false, visitMedications: false, markVisitAttendance: false,
  medicationRound: false, medicationRequests: false, reports: false, guardianNoticesEmitted: false, recordOpenAudited: false,
};

export function medicalCapabilities(): MedicalCapabilities {
  return onApi() ? MEDICAL_ON_API : MEDICAL_ON_SUPABASE;
}

/**
 * What the signed-in person may read on the sick bay screen, from the permissions the API gives them. The Medical area opens the
 * board and the visits, but not the learners' names or their health records: names need `resource.learner.read` (the People area)
 * and health records need `resource.medication.read` (school administrators only). On Supabase everyone with the page may read both.
 */
export interface MedicalAccess {
  /** Learners' names (the board, the learner box). */
  learners: boolean;
  /** Allergies, conditions and medication records. */
  healthRecords: boolean;
}

export const FULL_MEDICAL_ACCESS: MedicalAccess = { learners: true, healthRecords: true };

export const MEDICAL_LEARNERS_HIDDEN =
  "The new system does not let you read the school's learners with the access you have, so names are not shown on the board and you cannot search for a learner. Ask the school office to give you the People area as well.";
export const MEDICAL_HEALTH_HIDDEN =
  "Allergies, conditions and medication are not shown: the new system keeps health records to school administrators. Ask the learner before you give anything.";

/** The sentences the sick bay says when part of the screen is empty because of access (none when nothing is held back). */
export function medicalAccessNotes(access: MedicalAccess): string[] {
  const notes: string[] = [];
  if (!access.learners) notes.push(MEDICAL_LEARNERS_HIDDEN);
  if (!access.healthRecords) notes.push(MEDICAL_HEALTH_HIDDEN);
  return notes;
}

/** AI and Bloom screens: School assistant, Bloom study helper, and Bloom chat. */
export interface AiCapabilities {
  /** Saved Bloom chat history (list, open, rename, delete chats; apps/api has no chat persistence yet). */
  savedChats: boolean;
  /** Web search toggle and web citations in Bloom chat (not in the bloom-school/1 contract). */
  webSearch: boolean;
  /** Attaching files from Google Drive to Bloom chat questions (bloom-school/1 takes text prompts only). */
  chatAttachments: boolean;
  /** Maximum characters in one Bloom prompt (4,000 on bloom-school/1; 12,000 on Supabase). */
  promptMaxChars: number;
  /** Structured School assistant setup plans (creating classes, subjects, terms, exams, fees; bloom-school/1 has tools: []). */
  guideSetupPlans: boolean;
  /** Structured AI drafting (lesson plans, paper import, report comments, questions, homework, message drafting/translation; C13). */
  aiDrafting: boolean;
  /** Per-learner monthly question and token usage counts on the Study helper roster (not tracked by the API yet). */
  studyHelperUsage: boolean;
  /** The whole chat goes in one prompt (apps/api takes one prompt, not a list of turns), so Bloom reads only the newest part of a long chat. */
  chatInOnePrompt: boolean;
  /** A switch in School settings that turns Bloom on or off for the school (on apps/api Bloom is on once the school has study helper settings, and has no switch). */
  schoolSwitch: boolean;
}

const AI_ON_SUPABASE: AiCapabilities = {
  savedChats: true,
  webSearch: true,
  chatAttachments: true,
  promptMaxChars: 12_000,
  guideSetupPlans: true,
  aiDrafting: true,
  studyHelperUsage: true,
  chatInOnePrompt: false,
  schoolSwitch: true,
};

const AI_ON_API: AiCapabilities = {
  savedChats: false,
  webSearch: false,
  chatAttachments: false,
  promptMaxChars: 4_000,
  guideSetupPlans: false,
  aiDrafting: false,
  studyHelperUsage: false,
  chatInOnePrompt: true,
  schoolSwitch: false,
};

export function aiCapabilities(): AiCapabilities {
  return onApi() ? AI_ON_API : AI_ON_SUPABASE;
}

/**
 * Buses, fleet and the driver's pages: admin/fleet, teacher/buses, driver, driver/profile. A flag is true where that backend
 * offers the control. The API can add a route and its stops but cannot list them, and it has no read of who drives which vehicle,
 * so most of what the maps and tables show about a route stays hidden (docs/WEB_ON_THE_NEW_API.md, "Buses, fleet and driver").
 */
export interface FleetCapabilities {
  /** Reading and saving a route's stops: the stops under the maps, the stop editor, "Next stop" on the driver's screen (the API has no read of stops). */
  routeStops: boolean;
  /** Who rides a route, and "Rebuild stops from riders' homes" (no list of a route's riders, no learner home on the API). */
  routeRiders: boolean;
  /** Who drives which vehicle, as the office sees it: the Driver & route column, the Assigned count, "Currently ..." (the API has no read of assignments). */
  assignments: boolean;
  /** Speeding and off-route alerts raised by the server (the API raises none). */
  speedAlerts: boolean;
  /** API only: a driver's breakdown report (an "incident" on the trip) shown to the office as an alert. */
  tripIncidents: boolean;
  /** "Undo" on a child's mark (the API's trip events cannot be taken back). */
  undoRiderMark: boolean;
  /** A breakdown report tells the families of the children affected (on the API only the office is told, and tells families itself). */
  breakdownTellsFamilies: boolean;
  /** The driver's own screen follows the bus on the live feed (a driver may not read the fleet on the API; their phone's own position is used). */
  driverLiveFeed: boolean;
  /** Each trip's number of alerts in the trip history. */
  tripAlertCounts: boolean;
}

const FLEET_ON_SUPABASE: FleetCapabilities = {
  routeStops: true, routeRiders: true, assignments: true, speedAlerts: true, tripIncidents: false, undoRiderMark: true,
  breakdownTellsFamilies: true, driverLiveFeed: true, tripAlertCounts: true,
};

const FLEET_ON_API: FleetCapabilities = {
  routeStops: false, routeRiders: false, assignments: false, speedAlerts: false, tripIncidents: true, undoRiderMark: false,
  breakdownTellsFamilies: false, driverLiveFeed: false, tripAlertCounts: false,
};

export function fleetCapabilities(): FleetCapabilities {
  return onApi() ? FLEET_ON_API : FLEET_ON_SUPABASE;
}

/**
 * The organisation console (S11, apps/api/docs/ORG-CONSOLE.md). On the API an org admin reads their organisations, the
 * schools in them (name, address, status), the other org admins and their own audit events, and gives or takes away a
 * co-admin's access inside one school. The rest waits on an owner decision or on the platform console.
 */
export interface OrgCapabilities {
  /** Learners, attendance today and fees billed and collected per school (owner decision 4: which figures an org admin may see). */
  schoolFigures: boolean;
  /** A school's kind (K-12 or higher-ed) and delivery: the API's organisation school list does not carry them. */
  schoolKind: boolean;
  /** "Add school": on the API a school is provisioned by a platform super admin only. */
  addSchool: boolean;
  /** "Open for sign-in": on the API a school opens when its first administrator accepts the invitation. */
  openForSignIn: boolean;
  /** A school's own administrators on its page (a school-level read an org admin does not hold). */
  schoolAdmins: boolean;
  /** "Open school console": API entry requires delegated tenant.read and is limited to delegated admin areas. */
  openSchoolConsole: boolean;
  /** "Invite admin" (owner decision 1: who may add an org admin). */
  inviteOrgAdmin: boolean;
  /** "+ Create new organization" from the workspace switcher (no self-service organisations on the API). */
  createOrganization: boolean;
  /** Every console page view is logged and listed (Supabase). On the API the Audit log lists the person's own recorded actions. */
  pageViewLog: boolean;
  /** Give or take away a co-admin's access inside one school (API delegations; on Supabase an org admin already runs every school). */
  schoolAccess: boolean;
}

const ORG_ON_SUPABASE: OrgCapabilities = {
  schoolFigures: true, schoolKind: true, addSchool: true, openForSignIn: true, schoolAdmins: true, openSchoolConsole: true,
  inviteOrgAdmin: true, createOrganization: true, pageViewLog: true, schoolAccess: false,
};

const ORG_ON_API: OrgCapabilities = {
  schoolFigures: false, schoolKind: false, addSchool: false, openForSignIn: false, schoolAdmins: false, openSchoolConsole: true,
  inviteOrgAdmin: false, createOrganization: false, pageViewLog: false, schoolAccess: true,
};

export function orgCapabilities(): OrgCapabilities {
  return onApi() ? ORG_ON_API : ORG_ON_SUPABASE;
}

/** The admin home screens (admin: AdminDashboard and AreasHome). */
export interface DashboardCapabilities {
  /** "Waiting for your signature" banner on AdminDashboard (signatures wait on C12 / FIG-1880). */
  pendingSignatures: boolean;
  /** "Needs cover this week" card on AdminDashboard (per-period cover for approved leave has no API counterpart; finding 44). */
  periodCoverage: boolean;
}

const DASHBOARD_ON_SUPABASE: DashboardCapabilities = { pendingSignatures: true, periodCoverage: true };
const DASHBOARD_ON_API: DashboardCapabilities = { pendingSignatures: false, periodCoverage: false };

export function dashboardCapabilities(): DashboardCapabilities {
  return onApi() ? DASHBOARD_ON_API : DASHBOARD_ON_SUPABASE;
}

/** Online exam papers & tests (admin/papers, later teacher/exams). */
export interface ExamPapersCapabilities {
  /** Read-only PDF/typed papers alongside online MCQ papers (API only has /online-exam-papers). */
  readMode: boolean;
  /** Paper instructions, open/close window, duration timer, and paper kind (exam vs assessment). */
  scheduling: boolean;
  /** Reference sheet / PDF file uploads on papers (not part of /online-exam-papers). */
  fileAttachments: boolean;
  /** Linking a paper to a term exam so scores flow to the Gradebook. */
  examLink: boolean;
  /**
   * A new paper is a draft that learners cannot see until the office publishes it: the Status column and the Publish button
   * (`published_at` and `POST .../online-exam-papers/{paperId}/publish`, migration 110). Taking it back is `unpublishPaper`.
   */
  draftWorkflow: boolean;
  /**
   * Taking a published paper back to a draft. Hidden on the API build by design, not for a missing screen: the API has no
   * unpublish, because a learner may already have started the paper (`publishOnlinePaper` in `apps/api/src/modules/academics/
   * higherEd.ts`; "Online exams" in `apps/api/docs/STUDENT-ACCOUNTS.md`).
   */
  unpublishPaper: boolean;
  /** Editing a paper or its questions after creation (no PATCH /online-exam-papers/{id} endpoint). */
  editPaper: boolean;
  /** Deleting a paper (no DELETE /online-exam-papers/{id} endpoint). */
  deletePaper: boolean;
  /** Short and long written questions with model answers (API accepts mcq and true_false only). */
  writtenQuestions: boolean;
  /** Viewing learner attempts/scripts, marking written answers, releasing results, extensions and excusals (no GET attempts endpoint). */
  scripts: boolean;
  /** Maximum characters per question prompt (1,000 on API vs 4,000 on Supabase). */
  promptMaxChars: number;
  /**
   * API only: the paper editor makes a paper in one call (`POST /online-exam-papers` carries the title, total marks and the
   * multiple-choice questions), then publishes it if asked (so it needs `draftWorkflow`). The Supabase editor saves a paper in
   * steps (details, typed text, file, questions) and can reopen it. Turn this off when the API can edit a paper and takes the
   * full paper form.
   */
  oneStepCreate: boolean;
}

const EXAM_PAPERS_ON_SUPABASE: ExamPapersCapabilities = {
  readMode: true, scheduling: true, fileAttachments: true, examLink: true, draftWorkflow: true, unpublishPaper: true,
  editPaper: true, deletePaper: true, writtenQuestions: true, scripts: true, promptMaxChars: 4000, oneStepCreate: false,
};

const EXAM_PAPERS_ON_API: ExamPapersCapabilities = {
  readMode: false, scheduling: false, fileAttachments: false, examLink: false, draftWorkflow: true, unpublishPaper: false,
  editPaper: false, deletePaper: false, writtenQuestions: false, scripts: false, promptMaxChars: 1000, oneStepCreate: true,
};

export function examPapersCapabilities(): ExamPapersCapabilities {
  return onApi() ? EXAM_PAPERS_ON_API : EXAM_PAPERS_ON_SUPABASE;
}

/**
 * Whether the signed-in person may read and create online exam papers on `teacher/exams` (`GET/POST /online-exam-papers`
 * require `resource.academics.read` / `resource.academics.write`, held by school admins and holders of the Academics area).
 */
export function canManageExamPapers(adminAreas: readonly string[], role?: string): boolean {
  return !onApi() || role === "school_admin" || adminAreas.includes("academics");
}

/** Learning materials (admin/materials, later teacher/materials). */
export interface MaterialsCapabilities {
  /** Uploading files to object storage or attaching external links (API stores title/description metadata only). */
  filesAndLinks: boolean;
  /** Draft / publish / unpublish workflow (POST /learning-materials creates live entries immediately). */
  draftWorkflow: boolean;
  /** Editing a material after creation (no PATCH /learning-materials/{id} endpoint). */
  editMaterial: boolean;
  /** Deleting a material (no DELETE /learning-materials/{id} endpoint). */
  deleteMaterial: boolean;
}

const MATERIALS_ON_SUPABASE: MaterialsCapabilities = {
  filesAndLinks: true, draftWorkflow: true, editMaterial: true, deleteMaterial: true,
};

const MATERIALS_ON_API: MaterialsCapabilities = {
  filesAndLinks: false, draftWorkflow: false, editMaterial: false, deleteMaterial: false,
};

export function materialsCapabilities(): MaterialsCapabilities {
  return onApi() ? MATERIALS_ON_API : MATERIALS_ON_SUPABASE;
}

/**
 * Whether the signed-in person may read and add learning materials on `teacher/materials` (`GET/POST /learning-materials`
 * require `resource.academics.read` / `resource.academics.write`, held by school admins and holders of the Academics area).
 */
export function canManageMaterials(adminAreas: readonly string[], role?: string): boolean {
  return !onApi() || role === "school_admin" || adminAreas.includes("academics");
}

/** Gate & reception visitor log (admin/visitors, teacher/visitors and staff/visitors). */
export interface VisitorsCapabilities {
  /** Escalating an existing visit to the principal's office after arrival (API escalates principal visits on creation only). */
  escalateAfterArrival: boolean;
}

const VISITORS_ON_SUPABASE: VisitorsCapabilities = { escalateAfterArrival: true };
const VISITORS_ON_API: VisitorsCapabilities = { escalateAfterArrival: false };

export function visitorsCapabilities(): VisitorsCapabilities {
  return onApi() ? VISITORS_ON_API : VISITORS_ON_SUPABASE;
}

/** Teacher homework management (teacher/homework). */
export interface HomeworkCapabilities {
  /** Editing a homework item after it is set. */
  editHomework: boolean;
  /** Archiving a homework item after it is set. */
  deleteHomework: boolean;
  /** Choosing how learners hand work in. */
  handInMethod: boolean;
  /** Structured "For parents" guide. */
  parentGuide: boolean;
  /** Reading handed-in submission counts (API has no homework submission endpoint yet). */
  submissions: boolean;
  /** Attaching files or links to homework (waits on API file storage, A5 / FIG-1873). */
  attachments: boolean;
  /** Leaving instructions blank. */
  optionalInstructions: boolean;
}

const HOMEWORK_ON_SUPABASE: HomeworkCapabilities = {
  editHomework: true,
  deleteHomework: true,
  handInMethod: true,
  parentGuide: true,
  submissions: true,
  attachments: true,
  optionalInstructions: true,
};

const HOMEWORK_ON_API: HomeworkCapabilities = {
  editHomework: true,
  deleteHomework: true,
  handInMethod: true,
  parentGuide: true,
  submissions: false,
  attachments: false,
  optionalInstructions: true,
};

export function homeworkCapabilities(): HomeworkCapabilities {
  return onApi() ? HOMEWORK_ON_API : HOMEWORK_ON_SUPABASE;
}

/**
 * Whether the signed-in person may read and set homework on `teacher/homework`. On Supabase every teacher may. On the
 * API `GET/POST /homework-items` require `resource.academics.read/write` (school administrators and holders of the
 * Academics area).
 */
export function canManageHomework(adminAreas: readonly string[], role?: string): boolean {
  return !onApi() || role === "school_admin" || adminAreas.includes("academics");
}

/** The audit log screen (admin/audit). */
export interface AuditCapabilities {
  /**
   * Opening an event to see which fields of which record changed, with the values. The API's audit rows carry no detail, by design
   * (it can hold names, amounts and health information, and its shape differs by event): a row says what happened, who and when.
   */
  fieldChanges: boolean;
  /**
   * "Every change made in the school". On the API the log is the school's business events only: sign-in, session and two-step events,
   * refusals, read events, personal settings and any kind of event nobody classified on purpose are never shown to a school.
   */
  everyChange: boolean;
}

const AUDIT_ON_SUPABASE: AuditCapabilities = { fieldChanges: true, everyChange: true };
const AUDIT_ON_API: AuditCapabilities = { fieldChanges: false, everyChange: false };

export function auditCapabilities(): AuditCapabilities {
  return onApi() ? AUDIT_ON_API : AUDIT_ON_SUPABASE;
}

/**
 * The Figbloom platform console (`/platform/*`, `super_admin`).
 * On the API build (slice P2 of `apps/api/docs/PLATFORM-CONSOLE.md`), only the Tenants directory + onboarding
 * (`GET/POST /v1/platform/schools`) and System health (`GET /v1/platform/ops/status`) are backed; every other page
 * and every unbacked or invented widget is hidden until its API slice or owner decision lands.
 */
export interface PlatformCapabilities {
  /** `/platform/organizations` — needs platform organisations read endpoints (slice P3) and Q1 for lifecycle. */
  organizationsPage: boolean;
  /** `/platform/curriculum` — blocked on owner decision Q6 (platform-verified vs per-school KICD catalogue). */
  curriculumPage: boolean;
  /** `/platform/usage` — needs counts-only owner function (slice P4) and Q2 for licensed seats. */
  usagePage: boolean;
  /** `/platform/incidents` — hand-typed incident list backed by migration 121 and the platform incident routes. */
  incidentsPage: boolean;
  /** `/platform/subscriptions` — needs the platform billing API (slice S6a, D3). */
  subscriptionsPage: boolean;
  /** `/platform/invoices` — backed by the API billing endpoints and the S6c API page. */
  invoicesPage: boolean;
  /** `/platform/impersonation` — blocked on owner decision Q3 (impersonation / explicit support sessions). */
  impersonationPage: boolean;
  /** `/platform/audit` — needs platform-wide audit read endpoint (slice P5) and Q5 retention policy. */
  auditPage: boolean;
  /**
   * What each school's detail on `platform/tenants` shows besides its directory record: headcounts (active learners, staff and guardian
   * links, `GET /v1/platform/usage`), its plan, price and renewal (`GET /v1/platform/subscriptions`), and its Figbloom invoice balance
   * (`GET /v1/platform/invoices`). All three reads are counts or money records the platform already owns. MRR and seats are the next flag.
   */
  tenantFiguresAndBilling: boolean;
  /**
   * MRR and learner seats (licensed against used) on `platform/tenants`. Hidden on the API build by decision, not by a missing read:
   * the API owns Figbloom's billing (Q2, 2026-11-25) but no plan has a seat count, and a revenue figure worked out from list prices
   * and trials would be an estimate shown as a fact ("do not invent MRR or seat counts", `docs/web-on-api/platform-console.md`).
   */
  tenantMrrAndSeats: boolean;
  /** Activate, suspend, reactivate and move between organisations on `platform/tenants` (Q1 / R5). */
  tenantLifecycleActions: boolean;
  /** School administrators list/invite/remove on `platform/tenants` (slice P3). */
  tenantAdminsPanel: boolean;
  /** Illustrative "Daily active users" and "Role adoption" widgets (risk R6: never shown on the API build). */
  tenantIllustrativeCharts: boolean;
  /** Live external provider pings (Supabase/M-Pesa/Resend/Storage/Bloom) on `platform/health` (Q7). */
  liveProviderChecks: boolean;
}

const PLATFORM_ON_SUPABASE: PlatformCapabilities = {
  organizationsPage: true,
  curriculumPage: true,
  usagePage: true,
  incidentsPage: true,
  subscriptionsPage: true,
  invoicesPage: true,
  impersonationPage: true,
  auditPage: true,
  tenantFiguresAndBilling: true,
  tenantMrrAndSeats: true,
  tenantLifecycleActions: true,
  tenantAdminsPanel: true,
  tenantIllustrativeCharts: true,
  liveProviderChecks: true,
};

const PLATFORM_ON_API: PlatformCapabilities = {
  organizationsPage: true,
  curriculumPage: false,
  usagePage: true,
  incidentsPage: true,
  subscriptionsPage: true,
  invoicesPage: true,
  impersonationPage: false,
  auditPage: true,
  tenantFiguresAndBilling: true,
  tenantMrrAndSeats: false,
  tenantLifecycleActions: false,
  tenantAdminsPanel: true,
  tenantIllustrativeCharts: false,
  liveProviderChecks: false,
};

export function platformCapabilities(): PlatformCapabilities {
  return onApi() ? PLATFORM_ON_API : PLATFORM_ON_SUPABASE;
}

/**
 * The student pages (student/*): what a learner can do on this backend. A flag is true where that backend offers the control. The
 * API serves a learner the same family reads a parent has, plus their own record, exams and chat (apps/api/docs/STUDENT-ACCOUNTS.md);
 * what it does not give is listed in docs/web-on-api/student-pages.md (findings student-web-N).
 */
export interface StudentCapabilities {
  /** "Mark as handed in", the Done tab, and overdue state (the API has no learner submission or done-status endpoint). */
  homeworkDone: boolean;
  /** The teacher's worksheets and videos on a piece of work, and attaching a file to hand in (file storage, A5 / FIG-1873). */
  homeworkFiles: boolean;
  /** The teacher's name and the hand-in method on the learner's family-scoped homework read. */
  homeworkDetails: boolean;
  /** Opening a learning material's file (file storage, A5 / FIG-1873: the API holds the title and note only). */
  materialFiles: boolean;
  /** The live-class banner on Today (online classes are not on the API: C13). */
  liveClasses: boolean;
  /** A higher-education learner's timetable and course results (no read of a learner's own sections or grades on the API: student-web-4). */
  higherEdPages: boolean;
  /** Published results over time from the learner's own family-scoped results read (up to 500 rows across terms). */
  progressOverTime: boolean;
  /** Missed or excused papers under an exam (not in the learner's read). */
  examAbsences: boolean;
  /** Download a report card as a PDF (the learner read gives a summary, not the subject rows; the PDF is made per class). */
  reportCardPdf: boolean;
  /** API only: report cards shown as a summary list. */
  familyReportCards: boolean;
  /** Invoice and receipt signatures on Fees (signatures wait on C12 / FIG-1880). */
  signatures: boolean;
  /** Send a proof of payment (a slip or the pasted message): the proof's file needs object storage that is not set up (A5). */
  paymentProofSubmit: boolean;
  /** "Your score", released results and a review of a marked paper under Exams & tests (the API marks a learner's attempt but tells them no score). */
  examScores: boolean;
  /** The study helper's checks of the learner's opt-in at an opt-in school and of an exam being open (the API's /ai/query does neither: student-6). */
  studyHelperChecks: boolean;
}

const STUDENT_ON_SUPABASE: StudentCapabilities = {
  homeworkDone: true, homeworkFiles: true, homeworkDetails: true, materialFiles: true, liveClasses: true, higherEdPages: true,
  progressOverTime: true, examAbsences: true, reportCardPdf: true, familyReportCards: false,
  signatures: true, paymentProofSubmit: true, examScores: true, studyHelperChecks: true,
};

const STUDENT_ON_API: StudentCapabilities = {
  homeworkDone: false, homeworkFiles: false, homeworkDetails: true, materialFiles: false, liveClasses: false, higherEdPages: false,
  progressOverTime: true, examAbsences: false, reportCardPdf: false, familyReportCards: true,
  signatures: false, paymentProofSubmit: false, examScores: false, studyHelperChecks: false,
};

export function studentCapabilities(): StudentCapabilities {
  return onApi() ? STUDENT_ON_API : STUDENT_ON_SUPABASE;
}
