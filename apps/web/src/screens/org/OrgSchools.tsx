import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  SCHOOL_LEVEL_OPTIONS, fetchOrganizationTenantSummaries, logOrganizationAccess, normalizeSlug, similarSchoolNames, suggestSlug, validateSlug, formatMoney,
  type OrganizationTenantSummary, type Tenant,
} from "@figbloom/shared";
import { Badge, HIGHER_ED_SUBTYPE_LABEL } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { CountrySelect } from "../../components/ui/CountrySelect";
import { Mono } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { useToast, type ToastFn } from "../../components/ui/Toast";
import { RecordsPage, type RecordsSpec } from "../platform/RecordsPage";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";
import { createTenantSelfService } from "../../lib/orgSelfService";
import { inviteAdmin } from "../../lib/platformAdmin";
import { adminInviteError, schoolInsertError, useSlugAvailability } from "../../lib/slugAvailability";
import { SlugAvailabilityNote } from "../../components/SlugAvailabilityNote";

const STATUS_TONE: Record<OrganizationTenantSummary["status"], "ok" | "warn" | "info" | "muted"> = {
  active: "ok", trial: "muted", onboarding: "info", overdue: "warn", suspended: "warn", setup_stalled: "warn",
};

/** The member-schools list — RecordsPage, the same template as platform/Subscriptions(), filtered to this organization. */
export function OrgSchools() {
  const { profile, organization } = useOrgSessionCtx();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { data, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id, reloadKey]);
  const toast = useToast();

  useEffect(() => {
    void logOrganizationAccess(organization.id, profile.id, "viewed_schools_list");
  }, [organization.id, profile.id]);

  // First load only — a reload after adding a school keeps the list on screen.
  if (!data || error) {
    return (
      <RecordsPage
        spec={{ eyebrow: organization.name, title: "Schools", blurb: "", stats: [], columns: [], rows: [] }}
        loading={!error}
        error={error?.message}
      />
    );
  }

  const totalBilled = data.reduce((a, s) => a + s.fees_billed_cents, 0);
  const totalCollected = data.reduce((a, s) => a + s.fees_collected_cents, 0);

  const spec: RecordsSpec = {
    eyebrow: organization.name,
    title: "Schools",
    blurb: "Every school in this organization, at a glance — aggregate figures only.",
    actions: [{ label: "+ Add school", primary: true, onClick: () => setAdding(true) }],
    stats: [
      { label: "Schools", value: String(data.length) },
      { label: "Active students", value: data.reduce((a, s) => a + s.active_students, 0).toLocaleString() },
      // Every school in an organization is Kenyan today (the country
      // selector is locked to Kenya) — once organizations can span
      // countries, summing cents across schools becomes a real
      // multi-currency aggregation problem, not just a formatting one.
      { label: "Fees collected", value: formatMoney(totalCollected, "KE"), sub: totalBilled > 0 ? `of ${formatMoney(totalBilled, "KE")} billed` : "nothing billed yet" },
      { label: "Needs attention", value: String(data.filter((s) => s.status !== "active").length), alarming: data.some((s) => s.status !== "active") },
    ],
    columns: [
      { key: "name", header: "School", width: "1.6fr" },
      { key: "type", header: "Type", width: "1fr" },
      { key: "students", header: "Students", align: "right", width: "1fr" },
      { key: "fees", header: "Fees collected", align: "right", width: "1.4fr" },
      { key: "status", header: "Status", width: "1fr" },
      { key: "view", header: "", align: "right", width: "0.8fr" },
    ],
    chips: [
      { label: "All" },
      { label: "K-12", match: ["k12"] },
      { label: "Higher-ed", match: ["higher_ed"] },
      { label: "Needs attention", match: ["needs_attention"] },
    ],
    minWidth: "920px",
    rows: data.map((s) => ({
      id: s.tenant_id,
      tags: [s.institution_type, ...(s.status !== "active" ? ["needs_attention"] : [])],
      cells: [
        <span className="text-[13px] font-medium">{s.name}</span>,
        <Mono>{s.institution_type === "higher_ed" ? (s.higher_ed_subtype ? HIGHER_ED_SUBTYPE_LABEL[s.higher_ed_subtype] : "Higher-ed") : "K-12"}</Mono>,
        <Mono>{s.active_students.toLocaleString()}</Mono>,
        <span className="text-[13px]">{formatMoney(s.fees_collected_cents, "KE")} / {formatMoney(s.fees_billed_cents, "KE")}</span>,
        <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>,
        <button type="button" onClick={() => nav(`../schools/${s.tenant_id}`)} className="text-[12px] font-semibold text-leaf hover:underline">
          View
        </button>,
      ],
    })),
  };

  return (
    <>
      <RecordsPage spec={spec} />
      {adding && (
        <AddSchoolModal
          organizationId={organization.id}
          existingNames={data.map((s) => s.name)}
          ownEmail={profile.email}
          // a school saved before its administrator failed is real: show it in the list
          onClose={(saved) => { setAdding(false); if (saved) setReloadKey((k) => k + 1); }}
          onCreated={(name) => { setAdding(false); setReloadKey((k) => k + 1); toast(`${name} created.`); }}
          toast={toast}
        />
      )}
    </>
  );
}

