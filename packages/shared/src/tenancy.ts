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

/** Slug rules are strict because the school can never change it later. */
export function validateSlug(raw: string): { ok: boolean; message: string } {
  const slug = raw.trim().toLowerCase();
  if (!slug) return { ok: false, message: "Pick an address for the school." };
  if (slug.length < 3) return { ok: false, message: "At least three characters." };
  if (slug.length > 40) return { ok: false, message: "Forty characters at most." };
  if (!/^[a-z0-9-]+$/.test(slug)) return { ok: false, message: "Letters, numbers and hyphens only." };
  if (/^-|-$/.test(slug)) return { ok: false, message: "Cannot start or end with a hyphen." };
  if (RESERVED.has(slug)) return { ok: false, message: `"${slug}" is reserved by the platform.` };
  return { ok: true, message: `${slug} is available. This cannot be changed later, so check the spelling.` };
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
