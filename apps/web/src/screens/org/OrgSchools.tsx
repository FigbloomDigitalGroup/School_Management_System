import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  fetchOrganizationTenantSummaries, logOrganizationAccess, suggestSlug, validateSlug, KES,
  type OrganizationTenantSummary, type Tenant,
} from "@figbloom/shared";
import { Badge, HIGHER_ED_SUBTYPE_LABEL } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Mono } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../components/ui/Toast";
import { RecordsPage, type RecordsSpec } from "../platform/RecordsPage";
import { useAsync } from "../../lib/useAsync";
import { useOrgSessionCtx } from "../../lib/orgSessionContext";
import { createTenantSelfService } from "../../lib/orgSelfService";
import { inviteAdmin } from "../../lib/platformAdmin";

const STATUS_TONE: Record<OrganizationTenantSummary["status"], "ok" | "warn" | "info" | "muted"> = {
  active: "ok", trial: "muted", onboarding: "info", overdue: "warn", suspended: "warn", setup_stalled: "warn",
};

/** The member-schools list — RecordsPage, the same template as platform/Subscriptions(), filtered to this organization. */
export function OrgSchools() {
  const { profile, organization } = useOrgSessionCtx();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id, reloadKey]);
  const toast = useToast();

  useEffect(() => {
    void logOrganizationAccess(organization.id, profile.id, "viewed_schools_list");
  }, [organization.id, profile.id]);

  if (loading || !data) {
    return (
      <RecordsPage spec={{ eyebrow: organization.name, title: "Schools", blurb: "Loading…", stats: [], columns: [], rows: [] }} />
    );
  }
  if (error) {
    return (
      <RecordsPage spec={{ eyebrow: organization.name, title: "Schools", blurb: `Could not load: ${error.message}`, stats: [], columns: [], rows: [] }} />
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
      { label: "Fees collected", value: KES(totalCollected), sub: totalBilled > 0 ? `of ${KES(totalBilled)} billed` : "nothing billed yet" },
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
        <span className="text-[13px]">{KES(s.fees_collected_cents)} / {KES(s.fees_billed_cents)}</span>,
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
          onClose={() => setAdding(false)}
          onCreated={(name) => { setAdding(false); setReloadKey((k) => k + 1); toast(`${name} created.`); }}
          toast={toast}
        />
      )}
    </>
  );
}

const COUNTRY_OPTIONS = [{ value: "KE", label: "Kenya" }];

function AddSchoolModal({ organizationId, onClose, onCreated, toast }: {
  organizationId: string;
  onClose: () => void;
  onCreated: (name: string) => void;
  toast: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [county, setCounty] = useState("Nairobi");
  const [country] = useState("KE");
  const [institutionType, setInstitutionType] = useState<Tenant["institution_type"]>("k12");
  const [level, setLevel] = useState<Tenant["level"]>("secondary");
  const [higherEdSubtype, setHigherEdSubtype] = useState<NonNullable<Tenant["higher_ed_subtype"]>>("university");
  const [deliveryMode, setDeliveryMode] = useState<Tenant["delivery_mode"]>("in_person");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const slugValue = slug || (name ? suggestSlug(name) : "");
  const slugCheck = slugValue ? validateSlug(slugValue) : { ok: false, message: "" };

  async function create() {
    setError("");
    if (!name.trim()) { setError("Give the school a name."); return; }
    if (!slugCheck.ok) { setError(slugCheck.message || "Pick a valid address."); return; }
    if (!adminName.trim() || !adminEmail.trim()) { setError("The school's own administrator name and email are required."); return; }

    setSaving(true);
    try {
      const tenant = await createTenantSelfService({
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
      });

      await inviteAdmin({
        tenant_id: tenant.id,
        full_name: adminName.trim(),
        staff_title: "Principal",
        email: adminEmail.trim(),
      });

      onCreated(tenant.name);
    } catch (err) {
      toast(err instanceof Error ? `Could not add the school: ${err.message}` : "Could not add the school.");
    } finally {
      setSaving(false);
    }
  }

  function handleSubmit(e: FormEvent) { e.preventDefault(); void create(); }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Schools"
      title="Add a school"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void create()} disabled={saving}>{saving ? "Creating…" : "Add school"}</Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField id="school-name" label="School name" placeholder="e.g. Riverside Primary" value={name} onChange={(e) => setName(e.target.value)} />
          <TextField
            id="school-slug" label="Address" mono placeholder={slugValue || "riverside-primary"}
            value={slug} hint={slugCheck.ok ? `figbloom.co.ke/s/${slugValue}` : undefined}
            error={slug && !slugCheck.ok ? slugCheck.message : undefined}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <SelectField id="school-country" label="Country" value={country} options={COUNTRY_OPTIONS} disabled />
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
            options={[{ value: "secondary", label: "Secondary" }, { value: "primary", label: "Primary" }, { value: "combined", label: "Combined" }]} />
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
            <TextField id="school-admin-email" label="Email" type="email" error={error} value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
          </div>
        </div>
      </form>
    </Modal>
  );
}
