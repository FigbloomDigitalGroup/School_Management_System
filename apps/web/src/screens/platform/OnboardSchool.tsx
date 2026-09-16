import { useState } from "react";
import { countryProfile, suggestSlug, validateSlug, supabase, type Tenant } from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../components/ui/Toast";
import { createTenant, fetchOrganizations, inviteAdmin, type InviteAdminResult } from "../../lib/platformAdmin";
import { uploadTenantLogo } from "../../lib/uploads";
import { useAsync } from "../../lib/useAsync";

const STEPS = ["School", "Workspace", "Plan", "Administrator", "Review"] as const;

interface Form {
  name: string; moe: string; county: string; country: string; level: string; institutionType: string; higherEdSubtype: string; deliveryMode: string; seats: string;
  slug: string; accent: string;
  plan: string; trial: string; cycle: string;
  adminName: string; adminRole: string; email: string; phone: string;
  organizationId: string;
}

const BLANK: Form = {
  name: "", moe: "", county: "Nakuru", country: "KE", level: "secondary", institutionType: "k12", higherEdSubtype: "university", deliveryMode: "in_person", seats: "1200",
  slug: "", accent: "#1B4D2E",
  plan: "institution", trial: "30", cycle: "term",
  adminName: "", adminRole: "Principal", email: "", phone: "",
  organizationId: "",
};

// Kenya-only for now — matches the grading-scheme registry's current scope
// (FIG-356), which only has Kenyan schemes modeled. Not a real country
// picker yet; widen this the day a non-Kenyan tenant is real.
const COUNTRY_OPTIONS = [{ value: "KE", label: "Kenya" }];

/**
 * Five steps, nothing created until the last one.
 *
 * The drop-off point is step 4: the administrator's contact details. A wrong
 * email means a school that never logs in and shows up a fortnight later as
 * "setup stalled". There is no real email/SMS provider wired up locally, so
 * the account is created outright with a known dev password (see
 * supabase/functions/invite-admin) — the success screen shows those
 * credentials to hand to the school directly, rather than claiming an
 * invite was delivered when nothing was actually sent.
 */
