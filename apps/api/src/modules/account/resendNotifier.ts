import { logError, logInfo } from "../../log.js";
import type { AccountMessage, AccountNotifier, DeliveryResult } from "./notifier.js";
import { INVITATION_TTL_HOURS, RESET_TTL_MINUTES } from "./service.js";

/**
 * Account e-mail (invitations and password resets) through Resend (https://resend.com).
 *
 * Contract with the routes (src/http/routes/accounts.ts): "sent" means the person got a link and the API does NOT
 * hand the token to the issuer; "not_configured" means the issuer gets the token once to deliver by hand. A failed
 * send therefore answers "not_configured": the invitation is still usable through its issuer instead of being lost.
 *
 * Tokens and addresses are never logged (src/log.ts cannot represent them); only the kind and the HTTP status are.
 */
export interface ResendNotifierOptions {
  apiKey: string;
  /** e.g. `FigBloom <no-reply@figbloom.org>`; the domain must be verified in Resend. */
  from: string;
  /** The web app's origin; links are `${linkBaseUrl}/accept-invite?token=...` and `/reset-password?token=...`. */
  linkBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface AccountEmail {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function render(subject: string, lead: string, action: string, link: string, after: string): AccountEmail {
  const text = `${lead}\n\n${action}:\n${link}\n\n${after}\n\nFigBloom School Management`;
  const html =
    `<p>${escapeHtml(lead)}</p>` +
    `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>` +
    `<p>If the button does not work, copy this address into your browser:<br>${escapeHtml(link)}</p>` +
    `<p>${escapeHtml(after)}</p>` +
    `<p>FigBloom School Management</p>`;
  return { subject, text, html };
}

/** The e-mail for one account message, or null when this kind is not sent by e-mail. */
export function accountEmail(message: AccountMessage, linkBaseUrl: string): AccountEmail | null {
  const token = encodeURIComponent(message.token);
  switch (message.kind) {
    case "invitation":
      return render(
        "You're invited to FigBloom",
        "You have been invited to FigBloom School Management.",
        "Accept the invitation and choose your password",
        `${linkBaseUrl}/accept-invite?token=${token}`,
        `The link works once and expires in ${INVITATION_TTL_HOURS} hours. If you did not expect this e-mail, you can ignore it.`,
      );
    case "password_reset":
      return render(
        "Reset your FigBloom password",
        "We received a request to reset the password for this e-mail address.",
        "Choose a new password",
        `${linkBaseUrl}/reset-password?token=${token}`,
        `The link works once and expires in ${RESET_TTL_MINUTES} minutes. If you did not ask for this, ignore this e-mail: your password stays the same.`,
      );
    case "guardian_invitation":
      // Guardian invitations carry no address (they are handed over as a code or QR by the school).
      return null;
  }
}

export function createResendNotifier(opts: ResendNotifierOptions): AccountNotifier {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async send(message): Promise<DeliveryResult> {
      const email = message.email.trim();
      if (!email) return "not_configured";
      const content = accountEmail(message, opts.linkBaseUrl);
      if (!content) return "not_configured";
      try {
        const res = await doFetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: opts.from, to: [email], subject: content.subject, text: content.text, html: content.html }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          logInfo("account_email_sent", { outcome: message.kind });
          return "sent";
        }
        logError("account_email_failed", { outcome: message.kind, status: res.status });
        return "not_configured";
      } catch (err) {
        logError("account_email_failed", { outcome: message.kind, error_class: err instanceof Error ? err.name : typeof err });
        return "not_configured";
      }
    },
  };
}

/**
 * Builds the notifier from the environment, or returns null (the not-configured default) when e-mail is off.
 *   RESEND_API_KEY          Resend key ("re_..."). Anything else, including a placeholder, leaves e-mail off.
 *   ACCOUNT_EMAIL_FROM      sender, e.g. `FigBloom <no-reply@figbloom.org>`
 *   ACCOUNT_LINK_BASE_URL   the web app's origin (https outside local/test)
 * Errors name the variable, never a value.
 */
export function resendNotifierFromEnv(env: NodeJS.ProcessEnv, appEnv: string): AccountNotifier | null {
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  if (!apiKey.startsWith("re_")) return null;
  const from = env.ACCOUNT_EMAIL_FROM?.trim() ?? "";
  if (!/^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^[^<>]*<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(from)) {
    throw new Error("Invalid API config: ACCOUNT_EMAIL_FROM must be an address or `Name <address>` when RESEND_API_KEY is set.");
  }
  const rawBase = env.ACCOUNT_LINK_BASE_URL?.trim() ?? "";
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new Error("Invalid API config: ACCOUNT_LINK_BASE_URL must be the web app's origin when RESEND_API_KEY is set.");
  }
  if (base.origin !== rawBase.replace(/\/$/, "")) {
    throw new Error("Invalid API config: ACCOUNT_LINK_BASE_URL must be an origin only (scheme://host[:port], no path or query).");
  }
  if (appEnv !== "local" && appEnv !== "test" && base.protocol !== "https:") {
    throw new Error("Invalid API config: ACCOUNT_LINK_BASE_URL must be https outside local and test.");
  }
  return createResendNotifier({ apiKey, from, linkBaseUrl: base.origin });
}
