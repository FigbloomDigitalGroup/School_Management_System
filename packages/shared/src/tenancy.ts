import type { Tenant } from "./types";

/**
 * Tenants resolve by PATH: /s/<slug>/...
 * One deployment, no wildcard DNS, and a school's URL survives a domain change.
 * Mobile bakes the slug into the session instead of the URL.
 */

export const TENANT_PREFIX = "/s";

export function tenantSlugFromPath(pathname: string): string | null {
  const m = /^\/s\/([a-z0-9-]+)(?:\/|$)/.exec(pathname);
  return m ? m[1]! : null;
}

export function tenantPath(slug: string, rest = ""): string {
  const tail = rest.replace(/^\//, "");
  return tail ? `${TENANT_PREFIX}/${slug}/${tail}` : `${TENANT_PREFIX}/${slug}`;
}

/**
 * The slug exactly as it will be saved. Forms must send this, not the raw
 * input: validateSlug checks the lowercased value, and the tenants_slug_check
 * constraint rejects anything else, so "Nairobi" passed the form and then
 * failed the insert.
 */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Slug rules are strict because the school can never change it later. */
export function validateSlug(raw: string): { ok: boolean; message: string } {
  const slug = normalizeSlug(raw);
  if (!slug) return { ok: false, message: "Pick an address for the school." };
  if (slug.length < 3) return { ok: false, message: "At least three characters." };
  if (slug.length > 40) return { ok: false, message: "Forty characters at most." };
  if (!/^[a-z0-9-]+$/.test(slug)) return { ok: false, message: "Letters, numbers and hyphens only." };
  if (/^-|-$/.test(slug)) return { ok: false, message: "Cannot start or end with a hyphen." };
  if (RESERVED.has(slug)) return { ok: false, message: `"${slug}" is reserved by the platform.` };
  // Only the format is checked here -- whether it's free is a database question
  // (tenantSlugsTaken / organizationSlugsTaken), so this never claims "available".
  return { ok: true, message: "This can't be changed later, so check the spelling." };
}

const RESERVED = new Set([
  "admin", "api", "app", "auth", "console", "figbloom", "help", "login",
  "platform", "s", "signin", "status", "support", "www",
]);

export function suggestSlug(schoolName: string): string {
  return schoolName
    .toLowerCase()
    .replace(/\b(school|high|secondary|academy|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Free addresses to offer when the one typed is taken, most descriptive
 * first: the place (enterprise-junior-nairobi), then a number. Callers check
 * which of these are free before showing them.
 */
export function slugAlternatives(slug: string, place?: string | null): string[] {
  const base = normalizeSlug(slug).replace(/-\d+$/, "");
  const withSuffix = (suffix: string) => `${base.slice(0, 40 - suffix.length - 1).replace(/-+$/, "")}-${suffix}`;
  const placeSlug = place ? suggestSlug(place) : "";
  const candidates = [
    placeSlug && !base.endsWith(placeSlug) ? withSuffix(placeSlug) : "",
    ...[2, 3, 4, 5].map((n) => withSuffix(String(n))),
  ];
  return [...new Set(candidates)].filter((c) => c && c !== normalizeSlug(slug) && validateSlug(c).ok);
}

/** "The Enterprise Junior School" and "enterprise junior" compare equal. */
function schoolNameKey(name: string): string {
  return name.toLowerCase().replace(/\b(the|schools?)\b/g, " ").replace(/[^a-z0-9]+/g, "");
}

/**
 * Existing names that look like the same school, so a form can say so before
 * a near-duplicate is created. A warning, never a block: two branches of one
 * school may share a name. Matches the same name, or one name extending the
 * other ("Enterprise Junior" / "Enterprise Junior Academy").
 */
export function similarSchoolNames(name: string, existing: string[]): string[] {
  const key = schoolNameKey(name);
  if (key.length < 4) return [];
  return existing.filter((e) => {
    const k = schoolNameKey(e);
    return k === key || (Math.min(k.length, key.length) >= 6 && (k.startsWith(key) || key.startsWith(k)));
  });
}

export const needsAttention = (t: Tenant): boolean =>
  t.status === "overdue" || t.status === "setup_stalled" || t.status === "suspended";

/** A tenant's real per-term price: their negotiated override, or their plan's list price. */
export function effectivePriceCents(
  tenant: Pick<Tenant, "plan" | "price_cents_override">,
  listPriceByPlan: Map<string, number>,
): number {
  return tenant.price_cents_override ?? listPriceByPlan.get(tenant.plan) ?? 0;
}

/** A tenant counts toward MRR once it's actually being billed. */
export const isBilled = (t: Pick<Tenant, "status">): boolean =>
  t.status === "active" || t.status === "overdue";
