import { AppError, rateLimited, validationError, type ErrorDetail } from "../../http/errors.js";
import { isRecord } from "../../platform/http.js";
import { hrErrorCode, hrMessage, type HrAnswer } from "../../platform/hrApi.js";

/**
 * Figbloom HR's refusals as the API answers them: ONE table for every route that calls HR (docs/MY-HR.md), so My HR, and the
 * leave and hand-off routes, read the same sentence, status and code for the same refusal. It is the table in the header of
 * the Supabase function `my-hr` (supabase/functions/my-hr/index.ts), in the API's error shape `{ error: { code, message } }`
 * (codes in http/errors.ts and the OpenAPI `Error` enum).
 *
 *   HR said                                          the API answers
 *   404 not_linked, or {"status":"pending_hr"}      404 not_linked / pending_hr: "Your HR record isn't ready yet. ..."
 *   approver_not_linked (any status)                409 approver_not_linked: "Open HR & Payroll once to connect your HR account."
 *   404 otherwise                                   404 not_found (`notFound` says what was not found)
 *   422 leave_rules                                 422 leave_rules, HR's sentence, one `details` line per rule (at most 20)
 *   400, 422 otherwise                              400 validation_error, HR's sentence when it is a short plain one
 *   409 not_cancellable, already_decided            409 with that code and HR's sentence
 *   409 otherwise                                   409 conflict
 *   401, school_not_linked, invalid_token           502 hr_not_connected (HR does not accept Schools for this school)
 *   403 approver_no_access, not_your_approval       403 with that code and HR's sentence
 *   403 otherwise                                   403 hr_forbidden
 *   413                                             413 document_too_large
 *   429                                             429 rate_limited, with HR's Retry-After
 *   503 my_hr_off                                   503 hr_off     <- HR's own switch; the SAME answer on every route
 *   anything else (5xx, ...)                        503 hr_unavailable
 *
 * The leave rows (approver_not_linked, leave_rules, not_cancellable, already_decided, approver_no_access, not_your_approval,
 * 413) were added by the HR-run leave slice (docs/HR-HANDOFF.md, L1), matched BEFORE the generic rows, as my-hr does. The
 * staff-side ones (leave_rules, not_cancellable, 413) are only met by slice L3's routes, which are not built yet.
 *
 * Nothing HR sent is logged here, and HR's words are used only when they are a short plain sentence for a 400, 409, 422 or 403.
 */

export const NOT_READY = "Your HR record isn't ready yet. Ask the school's HR administrator.";
export const HR_UNAVAILABLE = "HR & Payroll can't be reached right now. Try again in a minute.";
export const HR_NOT_CONNECTED = "Figbloom HR isn't connected to this school yet. Ask Figbloom.";
export const HR_OFF = "My HR is switched off in Figbloom HR for now. Try again later.";
export const HR_RATE_LIMITED = "You've opened My HR many times in the last few minutes. Wait a few minutes and try again.";
/** my-hr's sentence for 409 approver_not_linked: the approver never opened HR & Payroll from Schools. */
export const CONNECT_ONCE = "Open HR & Payroll once to connect your HR account.";
export const DOCUMENT_TOO_LARGE = "The document is larger than 3 MB. Choose a smaller file.";
const GENERIC_REFUSAL = "HR couldn't take that. Check the details and try again.";
const MAX_PROBLEMS = 20;

/** HR was not reached, or the platform token could not be had: 503, try again in a minute. */
export const hrUnavailable = (): AppError => new AppError(503, "hr_unavailable", HR_UNAVAILABLE, true, 30);

/** HR answered with something that is not JSON, or too much of it: 502. */
export const hrBadAnswer = (): AppError => new AppError(502, "hr_bad_answer", HR_UNAVAILABLE, true, 30);

export interface HrRefusalOptions {
  /** The sentence for a 404 that is not "your record is not ready" (a payslip that is not there, a missing application). */
  notFound?: string;
}

/** HR's problems[] on a 422 leave_rules: one short sentence per rule that failed, as `details` lines. */
function leaveProblems(body: unknown): ErrorDetail[] {
  const list = isRecord(body) ? (isRecord(body.error) && Array.isArray(body.error.problems) ? body.error.problems : body.problems) : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0 && p.length <= 300)
    .slice(0, MAX_PROBLEMS)
    .map((message) => ({ field: "problems", code: "leave_rule", message: message.trim() }));
}

/** The API's error for an HR answer that is not a success (`answer.status` outside 2xx). */
export function refusalFromHr(answer: Pick<HrAnswer, "status" | "json" | "retryAfterSeconds">, options: HrRefusalOptions = {}): AppError {
  const code = hrErrorCode(answer.json);
  const said = hrMessage(answer.json);
  const { status } = answer;
  if (code === "not_linked" || code === "pending_hr") return new AppError(404, code, NOT_READY);
  if (code === "approver_not_linked") return new AppError(409, "approver_not_linked", CONNECT_ONCE);
  if (status === 404) return new AppError(404, "not_found", options.notFound ?? "That isn't available in HR.");
  if (status === 422 && code === "leave_rules") {
    return new AppError(422, "leave_rules", said ?? "HR's leave rules don't allow that.", true, undefined, leaveProblems(answer.json));
  }
  if (status === 400 || status === 422) return validationError(said ?? GENERIC_REFUSAL);
  if (status === 409 && code === "not_cancellable") return new AppError(409, code, said ?? "This leave can't be cancelled any more.");
  if (status === 409 && code === "already_decided") return new AppError(409, code, said ?? "This application has already been decided.");
  if (status === 409) return new AppError(409, "conflict", said ?? "That can't be done any more. Reload and try again.");
  if (status === 401 || code === "school_not_linked" || code === "invalid_token") {
    return new AppError(502, "hr_not_connected", HR_NOT_CONNECTED);
  }
  if (status === 403 && code === "approver_no_access") {
    return new AppError(403, code, said ?? "You don't have access to HR for this school. Ask your HR administrator.");
  }
  if (status === 403 && code === "not_your_approval") return new AppError(403, code, said ?? "You are not the approver for this step.");
  if (status === 403) return new AppError(403, "hr_forbidden", said ?? "Figbloom HR didn't allow that.");
  if (status === 413) return new AppError(413, "document_too_large", DOCUMENT_TOO_LARGE);
  if (status === 429) return rateLimited(HR_RATE_LIMITED, answer.retryAfterSeconds ?? 60);
  if (status === 503 && code === "my_hr_off") return new AppError(503, "hr_off", HR_OFF);
  return hrUnavailable();
}
