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
import { activateOrgSchool, createTenantSelfService } from "../../lib/orgSelfService";
import { inviteAdmin } from "../../lib/platformAdmin";
import { adminInviteError, schoolInsertError, useSlugAvailability } from "../../lib/slugAvailability";
import { TempPasswordCard } from "../../components/TempPasswordCard";
import { WebAddressField } from "../../components/WebAddressField";

const STATUS_TONE: Record<OrganizationTenantSummary["status"], "ok" | "warn" | "info" | "muted"> = {
  active: "ok", trial: "muted", onboarding: "info", overdue: "warn", suspended: "warn", setup_stalled: "warn",
};

/** The member-schools list — RecordsPage, the same template as platform/Subscriptions(), filtered to this organization. */
export function OrgSchools() {
  const { profile, organization } = useOrgSessionCtx();
  const nav = useNavigate();
  const [adding, setAdding] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const { data, error } = useAsync(() => fetchOrganizationTenantSummaries(organization.id), [organization.id, reloadKey]);
  const toast = useToast();

  useEffect(() => {
    void logOrganizationAccess(organization.id, profile.id, "viewed_schools_list");
  }, [organization.id, profile.id]);

  /** A school added before org-created schools went live straight away: let the org open it itself. */
  async function openForSignIn(s: OrganizationTenantSummary) {
    setOpening(s.tenant_id);
    try {
      await activateOrgSchool(s.tenant_id);
      toast(`${s.name} is open: its people can sign in now.`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(`Could not open ${s.name}: ${err instanceof Error ? err.message : (err as { message?: string })?.message ?? "something went wrong"}`, "error");
    } finally {
      setOpening(null);
    }
  }

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
      { key: "view", header: "", align: "right", width: "1.1fr" },
    ],
    chips: [
      { label: "All" },
      { label: "K-12", match: ["k12"] },
      { label: "Higher-ed", match: ["higher_ed"] },
      { label: "Needs attention", match: ["needs_attention"] },
    ],
    minWidth: "960px",
    empty: {
      title: "No schools yet",
      body: "Add your first school: it only needs a name, and it's ready to use straight away.",
      action: <Button variant="accent" onClick={() => setAdding(true)}>Add your first school</Button>,
    },
    rows: data.map((s) => ({
      id: s.tenant_id,
      tags: [s.institution_type, ...(s.status !== "active" ? ["needs_attention"] : [])],
      cells: [
        <span className="text-[13px] font-medium">{s.name}</span>,
        <Mono>{s.institution_type === "higher_ed" ? (s.higher_ed_subtype ? HIGHER_ED_SUBTYPE_LABEL[s.higher_ed_subtype] : "Higher-ed") : "K-12"}</Mono>,
        <Mono>{s.active_students.toLocaleString()}</Mono>,
        <span className="text-[13px]">{formatMoney(s.fees_collected_cents, "KE")} / {formatMoney(s.fees_billed_cents, "KE")}</span>,
        <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>,
        <span className="flex items-center justify-end gap-3">
          {s.status === "onboarding" && (
            <button type="button" disabled={opening === s.tenant_id} onClick={() => void openForSignIn(s)}
              className="text-[12px] font-semibold text-forest hover:underline disabled:opacity-50">
              {opening === s.tenant_id ? "Opening…" : "Open for sign-in"}
            </button>
          )}
          <button type="button" onClick={() => nav(`../schools/${s.tenant_id}`)} className="text-[12px] font-semibold text-leaf hover:underline">
            View
          </button>
        </span>,
      ],
    })),
  };

  return (
    <>
      <RecordsPage spec={spec} />
      {adding && (
        <AddSchoolModal
          organizationId={organization.id}
          organizationCounty={organization.county}
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

/** One question instead of three: K-12 level or higher-ed type, in a single list. */
const SCHOOL_KIND_OPTIONS: { value: string; label: string }[] = [
  ...SCHOOL_LEVEL_OPTIONS.map((o) => ({ value: `k12:${o.value}`, label: o.label })),
  { value: "higher_ed:university", label: "University" },
  { value: "higher_ed:college", label: "College" },
  { value: "higher_ed:tvet", label: "TVET" },
  { value: "higher_ed:short_course", label: "Short-course school" },
];

/**
 * "Add a school", kept to what's actually needed: a name (the web address
 * fills itself in from it, editable) and what kind of school it is.
 * Country, county and delivery are under "More options" with sensible
 * defaults. Inviting the school's own head teacher/administrator is
 * optional: the org admin can already run the school from here
 * (may_administer), so a school with no admin of its own yet is fine. The
 * school is live as soon as it's saved (createTenantSelfService).
 */
export function AddSchoolModal({ organizationId, organizationCounty, existingNames, ownEmail, onClose, onCreated, toast }: {
  organizationId: string;
  organizationCounty: string | null;
  existingNames: string[];
  ownEmail: string | null;
  onClose: (saved: boolean) => void;
  onCreated: (name: string) => void;
  toast: ToastFn;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [schoolKind, setSchoolKind] = useState("k12:secondary");
  const [moreOpen, setMoreOpen] = useState(false);
  const [county, setCounty] = useState(organizationCounty ?? "");
  const [country, setCountry] = useState("KE");
  const [deliveryMode, setDeliveryMode] = useState<Tenant["delivery_mode"]>("in_person");
  const [inviteNow, setInviteNow] = useState(false);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminTitle, setAdminTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState("");
  // Saved, but its administrator wasn't: a retry only re-tries the administrator,
  // instead of inserting the school again and colliding with its own address.
  const [saved, setSaved] = useState<Tenant | null>(null);
  // The administrator's one-time password, shown once before closing.
  const [credentials, setCredentials] = useState<{ name: string; email: string; password: string } | null>(null);

  const slugValue = normalizeSlug(slugTouched ? slug : (name ? suggestSlug(name) : ""));
  const slugCheck = slugValue ? validateSlug(slugValue) : { ok: false, message: "" };
  const availability = useSlugAvailability("school", saved ? "" : slugValue, county);
  const lookalikes = name.trim() ? similarSchoolNames(name, existingNames) : [];
  const close = () => (credentials && saved ? onCreated(saved.name) : onClose(saved !== null));

  async function create() {
    setError("");
    setEmailError("");
    if (!name.trim()) { setError("Give the school a name."); return; }
    if (!saved) {
      if (!slugCheck.ok) { setError(slugCheck.message || "Pick a valid web address."); return; }
      if (availability.status === "taken") { setError(`schoolmanagement.figbloom.org/s/${slugValue} is already taken. Pick another web address: there are suggestions under it.`); return; }
      if (availability.status === "checking") { setError("Still checking the web address. Give it a second and try again."); return; }
    }
    if (inviteNow) {
      if (!adminName.trim() || !adminEmail.trim()) { setError("Add the head teacher's name and email, or untick \"Invite a head teacher/admin now\"."); return; }
      if (ownEmail && adminEmail.trim().toLowerCase() === ownEmail.toLowerCase()) {
        setEmailError("That's your own login, and you can already manage this school from your organization. Use the head teacher's own email, or leave the invite for later.");
        return;
      }
    }

    const [institutionType, sub] = schoolKind.split(":") as [Tenant["institution_type"], string];
    setSaving(true);
    let tenant = saved;
    try {
      tenant ??= await createTenantSelfService({
        name: name.trim(),
        slug: slugValue,
        county: county.trim(),
        country,
        level: institutionType === "k12" ? (sub as Tenant["level"]) : "secondary",
        institution_type: institutionType,
        higher_ed_subtype: institutionType === "higher_ed" ? (sub as NonNullable<Tenant["higher_ed_subtype"]>) : null,
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

    if (!inviteNow) {
      setSaving(false);
      onCreated(tenant.name);
      return;
    }

    try {
      const r = await inviteAdmin({
        tenant_id: tenant.id,
        full_name: adminName.trim(),
        staff_title: adminTitle.trim() || "Head teacher",
        email: adminEmail.trim(),
      });
      setCredentials({ name: adminName.trim(), email: r.email, password: r.password });
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

  if (credentials && saved) {
    return (
      <Modal open onClose={close} eyebrow="Schools" title={`${saved.name} is ready`}
        actions={<Button variant="accent" onClick={close}>Done</Button>}>
        <div className="grid gap-3.5">
          <p className="text-[13px] leading-relaxed text-ink-muted">
            It's live at schoolmanagement.figbloom.org/s/{saved.slug}, and {credentials.name} can sign in through the Admin portal with their email.
          </p>
          <TempPasswordCard who={credentials.name} login={credentials.email} loginLabel="Email" password={credentials.password} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onClose={close}
      eyebrow="Schools"
      title="Add a school"
      blurb="It's ready to use as soon as you add it. You can fill in the rest later."
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
            <span className="font-semibold text-ink">{saved.name}</span> is saved at schoolmanagement.figbloom.org/s/{saved.slug}. Only its administrator is
            left: fix their details below and press Add administrator. Closing keeps the school.
          </p>
        )}
        {error && (
          <p role="alert" className="flex items-start gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>{error}
          </p>
        )}
        <div>
          <TextField id="school-name" label="School name" placeholder="e.g. Riverside Primary" autoFocus value={name} disabled={!!saved} onChange={(e) => setName(e.target.value)} />
          {!saved && lookalikes.length > 0 && (
            <p className="mt-1.5 text-[11.5px] text-orange-ink">
              This organization already has {lookalikes.length === 1 ? "a school" : "schools"} called {lookalikes.map((n) => `"${n}"`).join(", ")}.
              If it's the same school, it doesn't need adding again; if it's another branch, give it a name parents can tell apart.
            </p>
          )}
        </div>
        <WebAddressField
          id="school-slug" base="schoolmanagement.figbloom.org/s/" noun="school"
          slug={saved ? saved.slug : slugValue} editing={slugTouched} disabled={!!saved}
          availability={availability}
          onEdit={() => { setSlug(slugValue); setSlugTouched(true); }}
          onChange={(s) => { setSlugTouched(true); setSlug(s); }}
        />
        <SelectField id="school-kind" label="What kind of school?" value={schoolKind} disabled={!!saved}
          onChange={(e) => setSchoolKind(e.target.value)} options={SCHOOL_KIND_OPTIONS} />

        <div className="border-t border-line-soft pt-3">
          <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}
            className="flex w-full items-center justify-between text-left text-[12.5px] font-semibold text-ink">
            More options <span className="font-normal text-ink-faint">{moreOpen ? "Hide" : "Country, county, delivery"}</span>
          </button>
          {moreOpen && (
            <div className="mt-3 grid gap-3.5 sm:grid-cols-2">
              <CountrySelect id="school-country" label="Country" value={country} onChange={setCountry} />
              <TextField id="school-county" label="County" placeholder="e.g. Nairobi" value={county} disabled={!!saved} onChange={(e) => setCounty(e.target.value)} />
              <SelectField id="school-delivery-mode" label="Delivery" value={deliveryMode} disabled={!!saved} onChange={(e) => setDeliveryMode(e.target.value as Tenant["delivery_mode"])}
                options={[{ value: "in_person", label: "In-person" }, { value: "online", label: "Online" }, { value: "hybrid", label: "Hybrid" }]} />
            </div>
          )}
        </div>

        <div className="border-t border-line-soft pt-3">
          <label className="flex items-start gap-2.5 text-[12.5px]">
            <input type="checkbox" checked={inviteNow} onChange={(e) => setInviteNow(e.target.checked)} className="mt-0.5" style={{ accentColor: "#17402A" }} />
            <span>
              <span className="font-semibold text-ink">Invite a head teacher/admin now</span>
              <span className="block text-ink-muted">Optional. You can already run this school from your organization, and add its own admin any time.</span>
            </span>
          </label>
          {inviteNow && (
            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
              <TextField id="school-admin-name" label="Their name" value={adminName} onChange={(e) => setAdminName(e.target.value)} />
              <TextField id="school-admin-email" label="Their email" type="email" error={emailError || undefined} value={adminEmail} onChange={(e) => { setAdminEmail(e.target.value); setEmailError(""); }} />
              <div className="sm:col-span-2">
                <TextField
                  id="school-admin-title" label="Their role at this school" placeholder="e.g. Head teacher, Principal, Director"
                  value={adminTitle} onChange={(e) => setAdminTitle(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
      </form>
    </Modal>
  );
}