export function OnboardSchool({
  open, onClose, existingSlugs, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Real slugs already in use — checked live instead of a hardcoded example. */
  existingSlugs: string[];
  /** Called once the school and its administrator both exist for real. */
  onCreated: (tenant: Tenant) => void;
}) {
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<Form>(BLANK);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [credentials, setCredentials] = useState<InviteAdminResult | null>(null);
  // Held until the tenant actually exists (step 4) — there's nowhere to upload a
  // crest to before its tenant_id exists, since "nothing is created until the last step".
  const [crestFile, setCrestFile] = useState<File | null>(null);
  const [crestPreview, setCrestPreview] = useState<string | null>(null);
  const toast = useToast();
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { data: organizations } = useAsync(() => fetchOrganizations(), []);

  const slugValue = form.slug || (form.name ? suggestSlug(form.name) : "");
  const slugCheck = slugValue ? validateSlug(slugValue) : { ok: false, message: "Suggested from the school name." };
  const takenBy = existingSlugs.includes(slugValue);

  function close() {
    onClose();
    setStep(0); setForm(BLANK); setSubmitting(false); setSubmitError("");
    setTenant(null); setCredentials(null);
    if (crestPreview) URL.revokeObjectURL(crestPreview);
    setCrestFile(null); setCrestPreview(null);
  }

  function pickCrest(file: File | null) {
    if (crestPreview) URL.revokeObjectURL(crestPreview);
    setCrestFile(file);
    setCrestPreview(file ? URL.createObjectURL(file) : null);
  }

  async function createSchoolAndAdmin() {
    setSubmitting(true);
    setSubmitError("");
    try {
      // Re-entering after a partial failure shouldn't create a second tenant.
      let t = tenant ?? await createTenant({
        name: form.name.trim(),
        slug: slugValue,
        county: form.county,
        country: form.country,
        level: form.level as Tenant["level"],
        institution_type: form.institutionType as Tenant["institution_type"],
        higher_ed_subtype: form.institutionType === "higher_ed" ? (form.higherEdSubtype as Tenant["higher_ed_subtype"]) : null,
        delivery_mode: form.deliveryMode as Tenant["delivery_mode"],
        organization_id: form.organizationId || null,
        moe_registration: form.moe.trim() || null,
        plan: form.plan as Tenant["plan"],
        accent: form.accent,
        licensed_seats: Number(form.seats) || 0,
      });
      setTenant(t);

      if (crestFile && !t.logo_url) {
        const logoUrl = await uploadTenantLogo(t.id, crestFile);
        const { data: updated, error: logoErr } = await supabase()
          .from("tenants").update({ logo_url: logoUrl }).eq("id", t.id).select("*").single<Tenant>();
        if (!logoErr && updated) { t = updated; setTenant(t); }
      }

      const result = await inviteAdmin({
        tenant_id: t.id,
        full_name: form.adminName.trim(),
        staff_title: form.adminRole,
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
      });
      setCredentials(result);
      onCreated(t);
      setStep(5);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function next() {
    if (step === 4) { void createSchoolAndAdmin(); return; }
    if (step === 5) {
      close();
      toast(`${form.name || "The school"} is live`);
      return;
    }
    setStep((s) => s + 1);
  }

  const FOOT = [
    "Nothing is created until the last step.",
    "The address is permanent.",
    "Billing starts when the trial ends.",
    "There is no live password reset locally — write these down.",
    "You can remove the school again from its detail page.",
    tenant ? `${tenant.name} is in your tenant list now.` : "",
  ][step];

  return (
    <Modal
      open={open}
      onClose={close}
      width={740}
      eyebrow={step === 5 ? "Onboard a school · done" : `Onboard a school · step ${step + 1} of 5`}
      title={["Which school are we adding?", "Their workspace", "Plan and billing", "First administrator", "Review before creating", "School created"][step]!}
      footNote={FOOT}
      actions={
        <>
          {step > 0 && step < 5 && <Button disabled={submitting} onClick={() => setStep((s) => s - 1)}>Back</Button>}
          <Button
            variant={step === 4 ? "accent" : "primary"}
            disabled={
              submitting
              || (step === 0 && !form.name.trim())
              || ((step === 1 || step === 4) && (takenBy || !slugCheck.ok))
              || (step === 3 && (!form.adminName.trim() || !form.email.trim()))
            }
            onClick={next}
          >
            {submitting ? "Creating…" : ["Continue", "Continue", "Continue", "Continue", "Create school and send invite", "Done"][step]}
          </Button>
        </>
      }
    >
      <ol className="mb-5 flex gap-1.5" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className="flex-1">
            <div className="h-1 rounded" style={{ background: i < step ? "#2E7D4F" : i === step ? "#F26A1B" : "#E7EBE8" }} />
            <div className="mt-1.5 text-[10.5px]" style={{ color: i <= step ? "#16201A" : "#9AA69E", fontWeight: i === step ? 600 : 400 }}>
              {label}
            </div>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-3.5">
          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField id="name" label="School name" placeholder="e.g. Kabarak High School" value={form.name} onChange={(e) => set("name", e.target.value)} />
            <TextField id="moe" label="MoE registration number" mono placeholder="e.g. 31/1/0071" value={form.moe} onChange={(e) => set("moe", e.target.value)} />
          </div>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <SelectField id="country" label="Country" value={form.country} onChange={(e) => set("country", e.target.value)}
              options={COUNTRY_OPTIONS} />
            <SelectField id="county" label="County" value={form.county} onChange={(e) => set("county", e.target.value)}
              options={["Nakuru", "Nairobi", "Kiambu", "Kisumu", "Uasin Gishu", "Siaya", "Bungoma", "Kakamega"].map((c) => ({ value: c, label: c }))} />
          </div>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <SelectField id="institutionType" label="Institution type" value={form.institutionType} onChange={(e) => set("institutionType", e.target.value)}
              options={[{ value: "k12", label: "K-12 school" }, { value: "higher_ed", label: "Higher education" }]} />
            <TextField id="seats" label="Expected learners" mono value={form.seats} onChange={(e) => set("seats", e.target.value)} />
          </div>
          <div className="grid gap-3.5 sm:grid-cols-2">
            {form.institutionType === "k12" ? (
              <SelectField id="level" label="Level" value={form.level} onChange={(e) => set("level", e.target.value)}
                options={[{ value: "secondary", label: "Secondary" }, { value: "primary", label: "Primary" }, { value: "combined", label: "Combined" }]} />
            ) : (
              <SelectField id="higherEdSubtype" label="Type" value={form.higherEdSubtype} onChange={(e) => set("higherEdSubtype", e.target.value)}
                options={[
                  { value: "university", label: "University" },
                  { value: "college", label: "College" },
                  { value: "short_course", label: "Short-course school" },
                  { value: "tvet", label: "TVET" },
                ]} />
            )}
            <SelectField id="deliveryMode" label="Delivery" value={form.deliveryMode} onChange={(e) => set("deliveryMode", e.target.value)}
              options={[{ value: "in_person", label: "In-person" }, { value: "online", label: "Online" }, { value: "hybrid", label: "Hybrid" }]} />
          </div>
          <p className="rounded-md bg-page px-3.5 py-3 text-small leading-relaxed text-ink-muted">
            {form.institutionType === "higher_ed"
              ? "Higher-ed institutions manage courses and enrollment rather than fixed classes — set up after onboarding."
              : "The registration number is checked against the Ministry list. A mismatch is a warning, not a blocker — you can proceed and flag it for follow-up."}
          </p>
        </div>
      )}

      {step === 1 && (
        <div className="grid gap-4">
          <div>
            <label htmlFor="slug" className="mb-1.5 block text-small font-semibold">Workspace address</label>
            <div className="flex items-center overflow-hidden rounded-md border border-[#D3DAD5]">
              <span className="border-r border-line bg-page px-3 py-2.5 font-mono text-[13px] text-ink-faint">figbloom.co.ke/s/</span>
              <input id="slug" value={slugValue} onChange={(e) => set("slug", e.target.value)} className="flex-1 px-3 py-2.5 font-mono text-body outline-none" />
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-small" style={{ color: takenBy || !slugCheck.ok ? "#B8460A" : "#2E7D4F" }}>
              <span aria-hidden>{takenBy || !slugCheck.ok ? "✕" : "✓"}</span>
              {takenBy ? "That address is already taken by another school." : slugCheck.message}
            </p>
          </div>
          {organizations && organizations.length > 0 && (
            <SelectField
              id="organization" label="Part of an organization? (optional)"
              value={form.organizationId} onChange={(e) => set("organizationId", e.target.value)}
              options={[{ value: "", label: "Not part of one" }, ...organizations.map((o) => ({ value: o.id, label: o.name }))]}
            />
          )}
          <div>
            <span className="mb-2 block text-small font-semibold">Accent colour</span>
            <div className="flex gap-2.5">
              {["#7A1F2B", "#123C63", "#1B4D2E", "#5C2E1F", "#3B3B6D", "#0F5257"].map((c) => (
                <button key={c} onClick={() => set("accent", c)} aria-label={c} className="h-9 w-9 rounded-[9px]"
                  style={{ background: c, boxShadow: form.accent === c ? "0 0 0 2px #fff, 0 0 0 4px #16201A" : undefined }} />
              ))}
            </div>
          </div>
          <div>
            <span className="mb-2 block text-small font-semibold">School crest</span>
            <label
              htmlFor="crest"
              className="flex cursor-pointer items-center gap-3.5 rounded-xl border-[1.5px] border-dashed border-[#C9D2CB] bg-page px-4 py-4 text-center"
            >
              {crestPreview ? (
                <img src={crestPreview} alt="" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
              ) : (
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-white text-ink-faint" aria-hidden>◭</span>
              )}
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] font-medium">{crestFile ? crestFile.name : "Choose a PNG, JPG or SVG"}</span>
                <span className="mt-0.5 block text-[12px] text-ink-faint">
                  Optional — uploaded once the school is created. The initials placeholder works until then.
                </span>
              </span>
              {crestFile && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); pickCrest(null); }}
                  className="hit shrink-0 rounded-md px-2 py-1 text-[12px] font-semibold text-ink-muted"
                >
                  Remove
                </button>
              )}
              <input
                id="crest" type="file" accept="image/png,image/jpeg,image/svg+xml" className="hidden"
                onChange={(e) => pickCrest(e.target.files?.[0] ?? null)}
              />
            </label>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-3.5">
          {[
            // Figbloom's own price list is quoted in KES regardless of the
            // school being onboarded — a deliberate business-currency choice.
            { id: "standard", name: "Standard", price: `${countryProfile("KE").currencySymbol} 110 / learner / term`, desc: "Attendance, grades, fees, parent app. Up to 1,200 learners." },
            { id: "institution", name: "Institution", price: `${countryProfile("KE").currencySymbol} 145 / learner / term`, desc: "Adds multi-campus, custom report cards, an SMS bundle and priority support." },
            { id: "county", name: "County partnership", price: "Negotiated", desc: "For county education offices onboarding ten or more schools at once." },
          ].map((p) => {
            const on = form.plan === p.id;
            return (
              <button key={p.id} onClick={() => set("plan", p.id)}
                className="flex items-start gap-3.5 rounded-xl border-[1.5px] px-4 py-3.5 text-left"
                style={{ borderColor: on ? "#17402A" : "#E2E6E2", background: on ? "#F6F9F7" : "#fff" }}>
                <span className="mt-0.5 grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2" style={{ borderColor: on ? "#17402A" : "#C9D2CB" }}>
                  <span className="h-2 w-2 rounded-full" style={{ background: on ? "#17402A" : "transparent" }} />
                </span>
                <span className="flex-1">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="text-[14px] font-semibold">{p.name}</span>
                    <span className="font-mono text-[13px]">{p.price}</span>
                  </span>
                  <span className="mt-1 block text-small leading-relaxed text-ink-muted">{p.desc}</span>
                </span>
              </button>
            );
          })}
          <div className="grid gap-3.5 sm:grid-cols-2">
            <SelectField id="trial" label="Free trial" value={form.trial} onChange={(e) => set("trial", e.target.value)}
              options={[{ value: "30", label: "30 days" }, { value: "14", label: "14 days" }, { value: "0", label: "No trial" }]} />
            <SelectField id="cycle" label="Billing cycle" value={form.cycle} onChange={(e) => set("cycle", e.target.value)}
              options={[{ value: "term", label: "Per term (3 per year)" }, { value: "annual", label: "Annual, paid upfront" }]} />
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="grid gap-3.5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            This person becomes the school's first administrator and can add everyone else.
          </p>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField id="admin" label="Full name" placeholder="e.g. Peter Mwangi" value={form.adminName} onChange={(e) => set("adminName", e.target.value)} />
            <SelectField id="role" label="Role at school" value={form.adminRole} onChange={(e) => set("adminRole", e.target.value)}
              options={["Principal", "Deputy Principal", "Bursar", "ICT Coordinator"].map((r) => ({ value: r, label: r }))} />
          </div>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField id="email" label="Email" type="email" placeholder="principal@school.sc.ke" value={form.email} onChange={(e) => set("email", e.target.value)} />
            <TextField id="phone" label="Mobile (optional)" mono placeholder={countryProfile(form.country).phonePlaceholder} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </div>
          <p className="rounded-lg bg-sunken px-3.5 py-3 text-[12px] leading-relaxed text-ink-muted">
            No email or SMS provider is configured in this environment, so nothing gets sent. Their login is created
            outright with a starting password shown on the next screen — hand it to them directly, the same way every
            other development login in this system works.
          </p>
        </div>
      )}

      {step === 4 && (
        <div>
          <dl className="mb-4 overflow-hidden rounded-lg border border-line">
            {[
              ["School", form.name || "—"],
              ["Address", `figbloom.co.ke/s/${slugValue || "—"}`],
              ...(form.organizationId ? [["Organization", organizations?.find((o) => o.id === form.organizationId)?.name ?? "—"]] : []),
              ["Plan", `${form.plan} · ${form.cycle === "term" ? "per term" : "annual"}`],
              ["Trial", form.trial === "0" ? "No trial" : `${form.trial} days`],
              ["First administrator", `${form.adminName || "—"} · ${form.adminRole}`],
              ["Login", form.email || "—"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-line-soft px-4 py-2.5 last:border-0">
                <dt className="text-small text-ink-muted">{k}</dt>
                <dd className="text-right text-[13px] font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="rounded-xl bg-sunken p-4">
            <h3 className="mb-2 text-[13px] font-semibold">What happens when you create this school</h3>
            <ol className="grid gap-1.5">
              {[
                "The school is added to your tenant list, status Onboarding.",
                "The administrator's account is created for real, with a starting password shown next.",
                "The school shows as Onboarding until they finish their term setup.",
              ].map((t, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="font-mono text-[11px] text-ink-muted">0{i + 1}</span>
                  <span className="text-small leading-relaxed">{t}</span>
                </li>
              ))}
            </ol>
          </div>
          {submitError && (
            <p className="mt-4 flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
              <span aria-hidden>✕</span>{submitError}
              {tenant && " The school was created — trying again will only retry the administrator's login."}
            </p>
          )}
        </div>
      )}

      {step === 5 && (
        <div className="py-4 text-center">
          <div className="mx-auto mb-4 grid h-[52px] w-[52px] place-items-center rounded-full bg-ok-bg text-2xl text-ok-ink">✓</div>
          <h3 className="text-[19px] font-semibold">{tenant?.name ?? form.name ?? "The school"} is live</h3>
          <p className="mx-auto mt-1.5 max-w-[430px] text-body leading-relaxed text-ink-muted">
            The school and its administrator's account both exist for real now. Nothing was emailed or texted — hand
            these credentials to {form.adminName || "the administrator"} directly.
          </p>
          <div className="mx-auto mt-5 max-w-[420px] rounded-xl border border-line bg-sunken p-4 text-left">
            <div className="mb-2.5 font-mono text-micro tracking-[0.12em] text-ink-faint">FIRST LOGIN</div>
            {[["Email", credentials?.email ?? form.email], ["Password", credentials?.password ?? ""]].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 border-b border-line-soft py-2 text-[13px] last:border-0">
                <span className="text-ink-muted">{k}</span>
                <span className="font-mono font-medium">{v || "—"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}
