/**
 * Email through Resend's HTTP API (POST https://api.resend.com/emails), plain
 * fetch, no SDK. Used to send a new or reset account its sign-in details, so
 * the one-time password no longer has to be read off someone's screen.
 *
 * Secrets (supabase secrets set ...):
 *   RESEND_API_KEY   the key from resend.com -> API Keys. Unset: nothing is
 *                    sent and every caller reports "not configured", so the
 *                    on-screen password is still the way in.
 *   EMAIL_FROM       e.g. "Figbloom <no-reply@figbloom.org>", on a domain
 *                    verified in Resend. Unset: treated as not configured.
 *   EMAIL_REPLY_TO   optional, e.g. the support address.
 *   APP_URL          the web app's origin for the sign-in link, e.g.
 *                    https://schoolmanagement.figbloom.org. Unset: the email
 *                    has no link and says to open Figbloom instead.
 *
 * Never logged: the password, the body, or the full address. Logged: the
 * template, the recipient's domain, and Resend's message id.
 *
 * The functions take a Mailer through their deps; handle() defaults to
 * NO_MAILER, and only each function's own Deno.serve wires up resendMailer(),
 * so a test run can never reach the real API, even with the key in its env.
 */

import { dbLimiter, type Limiter, userKey } from "./rateLimit.ts";
import type { LoginDetails } from "./emailTemplates.ts";
import { loginEmail } from "./emailTemplates.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Which template this is, for the log line. */
  template: string;
}

export type SendResult =
  | { status: "sent"; id: string | null }
  | { status: "not_configured" }
  | { status: "failed"; reason: string };

export interface Mailer {
  /** False when there's no key (or no sender): callers skip the send and say so. */
  configured: boolean;
  /** The web app's origin for sign-in links, without a trailing slash, or null. */
  appUrl: string | null;
  send(message: EmailMessage): Promise<SendResult>;
}

/** What a function tells the browser about the email, next to the on-screen password. */
export type EmailOutcome =
  | { status: "sent"; to: string }
  | { status: "not_configured" }
  | { status: "no_address" }
  | { status: "failed"; to: string; reason: string };

/** The mailer when email isn't set up: sends nothing. */
export const NO_MAILER: Mailer = {
  configured: false,
  appUrl: null,
  send: () => Promise.resolve({ status: "not_configured" }),
};

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

/** Only the part after the @, for logs. */
export function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase() || "unknown";
}

const LOOKS_LIKE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/**
 * Whether this is a real mailbox to write to: well-formed, and not one of the
 * synthetic sign-in addresses (loginIdEmail(): ...@login.<slug>.figbloom.internal).
 */
export function isDeliverable(address: string | null | undefined): address is string {
  if (!address) return false;
  const a = address.trim();
  return LOOKS_LIKE_EMAIL.test(a) && !a.toLowerCase().endsWith(".figbloom.internal");
}

