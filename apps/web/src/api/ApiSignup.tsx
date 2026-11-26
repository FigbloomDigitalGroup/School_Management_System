import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  apiConfirmOrgSignup,
  apiRequestOrgSignup,
  fieldErrors,
  isApiError,
  ORG_SIGNUP_KINDS,
  userMessage,
  type OrgSignupKind,
} from "@figbloom/shared";
import { AuthLayout, type Scene } from "../components/AuthLayout";
import { Button } from "../components/ui/Button";
import { SelectField, TextField } from "../components/ui/Field";

/**
 * Organisation sign-up on the API build (`/signup`, `/signup/verify`; slice S6b of docs/web-on-api/signup.md).
 *
 * The one screen a stranger reaches with no account and no invite. It asks for an organisation and creates nothing by itself:
 * the server stores a request and e-mails a link, following the link proves the address, and then our team approves or rejects
 * it (apps/api/docs/ORG-SIGNUP.md). So there is no password here, and no web address to pick: the person chooses a password
 * from the e-mail they get after approval, and the platform sets the organisation's address.
 *
 * The server answers every address the same way, so this page never says whether an address already has a request or an account.
 */

const SCENE: Scene = {
  art: "/portals/admin.webp", tint: "#E3F0E8", accent: "#17402A", accentDeep: "#123420",
  headline: "Bring your schools onto Figbloom.",
  tagline: "One console for every school you run: learners, staff, fees, CBE results and the school bus.",
};

// A Record over the kinds the server accepts: a kind added there cannot be left without a label here (this would not compile).
const KIND_LABEL: Record<OrgSignupKind, string> = {
  group_owner: "I own/manage a school or a group of schools",
  government: "National government body",
  county: "County government",
  constituency: "Constituency",
};
const KIND_OPTIONS = ORG_SIGNUP_KINDS.map((value) => ({ value, label: KIND_LABEL[value] }));

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_SHAPE = /^[0-9+()\s-]{6,40}$/;

/** What to tell a person for an answer the page cannot act on. */
function signupErrorText(err: unknown): string {
  if (isApiError(err)) {
    if (err.code === "service_unavailable") return "Sign-up isn't available right now. Email hello@figbloom.org and we'll set you up.";
    if (err.code === "rate_limited") return userMessage(err);
    if (err.code === "validation_error") return err.message || "Check the details and try again.";
  }
  return userMessage(err);
}

