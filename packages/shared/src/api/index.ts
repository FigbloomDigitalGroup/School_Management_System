// The new API's client side (FIG-1890). Schema types are in ./schema (generated; `npm run api:types`), not re-exported:
// import `paths` or `components` from "./api/schema" where a type is needed.
export * from "./errors";
export * from "./tokenStore";
export * from "./client";
export * from "./paging";
export * from "./authApi";
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
