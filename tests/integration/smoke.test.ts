import { describe, expect, it } from "vitest";
import { signInAs, TEST_ROLES, type TestRole } from "./support/signInAs";

/**
 * One smoke test per kind of user: sign in with the seeded login, then read your own profile row.
 * If this fails for a role, either the local database is not seeded (npm run db:seed, and
 * npm run db:seed-org for the org admin) or sign-in / profile RLS broke for that role.
 */
const roles = Object.keys(TEST_ROLES) as TestRole[];

describe.each(roles)("smoke: %s", (role) => {
  it("signs in and reads its own profile", async () => {
    const { client, userId, login } = await signInAs(role);

    const { data, error } = await client.from("profiles").select("id, role, tenant_id, full_name").eq("id", userId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ id: userId, role: login.profileRole });
    expect(data![0]!.full_name).toBeTruthy();
    expect(data![0]!.tenant_id !== null).toBe(login.hasTenant);
  });
});
