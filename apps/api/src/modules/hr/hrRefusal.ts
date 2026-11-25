import { AppError, rateLimited, validationError } from "../../http/errors.js";
import { hrErrorCode, hrMessage, type HrAnswer } from "../../platform/hrApi.js";

/**
 * Figbloom HR's refusals as the API answers them: ONE table for every route that calls HR (docs/MY-HR.md), so My HR, and the
 * leave and hand-off routes added later, read the same sentence, status and code for the same refusal. It is the table in the
 * header of the Supabase function `my-hr` (supabase/functions/my-hr/index.ts), in the API's error shape
 * `{ error: { code, message } }` (codes in http/errors.ts and the OpenAPI `Error` enum).
 *
 *   HR said                                          the API answers
 *   404 not_linked, or {"status":"pending_hr"}      404 not_linked / pending_hr: "Your HR record isn't ready yet. ..."
 *   404 otherwise                                   404 not_found (`notFound` says what was not found)
 *   400, 422                                        400 validation_error, HR's sentence when it is a short plain one
 *   409                                             409 conflict
 *   401, school_not_linked, invalid_token           502 hr_not_connected (HR does not accept Schools for this school)
 *   403 otherwise                                   403 hr_forbidden
 *   429                                             429 rate_limited, with HR's Retry-After
 *   503 my_hr_off                                   503 hr_off     <- HR's own switch; the SAME answer on every route
 *   anything else (5xx, ...)                        503 hr_unavailable
 *
 * Not here yet: the rows only the HR-run leave and approval routes can meet (approver_not_linked, leave_rules, not_cancellable,
 * already_decided, approver_no_access, not_your_approval, 413 too_large). The slice that adds those routes adds them to
 * `refusalFromHr`, with their error codes, so that there stays one table.
 *
 * Nothing HR sent is logged here, and HR's words are used only when they are a short plain sentence for a 400, 409, 422 or 403.
 */

export const NOT_READY = "Your HR record isn't ready yet. Ask the school's HR administrator.";
export const HR_UNAVAILABLE = "HR & Payroll can't be reached right now. Try again in a minute.";
export const HR_NOT_CONNECTED = "Figbloom HR isn't connected to this school yet. Ask Figbloom.";
export const HR_OFF = "My HR is switched off in Figbloom HR for now. Try again later.";
export const HR_RATE_LIMITED = "You've opened My HR many times in the last few minutes. Wait a few minutes and try again.";
const GENERIC_REFUSAL = "HR couldn't take that. Check the details and try again.";

/** HR was not reached, or the platform token could not be had: 503, try again in a minute. */
export const hrUnavailable = (): AppError => new AppError(503, "hr_unavailable", HR_UNAVAILABLE, true, 30);

/** HR answered with something that is not JSON, or too much of it: 502. */
export const hrBadAnswer = (): AppError => new AppError(502, "hr_bad_answer", HR_UNAVAILABLE, true, 30);

export interface HrRefusalOptions {
  /** The sentence for a 404 that is not "your record is not ready" (a payslip that is not there, a missing application). */
  notFound?: string;
}

/** The API's error for an HR answer that is not a success (`answer.status` outside 2xx). */
export function refusalFromHr(answer: Pick<HrAnswer, "status" | "json" | "retryAfterSeconds">, options: HrRefusalOptions = {}): AppError {
  const code = hrErrorCode(answer.json);
  const said = hrMessage(answer.json);
  const { status } = answer;
  if (code === "not_linked" || code === "pending_hr") return new AppError(404, code, NOT_READY);
  if (status === 404) return new AppError(404, "not_found", options.notFound ?? "That isn't available in HR.");
  if (status === 400 || status === 422) return validationError(said ?? GENERIC_REFUSAL);
  if (status === 409) return new AppError(409, "conflict", said ?? "That can't be done any more. Reload and try again.");
  if (status === 401 || code === "school_not_linked" || code === "invalid_token") {
    return new AppError(502, "hr_not_connected", HR_NOT_CONNECTED);
  }
  if (status === 403) return new AppError(403, "hr_forbidden", said ?? "Figbloom HR didn't allow that.");
  if (status === 429) return rateLimited(HR_RATE_LIMITED, answer.retryAfterSeconds ?? 60);
  if (status === 503 && code === "my_hr_off") return new AppError(503, "hr_off", HR_OFF);
  return hrUnavailable();
}