export function ApiSignup() {
  const [name, setName] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [kind, setKind] = useState<OrgSignupKind>("group_owner");
  const [county, setCounty] = useState("");
  const [phone, setPhone] = useState("");
  const [adminName, setAdminName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // the address the link went to, so the "check your email" screen can name it
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setError("");
    setProblems({});
    const local: Record<string, string> = {};
    if (name.trim().length < 2) local.name = "Give your organization a name.";
    if (!adminName.trim()) local.admin_full_name = "Your name is required.";
    if (!EMAIL_SHAPE.test(email.trim())) local.admin_email = "Enter a valid email address.";
    if (phone.trim() && !PHONE_SHAPE.test(phone.trim())) local.contact_phone = "Enter a phone number, for example 0712 345 678.";
    if (Object.keys(local).length > 0) {
      setProblems(local);
      if (local.contact_phone) setMoreOpen(true);
      return;
    }

    setBusy(true);
    try {
      await apiRequestOrgSignup({ name, kind, county, contactPhone: phone, adminFullName: adminName, adminEmail: email });
      setSentTo(email.trim());
    } catch (err) {
      const fromServer = fieldErrors(err);
      if (Object.keys(fromServer).length > 0) setProblems(fromServer);
      setError(signupErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <AuthLayout scene={SCENE} subtitle="GET STARTED" width={440}>
        <div className="animate-rise">
          <h2 className="text-[22px] font-semibold tracking-tight">Check your email</h2>
          <p className="mt-2 text-body text-ink-muted">
            We sent a link to <span className="font-semibold text-ink">{sentTo}</span>. Open it to confirm the address. After that, our team
            reviews your request and writes to you with a link to choose your password. Nothing is created until then.
          </p>
          <p className="mt-3 text-[12.5px] text-ink-faint">Nothing there after a few minutes? Check your spam folder, or send the form again.</p>
          <Link to="/signin" className="mt-5 inline-block text-[13px] font-semibold text-forest hover:underline">Go to sign in</Link>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout scene={SCENE} subtitle="GET STARTED" width={440}>
      <div className="animate-rise">
        <Link to="/signin" className="mb-4 inline-block text-[12px] font-medium text-forest hover:underline">
          ← Back to sign in
        </Link>
        <h2 className="text-[22px] font-semibold tracking-tight">Create your organization</h2>
        <p className="mt-1 text-body text-ink-muted">
          A school, a group of schools, or a government body. Tell us who you are; we confirm your email, review the request, and then
          you can add your first school.
        </p>

        <form onSubmit={(e) => void submit(e)} noValidate className="mt-5 rounded-xl border border-line bg-white p-5">
          <div className="grid gap-3.5">
            <TextField
              id="orgName" label="Organization name" placeholder="e.g. Kijani Schools" autoFocus
              value={name} onChange={(e) => setName(e.target.value)} error={problems.name}
            />

            <div className="mt-1 border-t border-line-soft pt-3.5">
              <p className="mb-3 text-[12.5px] font-semibold text-ink">You, the administrator</p>
              <div className="grid gap-3.5">
                <TextField id="adminName" label="Your name" autoComplete="name" value={adminName} onChange={(e) => setAdminName(e.target.value)} error={problems.admin_full_name} />
                <TextField
                  id="adminEmail" label="Email" type="email" autoComplete="email" placeholder="you@example.com"
                  value={email} onChange={(e) => setEmail(e.target.value)} error={problems.admin_email}
                  hint="We send a link here to confirm it is yours. You choose your password later, after approval."
                />
              </div>
            </div>

            <div className="border-t border-line-soft pt-3">
              <button
                type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}
                className="flex w-full items-center justify-between text-left text-[12.5px] font-semibold text-ink"
              >
                More details <span className="font-normal text-ink-faint">{moreOpen ? "Hide" : "Optional"}</span>
              </button>
              {moreOpen && (
                <div className="mt-3 grid gap-3.5">
                  <SelectField id="orgKind" label="What best describes you?" value={kind} onChange={(e) => setKind(e.target.value as OrgSignupKind)} options={KIND_OPTIONS} />
                  <TextField id="orgCounty" label="County" placeholder="e.g. Kiambu" value={county} onChange={(e) => setCounty(e.target.value)} error={problems.county} />
                  <TextField id="orgPhone" label="Contact phone" type="tel" placeholder="e.g. 0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)} error={problems.contact_phone} />
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
                <span aria-hidden>✕</span>{error}
              </p>
            )}

            <Button type="submit" variant="primary" block disabled={busy}>
              {busy ? "Sending your request…" : "Send request"}
            </Button>
          </div>
        </form>

        <p className="mt-5 text-center text-small text-ink-muted">
          Already have an account? <Link to="/signin" className="font-medium text-forest hover:underline">Sign in</Link>
        </p>
      </div>
    </AuthLayout>
  );
}

/**
 * `/signup/verify?token=...`: the link in the confirmation e-mail. It does NOT confirm on load: mail scanners open links, and the
 * token works once, so the person presses a button (which is also what makes the request theirs).
 */
export function ApiSignupVerify() {
  const [params] = useSearchParams();
  const token = params.get("token")?.trim() ?? "";
  const [state, setState] = useState<"ready" | "busy" | "done" | "failed">("ready");
  const [error, setError] = useState("");

  async function confirm() {
    setState("busy");
    setError("");
    try {
      await apiConfirmOrgSignup(token);
      setState("done");
    } catch (err) {
      setState("failed");
      // A bad link is always the same 400 from the server; anything else (limits, an outage) is worth saying as it is.
      setError(isApiError(err) && err.code === "validation_error"
        ? "This link is invalid, has already been used, or has expired. Send the sign-up form again to get a new one."
        : userMessage(err));
    }
  }

  return (
    <AuthLayout scene={SCENE} subtitle="GET STARTED" width={440}>
      <div className="animate-rise">
        {state === "done" ? (
          <>
            <h2 className="text-[22px] font-semibold tracking-tight">Email confirmed</h2>
            <p className="mt-2 text-body text-ink-muted" role="status">
              Thank you. Our team will review your request and write to you at this address with a link to choose your password.
              Nothing more is needed from you now.
            </p>
            <Link to="/signin" className="mt-5 inline-block text-[13px] font-semibold text-forest hover:underline">Go to sign in</Link>
          </>
        ) : !token ? (
          <>
            <h2 className="text-[22px] font-semibold tracking-tight">This link is incomplete</h2>
            <p className="mt-2 text-body text-ink-muted" role="alert">Open the link in your confirmation email again, or send the sign-up form to get a new one.</p>
            <Link to="/signup" className="mt-5 inline-block text-[13px] font-semibold text-forest hover:underline">Back to sign-up</Link>
          </>
        ) : (
          <>
            <h2 className="text-[22px] font-semibold tracking-tight">Confirm your email address</h2>
            <p className="mt-2 text-body text-ink-muted">
              Press the button to confirm that this address is yours. After that, our team reviews your request for an organization.
            </p>
            {error && (
              <p role="alert" className="mt-4 flex items-start gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
                <span aria-hidden>✕</span>{error}
              </p>
            )}
            <div className="mt-5">
              <Button type="button" variant="primary" block disabled={state === "busy"} onClick={() => void confirm()}>
                {state === "busy" ? "Confirming…" : "Confirm my email"}
              </Button>
            </div>
            {state === "failed" && <Link to="/signup" className="mt-4 inline-block text-[13px] font-semibold text-forest hover:underline">Send the form again</Link>}
          </>
        )}
      </div>
    </AuthLayout>
  );
}
