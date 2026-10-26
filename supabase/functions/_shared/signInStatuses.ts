/**
 * The school statuses whose teachers, parents and learners may sign in. A school
 * on trial or one with an overdue invoice is still a working school: the platform
 * never suspends on a first overdue invoice, so locking its users out before that
 * would hand the school's own staff the bill. `onboarding` waits for Figbloom staff
 * to activate the school, and `setup_stalled` and `suspended` are deliberate stops.
 */
export const SIGN_IN_STATUSES = ["active", "trial", "overdue"];

export const canSignIn = (status: unknown): boolean => SIGN_IN_STATUSES.includes(String(status));
