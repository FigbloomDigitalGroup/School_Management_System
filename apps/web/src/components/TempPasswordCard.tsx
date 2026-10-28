import { useState } from "react";
import { emailOutcomeLine, type EmailOutcome } from "@figbloom/shared";

const ONCE = "The password only works until they first sign in, when they'll choose their own, and it won't be shown again.";

/**
 * The sentence above an on-screen password: whether it was emailed as well
 * ("Also emailed to x@y" / "Not emailed: ..."), then how to hand it over.
 * No `emailed` at all means a function deployed before sign-in emails.
 */
export function handOverNote(emailed?: EmailOutcome): string {
  if (!emailed) return `Nothing was sent — hand these to them directly. ${ONCE}`;
  if (emailed.status === "sent") return `${emailOutcomeLine(emailed)} If it doesn't arrive, hand these over directly. ${ONCE}`;
  return `${emailOutcomeLine(emailed)} Hand these to them directly. ${ONCE}`;
}

/**
 * A one-time starting password, shown once with a copy button. Used after
 * adding a school's administrator and after a password reset: the password
 * isn't stored anywhere it can be read back, so the person on screen hands
 * it over now, and the account holder picks their own at first sign-in.
 * If it was emailed to them too, the card says so (or why not).
 */
export function TempPasswordCard({ who, login, loginLabel = "Login", password, schoolName, emailed }: {
  who: string;
  /** What they sign in with: a login ID ("ST-0001") or an email. */
  login: string | null;
  loginLabel?: string;
  password: string;
  /** For a login ID, which school to pick on the sign-in screen. */
  schoolName?: string;
  /** Whether the same details were emailed to them; left out, nothing is said. */
  emailed?: EmailOutcome;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const text = [login ? `${loginLabel}: ${login}` : null, `Password: ${password}`].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked (http, or permission): the password is on screen to copy by hand
    }
  }

  return (
    <div className="rounded-lg border border-line bg-sunken p-4">
      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        Give these to <span className="font-semibold text-ink">{who}</span>.
        {schoolName ? ` They pick ${schoolName} on the sign-in screen, then enter the ID.` : ""} The password works once:
        they choose their own as soon as they sign in. It won't be shown again.
      </p>
      {emailed && (
        <p className={`mt-1.5 text-[12.5px] font-medium ${emailed.status === "sent" ? "text-forest" : "text-ink-muted"}`}>
          {emailOutcomeLine(emailed)}
        </p>
      )}
      <dl className="mt-3 grid gap-1.5 font-mono text-[13px]">
        {login && (
          <div className="flex gap-3"><dt className="w-20 shrink-0 font-sans text-ink-faint">{loginLabel}</dt><dd className="font-semibold">{login}</dd></div>
        )}
        <div className="flex gap-3"><dt className="w-20 shrink-0 font-sans text-ink-faint">Password</dt><dd className="select-all font-semibold">{password}</dd></div>
      </dl>
      <button type="button" onClick={() => void copy()} className="mt-3 text-[12px] font-semibold text-forest hover:underline">
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}
