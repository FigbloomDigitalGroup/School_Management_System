// The new API's client side (FIG-1890). Schema types are in ./schema (generated; `npm run api:types`), not re-exported:
// import `paths` or `components` from "./api/schema" where a type is needed.
export * from "./errors";
export * from "./tokenStore";
export * from "./client";
export * from "./paging";
export * from "./poll";
export * from "./authApi";
export * from "./sessionLifecycle";
export * from "./qrCode";
export { apiLoadSchoolSession, adminAreasFromPermissions, accentFromApi, tenantFromApi, profileFromApi, roleOutsideSchools, viewOfMe, isRole, forgetApiSchools, type ApiSchoolSession, type MeView, type MembershipView } from "./sessionApi";
export * from "./sessionEvents";
export * from "./signInFlow";
export { apiLookupSchool, apiLoginWithSchool, schoolFromInput, parseSchoolLookup, SchoolNotFoundError, type SchoolLookup } from "./schoolLookupApi";
export { apiActiveRole, apiFetchOwnLearner, isNoLearnerError, type OwnLearner } from "./ownLearner";
export { weekFromFamilyTimetable, workItemFromFamily } from "./studentApi";
export { classGroupFromApi, termFromApi, subjectFromApi, yearNumberOf, listAcademicYears, listAcademicTerms, currentAcademicYear } from "./setupApi";
export {
  LearnerPlacementError, apiAddStaff, apiArchiveStaff, apiRestoreStaff, apiFetchArchivedStaff, apiAddGuardian, ImportRejectedError, apiImportLearners,
  IMPORT_BATCH_ROWS, peopleErrorText, readableApiError, type NewStaffMember, type NewGuardianContact, type ImportLearnerRow, type ImportOutcome, type ImportProblem,
} from "./peopleApi";
export {
  apiInviteStaff, apiRevokeStaffInvitation, apiInviteGuardian, apiListGuardianInvitations, apiRevokeGuardianInvitation, apiIssueMemberReset,
  guardianInviteMethod, acceptInviteLink, resetPasswordLink,
  type InvitationDelivery, type InvitationSent, type StaffInviteRole, type GuardianInviteMethod, type GuardianInvitation, type GuardianInvitationStatus,
} from "./invitationsApi";
export { recentAnnouncementFromApi, activeApiChannels } from "./announcementsApi";
export { feeItemFromApi } from "./feesApi";
export { earlySignOutFromApi, ATTENDANCE_WRITE_CONCURRENCY } from "./attendanceApi";
export { API_LEAVE_REASON_MIN, leaveRequestFromApi, leaveStatusFromApi } from "./leaveApi";
export { apiPublishClassReportCard, apiCanWriteCompetencyRatings, resetCompetencyRatingVersions } from "./reportCardsApi";
export { inventoryItemFromApi, inventoryIssueFromApi, INVENTORY_ISSUE_CONCURRENCY } from "./inventoryApi";
export {
  accessLockedReason, apiFetchAccessPeople, apiFetchStaffAreas, apiSetStaffAreas, apiFetchGuardianAccess, apiSetGuardianAccess, guardianAccessFromCodes, apiFetchOrgDelegations,
  apiRevokeOrgDelegations, describeDelegatedCode, GUARDIAN_READ, GUARDIAN_WRITE, type AccessPerson, type GuardianAccess, type OrgDelegation,
} from "./accessApi";
export { apiFetchMyProfile, apiFetchNotificationPreferences, apiSetNotificationPreferences, notificationPreferencesFromApi } from "./accountApi";
export {
  apiFetchChildMaterials, apiFetchChildReportCards, apiFetchParentMessages, levelOfChildClass, type FamilyMaterialView, type FamilyReportCardView,
} from "./parentApi";
export { apiAnswerMedicationConsent, type FamilyHealthView, type MedicationAuthorizationView } from "./parentHealthApi";
export { apiFetchFamilyRides, rideStatusText, ridesFromTransport, type FamilyRide, type RideStatus } from "./parentBusApi";
export { apiFetchMyStaffRecord, myStaffRecordFromApi, staffMayKeepVisitors, staffMayReadItems, type MyStaffRecord } from "./otherStaffApi";
export { API_BLOOM_PROMPT_MAX, apiFetchBloomReadiness, formatBloomPrompt, type BloomReadiness, type BloomScope } from "./aiApi";
export { SCHOOL_ACCESS_CODES, apiFetchMySchoolAccess, apiGrantSchoolAccess, apiRemoveSchoolAccess, orgHomePath } from "./orgApi";
export {
  apiCreatePlatformInvoice,
  apiFetchPlatformAuditEvents,
  apiFetchPlatformInvoices,
  apiFetchPlatformOpsStatus,
  apiFetchPlatformOrganization,
  apiFetchPlatformOrganizationAdmins,
  apiFetchPlatformOrganizations,
  apiFetchPlatformSubscriptions,
  apiFetchPlatformSchool,
  apiFetchPlatformSchoolAdmins,
  apiFetchPlatformSchools,
  apiFetchPlatformUsage,
  apiSetPlatformPlanPrice,
  apiUpdatePlatformSubscription,
  apiLoadPlatformSession,
  apiMarkPlatformInvoicePaid,
  apiProvisionSchool,
  parsePlatformOpsStatus,
  platformOrganizationFromApi,
  platformOrganizationToOrg,
  platformSchoolFromApi,
  platformSchoolToTenant,
  type OpsQueueStatus,
  type OpsReconciliationStatus,
  type OpsUnmatchedCasesStatus,
  type OpsWorkerStatus,
  type PlatformAdminItem,
  type PlatformAuditEventItem,
  type PlatformAuditPage,
  type PlatformBillingInvoice,
  type PlatformBillingInvoiceStatus,
  type PlatformOpsStatus,
  type PlatformPlanCode,
  type PlatformPlanPrice,
  type PlatformOrganizationItem,
  type PlatformSubscriptionItem,
  type PlatformSubscriptionUpdate,
  type PlatformSubscriptionsData,
  type PlatformSchoolItem,
  type PlatformSchoolOrganization,
  type PlatformUsageSchoolItem,
  type PlatformUsageSummary,
  type ProvisionSchoolInput,
  type ProvisionSchoolResult,
} from "./platformApi";
export { OpenRidersError, isOpenRidersError } from "./fleetApi";
export { feeTotalsFromInvoices } from "./adminOverviewApi";
export { apiQuestionsFromDrafts, apiCreateOnlineExamPaper, apiFetchMyTeachingPairs, apiPublishOnlineExamPaper } from "./examPapersApi";
export { apiCreateLearningMaterial } from "./materialsApi";
export { visitFromApi, apiSubscribeVisits } from "./visitorsApi";
export { apiFetchMyHomework, apiCreateHomework, apiFetchHomeworkSubjectsForClass } from "./homeworkApi";
export { auditEventFromApi, API_AUDIT_SEARCH_MAX, AUDIT_SYSTEM_ACTOR } from "./auditApi";

export * from "./orgSignupApi";
