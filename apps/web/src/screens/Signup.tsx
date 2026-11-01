import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { normalizeSlug, suggestSlug, validateSlug } from "@figbloom/shared";
import { AuthLayout, type Scene } from "../components/AuthLayout";
import { Button } from "../components/ui/Button";
import { SelectField, TextField } from "../components/ui/Field";
import { WebAddressField } from "../components/WebAddressField";
import { signupOrganization, type SignupOrganizationInput } from "../lib/signup";
import { useSlugAvailability } from "../lib/slugAvailability";

/**
 * Public self-service signup (FIG-371) — the one screen a stranger reaches
 * with no account and no invite. Kept to the minimum: the organization's
 * name, and the signer's own name, email and password. The web address
 * fills itself in from the name as it's typed (and can be edited); what
 * kind of organization it is, the county and contact details are optional,
 * folded under "More details". Submits to the signup-organization edge
 * function (FIG-370), signs the new org_admin straight in with the password
 * they just chose, and lands them on their own org console, live at once:
 * there's no approval step for now.
 */

/** Same illustrated layout as sign-in; the admin art, since the signer becomes the org admin. */
const SCENE: Scene = {
  art: "/portals/admin.webp", tint: "#E3F0E8", accent: "#17402A", accentDeep: "#123420",
  headline: "Bring your schools onto Figbloom.",
  tagline: "One console for every school you run: learners, staff, fees, CBE results and the school bus.",
};

const ORG_BASE = "schoolmanagement.figbloom.org/org/";

const KIND_OPTIONS: { value: SignupOrganizationInput["kind"]; label: string }[] = [
  { value: "group_owner", label: "I own/manage a school or a group of schools" },
  { value: "government", label: "National government body" },
  { value: "county", label: "County government" },
  { value: "constituency", label: "Constituency" },
];

export function Signup() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [kind, setKind] = useState<SignupOrganizationInput["kind"]>("group_owner");
  const [county, setCounty] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [adminName, setAdminName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // the address the confirmation went to: the account works once its link is followed (FIG-1337)
  const [sentTo, setSentTo] = useState<string | null>(null);

  const slugValue = normalizeSlug(slugTouched ? slug : (name ? suggestSlug(name) : ""));
  const slugCheck = slugValue ? validateSlug(slugValue) : { ok: false, message: "" };
  const availability = useSlugAvailability("organization", slugValue, county);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    setError("");
    if (!name.trim()) { setError("Give your organization a name."); return; }
    if (!slugCheck.ok) { setError(slugCheck.message || "Pick a valid web address."); return; }
    if (availability.status === "taken") { setError(`${ORG_BASE}${slugValue} is already taken. Pick another web address: there are suggestions under it.`); return; }
    if (!adminName.trim()) { setError("Your name is required."); return; }
    if (!email.trim()) { setError("Your email is required."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords don't match."); return; }

    setBusy(true);
    try {
      await signupOrganization({
        name: name.trim(),
        slug: slugValue,
        kind,
        county: county.trim() || undefined,
        contact_phone: contactPhone.trim() || undefined,
        admin_full_name: adminName.trim(),
        admin_email: email.trim(),
        admin_password: password,
      });

      setSentTo(email.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
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
            We sent a link to <span className="font-semibold text-ink">{sentTo}</span>. Open it to confirm the address, then
            sign in with the password you just chose. Nobody can sign in to the account until the link is used.
          </p>
          <p className="mt-3 text-[12.5px] text-ink-faint">Nothing there after a few minutes? Check your spam folder.</p>
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
          A school, a group of schools, or a government body. It takes a minute, and you can add your first school
          straight after.
        </p>

        <form onSubmit={(e) => void submit(e)} className="mt-5 rounded-xl border border-line bg-white p-5">
          <div className="grid gap-3.5">
            <TextField id="orgName" label="Organization name" placeholder="e.g. Kijani Schools" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <WebAddressField
              id="orgSlug" base={ORG_BASE} noun="organization"
              slug={slugValue} editing={slugTouched} availability={availability}
              onEdit={() => { setSlug(slugValue); setSlugTouched(true); }}
              onChange={(s) => { setSlugTouched(true); setSlug(s); }}
            />

            <div className="mt-1 border-t border-line-soft pt-3.5">
              <p className="mb-3 text-[12.5px] font-semibold text-ink">Your own login</p>
              <div className="grid gap-3.5">
                <TextField id="adminName" label="Your name" autoComplete="name" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
                <TextField id="adminEmail" label="Email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <TextField id="adminPassword" label="Password" type="password" showToggle autoComplete="new-password" hint="At least 8 characters." value={password} onChange={(e) => setPassword(e.target.value)} />
                <TextField id="adminConfirm" label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
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
                  <SelectField id="orgKind" label="What best describes you?" value={kind} onChange={(e) => setKind(e.target.value as SignupOrganizationInput["kind"])} options={KIND_OPTIONS} />
                  <TextField id="orgCounty" label="County" placeholder="e.g. Kiambu" value={county} onChange={(e) => setCounty(e.target.value)} />
                  <TextField id="orgPhone" label="Contact phone" type="tel" placeholder="e.g. 0712 345 678" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
                <span aria-hidden>✕</span>{error}
              </p>
            )}

            <Button type="submit" variant="primary" block disabled={busy}>
              {busy ? "Creating your organization…" : "Create organization"}
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
