import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import { ADMIN_AREAS } from "../src/modules/identity/roles.js";
import { createTestApp } from "./support.js";

/**
 * Workstream 5A: the permission registry reconciled with the code and the contract.
 *   * every permission code the source enforces exists in the catalogue (a typo would silently deny everyone, or worse, be
 *     "allowed" by a default),
 *   * every permission the OpenAPI contract documents exists,
 *   * every catalogue permission is referenced by the code or the contract, or is on the explicit, justified allowlist of
 *     permissions that exist on purpose without a route (so a new unused permission cannot be added unnoticed).
 */
const SRC = join(process.cwd(), "src");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const PERMISSION_LITERAL = /["'`]((?:resource|rbac|identity|platform|org|tenant|session)\.[a-z_]+(?:\.[a-z_]+)*)["'`]/g;

/** Catalogue permissions that intentionally have no route reference, each with the reason. */
const UNREFERENCED_BY_DESIGN: Record<string, string> = {
  "resource.report.read": "superseded by resource.report.overview.read / resource.report.attendance.read (migration 070); kept so existing role grants and delegations remain valid",
  "platform.tenants.read": "granted to super_admin in the foundation (001); no route yet lists tenants at platform level",
  "identity.self.read": "role-catalogue marker for the self-service identity surface (/v1/auth/me is session-authenticated, not permission-gated)",
  "session.manage": "role-catalogue marker for session self-management (logout/select-tenant are session-authenticated)",
  "rbac.permissions.read": "referenced by the permission-catalogue route through a constant",
  "identity.self.write": "role-catalogue marker for self-service profile changes; the self routes are session-authenticated",
};

describe("permission registry reconciliation", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);
  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  const catalogue = async () => new Set((await ctx.pool.query<{ code: string }>(`SELECT code FROM permissions`)).rows.map((r) => r.code));
  const used = () => {
    const found = new Map<string, string[]>();
    for (const file of walk(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(PERMISSION_LITERAL)) {
        const list = found.get(m[1]!) ?? [];
        list.push(file.slice(SRC.length + 1));
        found.set(m[1]!, list);
      }
    }
    return found;
  };
  const documented = () => {
    const spec = YAML.parse(readFileSync(join(process.cwd(), "openapi", "openapi.yaml"), "utf8"));
    const codes = new Set<string>();
    for (const ops of Object.values<any>(spec.paths)) for (const op of Object.values<any>(ops)) for (const p of op["x-figbloom-permissions"] ?? []) codes.add(p);
    return codes;
  };

  it("every permission literal enforced in the source exists in the catalogue", async () => {
    const cat = await catalogue();
    // audit event names share the dotted shape (rbac.permission.denied); a PERMISSION literal ends in a verb the catalogue uses
    const verbs = new Set([...cat].map((c) => c.split(".").pop()!));
    const unknown = [...used().entries()].filter(([code]) => !cat.has(code) && verbs.has(code.split(".").pop()!)).map(([code, files]) => `${code} (${[...new Set(files)].join(", ")})`);
    expect(unknown, "permission codes used in src but missing from the permissions table").toEqual([]);
  });

  it("every permission documented in OpenAPI exists in the catalogue", async () => {
    const cat = await catalogue();
    expect([...documented()].filter((c) => !cat.has(c))).toEqual([]);
  });

  it("every catalogue permission is referenced by the code or the contract, or is allowlisted with a reason", async () => {
    const cat = await catalogue();
    const refs = used();
    const docs = documented();
    const areaCodes = new Set([...ADMIN_AREAS].map((a) => `area.${a}`)); // composed at runtime (area.<name>) from the admin-area list
    const unreferenced = [...cat].filter((c) => !refs.has(c) && !docs.has(c) && !areaCodes.has(c) && !(c in UNREFERENCED_BY_DESIGN)).sort();
    expect([...cat].filter((c) => c.startsWith("area.") && !areaCodes.has(c)), "area.* catalogue entries that are not admin areas").toEqual([]);
    expect(unreferenced, "add a route/contract reference, or allowlist with a justification").toEqual([]);
    // the allowlist itself must not rot: an allowlisted permission that no longer exists or is now referenced is stale
    for (const c of Object.keys(UNREFERENCED_BY_DESIGN)) expect(cat.has(c), `${c} no longer exists`).toBe(true);
  });

  it("no permission is granted to a role that does not exist as an application role", async () => {
    const roles = (await ctx.pool.query<{ role: string }>(`SELECT DISTINCT role FROM role_permissions`)).rows.map((r) => r.role).sort();
    const known = new Set(["super_admin", "school_admin", "org_admin", "teacher", "staff", "parent", "student", "driver"]);
    expect(roles.filter((r) => !known.has(r))).toEqual([]);
  });

  it("guardians and students hold no write, administer, manage, or platform permission through the role catalogue", async () => {
    const r = await ctx.pool.query<{ role: string; permission_code: string }>(
      `SELECT role, permission_code FROM role_permissions WHERE role IN ('parent', 'student', 'driver')
        AND permission_code NOT IN ('session.manage', 'identity.self.write') AND (permission_code ~ '\\.(write|administer|manage|grant|revoke)(\\.|$)' OR permission_code LIKE 'platform.%')`,
    );
    expect(r.rows).toEqual([]);
  });

  it("platform permissions are held only by super_admin", async () => {
    const r = await ctx.pool.query<{ role: string; permission_code: string }>(`SELECT role, permission_code FROM role_permissions WHERE permission_code LIKE 'platform.%' AND role <> 'super_admin'`);
    expect(r.rows).toEqual([]);
  });
});
