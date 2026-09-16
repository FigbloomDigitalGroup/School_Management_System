import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DEMO_LOGINS, OTP_LENGTH, homeRouteFor, studentLoginEmail, supabase, validateOtp, validatePin, type Role, type Tenant,
} from "@figbloom/shared";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";

/** "07xx xxx xxx" or "+254 7xx xxx xxx" → the +254… form Supabase auth stores. */
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("254")) return `+${digits}`;
  if (digits.startsWith("0")) return `+254${digits.slice(1)}`;
  return `+254${digits}`;
}

type Tab = { role: Role; label: string; hint: string };

const TABS: Tab[] = [
  { role: "school_admin", label: "Staff", hint: "Your school email and password." },
  { role: "parent", label: "Parent", hint: "We text a six-digit code to the number the school holds." },
  { role: "student", label: "Student", hint: "Your admission number and the PIN the school gave you." },
  { role: "super_admin", label: "Platform", hint: "Figbloom staff only." },
];

/**
 * One door, four ways through it. Parents get phone-first because most have no
 * working email; students get an admission number because they have neither.
 */
export function SignIn() {
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>(TABS[0]!);
  const [sent, setSent] = useState(false);
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  async function sendReset() {
    if (!value.trim()) { setError("Enter your email first."); return; }
    setError("");
    setResetBusy(true);
    try {
      const { error: err } = await supabase().auth.resetPasswordForEmail(value.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (err) throw err;
      setResetSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the reset link.");
    } finally {
      setResetBusy(false);
    }
  }

  // The student tab still assumes a single school — an admission number only
  // resolves to a login email once the school it belongs to is known, and
  // there is no "choose your school" step yet to ask for that up front.
  const studentSlug = "alliance";

  async function submit() {
    setError("");
    setBusy(true);
    try {
      let userId: string | undefined;

      if (tab.role === "parent") {
        const phone = normalizePhone(value);
        if (!sent) {
          const { error: err } = await supabase().auth.signInWithOtp({
            phone, options: { shouldCreateUser: false },
          });
          if (err) { setError("We don't have that number on file. Check with the school office."); return; }
          setSent(true);
          return;
        }
        const v = validateOtp(code);
        if (!v.ok) { setError(v.message || `The code is ${OTP_LENGTH} numbers.`); return; }
        const { data, error: err } = await supabase().auth.verifyOtp({ phone, token: code, type: "sms" });
        if (err) { setError("That code is wrong or has expired."); return; }
        userId = data.user?.id;
      } else if (tab.role === "student") {
        const v = validatePin(code);
        if (!v.ok) { setError(v.message); return; }
        const { data, error: err } = await supabase().auth.signInWithPassword({
          email: studentLoginEmail(value.trim(), studentSlug), password: code,
        });
        if (err) { setError("Check the admission number and PIN."); return; }
        userId = data.user?.id;
      } else {
        const { data, error: err } = await supabase().auth.signInWithPassword({ email: value.trim(), password: code });
        if (err) { setError("Check the email and password."); return; }
        userId = data.user?.id;
      }

      if (!userId) { setError("Something went wrong signing you in."); return; }

      // Route by the account's REAL school, not a hardcoded one — every
      // school onboarded after "alliance" needs this to ever reach its console.
      const { data: profile } = await supabase()
        .from("profiles").select("role, tenant_id").eq("id", userId).maybeSingle();
      if (!profile) { setError("Your account isn't fully set up yet. Contact the school office."); return; }

      let destSlug: string | null = null;
      let institutionType: Tenant["institution_type"] | undefined;
      if (profile.tenant_id) {
        const { data: tenant } = await supabase().from("tenants").select("slug, institution_type").eq("id", profile.tenant_id).maybeSingle();
        destSlug = tenant?.slug ?? null;
        institutionType = tenant?.institution_type;
      } else if (profile.role === "org_admin") {
        // Not tenant-scoped at all — resolve which organization(s) this
        // profile administers via organization_admins instead (the same
        // mapping-table pattern guardians uses for parents), then reuse
        // homeRouteFor's `slug` param for the organization's own slug.
        const { data: link } = await supabase()
          .from("organization_admins").select("organizations(slug)").eq("profile_id", userId).maybeSingle<{ organizations: { slug: string } | null }>();
        destSlug = link?.organizations?.slug ?? null;
      }
      if (profile.role !== "super_admin" && !destSlug) {
        setError(profile.role === "org_admin" ? "Could not find your organization. Contact Figbloom support." : "Could not find your school. Contact Figbloom support.");
        return;
      }
      nav(homeRouteFor(profile.role as Role, destSlug, institutionType));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-page p-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-line">
            <img src="/logo-mark.png" alt="Figbloom" className="h-full w-full object-contain" />
          </div>
          <div>
            <div className="text-[17px] font-semibold tracking-tight">Figbloom School Systems</div>
            <div className="font-mono text-[9.5px] tracking-[0.12em] text-ink-faint">SIGN IN</div>
          </div>
        </div>

        <div className="rounded-xl border border-line bg-white p-5">
          <div role="tablist" aria-label="Sign in as" className="mb-4 flex gap-1.5 rounded-lg bg-sunken p-1">
            {TABS.map((t) => (
              <button
                key={t.role}
                role="tab"
                aria-selected={t.role === tab.role}
                onClick={() => { setTab(t); setSent(false); setError(""); setResetSent(false); }}
                className="hit flex-1 rounded-md px-2 py-2 text-[12.5px]"
                style={{
                  background: t.role === tab.role ? "#fff" : "transparent",
                  fontWeight: t.role === tab.role ? 600 : 400,
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <p className="mb-4 text-small leading-relaxed text-ink-muted">{tab.hint}</p>

          <div className="grid gap-3.5">
            {tab.role === "parent" ? (
              <>
                <TextField
                  id="phone" label="Mobile number" mono inputMode="tel"
                  placeholder="07xx xxx xxx" value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={sent}
                />
                {sent && (
                  <TextField
                    id="otp" label="The six-digit code" mono inputMode="numeric"
                    placeholder="000000" value={code} error={error}
                    hint="It can take a minute to arrive on a slow network."
                    onChange={(e) => setCode(e.target.value)}
                  />
                )}
              </>
            ) : tab.role === "student" ? (
              <>
                <TextField id="adm" label="Admission number" mono inputMode="numeric" placeholder="4102" value={value} onChange={(e) => setValue(e.target.value)} />
                <TextField id="pin" label="PIN" type="password" mono inputMode="numeric" placeholder="••••" value={code} error={error} onChange={(e) => setCode(e.target.value)} />
              </>
            ) : (
              <>
                <TextField id="email" label="Email" type="email" placeholder="you@school.sc.ke" value={value} onChange={(e) => setValue(e.target.value)} />
                <TextField id="pw" label="Password" type="password" value={code} error={error} onChange={(e) => setCode(e.target.value)} />
                {resetSent ? (
                  <p className="text-[12px] leading-relaxed text-ok-ink">
                    If that email has an account, a reset link is on its way.
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={() => void sendReset()}
                    disabled={resetBusy}
                    className="text-left text-[12px] font-medium text-forest hover:underline disabled:opacity-50"
                  >
                    {resetBusy ? "Sending…" : "Forgot password?"}
                  </button>
                )}
              </>
            )}

            <Button variant="primary" block disabled={busy} onClick={submit}>
              {busy ? "One moment…" : tab.role === "parent" && !sent ? "Text me a code" : "Sign in"}
            </Button>
          </div>
        </div>

        <p className="mt-4 text-center text-small text-ink-muted">
          New organization? <Link to="/signup" className="font-medium text-forest hover:underline">Get started</Link>
        </p>

        <details className="mt-4 rounded-xl border border-line bg-white p-4">
          <summary className="cursor-pointer text-small font-semibold">Development logins</summary>
          <table className="mt-3 w-full text-[12px]">
            <tbody>
              {DEMO_LOGINS.map((l) => (
                <tr key={l.role} className="border-t border-line-soft">
                  <td className="py-1.5 pr-3 text-ink-muted">{l.role}</td>
                  <td className="py-1.5 font-mono">{"email" in l ? l.email : "phone" in l ? l.phone : l.admission_no}</td>
                  <td className="py-1.5 pl-3 font-mono text-ink-faint">{l.password}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}
