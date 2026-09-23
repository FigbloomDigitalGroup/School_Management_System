import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  DEMO_LOGINS, homeRouteFor, resolveLoginId, searchSchools, supabase,
  type Role, type SchoolSearchResult, type Tenant,
} from "@figbloom/shared";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";

type Mode = "id" | "email";

/**
 * Unified sign-in (FIG-396/402) — no visible role tabs. Two entry modes,
 * chosen by MECHANISM rather than role: "email" (org owners, Figbloom
 * staff — the only two roles ever provisioned by real email) and "id"
 * (everyone else — pick a school, then a school-assigned login_id like
 * "TC-0001", no SMS OTP). Which flow and pages someone lands on is still
 * resolved entirely after authentication, from their real profile.role —
 * the mode toggle only picks a credential shape, never an identity claim.
 */
export function SignIn() {
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("id");

  const [school, setSchool] = useState<SchoolSearchResult | null>(null);
  const [loginId, setLoginId] = useState("");
  const [resolved, setResolved] = useState<{ full_name: string; email: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [idHint, setIdHint] = useState("");

  const [email, setEmail] = useState("");

  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  function switchMode(m: Mode) {
    setMode(m);
    setError("");
    setResetSent(false);
  }

  function selectSchool(s: SchoolSearchResult) {
    setSchool(s);
    setResolved(null);
    setLoginId("");
    setIdHint("");
  }

  function clearSchool() {
    setSchool(null);
    setResolved(null);
    setLoginId("");
    setIdHint("");
  }

  async function resolveId() {
    if (!school || !loginId.trim()) return;
    setResolving(true);
    try {
      const r = await resolveLoginId(school.id, loginId.trim());
      setResolved(r);
      setIdHint("");
    } catch (err) {
      setResolved(null);
      setIdHint(err instanceof Error ? err.message : "Could not find that ID.");
    } finally {
      setResolving(false);
    }
  }

  async function sendReset() {
    if (!email.trim()) { setError("Enter your email first."); return; }
    setError("");
    setResetBusy(true);
    try {
      const { error: err } = await supabase().auth.resetPasswordForEmail(email.trim(), {
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

  async function submit() {
    setError("");
    setBusy(true);
    try {
      const signInEmail = mode === "email" ? email.trim() : resolved?.email;
      if (!signInEmail) { setError("Enter your ID and wait for it to be recognized first."); return; }

      const { data, error: err } = await supabase().auth.signInWithPassword({ email: signInEmail, password });
      if (err) { setError(mode === "email" ? "Check the email and password." : "Check your ID and password."); return; }
      const userId = data.user?.id;
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
        // homeRouteFor's `slug` param for the organization's own slug. A
        // profile can administer more than one organization (no per-profile
        // uniqueness on organization_admins, only per profile+org) — one
        // match goes straight there, several land on the workspace picker
        // instead of a plain .maybeSingle() erroring on multiple rows.
        const { data: links } = await supabase()
          .from("organization_admins").select("organizations(slug)").eq("profile_id", userId)
          .returns<{ organizations: { slug: string } | null }[]>();
        const slugs = (links ?? []).map((l) => l.organizations?.slug).filter((s): s is string => !!s);
        if (slugs.length > 1) { nav("/org-picker"); return; }
        destSlug = slugs[0] ?? null;
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

  const canSubmit = mode === "email" ? !!email.trim() && !!password : !!resolved && !!password;

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
          {mode === "id" ? (
            <div className="grid gap-3.5">
              <SchoolPicker selected={school} onSelect={selectSchool} onClear={clearSchool} />
              {school && (
                <TextField
                  id="login-id" label="Your ID" mono placeholder="e.g. TC-0001"
                  value={loginId}
                  onChange={(e) => { setLoginId(e.target.value); setResolved(null); setIdHint(""); }}
                  onBlur={() => void resolveId()}
                  hint={resolving ? "Checking…" : resolved ? `Signing in as ${resolved.full_name}.` : undefined}
                  error={!resolving && idHint ? idHint : undefined}
                />
              )}
              {resolved && (
                <TextField
                  id="pw-id" label="Password" type="password" showToggle
                  value={password} error={error} onChange={(e) => setPassword(e.target.value)}
                />
              )}
            </div>
          ) : (
            <div className="grid gap-3.5">
              <TextField id="email" label="Email" type="email" placeholder="you@school.sc.ke" value={email} onChange={(e) => setEmail(e.target.value)} />
              <TextField id="pw" label="Password" type="password" showToggle value={password} error={error} onChange={(e) => setPassword(e.target.value)} />
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
            </div>
          )}

          <Button variant="primary" block disabled={busy || !canSubmit} onClick={submit} className="mt-3.5">
            {busy ? "One moment…" : "Sign in"}
          </Button>

          <button
            type="button"
            onClick={() => switchMode(mode === "id" ? "email" : "id")}
            className="mt-3 w-full text-center text-[12px] font-medium text-ink-muted hover:text-forest hover:underline"
          >
            {mode === "id" ? "Sign in with email instead" : "Sign in with your school and ID instead"}
          </button>
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
                  <td className="py-1.5 pr-3 text-ink-muted">
                    {l.role}
                    {"school" in l && <span className="block text-[10.5px] text-ink-faint">{l.school}</span>}
                  </td>
                  <td className="py-1.5 font-mono">{"email" in l ? l.email : l.login_id}</td>
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

/** The "type your school's name" step — a live search against the
 *  anonymous search-schools function, since there's no account yet to
 *  scope a normal query by. Collapses to a read-only chip once a school is
 *  picked, with a "Change" link back to search again. */
function SchoolPicker({ selected, onSelect, onClear }: {
  selected: SchoolSearchResult | null;
  onSelect: (s: SchoolSearchResult) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SchoolSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(() => {
      searchSchools(q)
        .then((schools) => { setResults(schools); setOpen(true); })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-md border border-[#D3DAD5] bg-page px-3 py-2.5">
        <div>
          <div className="text-[10.5px] font-semibold tracking-wide text-ink-faint">SCHOOL</div>
          <div className="text-body font-medium">{selected.name}</div>
        </div>
        <button type="button" onClick={onClear} className="text-[12px] font-medium text-forest hover:underline">
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative">
      <TextField
        id="school-search" label="School" placeholder="Start typing your school's name"
        value={query} onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        autoComplete="off"
      />
      {open && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-line bg-white py-1 shadow-lg">
          {searching ? (
            <div className="px-3 py-2 text-[12.5px] text-ink-faint">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-[12.5px] text-ink-faint">No schools found.</div>
          ) : (
            results.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => { onSelect(s); setOpen(false); setQuery(""); }}
                className="block w-full px-3 py-2 text-left text-[13px] hover:bg-page"
              >
                <div className="font-medium">{s.name}</div>
                {s.county && <div className="text-[11.5px] text-ink-faint">{s.county}</div>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
