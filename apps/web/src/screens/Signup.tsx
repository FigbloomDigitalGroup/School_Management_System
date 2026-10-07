import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { suggestSlug, supabase } from "@figbloom/shared";
import { AuthLayout, type Scene } from "../components/AuthLayout";
import { Button } from "../components/ui/Button";
import { SelectField, TextField } from "../components/ui/Field";
import { signupOrganization } from "../lib/signup";

/**
 * Public self-service signup (FIG-371) — the one screen a stranger reaches
 * with no account and no invite. One page, not a wizard: there's no
 * "plan"/"administrator" step to collect since the signer *is* the admin,
 * and every extra step here costs real signups. Submits to the
 * signup-organization edge function (FIG-370, the one publicly-callable
 * privileged endpoint in the app), then signs the new org_admin in directly
 * with the password they just chose and lands them on their own org
 * console — which shows a "pending approval" holding screen (FIG-372) until
 * a super_admin approves them.
 */

/** Same illustrated layout as sign-in; the admin art, since the signer becomes the org admin. */
const SCENE: Scene = {
  art: "/portals/admin.webp", tint: "#E3F0E8", accent: "#17402A", accentDeep: "#123420",
  headline: "Bring your schools onto Figbloom.",
  tagline: "One console for every school you run: learners, staff, fees, CBE results and the school bus.",
};

const KIND_OPTIONS = [
  { value: "group_owner", label: "I own/manage a group of schools" },
  { value: "government", label: "National government body" },
  { value: "county", label: "County government" },
  { value: "constituency", label: "Constituency" },
];

const SLUG_RE = /^[a-z0-9-]{3,40}$/;
const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "auth", "console", "figbloom", "help", "login",
  "platform", "s", "org", "signin", "signup", "status", "support", "www",
]);

function validateOrgSlug(raw: string): { ok: boolean; message: string } {
  const slug = raw.trim().toLowerCase();
  if (!slug) return { ok: false, message: "Pick an address for your organization." };
  if (!SLUG_RE.test(slug)) return { ok: false, message: "3-40 characters, lowercase letters, numbers and hyphens only." };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, message: `"${slug}" is reserved by the platform.` };
  return { ok: true, message: "" };
}

export function Signup() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [kind, setKind] = useState("group_owner");
  const [county, setCounty] = useState("");
  const [adminName, setAdminName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const slugValue = slugTouched ? slug : (name ? suggestSlug(name) : "");
  const slugCheck = slugValue ? validateOrgSlug(slugValue) : { ok: false, message: "" };

  async function submit() {
    setError("");
    if (!name.trim()) { setError("Give your organization a name."); return; }
    if (!slugCheck.ok) { setError(slugCheck.message || "Pick a valid address."); return; }
    if (!adminName.trim()) { setError("Your name is required."); return; }
    if (!email.trim()) { setError("Your email is required."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords don't match."); return; }

    setBusy(true);
    try {
      const result = await signupOrganization({
        name: name.trim(),
        slug: slugValue,
        kind: kind as "government" | "county" | "constituency" | "group_owner",
        county: county.trim() || undefined,
        admin_full_name: adminName.trim(),
        admin_email: email.trim(),
        admin_password: password,
      });

      const { error: signInErr } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
      if (signInErr) { setError("Your organization was created — sign in from here to continue."); nav("/signin"); return; }

      nav(`/org/${result.slug}/dashboard`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout scene={SCENE} subtitle="GET STARTED" width={440}>
      <div className="animate-rise">
        <Link to="/signin" className="mb-4 inline-block text-[12px] font-medium text-forest hover:underline">
          ← Back to sign in
        </Link>
        <h2 className="text-[22px] font-semibold tracking-tight">Register your organization</h2>
        <p className="mt-1 text-body text-ink-muted">
          A group of schools, or a government body. Our team reviews new organizations before they go live, usually
          within a day.
        </p>

        <div className="mt-5 rounded-xl border border-line bg-white p-5">
          <div className="grid gap-3.5">
            <TextField id="orgName" label="Organization name" placeholder="e.g. Riverside Schools Trust" value={name} onChange={(e) => setName(e.target.value)} />
            <TextField
              id="orgSlug" label="Address" mono placeholder={slugValue || "riverside-schools-trust"}
              value={slugTouched ? slug : slugValue}
              hint={slugCheck.ok ? `figbloom.co.ke/org/${slugValue} — this cannot be changed later.` : undefined}
              error={slugTouched && slug && !slugCheck.ok ? slugCheck.message : undefined}
              onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }}
            />
            <SelectField id="orgKind" label="What best describes you?" value={kind} onChange={(e) => setKind(e.target.value)} options={KIND_OPTIONS} />
            <TextField id="orgCounty" label="County (optional)" placeholder="e.g. Kiambu" value={county} onChange={(e) => setCounty(e.target.value)} />

            <div className="mt-1 border-t border-line-soft pt-3.5">
              <p className="mb-3 text-[12.5px] font-semibold text-ink">Your own login</p>
              <div className="grid gap-3.5">
                <TextField id="adminName" label="Your name" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
                <TextField id="adminEmail" label="Email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <TextField id="adminPassword" label="Password" type="password" hint="At least 8 characters." value={password} onChange={(e) => setPassword(e.target.value)} />
                <TextField id="adminConfirm" label="Confirm password" type="password" error={error} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
            </div>

            <Button variant="primary" block disabled={busy} onClick={() => void submit()}>
              {busy ? "Creating your organization…" : "Create organization"}
            </Button>
          </div>
        </div>

        <p className="mt-5 text-center text-small text-ink-muted">
          Already have an account? <Link to="/signin" className="font-medium text-forest hover:underline">Sign in</Link>
        </p>
      </div>
    </AuthLayout>
  );
}
