// The new API's client side (FIG-1890). Schema types are in ./schema (generated; `npm run api:types`), not re-exported:
// import `paths` or `components` from "./api/schema" where a type is needed.
export * from "./errors";
export * from "./tokenStore";
export * from "./client";
export * from "./paging";
export * from "./authApi";
export * from "./sessionLifecycle";
export * from "./qrCode";
export { apiLoadSchoolSession, adminAreasFromPermissions, accentFromApi, tenantFromApi, profileFromApi, roleOutsideSchools, viewOfMe, isRole, forgetApiSchools, type ApiSchoolSession, type MeView, type MembershipView } from "./sessionApi";
export * from "./sessionEvents";
export * from "./signInFlow";
export { classGroupFromApi, termFromApi, subjectFromApi, yearNumberOf, listAcademicYears, listAcademicTerms, currentAcademicYear } from "./setupApi";
export {
  LearnerPlacementError, apiAddStaff, apiArchiveStaff, apiRestoreStaff, apiFetchArchivedStaff, apiAddGuardian, ImportRejectedError, apiImportLearners,
  IMPORT_BATCH_ROWS, peopleErrorText, readableApiError, type NewStaffMember, type NewGuardianContact, type ImportLearnerRow, type ImportOutcome, type ImportProblem,
} from "./peopleApi";
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
