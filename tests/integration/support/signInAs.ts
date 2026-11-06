import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DEMO_LOGINS, DEMO_TENANTS } from "../../../packages/shared/src/demo";
import { loginIdEmail } from "../../../packages/shared/src/auth";
import type { Role } from "../../../packages/shared/src/types";
import { assertLocalSupabaseUrl } from "./localGuard";

/** The seven kinds of user the QA plan signs in as. */
export type TestRole = "platform_staff" | "org_admin" | "school_admin" | "teacher" | "parent" | "student" | "driver";

interface RoleLogin {
  email: string;
  password: string;
  /** What `profiles.role` holds for this user. */
  profileRole: Role;
  /** Platform staff and org admins belong to no single school, so their profile has no tenant. */
  hasTenant: boolean;
}

/** Every login_id in DEMO_LOGINS belongs to the first demo school. */
const DEMO_SCHOOL_SLUG = DEMO_TENANTS[0]!.slug;

/**
 * Same address the sign-in screen and supabase/seed.ts derive: staff with an email use it as is,
 * everyone else gets a synthetic one built from their login_id and school.
 */
function demoLogin(demoRole: (typeof DEMO_LOGINS)[number]["role"], profileRole: Role): RoleLogin {
  const login = DEMO_LOGINS.find((l) => l.role === demoRole);
  if (!login) throw new Error(`DEMO_LOGINS has no "${demoRole}" entry`);
  const email = "email" in login ? login.email : loginIdEmail(login.login_id, DEMO_SCHOOL_SLUG);
  return { email, password: login.password, profileRole, hasTenant: demoRole !== "super_admin" };
}

export const TEST_ROLES: Record<TestRole, RoleLogin> = {
  platform_staff: demoLogin("super_admin", "super_admin"),
  // Not in DEMO_LOGINS: created by `npm run db:seed-org` (supabase/seed-cbe.ts, with --with-org).
  org_admin: { email: "group@kijaniridge.sc.ke", password: "figbloom-dev", profileRole: "org_admin", hasTenant: false },
  school_admin: demoLogin("school_admin", "school_admin"),
  teacher: demoLogin("teacher", "teacher"),
  parent: demoLogin("parent", "parent"),
  student: demoLogin("student", "student"),
  driver: demoLogin("driver", "driver"),
};

export interface SignedIn {
  client: SupabaseClient;
  userId: string;
  email: string;
  role: TestRole;
  login: RoleLogin;
}

/**
 * A client with the public anon key and no session. Refuses to exist unless the URL is local.
 * SUPABASE_URL is read first, then VITE_SUPABASE_URL (both come from .env via vitest.integration.config.ts).
 */
export function anonClient(): SupabaseClient {
  const url = assertLocalSupabaseUrl(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL);
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("VITE_SUPABASE_ANON_KEY is not set. Copy it from `npx supabase status` into .env.");
  return createClient(url.origin, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Signs in as the seeded user for `role` and returns a client that carries that user's session. */
export async function signInAs(role: TestRole): Promise<SignedIn> {
  const login = TEST_ROLES[role];
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email: login.email, password: login.password });
  if (error || !data.user) {
    const hint = role === "org_admin" ? "npm run db:seed, then npm run db:seed-org" : "npm run db:seed";
    throw new Error(`signInAs("${role}") failed for ${login.email}: ${error?.message ?? "no user returned"}. Is the local database seeded (${hint})?`);
  }
  return { client, userId: data.user.id, email: login.email, role, login };
}