function AddSchoolModal({ organizationId, existingNames, ownEmail, onClose, onCreated, toast }: {
  organizationId: string;
  existingNames: string[];
  ownEmail: string | null;
  onClose: (saved: boolean) => void;
  onCreated: (name: string) => void;
  toast: ToastFn;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [county, setCounty] = useState("Nairobi");
  const [country, setCountry] = useState("KE");
  const [institutionType, setInstitutionType] = useState<Tenant["institution_type"]>("k12");
  const [level, setLevel] = useState<Tenant["level"]>("secondary");
  const [higherEdSubtype, setHigherEdSubtype] = useState<NonNullable<Tenant["higher_ed_subtype"]>>("university");
  const [deliveryMode, setDeliveryMode] = useState<Tenant["delivery_mode"]>("in_person");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminTitle, setAdminTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  // Saved, but its administrator wasn't: a retry only re-tries the administrator,
  // instead of inserting the school again and colliding with its own address.
  const [saved, setSaved] = useState<Tenant | null>(null);

  const slugValue = normalizeSlug(slug || (name ? suggestSlug(name) : ""));
  const slugCheck = slugValue ? validateSlug(slugValue) : { ok: false, message: "" };
  const availability = useSlugAvailability("school", saved ? "" : slugValue, county);
  const lookalikes = name.trim() ? similarSchoolNames(name, existingNames) : [];
  const close = () => onClose(saved !== null);

  async function create() {
    setError("");
    setEmailError("");
    if (!name.trim()) { setError("Give the school a name."); return; }
    if (!saved) {
      if (!slugCheck.ok) { setError(slugCheck.message || "Pick a valid web address."); return; }
      if (availability.status === "taken") { setError(`figbloom.co.ke/s/${slugValue} is already taken. Pick another web address: there are suggestions under the field.`); return; }
      if (availability.status === "checking") { setError("Still checking the web address. Give it a second and try again."); return; }
    }
    if (!adminName.trim() || !adminEmail.trim()) { setError("The school's own administrator name and email are required."); return; }
    if (ownEmail && adminEmail.trim().toLowerCase() === ownEmail.toLowerCase()) {
      setEmailError("That's your own login. The school needs its own administrator with their own email; you can already manage it from this organization.");
      return;
    }

    setSaving(true);
    let tenant = saved;
    try {
      tenant ??= await createTenantSelfService({
        name: name.trim(),
        slug: slugValue,
        county: county.trim(),
        country,
        level,
        institution_type: institutionType,
        higher_ed_subtype: institutionType === "higher_ed" ? higherEdSubtype : null,
        delivery_mode: deliveryMode,
        organization_id: organizationId,
        moe_registration: null,
        plan: "standard",
        accent: "#1B4D2E",
        licensed_seats: 0,
      }).catch((err) => { throw schoolInsertError(err, slugValue); });
      setSaved(tenant);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The school could not be saved.");
      setSaving(false);
      return;
    }

    try {
      await inviteAdmin({
        tenant_id: tenant.id,
        full_name: adminName.trim(),
        staff_title: adminTitle.trim() || "Principal",
        email: adminEmail.trim(),
      });

      onCreated(tenant.name);
    } catch (err) {
      const reason = adminInviteError(err, adminEmail.trim());
      if (/already has a Figbloom login/.test(reason)) setEmailError(reason);
      else setError(`${tenant.name} is saved, but its administrator couldn't be added: ${reason}`);
      toast(`${tenant.name} is saved. Only its administrator still needs adding.`, "error");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void create(); }

  return (
    <Modal
      open
      onClose={close}
      eyebrow="Schools"
      title="Add a school"
      actions={
        <>
          <Button onClick={close}>{saved ? "Close" : "Cancel"}</Button>
          <Button variant="accent" onClick={() => void create()} disabled={saving || (!saved && availability.status === "taken")}>
            {saving ? "Saving…" : saved ? "Add administrator" : "Add school"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        {saved && (
          <p className="rounded-lg border border-line bg-sunken px-3 py-2.5 text-[12.5px] text-ink-muted">
            <span className="font-semibold text-ink">{saved.name}</span> is saved at figbloom.co.ke/s/{saved.slug}. Only its administrator is
            left: fix their details below and press Add administrator. Closing keeps the school.
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>{error}
          </p>
        )}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <div>
            <TextField id="school-name" label="School name" placeholder="e.g. Riverside Primary" value={name} disabled={!!saved} onChange={(e) => setName(e.target.value)} />
            {!saved && lookalikes.length > 0 && (
              <p className="mt-1.5 text-[11.5px] text-orange-ink">
                This organization already has {lookalikes.length === 1 ? "a school" : "schools"} called {lookalikes.map((n) => `"${n}"`).join(", ")}.
                If it's the same school, it doesn't need adding again; if it's another branch, give it a name parents can tell apart.
              </p>
            )}
          </div>
          <div>
            <TextField
              id="school-slug" label="Web address" mono placeholder={slugValue || "riverside-primary"}
              value={saved ? saved.slug : slug} disabled={!!saved}
              hint={slugCheck.ok && availability.status === "idle" ? `figbloom.co.ke/s/${slugValue}` : undefined}
              error={slug && !slugCheck.ok ? slugCheck.message : undefined}
              onChange={(e) => setSlug(e.target.value)}
            />
            {!saved && <SlugAvailabilityNote slug={slugValue} noun="school" availability={availability} onPick={setSlug} />}
          </div>
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <CountrySelect id="school-country" label="Country" value={country} onChange={setCountry} />
          <TextField id="school-county" label="County" value={county} onChange={(e) => setCounty(e.target.value)} />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField
            id="school-institution-type" label="Institution type" value={institutionType}
            onChange={(e) => setInstitutionType(e.target.value as Tenant["institution_type"])}
            options={[{ value: "k12", label: "K-12 school" }, { value: "higher_ed", label: "Higher education" }]}
          />
          <SelectField id="school-delivery-mode" label="Delivery" value={deliveryMode} onChange={(e) => setDeliveryMode(e.target.value as Tenant["delivery_mode"])}
            options={[{ value: "in_person", label: "In-person" }, { value: "online", label: "Online" }, { value: "hybrid", label: "Hybrid" }]} />
        </div>
        {institutionType === "k12" ? (
          <SelectField id="school-level" label="Level" value={level} onChange={(e) => setLevel(e.target.value as Tenant["level"])}
            options={SCHOOL_LEVEL_OPTIONS} />
        ) : (
          <SelectField id="school-higher-ed-subtype" label="Type" value={higherEdSubtype} onChange={(e) => setHigherEdSubtype(e.target.value as NonNullable<Tenant["higher_ed_subtype"]>)}
            options={[
              { value: "university", label: "University" },
              { value: "college", label: "College" },
              { value: "short_course", label: "Short-course school" },
              { value: "tvet", label: "TVET" },
            ]} />
        )}
        <div className="mt-1 border-t border-line-soft pt-3.5">
          <p className="mb-3 text-[12.5px] font-semibold text-ink">This school's own administrator</p>
          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField id="school-admin-name" label="Name" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
            <TextField id="school-admin-email" label="Email" type="email" error={emailError || undefined} value={adminEmail} onChange={(e) => { setAdminEmail(e.target.value); setEmailError(""); }} />
          </div>
          <div className="mt-3.5">
            <TextField
              id="school-admin-title" label="Their role at this school" placeholder="e.g. Principal, Director, Owner"
              hint="Whatever they actually are — not every school's lead admin is a Principal."
              value={adminTitle} onChange={(e) => setAdminTitle(e.target.value)}
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}
