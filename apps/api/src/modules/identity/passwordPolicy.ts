/**
 * Password policy for authenticated password changes (R2-07).
 * Deliberately conservative; tune with product later.
 */
export function assertPasswordPolicy(password: string): void {
  if (password.length < 10) {
    throw Object.assign(new Error("Password must be at least 10 characters"), {
      code: "password_policy",
    });
  }
  if (password.length > 256) {
    throw Object.assign(new Error("Password is too long"), { code: "password_policy" });
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw Object.assign(new Error("Password must include letters and numbers"), {
      code: "password_policy",
    });
  }
}
