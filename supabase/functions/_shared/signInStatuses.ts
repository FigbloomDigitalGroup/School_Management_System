/**
 * The school statuses whose teachers, parents and learners may sign in. A school
 * on trial or one with an overdue invoice is still a working school: the platform
 * never suspends on a first overdue invoice, so locking its users out before that
 * would hand the school's own staff the bill. `onboarding` waits for Figbloom staff
 * to activate the school, and `setup_stalled` and `suspended` are deliberate stops.
 */
export const SIGN_IN_STATUSES = ["active", "trial", "overdue"];

export const canSignIn = (status: unknown): boolean => SIGN_IN_STATUSES.includes(String(status));

/**
 * The schools the sign-in picker lists: those that can sign in, and suspended
 * ones, so their people can pick their school and be told it is suspended
 * (resolve-login-id) instead of finding nothing. Listing a suspended school
 * says only that it exists, which its name in the picker always did; the
 * suspension itself is said once an ID is entered for it.
 */
export const SEARCHABLE_STATUSES = [...SIGN_IN_STATUSES, "suspended"];

/**
 * What resolve-login-id answers for a suspended school, with code
 * "school_suspended". The same words as SUSPENDED_SCHOOL_MESSAGE in
 * packages/shared/src/suspended.ts (scripts/suspendedMessage.test.ts checks
 * they match). Never the reason.
 */
export const SUSPENDED_SCHOOL_MESSAGE =
  "Your school's account is suspended. Please contact your school's administrator or Figbloom support.";
