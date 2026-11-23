import type { ZodType } from "zod";
import { validationError, type ErrorDetail } from "./errors.js";

const SAFE_ISSUE_MESSAGES: Record<string, string> = {
  invalid_type: "Invalid type",
  invalid_value: "Invalid value",
  invalid_format: "Invalid format",
  invalid_union: "Invalid value",
  invalid_key: "Invalid key",
  invalid_element: "Invalid element",
  too_small: "Value is too small",
  too_big: "Value is too large",
  not_multiple_of: "Invalid value",
  unrecognized_keys: "Unrecognized field",
  custom: "Invalid value",
};

/**
 * One shared validation helper (FIG-1621 E3a). Maps Zod failures to the standard
 * error shape with additive `details[]`. Never echoes submitted values.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown, message = "Invalid request"): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const details: ErrorDetail[] = parsed.error.issues.map((issue) => {
    const field =
      issue.path.length === 0
        ? "(root)"
        : issue.path.map((p) => (typeof p === "symbol" ? String(p) : String(p))).join(".");
    const code = typeof issue.code === "string" ? issue.code : "invalid";
    return {
      field,
      code,
      message: SAFE_ISSUE_MESSAGES[code] ?? "Invalid value",
    };
  });
  throw validationError(message, details);
}
