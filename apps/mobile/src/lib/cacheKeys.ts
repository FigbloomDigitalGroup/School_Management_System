/**
 * Where the app keeps a copy of a family's or a learner's data, one entry per profile
 * (`<key>.<profileId>`), so the last-known balance and results stay readable with no signal.
 * Signing out deletes every entry under these keys (FIG-1489), so a key added here is cleaned up too.
 */
export const PARENT_CACHE_KEY = "figbloom.parentData.v1";
export const STUDENT_CACHE_KEY = "figbloom.studentData.v1";
export const CACHE_KEYS = [PARENT_CACHE_KEY, STUDENT_CACHE_KEY] as const;
