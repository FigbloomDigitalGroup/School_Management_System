/**
 * The sign-in email, as plain mobile-friendly HTML (one column, inline
 * styles, no images) and a text version. Every value put into the HTML is
 * escaped: names and school names are typed in by people.
 *
 * "welcome": a new account (invite-admin, invite-org-admin, provision-guardian)
 *            or the same details sent again (reset-user-password, resend).
 * "reset":   a password someone else just reset (reset-user-password).
 */

export interface LoginDetails {
  kind: "welcome" | "reset";
  /** The account holder's name. */
  fullName: string;
  /** The school (or organization) the account belongs to. */
  placeName: string;
  /** What they sign in with: a login ID like "TC-0001", or their email. */
  login: string;
  loginIsId: boolean;
  password: string;
  /** The page to sign in at, or null when APP_URL isn't set. */
  signInUrl: string | null;
  /** Who added them or reset it, e.g. "Mary Wanjiku (school admin)". */
  actor: string | null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A header can't carry a line break: a name with one in it would start a new header. */
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

export function loginEmail(d: LoginDetails): { subject: string; html: string; text: string; template: string } {
  const welcome = d.kind === "welcome";
  const subject = oneLine(welcome ? `Your Figbloom account at ${d.placeName}` : `Your new Figbloom password for ${d.placeName}`);
  const first = d.fullName.trim().split(/\s+/)[0] || d.fullName.trim();
  const loginLabel = d.loginIsId ? "Login ID" : "Email";

  const intro = welcome
    ? `You have a Figbloom account at ${d.placeName}.${d.actor ? ` ${d.actor} added you.` : ""}`
    : `Your Figbloom password at ${d.placeName} has been reset${d.actor ? ` by ${d.actor}` : ""}. Your old password no longer works.`;
  const howTo = d.loginIsId
    ? `On the sign-in page, pick ${d.placeName}, then enter your login ID and this password.`
    : "On the sign-in page, enter your email and this password.";
  const once = "This password works once: you'll choose your own password when you first sign in.";
  const notYou = welcome
    ? "If you weren't expecting this, you can ignore this email, or tell the school."
    : "If you didn't ask for this, tell the school straight away.";

  const text = [
    `Hello ${first},`,
    "",
    intro,
    "",
    `${loginLabel}: ${d.login}`,
    `One-time password: ${d.password}`,
    "",
    howTo,
    d.signInUrl ? `Sign in: ${d.signInUrl}` : "Open Figbloom to sign in.",
    "",
    once,
    "",
    notYou,
    "",
    "Figbloom School Systems",
  ].join("\n");

  const e = escapeHtml;
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#5b6b61;font-size:14px;width:150px;">${e(label)}</td>`
    + `<td style="padding:6px 0;font-family:Menlo,Consolas,monospace;font-size:16px;font-weight:bold;color:#17402A;">${e(value)}</td></tr>`;
  const button = d.signInUrl
    ? `<p style="margin:24px 0;"><a href="${e(d.signInUrl)}" style="display:inline-block;background:#17402A;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold;font-size:15px;">Sign in</a></p>`
      + `<p style="margin:0 0 16px;font-size:13px;color:#5b6b61;">Or open this link: <a href="${e(d.signInUrl)}" style="color:#17402A;">${e(d.signInUrl)}</a></p>`
    : `<p style="margin:16px 0;">Open Figbloom to sign in.</p>`;

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ea;">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1d2a22;font-size:15px;line-height:1.5;">
<div style="background:#ffffff;border:1px solid #e3ddd0;border-radius:10px;padding:24px 20px;">
<p style="margin:0 0 12px;">Hello ${e(first)},</p>
<p style="margin:0 0 16px;">${e(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px;">
${row(loginLabel, d.login)}
${row("One-time password", d.password)}
</table>
<p style="margin:16px 0 0;">${e(howTo)}</p>
${button}
<p style="margin:0 0 12px;font-weight:bold;">${e(once)}</p>
<p style="margin:0;font-size:13px;color:#5b6b61;">${e(notYou)}</p>
</div>
<p style="margin:16px 0 0;font-size:12px;color:#8a948d;text-align:center;">Figbloom School Systems</p>
</div>
</body>
</html>`;

  return { subject, html, text, template: welcome ? "login-welcome" : "login-reset" };
}