export function resendMailer(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
  fetchFn: typeof fetch = fetch,
): Mailer {
  const apiKey = env("RESEND_API_KEY")?.trim();
  const from = env("EMAIL_FROM")?.trim();
  const replyTo = env("EMAIL_REPLY_TO")?.trim() || undefined;
  const appUrl = env("APP_URL")?.trim().replace(/\/+$/, "") || null;
  if (apiKey && !from) console.error("email: RESEND_API_KEY is set but EMAIL_FROM isn't, so nothing is sent");
  if (!apiKey || !from) return { ...NO_MAILER, appUrl };

  async function attempt(message: EmailMessage, idempotencyKey: string): Promise<Response> {
    return await fetchFn(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // the same key on the retry, so a send that got through before a timeout isn't sent twice
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  return {
    configured: true,
    appUrl,
    async send(message) {
      const domain = emailDomain(message.to);
      const idempotencyKey = crypto.randomUUID();
      let res: Response | null = null;
      let lastError = "";
      // one try, then one retry on a 5xx or a network error/timeout; a 4xx is final
      for (let i = 0; i < 2; i++) {
        try {
          res = await attempt(message, idempotencyKey);
          if (res.status < 500) break;
          lastError = `Resend answered ${res.status}`;
          await res.body?.cancel();
        } catch (err) {
          res = null;
          lastError = err instanceof Error && err.name === "TimeoutError" ? "Resend didn't answer in time" : "Could not reach Resend";
        }
      }
      if (res && res.ok) {
        const out = await res.json().catch(() => ({})) as { id?: string };
        console.log(`email: sent ${message.template} to @${domain}, id ${out.id ?? "unknown"}`);
        return { status: "sent", id: out.id ?? null };
      }
      if (res && res.status < 500) {
        // Resend's own message ("The figbloom.org domain is not verified", ...) goes back
        // to the person who added the account, not to the log
        const out = await res.json().catch(() => ({})) as { message?: string };
        lastError = `Resend answered ${res.status}${out.message ? `: ${String(out.message).slice(0, 200)}` : ""}`;
        console.error(`email: ${message.template} to @${domain} refused, status ${res.status}`);
      } else {
        console.error(`email: ${message.template} to @${domain} failed: ${lastError}`);
      }
      return { status: "failed", reason: lastError };
    },
  };
}

/** How many sign-in emails one person may set off in an hour, across every function here. */
export const LOGIN_EMAIL_LIMIT = 60;
export const LOGIN_EMAIL_WINDOW = "1 hour";

/** What a function's deps may carry for email. Left out, nothing is sent (NO_MAILER). */
export interface EmailDeps {
  mailer?: Mailer;
  limiter?: Limiter;
}

/** The mailer, limiter and caller key one request sends with. */
// deno-lint-ignore no-explicit-any
export async function emailContext(admin: any, deps: EmailDeps, callerId: string) {
  return {
    mailer: deps.mailer ?? NO_MAILER,
    limiter: deps.limiter ?? dbLimiter(admin, "login-email", LOGIN_EMAIL_LIMIT, LOGIN_EMAIL_WINDOW),
    callerKey: await userKey(callerId, "login-email"),
  };
}

/** Who added them or reset it, for the email: "Mary Wanjiku (school admin)", or "Figbloom". */
export function actorName(caller: { role: string; full_name?: string | null }): string | null {
  if (caller.role === "super_admin") return "Figbloom";
  const what = caller.role === "org_admin" ? "organization admin" : caller.role === "school_admin" ? "school admin"
    : caller.role === "parent" ? "parent" : "school office";
  return caller.full_name ? `${caller.full_name} (${what})` : null;
}

/** Where a role signs in: its own portal at the school (homeRouteFor in packages/shared/src/auth.ts). */
export function signInPath(role: string, slug: string | null | undefined): string {
  if (!slug) return "/signin";
  if (role === "org_admin") return `/org/${encodeURIComponent(slug)}/dashboard`;
  const portal: Record<string, string> = { school_admin: "admin", teacher: "teacher", parent: "parent", driver: "driver", staff: "staff" };
  return portal[role] ? `/s/${encodeURIComponent(slug)}/${portal[role]}` : "/signin";
}

/**
 * Sends a person their sign-in details, if there's somewhere and some way to
 * send them, and says what happened. Never throws: the account already exists
 * by the time this runs, and the on-screen password still works whatever this answers.
 */
export async function deliverLoginDetails(
  { mailer, limiter, callerKey }: { mailer: Mailer; limiter: Limiter; callerKey: string },
  to: string | null | undefined,
  details: Omit<LoginDetails, "signInUrl"> & { signInPath: string },
): Promise<EmailOutcome> {
  if (!isDeliverable(to)) return { status: "no_address" };
  const address = to.trim();
  if (!mailer.configured) return { status: "not_configured" };
  try {
    if (!(await limiter(callerKey))) {
      return { status: "failed", to: address, reason: "too many emails sent from your account in the last hour" };
    }
    const { signInPath, ...rest } = details;
    const message = loginEmail({ ...rest, signInUrl: mailer.appUrl ? `${mailer.appUrl}${signInPath}` : null });
    const result = await mailer.send({ ...message, to: address });
    if (result.status === "sent") return { status: "sent", to: address };
    if (result.status === "not_configured") return { status: "not_configured" };
    return { status: "failed", to: address, reason: result.reason };
  } catch (err) {
    console.error(`email: ${details.kind} to @${emailDomain(address)} failed:`, err instanceof Error ? err.name : "error");
    return { status: "failed", to: address, reason: "something went wrong sending it" };
  }
}
