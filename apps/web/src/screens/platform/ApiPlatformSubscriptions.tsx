import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  apiFetchPlatformSubscriptions,
  apiSetPlatformPlanPrice,
  apiUpdatePlatformSubscription,
  formatMoney,
  userMessage,
  type PlatformPlanCode,
  type PlatformSubscriptionItem,
  type TenantStatus,
} from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { Badge, Cell, Mono, RecordsPage, type RecordsSpec, type Tone } from "./RecordsPage";
import { STATUS_LABEL, STATUS_TONE } from "./Tenants";

const PLANS: readonly PlatformPlanCode[] = ["standard", "institution", "county"];
const PLAN_LABEL: Record<PlatformPlanCode, string> = {
  standard: "Standard",
  institution: "Institution",
  county: "County",
};
const SUBSCRIPTION_STATUSES: readonly TenantStatus[] = ["active", "trial", "onboarding", "overdue", "suspended", "setup_stalled"];

interface SubscriptionDraft {
  school: PlatformSubscriptionItem;
  plan: PlatformPlanCode;
  status: TenantStatus;
  overridePrice: string;
  trialEndsAt: string;
  renewsOn: string;
}

function centsInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Parses KES text without floating point rounding; the API stores integer cents. */
function parseKesCents(value: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function priceText(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? "Not configured" : formatMoney(cents, "KE");
}

function initialDraft(school: PlatformSubscriptionItem): SubscriptionDraft {
  return {
    school,
    plan: school.plan,
    status: school.status,
    overridePrice: school.priceCentsOverride === null ? "" : centsInput(school.priceCentsOverride),
    trialEndsAt: localDateTime(school.trialEndsAt),
    renewsOn: school.renewsOn ?? "",
  };
}

/**
 * Platform subscriptions on the API (`GET/PUT /v1/platform/subscriptions`, slice S6a).
 * Displays only configured KES prices and actual subscription terms; it does not estimate MRR or licensed seats.
 */
export function ApiPlatformSubscriptions() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, loading, error } = useAsync(() => apiFetchPlatformSubscriptions(), [refreshKey]);
  const [editing, setEditing] = useState<SubscriptionDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingSubscription, setSavingSubscription] = useState(false);
  const [priceDrafts, setPriceDrafts] = useState<Partial<Record<PlatformPlanCode, string>>>({});
  const [savingPrice, setSavingPrice] = useState<PlatformPlanCode | null>(null);
  const [priceErrors, setPriceErrors] = useState<Partial<Record<PlatformPlanCode, string>>>({});
  const toast = useToast();

  useEffect(() => {
    if (!data) return;
    setPriceDrafts(Object.fromEntries(data.pricing.map((p) => [p.plan, centsInput(p.priceCents)])));
  }, [data]);

  const listPriceByPlan = useMemo(
    () => new Map((data?.pricing ?? []).map((price) => [price.plan, price.priceCents])),
    [data?.pricing],
  );

  const emptySpec: RecordsSpec = {
    eyebrow: "Platform · billing",
    title: "Subscriptions",
    blurb: "Manage school subscription terms and explicitly configured KES plan prices.",
    stats: [],
    columns: [],
    rows: [],
  };

  if (loading && !data) return <RecordsPage spec={emptySpec} loading />;
  if (error) return <RecordsPage spec={emptySpec} error={userMessage(error)} />;
  if (!data) return <RecordsPage spec={emptySpec} loading />;

  const active = data.items.filter((item) => item.status === "active").length;
  const trials = data.items.filter((item) => item.status === "trial").length;
  const atRisk = data.items.filter((item) => item.status === "overdue" || item.status === "suspended").length;

  function openEdit(school: PlatformSubscriptionItem) {
    setEditError(null);
    setEditing(initialDraft(school));
  }

  async function saveSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const override = editing.overridePrice.trim() ? parseKesCents(editing.overridePrice) : null;
    if (editing.overridePrice.trim() && override === null) {
      setEditError("Enter a non-negative KES amount with up to two decimal places, or leave the override blank.");
      return;
    }
    setSavingSubscription(true);
    setEditError(null);
    try {
      const changed = await apiUpdatePlatformSubscription(editing.school.tenantId, {
        plan: editing.plan,
        status: editing.status,
        price_cents_override: override,
        trial_ends_at: editing.trialEndsAt ? new Date(editing.trialEndsAt).toISOString() : null,
        renews_on: editing.renewsOn || null,
      });
      toast(changed ? `${editing.school.name}'s subscription terms saved.` : "Subscription terms are unchanged.");
      setEditing(null);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setEditError(userMessage(err));
    } finally {
      setSavingSubscription(false);
    }
  }

  async function savePlanPrice(plan: PlatformPlanCode, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = priceDrafts[plan] ?? "";
    const cents = parseKesCents(input);
    if (cents === null) {
      setPriceErrors((current) => ({ ...current, [plan]: "Enter a non-negative KES amount with up to two decimal places." }));
      return;
    }
    setSavingPrice(plan);
    setPriceErrors((current) => ({ ...current, [plan]: undefined }));
    try {
      const changed = await apiSetPlatformPlanPrice(plan, cents);
      toast(changed ? `${PLAN_LABEL[plan]} plan price saved.` : `${PLAN_LABEL[plan]} plan price is unchanged.`);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      setPriceErrors((current) => ({ ...current, [plan]: userMessage(err) }));
    } finally {
      setSavingPrice(null);
    }
  }

  const spec: RecordsSpec = {
    eyebrow: "Platform · billing",
    title: "Subscriptions",
    blurb: "School subscription terms and configured KES prices. MRR and seat estimates are not available on this API build.",
    actions: [{ label: loading ? "Refreshing…" : "Refresh", primary: true, onClick: () => setRefreshKey((key) => key + 1) }],
    stats: [
      { label: "Schools", value: String(data.items.length), sub: "with subscription records" },
      { label: "Active", value: String(active), sub: "subscription status" },
      { label: "In trial", value: String(trials), sub: "trial status" },
      { label: "At risk", value: String(atRisk), sub: "overdue or suspended", alarming: atRisk > 0 },
    ],
    extra: (
      <section className="rounded-lg border border-line bg-white p-4" aria-label="Figbloom plan prices">
        <div className="mb-3">
          <h2 className="text-[13px] font-semibold">Figbloom plan prices</h2>
          <p className="mt-1 text-small text-ink-muted">KES amounts are stored in cents. An unset price remains unconfigured until saved.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {PLANS.map((plan) => {
            const configured = listPriceByPlan.has(plan);
            return (
              <form key={plan} onSubmit={(event) => void savePlanPrice(plan, event)} className="rounded-md border border-line-soft bg-page p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <label htmlFor={`plan-price-${plan}`} className="text-small font-semibold">{PLAN_LABEL[plan]}</label>
                  <span className="text-[11px] text-ink-faint">{configured ? "Configured" : "Not configured"}</span>
                </div>
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <TextField
                      id={`plan-price-${plan}`}
                      label="Price (KES)"
                      type="text"
                      inputMode="decimal"
                      value={priceDrafts[plan] ?? ""}
                      onChange={(event) => setPriceDrafts((current) => ({ ...current, [plan]: event.target.value }))}
                      error={priceErrors[plan]}
                    />
                  </div>
                  <Button type="submit" variant="secondary" disabled={savingPrice !== null}>
                    {savingPrice === plan ? "Saving…" : "Save"}
                  </Button>
                </div>
                {configured && <p className="mt-2 text-[11px] text-ink-faint">Current: {priceText(listPriceByPlan.get(plan))}</p>}
              </form>
            );
          })}
        </div>
      </section>
    ),
    columns: [
      { key: "school", header: "School", width: "1.6fr" },
      { key: "plan", header: "Plan", width: "0.9fr" },
      { key: "price", header: "Price", align: "right" },
      { key: "renewal", header: "Trial / renewal", width: "1.2fr" },
      { key: "status", header: "Status", width: "0.9fr" },
      { key: "actions", header: "Terms", align: "right" },
    ],
    chips: [
      { label: "All" },
      { label: "Trial", match: ["trial"] },
      { label: "At risk", match: ["overdue", "suspended"] },
    ],
    minWidth: "920px",
    empty: {
      title: "No subscriptions match this filter",
      body: "Switch back to All to see every school subscription.",
    },
    rows: data.items.map((school) => {
      const effective = school.priceCentsOverride ?? listPriceByPlan.get(school.plan);
      const renewal = school.status === "trial"
        ? (school.trialEndsAt ? `Trial ends ${new Date(school.trialEndsAt).toLocaleDateString()}` : "Trial end not set")
        : (school.renewsOn ? new Date(`${school.renewsOn}T00:00:00`).toLocaleDateString() : "Renewal not set");
      const tone: Tone = STATUS_TONE[school.status];
      return {
        id: school.tenantId,
        tags: [school.status],
        cells: [
          <Cell key="school" sub={school.slug}>{school.name}</Cell>,
          <span key="plan" className="text-[13px]">{PLAN_LABEL[school.plan]}</span>,
          <Mono key="price">{priceText(effective)}</Mono>,
          <span key="renewal" className="font-mono text-[12px] text-ink-muted">{renewal}</span>,
          <Badge key="status" tone={tone}>{STATUS_LABEL[school.status]}</Badge>,
          <Button key="edit" type="button" variant="secondary" onClick={() => openEdit(school)}>Edit terms</Button>,
        ],
      };
    }),
  };

  return (
    <>
      <RecordsPage spec={spec} />
      <Modal
        open={!!editing}
        onClose={() => { if (!savingSubscription) setEditing(null); }}
        eyebrow="Platform · billing"
        title={editing ? `Edit ${editing.school.name}` : "Edit subscription"}
        blurb="Changes are audited. A recent password confirmation is required before saving. This does not change school access."
        footNote="Blank price override, trial end, or renewal date means unset."
        actions={(
          <>
            <Button type="button" onClick={() => setEditing(null)} disabled={savingSubscription}>Cancel</Button>
            <Button type="submit" form="platform-subscription-form" variant="accent" disabled={savingSubscription}>
              {savingSubscription ? "Saving…" : "Save terms"}
            </Button>
          </>
        )}
      >
        {editing && (
          <form id="platform-subscription-form" onSubmit={(event) => void saveSubscription(event)} className="space-y-4">
            {editError && <p role="alert" className="rounded-md border border-warn-ink/30 bg-warn-ink/5 px-3 py-2 text-small text-warn-ink">{editError}</p>}
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                id="subscription-plan"
                label="Plan"
                value={editing.plan}
                onChange={(event) => setEditing({ ...editing, plan: event.target.value as PlatformPlanCode })}
                options={PLANS.map((plan) => ({ value: plan, label: PLAN_LABEL[plan] }))}
              />
              <SelectField
                id="subscription-status"
                label="Subscription status"
                value={editing.status}
                onChange={(event) => setEditing({ ...editing, status: event.target.value as TenantStatus })}
                options={SUBSCRIPTION_STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] }))}
              />
              <TextField
                id="subscription-override"
                label="Price override (KES)"
                hint="Leave blank to use the configured plan price."
                type="text"
                inputMode="decimal"
                value={editing.overridePrice}
                onChange={(event) => setEditing({ ...editing, overridePrice: event.target.value })}
              />
              <TextField
                id="subscription-trial-end"
                label="Trial ends"
                type="datetime-local"
                value={editing.trialEndsAt}
                onChange={(event) => setEditing({ ...editing, trialEndsAt: event.target.value })}
              />
              <TextField
                id="subscription-renews-on"
                label="Renewal date"
                type="date"
                value={editing.renewsOn}
                onChange={(event) => setEditing({ ...editing, renewsOn: event.target.value })}
              />
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
