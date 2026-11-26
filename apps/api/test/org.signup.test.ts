/**
 * Organisation self-service sign-up (docs/ORG-SIGNUP.md, owner decisions D2 and D8; migration 124).
 *
 * Refusals first. The public route may only ever store a REQUEST: nothing it does can create an organisation, an account or a
 * school, it answers every address alike (new, waiting, already an account), it is limited per person, per address and per day,
 * it is closed while e-mail is not configured, and it never returns the confirmation token. The platform half refuses everyone
 * but a super administrator (before any input is read), needs a recent sign-in to decide, and the table behind both is
 * owner-only. Then the work: confirm, list, approve (and the account it makes), reject, re-issue the password link.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountEmail } from "../src/modules/account/resendNotifier.js";
import { setAccountNotifier, type AccountMessage, type DeliveryResult } from "../src/modules/account/notifier.js";
import { createTestApp, type FixtureIds } from "./support.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
const PASSWORD = "correct-horse-battery";
const NEW_PASSWORD = "a-brand-new-passphrase-9";
const SIGNUP = "/v1/signup/organizations";
const VERIFY = "/v1/signup/organizations/verify";
const PLATFORM = "/v1/platform/org-signups";
const spec = loadSpec();

describe("organisation sign-up (slice S6a, migration 124)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  const tokens: Record<string, string> = {};
  let sent: AccountMessage[] = [];
  let delivery: DeliveryResult = "sent";
  let seq = 0;

  const login = async (payload: Record<string, unknown>) => {
    const url = "email" in payload ? "/v1/auth/login/email" : "/v1/auth/login/login-id";
    const res = await ctx.app.inject({ method: "POST", url, payload });
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    return res.json().token as string;
  };
  const call = (method: "GET" | "POST", url: string, opts: { token?: string; tenant?: string; body?: unknown; ip?: string } = {}) =>
    ctx.app.inject({
      method,
      url,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.tenant ? { "x-tenant-id": opts.tenant } : {}) },
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
      ...(opts.body === undefined ? {} : { payload: opts.body as Record<string, unknown> }),
    });
  const conforms = (method: string, path: string, status: number, body: unknown) => {
    const schema = responseSchema(spec, method, path, status);
    expect(typeof schema, `${method} ${path} ${status}`).toBe("object");
    expect(validate(spec, schema, body)).toEqual([]);
  };
  /** Every request in this file starts from its own address, so no test depends on another's rows. */
  const fresh = (over: Record<string, unknown> = {}) => {
    seq += 1;
    return {
      name: `Kijani Learning Trust ${seq}`,
      kind: "group_owner",
      admin_full_name: `Wanjiru Kamau ${seq}`,
      admin_email: `founder${seq}-${randomUUID().slice(0, 8)}@example.org`,
      ...over,
    } as Record<string, unknown> & { admin_email: string; name: string };
  };
  const ipOf = () => `10.${Math.floor(seq / 250) % 250}.${seq % 250}.7`;
  const rows = async (email: string) =>
    (await ctx.pool.query(`SELECT * FROM organization_signups WHERE admin_email = $1 ORDER BY created_at`, [email.toLowerCase()])).rows;
  const audits = async (type: string) =>
    (await ctx.pool.query<{ actor_user_id: string | null; tenant_id: string | null; detail: Record<string, unknown> }>(
      `SELECT actor_user_id, tenant_id, detail FROM security_audit_events WHERE event_type = $1 ORDER BY occurred_at, id`,
      [type],
    )).rows;
  const tokenFor = (email: string, kind: AccountMessage["kind"]) => {
    const m = [...sent].reverse().find((x) => x.email === email.toLowerCase() && x.kind === kind);
    expect(m, `no ${kind} message for ${email}`).toBeTruthy();
    return m!.token;
  };
  const submit = async (body: Record<string, unknown> = fresh(), ip: string = ipOf()) => call("POST", SIGNUP, { body, ip });
  /** Submit and confirm: a request waiting for review. */
  const waiting = async (over: Record<string, unknown> = {}) => {
    const body = fresh(over);
    expect((await submit(body)).statusCode).toBe(202);
    const v = await call("POST", VERIFY, { body: { token: tokenFor(body.admin_email, "org_signup_verify") } });
    expect(v.statusCode, v.body).toBe(200);
    const row = (await rows(body.admin_email)).find((r) => r.status === "pending_review")!;
    return { body, id: row.id as string };
  };
  const ageSessions = () =>
    ctx.pool.query(`UPDATE sessions SET created_at = created_at - interval '1 hour', expires_at = expires_at - interval '1 hour', reauthenticated_at = NULL`);
  const signupCount = async () => Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organization_signups`)).rows[0].n);

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    // this file stores far more than a day's default cap of requests; the cap itself is tested below with a low value
    Object.assign(ctx.app.appConfig, { orgSignupDailyCap: 10_000, orgSignupEnabled: true });
    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    tokens.schoolAdmin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
    tokens.parent = await login({ tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD });
  }, 120_000);

  beforeEach(async () => {
    sent = [];
    delivery = "sent";
    setAccountNotifier({ configured: true, send: async (m) => (sent.push(m), delivery) });
    await ctx.pool.query(`DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'org_signup%'`);
  });
  afterEach(() => setAccountNotifier(null));
  afterAll(async () => {
    setAccountNotifier(null);
    await ctx.app.close();
    await ctx.pool.end();
  });

  describe("the public route stores a request and nothing more", () => {
    it("ships closed: off by default, and a 503 for everyone while it is switched off, with nothing stored", async () => {
      const cfg = ctx.app.appConfig as { orgSignupEnabled: boolean };
      cfg.orgSignupEnabled = false;
      try {
        const before = await signupCount();
        for (const body of [fresh(), fresh({ admin_email: "admin-a@example.com" })]) {
          const r = await submit(body);
          expect(r.statusCode).toBe(503);
          expect(r.json().error.code).toBe("service_unavailable");
        }
        expect(await signupCount()).toBe(before);
        expect(sent).toEqual([]);
        // deciding what is already stored is not affected by the switch
        expect((await call("GET", PLATFORM, { token: tokens.super })).statusCode).toBe(200);
      } finally {
        cfg.orgSignupEnabled = true;
      }
    });

    it("is closed (503, for everyone) while e-mail is not configured, and stores nothing", async () => {
      setAccountNotifier(null);
      const before = await signupCount();
      const a = await submit();
      const b = await submit(fresh({ admin_email: "admin-a@example.com" }));
      expect(a.statusCode).toBe(503);
      expect(b.statusCode).toBe(503);
      expect(a.json().error.code).toBe("service_unavailable");
      expect(await signupCount()).toBe(before);
      // a notifier that merely exists is not enough
      setAccountNotifier({ send: async () => "sent" });
      expect((await submit()).statusCode).toBe(503);
      expect(await signupCount()).toBe(before);
    });

    it("refuses bodies that break the rules (400) before any limit or database work", async () => {
      const before = await signupCount();
      const ok = fresh();
      const bad: unknown[] = [
        {},
        { ...ok, name: "x" },
        { ...ok, name: "x".repeat(161) },
        { ...ok, name: "Kijani\u0007Trust" },
        { ...ok, name: "Kijani\nTrust" },
        { ...ok, kind: "school" },
        { ...ok, kind: undefined },
        { ...ok, admin_full_name: "" },
        { ...ok, admin_full_name: "x".repeat(161) },
        { ...ok, admin_email: "no-at-sign" },
        { ...ok, admin_email: "a@b" },
        { ...ok, admin_email: "a b@example.org" },
        { ...ok, admin_email: `${"x".repeat(250)}@example.org` },
        { ...ok, county: "x".repeat(81) },
        { ...ok, contact_phone: "call me maybe" },
        { ...ok, contact_phone: "123" },
        { ...ok, admin_password: "a-password-nobody-asked-for" },
        { ...ok, status: "approved" },
        { ...ok, organization_id: randomUUID() },
        [],
      ];
      for (const body of bad) {
        const res = await call("POST", SIGNUP, { body: body as Record<string, unknown>, ip: ipOf() });
        expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
      // a body that is not JSON at all is refused too, also before any work
      const notJson = await ctx.app.inject({ method: "POST", url: SIGNUP, headers: { "content-type": "text/plain" }, payload: "hello", remoteAddress: ipOf() });
      expect([400, 415]).toContain(notJson.statusCode);
      expect(await signupCount()).toBe(before);
      expect(sent).toEqual([]);
      const buckets = await ctx.pool.query(`SELECT count(*)::int AS n FROM auth_rate_buckets WHERE bucket_key LIKE 'org_signup%'`);
      expect(buckets.rows[0].n).toBe(0);
    });

    it("refuses a body over 4 KiB (413)", async () => {
      const res = await call("POST", SIGNUP, { body: { ...fresh(), county: "x".repeat(6000) }, ip: ipOf() });
      expect(res.statusCode).toBe(413);
      expect(await rows("nobody@example.org")).toEqual([]);
    });

    it("stores a pending request, e-mails a link to the lower-cased address, and never returns the token", async () => {
      const body = fresh({ admin_email: `  Mixed.Case${seq}@Example.ORG  `, county: " Kiambu ", contact_phone: "0712 345 678" });
      const res = await submit(body);
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({ status: "received" });
      conforms("POST", SIGNUP, 202, res.json());
      expect(res.body).not.toMatch(/token/i);
      expect(res.headers["cache-control"]).toBe("no-store");

      const email = body.admin_email.trim().toLowerCase();
      const stored = await rows(email);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ status: "pending_email", kind: "group_owner", county: "Kiambu", contact_phone: "0712 345 678", verified_at: null });
      expect(stored[0].name).toBe(body.name);
      expect(stored[0].verify_token_hash).toMatch(/^[0-9a-f]{64}$/);
      const ttlHours = (new Date(stored[0].verify_expires_at).getTime() - Date.now()) / 3_600_000;
      expect(ttlHours).toBeGreaterThan(23);
      expect(ttlHours).toBeLessThanOrEqual(24.01);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ kind: "org_signup_verify", email });
      expect(sent[0]!.token).not.toBe(stored[0].verify_token_hash);
      expect(sent[0]!.token.length).toBeGreaterThanOrEqual(40);
      // only the hash is kept: the link's token is nowhere in the table
      expect(JSON.stringify(stored[0])).not.toContain(sent[0]!.token);
    });

    it("creates no organisation, user, membership, school or password link", async () => {
      const count = async () =>
        (await ctx.pool.query(
          `SELECT (SELECT count(*) FROM organizations)::int AS o, (SELECT count(*) FROM users)::int AS u, (SELECT count(*) FROM organization_memberships)::int AS m,
                  (SELECT count(*) FROM tenants)::int AS t, (SELECT count(*) FROM account_tokens)::int AS a`,
        )).rows[0];
      const before = await count();
      const w = await waiting(); // submitted AND confirmed: still only a request
      expect(await count()).toEqual(before);
      expect((await rows(w.body.admin_email))[0].status).toBe("pending_review");
    });

    it("gives the same answer for a new address, a waiting request and an address that already has an account", async () => {
      const fresh1 = await submit(fresh());
      const dupBody = fresh();
      await submit(dupBody);
      const dup = await submit(dupBody); // unconfirmed request exists: resent
      const confirmedBody = (await waiting()).body;
      const confirmed = await submit(confirmedBody); // confirmed request exists: nothing happens
      const taken = await submit(fresh({ admin_email: "admin-a@example.com" })); // an account
      const takenSuper = await submit(fresh({ admin_email: "SUPER@example.com" }));
      const shape = (r: { statusCode: number; body: string; headers: Record<string, unknown> }) => ({
        status: r.statusCode,
        body: r.body,
        type: r.headers["content-type"],
        cache: r.headers["cache-control"],
      });
      for (const other of [dup, confirmed, taken, takenSuper]) expect(shape(other)).toEqual(shape(fresh1));
      // and the address that has an account is stored like any other: the route never looked at accounts
      expect(await rows("admin-a@example.com")).toHaveLength(1);
    });

    it("a second submit while the first is unconfirmed replaces the link (the old one stops working) and e-mails again; a confirmed one sends nothing", async () => {
      const body = fresh();
      await submit(body);
      const first = tokenFor(body.admin_email, "org_signup_verify");
      await submit(body);
      expect(sent).toHaveLength(2);
      const second = tokenFor(body.admin_email, "org_signup_verify");
      expect(second).not.toBe(first);
      expect(await rows(body.admin_email)).toHaveLength(1);
      expect((await call("POST", VERIFY, { body: { token: first } })).statusCode).toBe(400);
      expect((await call("POST", VERIFY, { body: { token: second } })).statusCode).toBe(200);
      const countAfterVerify = sent.length;
      expect((await submit(body)).statusCode).toBe(202);
      expect(sent).toHaveLength(countAfterVerify);
      expect(await rows(body.admin_email)).toHaveLength(1);
    });

    it("a lapsed unconfirmed request no longer holds the address", async () => {
      const body = fresh();
      await submit(body);
      await ctx.pool.query(`UPDATE organization_signups SET verify_expires_at = now() - interval '1 minute' WHERE admin_email = $1`, [body.admin_email]);
      expect((await submit(body)).statusCode).toBe(202);
      const all = await rows(body.admin_email);
      expect(all.map((r) => r.status).sort()).toEqual(["expired", "pending_email"]);
      expect(sent).toHaveLength(2);
    });

    it("limits one address to 3 at once then 1 an hour (429 with Retry-After), without saying anything about the address", async () => {
      const body = fresh();
      const answers: number[] = [];
      for (let i = 0; i < 4; i += 1) answers.push((await submit(body, `172.16.${i}.9`)).statusCode);
      expect(answers).toEqual([202, 202, 202, 429]);
      const limited = await submit(body, "172.16.9.9");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeTruthy();
      expect(limited.json().error.code).toBe("rate_limited");
      // the bucket key holds a hash, never the address
      const keys = (await ctx.pool.query(`SELECT bucket_key FROM auth_rate_buckets WHERE bucket_key LIKE 'org_signup:email:%'`)).rows.map((r) => r.bucket_key as string);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(k).not.toContain("@");
      // an address that has an account is limited the same way
      const t = fresh({ admin_email: "admin-a@example.com" });
      const t2: number[] = [];
      for (let i = 0; i < 4; i += 1) t2.push((await submit(t, `172.17.${i}.9`)).statusCode);
      expect(t2).toEqual([202, 202, 202, 429]);
    });

    it("limits one caller to 5 at once then 5 an hour, and another caller is untouched; an IPv6 network counts as one caller", async () => {
      const ip = "192.0.2.77";
      const answers: number[] = [];
      for (let i = 0; i < 6; i += 1) answers.push((await submit(fresh(), ip)).statusCode);
      expect(answers).toEqual([202, 202, 202, 202, 202, 429]);
      expect((await submit(fresh(), "192.0.2.78")).statusCode).toBe(202);
      const v6: number[] = [];
      for (let i = 0; i < 6; i += 1) v6.push((await submit(fresh(), `2001:db8:1:2:${i}::1`)).statusCode);
      expect(v6).toEqual([202, 202, 202, 202, 202, 429]);
      expect((await submit(fresh(), "2001:db8:1:3::1")).statusCode).toBe(202);
    });

    it("stops storing new requests once the day's cap is reached, for every caller alike, and says nothing about which addresses are waiting", async () => {
      const cfg = ctx.app.appConfig as { orgSignupDailyCap: number };
      const original = cfg.orgSignupDailyCap;
      const waitingBody = fresh();
      await submit(waitingBody);
      const used = Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organization_signups WHERE created_at > now() - interval '1 day'`)).rows[0].n);
      cfg.orgSignupDailyCap = used;
      try {
        const before = await signupCount();
        const sentBefore = sent.length;
        const newAddress = await submit(fresh());
        const waitingAddress = await submit(waitingBody);
        const accountAddress = await submit(fresh({ admin_email: "admin-a@example.com" }));
        for (const r of [newAddress, waitingAddress, accountAddress]) {
          expect(r.statusCode).toBe(503);
          expect(r.json().error.code).toBe("service_unavailable");
          expect(r.headers["retry-after"]).toBeTruthy();
        }
        expect(newAddress.body.replace(/"request_id":"[^"]*"/, "")).toBe(waitingAddress.body.replace(/"request_id":"[^"]*"/, ""));
        expect(await signupCount()).toBe(before);
        expect(sent).toHaveLength(sentBefore);
      } finally {
        cfg.orgSignupDailyCap = original;
      }
    });

    it("writes audit rows that name the request's id and kind only, never a name, an address or a phone", async () => {
      const body = fresh({ contact_phone: "+254 700 111 222", county: "Nyeri" });
      await submit(body);
      await submit(body);
      const row = (await rows(body.admin_email))[0];
      await call("POST", VERIFY, { body: { token: tokenFor(body.admin_email, "org_signup_verify") } });
      const mine = [
        ...(await audits("org_signup.submitted")),
        ...(await audits("org_signup.verification_resent")),
        ...(await audits("org_signup.verified")),
      ].filter((a) => a.detail.signupId === row.id);
      expect(mine.map((a) => Object.keys(a.detail).sort())).toEqual([["kind", "signupId"], ["signupId"], ["signupId"]]);
      for (const a of mine) {
        expect(a.actor_user_id).toBeNull();
        expect(a.tenant_id).toBeNull();
        const text = JSON.stringify(a.detail);
        for (const secret of [body.admin_email, body.name, String(body.admin_full_name), "+254 700 111 222", "Nyeri"]) expect(text).not.toContain(secret);
      }
    });
  });

  describe("confirming the address", () => {
    it("answers every failure the same (400): short, unknown, replaced, used, expired and rejected links", async () => {
      const unknownLink = "A".repeat(43);
      const replaced = fresh();
      await submit(replaced);
      const oldLink = tokenFor(replaced.admin_email, "org_signup_verify");
      await submit(replaced);
      const used = await waiting();
      const usedLink = tokenFor(used.body.admin_email, "org_signup_verify");
      const lapsed = fresh();
      await submit(lapsed);
      const lapsedLink = tokenFor(lapsed.admin_email, "org_signup_verify");
      await ctx.pool.query(`UPDATE organization_signups SET verify_expires_at = now() - interval '1 second' WHERE admin_email = $1`, [lapsed.admin_email]);
      const rejected = fresh();
      await submit(rejected);
      const rejectedLink = tokenFor(rejected.admin_email, "org_signup_verify");
      await ctx.pool.query(`UPDATE organization_signups SET status = 'rejected', decided_at = now(), verify_token_hash = verify_token_hash WHERE admin_email = $1`, [rejected.admin_email]);

      const answers = [];
      for (const token of ["short", unknownLink, oldLink, usedLink, lapsedLink, rejectedLink]) {
        const r = await call("POST", VERIFY, { body: { token } });
        answers.push({ status: r.statusCode, code: r.json().error.code, message: r.json().error.message });
      }
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(answers[0]).toMatchObject({ status: 400, code: "validation_error" });
      // an expired link marks the request expired, and nothing was confirmed
      expect((await rows(lapsed.admin_email))[0].status).toBe("expired");
      expect((await rows(rejected.admin_email))[0].verified_at).toBeNull();
      for (const bad of [{}, { token: 5 }, { token: "x".repeat(300) }, { token: unknownLink, extra: 1 }]) {
        expect((await call("POST", VERIFY, { body: bad })).statusCode).toBe(400);
      }
    });

    it("confirms once: the request waits for review, the link is cleared, the answer conforms to the contract", async () => {
      const body = fresh();
      await submit(body);
      const link = tokenFor(body.admin_email, "org_signup_verify");
      const res = await call("POST", VERIFY, { body: { token: link } });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ status: "confirmed" });
      conforms("POST", VERIFY, 200, res.json());
      const row = (await rows(body.admin_email))[0];
      expect(row).toMatchObject({ status: "pending_review", verify_token_hash: null });
      expect(row.verified_at).toBeTruthy();
      expect((await call("POST", VERIFY, { body: { token: link } })).statusCode).toBe(400);
      expect((await audits("org_signup.verified")).some((a) => a.detail.signupId === row.id)).toBe(true);
    });
  });

  describe("the platform half refuses everyone but a super administrator", () => {
    it("401 without a session, on every route, and nothing is written", async () => {
      const id = randomUUID();
      const before = await signupCount();
      expect((await call("GET", PLATFORM)).statusCode).toBe(401);
      for (const action of ["approve", "reject", "reissue-setup"]) {
        expect((await call("POST", `${PLATFORM}/${id}/${action}`, { body: {} })).statusCode, action).toBe(401);
      }
      expect(await signupCount()).toBe(before);
    });

    it("school admin, org admin, teacher and parent get 403 on every route, with or without X-Tenant-Id, before any input is read", async () => {
      const w = await waiting();
      const id = randomUUID();
      const snapshot = JSON.stringify(await rows(w.body.admin_email));
      const orgs = Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n);
      for (const who of ["schoolAdmin", "orgAdmin", "teacher", "parent"]) {
        for (const tenant of [undefined, ids.tenantA, ids.tenantB]) {
          const tag = `${who}${tenant ? "+tenant" : ""}`;
          const opts = { token: tokens[who], tenant };
          expect((await call("GET", PLATFORM, opts)).statusCode, `GET ${tag}`).toBe(403);
          expect((await call("GET", `${PLATFORM}?status=nonsense&limit=zzz`, opts)).statusCode, `GET bad query ${tag}`).toBe(403);
          for (const action of ["approve", "reject", "reissue-setup"]) {
            expect((await call("POST", `${PLATFORM}/${w.id}/${action}`, { ...opts, body: {} })).statusCode, `${action} ${tag}`).toBe(403);
            expect((await call("POST", `${PLATFORM}/${id}/${action}`, { ...opts, body: { slug: "x", nonsense: true } })).statusCode, `${action} bad body ${tag}`).toBe(403);
            expect((await call("POST", `${PLATFORM}/not-a-uuid/${action}`, { ...opts, body: {} })).statusCode, `${action} bad id ${tag}`).toBe(403);
          }
        }
      }
      expect(JSON.stringify(await rows(w.body.admin_email))).toBe(snapshot);
      expect(Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n)).toBe(orgs);
      const denied = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND detail->>'permission' = 'platform.org_signups.manage'`,
      );
      expect(denied.rows[0].n).toBeGreaterThan(0);
    });

    it("a super administrator whose sign-in is older than the window cannot approve, reject or re-issue (reauth_required, nothing changed), but may still read", async () => {
      const w = await waiting();
      const stale = await login({ email: "super@example.com", password: PASSWORD });
      await ageSessions();
      try {
        const snapshot = JSON.stringify(await rows(w.body.admin_email));
        for (const action of ["approve", "reject", "reissue-setup"]) {
          const r = await call("POST", `${PLATFORM}/${w.id}/${action}`, { token: stale, body: {} });
          expect(r.statusCode, action).toBe(403);
          expect(r.json().error.code, action).toBe("reauth_required");
        }
        expect(JSON.stringify(await rows(w.body.admin_email))).toBe(snapshot);
        expect((await call("GET", PLATFORM, { token: stale })).statusCode).toBe(200);
        expect(sent.filter((m) => m.kind !== "org_signup_verify")).toEqual([]);
      } finally {
        await ctx.pool.query(`UPDATE sessions SET reauthenticated_at = now()`);
      }
    });

    it("the runtime role holds no privilege on organization_signups; every platform function refuses anyone but a super administrator", async () => {
      const grants = await ctx.pool.query(
        `SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'organization_signups' AND grantee IN ('figbloom_app', 'figbloom_worker', 'PUBLIC')`,
      );
      expect(grants.rows).toEqual([]);
      const flags = (await ctx.pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.organization_signups'::regclass`)).rows[0];
      expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const w = await waiting();
      const hash = "a".repeat(64);
      const later = new Date(Date.now() + 86_400_000).toISOString();
      const c = await ctx.runtimePool.connect();
      const attempt = async (userId: string | null, sql: string, params: unknown[] = []) => {
        await c.query("BEGIN");
        try {
          if (userId) await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
          await c.query(sql, params);
          return "ok";
        } catch (e) {
          return (e as { code?: string }).code ?? "error";
        } finally {
          await c.query("ROLLBACK");
        }
      };
      try {
        expect(await attempt(ids.superAdmin, `SELECT * FROM organization_signups`)).toBe("42501");
        expect(await attempt(ids.superAdmin, `UPDATE organization_signups SET status = 'approved'`)).toBe("42501");
        for (const who of [null, ids.adminA, ids.teacherA, ids.parentA, ids.orgAdmin]) {
          expect(await attempt(who, `SELECT * FROM public.platform_org_signups_list(NULL, NULL, NULL, NULL, 10)`), `list ${who}`).toBe("42501");
          expect(await attempt(who, `SELECT * FROM public.platform_org_signup_approve($1, NULL, $2, $3)`, [w.id, hash, later]), `approve ${who}`).toBe("42501");
          expect(await attempt(who, `SELECT * FROM public.platform_org_signup_reject($1, NULL)`, [w.id]), `reject ${who}`).toBe("42501");
          expect(await attempt(who, `SELECT * FROM public.platform_org_signup_reissue($1, $2, $3)`, [w.id, hash, later]), `reissue ${who}`).toBe("42501");
        }
        // the two public functions need no actor, and the table is still not readable through them
        expect(await attempt(null, `SELECT public.org_signup_verify($1)`, ["b".repeat(64)])).toBe("ok");
      } finally {
        c.release();
      }
      expect((await rows(w.body.admin_email))[0].status).toBe("pending_review");
    });
  });

  describe("the list", () => {
    it("shows the requests newest first with the effective status, filters, pages, conforms to the contract, and audits the read without personal data", async () => {
      const a = await waiting({ county: "Machakos", contact_phone: "0722 000 111" });
      const b = fresh();
      await submit(b);
      const lapsed = fresh();
      await submit(lapsed);
      await ctx.pool.query(`UPDATE organization_signups SET verify_expires_at = now() - interval '1 second' WHERE admin_email = $1`, [lapsed.admin_email]);

      const res = await call("GET", `${PLATFORM}?limit=200`, { token: tokens.super });
      expect(res.statusCode, res.body).toBe(200);
      conforms("GET", PLATFORM, 200, res.json());
      const items = res.json().items as Array<Record<string, unknown>>;
      const byEmail = Object.fromEntries(items.map((i) => [i.adminEmail as string, i]));
      expect(byEmail[a.body.admin_email]).toMatchObject({
        id: a.id,
        name: a.body.name,
        kind: "group_owner",
        county: "Machakos",
        contactPhone: "0722 000 111",
        adminFullName: a.body.admin_full_name,
        status: "pending_review",
        decidedAt: null,
        organizationId: null,
        organizationSlug: null,
      });
      expect(byEmail[a.body.admin_email]!.verifiedAt).toBeTruthy();
      expect(byEmail[b.admin_email]).toMatchObject({ status: "pending_email", verifiedAt: null });
      expect(byEmail[lapsed.admin_email]).toMatchObject({ status: "expired" });
      const times = items.map((i) => Date.parse(i.createdAt as string));
      expect([...times].sort((x, y) => y - x)).toEqual(times);

      const onlyReview = (await call("GET", `${PLATFORM}?status=pending_review&limit=200`, { token: tokens.super })).json().items as Array<{ status: string }>;
      expect(onlyReview.length).toBeGreaterThan(0);
      expect(onlyReview.every((i) => i.status === "pending_review")).toBe(true);
      const onlyExpired = (await call("GET", `${PLATFORM}?status=expired&limit=200`, { token: tokens.super })).json().items as Array<{ adminEmail: string }>;
      expect(onlyExpired.some((i) => i.adminEmail === lapsed.admin_email)).toBe(true);

      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = (await call("GET", `${PLATFORM}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: tokens.super })).json();
        expect(page.items.length).toBeLessThanOrEqual(2);
        for (const i of page.items) {
          expect(seen.has(i.id), "an item came twice").toBe(false);
          seen.add(i.id);
        }
        if (!page.page.next_cursor) break;
        cursor = page.page.next_cursor;
      }
      expect(seen.size).toBe(items.length);

      for (const q of ["status=nonsense", "limit=0", "limit=abc", "cursor=garbage", "sort=name"]) {
        expect((await call("GET", `${PLATFORM}?${q}`, { token: tokens.super })).statusCode, q).toBe(400);
      }
      const listed = await audits("platform.org_signup.listed");
      expect(listed.length).toBeGreaterThan(0);
      for (const l of listed) {
        expect(Object.keys(l.detail)).toEqual(["count"]);
        expect(l.actor_user_id).toBe(ids.superAdmin);
        expect(l.tenant_id).toBeNull();
      }
    });
  });

  describe("approving", () => {
    it("creates the organisation, an invited administrator and a password link in one go; the link is e-mailed, not returned; the audit row has ids only", async () => {
      const w = await waiting({ name: "  Hekima Education Group  " });
      const res = await call("POST", `${PLATFORM}/${w.id}/approve`, { token: tokens.super, body: {} });
      expect(res.statusCode, res.body).toBe(200);
      conforms("POST", `${PLATFORM}/{signupId}/approve`, 200, res.json());
      const out = res.json();
      expect(out.organization.slug).toBe("hekima-education-group");
      expect(out.signup).toMatchObject({ id: w.id, status: "approved", organizationId: out.organization.id, organizationSlug: "hekima-education-group", decidedByName: "Super Admin" });
      expect(out.setup.delivery).toBe("sent");
      expect(out.setup.token).toBeUndefined();
      expect(res.body).not.toContain(tokenFor(w.body.admin_email, "org_signup_approved"));

      const org = (await ctx.pool.query(`SELECT * FROM organizations WHERE id = $1`, [out.organization.id])).rows[0];
      expect(org).toMatchObject({ name: "Hekima Education Group", slug: "hekima-education-group", kind: "group_owner", status: "active" });
      const user = (await ctx.pool.query(`SELECT * FROM users WHERE email = $1`, [w.body.admin_email])).rows[0];
      expect(user).toMatchObject({ status: "invited", password_hash: "!", full_name: w.body.admin_full_name, must_change_password: false });
      const member = (await ctx.pool.query(`SELECT role FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`, [user.id, org.id])).rows;
      expect(member).toEqual([{ role: "org_admin" }]);
      expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM tenants WHERE organization_id = $1`, [org.id])).rows[0].n).toBe(0);
      expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM school_memberships WHERE user_id = $1`, [user.id])).rows[0].n).toBe(0);

      const mail = sent.filter((m) => m.kind === "org_signup_approved");
      expect(mail).toHaveLength(1);
      expect(mail[0]!.email).toBe(w.body.admin_email);
      const tok = (await ctx.pool.query(`SELECT * FROM account_tokens WHERE user_id = $1`, [user.id])).rows;
      expect(tok).toHaveLength(1);
      expect(tok[0]).toMatchObject({ kind: "password_reset", email: w.body.admin_email, created_by: ids.superAdmin, used_at: null, revoked_at: null });
      const days = (new Date(tok[0].expires_at).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThanOrEqual(7.01);
      expect(JSON.stringify(tok[0])).not.toContain(mail[0]!.token);

      const a = (await audits("platform.org_signup.approved")).find((r) => r.detail.signupId === w.id);
      expect(a).toBeTruthy();
      expect(a!.actor_user_id).toBe(ids.superAdmin);
      expect(a!.tenant_id).toBeNull();
      expect(a!.detail).toEqual({ signupId: w.id, organizationId: org.id, adminUserId: user.id });
      const row = (await rows(w.body.admin_email))[0];
      expect(row).toMatchObject({ status: "approved", decided_by: ids.superAdmin, organization_id: org.id, verify_token_hash: null });
    });

    it("the administrator cannot sign in until they choose a password with the link; then they run their own organisation", async () => {
      const w = await waiting();
      const approved = await call("POST", `${PLATFORM}/${w.id}/approve`, { token: tokens.super, body: {} });
      expect(approved.statusCode, approved.body).toBe(200);
      const link = tokenFor(w.body.admin_email, "org_signup_approved");

      // nothing a person could type signs in to the invited account
      for (const password of ["!", "", PASSWORD, NEW_PASSWORD]) {
        const r = await call("POST", "/v1/auth/login/email", { body: { email: w.body.admin_email, password: password || "x" } });
        expect(r.statusCode, `password ${JSON.stringify(password)}`).toBe(401);
      }
      // the setup link is the existing password-reset completion
      const done = await call("POST", "/v1/auth/password-reset/complete", { body: { token: link, password: NEW_PASSWORD } });
      expect(done.statusCode, done.body).toBe(200);
      expect((await call("POST", "/v1/auth/password-reset/complete", { body: { token: link, password: NEW_PASSWORD } })).statusCode).toBe(400);

      const signedIn = await call("POST", "/v1/auth/login/email", { body: { email: w.body.admin_email, password: NEW_PASSWORD } });
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      const mine = await call("GET", "/v1/org/organizations", { token: signedIn.json().token });
      expect(mine.statusCode, mine.body).toBe(200);
      const orgs = mine.json().items ?? mine.json().organizations ?? mine.json();
      expect(JSON.stringify(orgs)).toContain(approved.json().organization.slug);
      expect((await call("GET", PLATFORM, { token: signedIn.json().token })).statusCode).toBe(403);
    });

    it("takes a given address (taken is 409, reserved or malformed is refused) and numbers a derived address that is taken", async () => {
      const w1 = await waiting({ name: "Zuri Schools" });
      const w2 = await waiting({ name: "Zuri Schools" });
      const w3 = await waiting({ name: "Zuri Schools" });
      const first = await call("POST", `${PLATFORM}/${w1.id}/approve`, { token: tokens.super, body: {} });
      expect(first.json().organization.slug).toBe("zuri-schools");
      const second = await call("POST", `${PLATFORM}/${w2.id}/approve`, { token: tokens.super, body: {} });
      expect(second.json().organization.slug).toBe("zuri-schools-2");
      const taken = await call("POST", `${PLATFORM}/${w3.id}/approve`, { token: tokens.super, body: { slug: "zuri-schools" } });
      expect(taken.statusCode).toBe(409);
      expect(taken.json().error.message).toMatch(/taken/);
      for (const slug of ["platform", "admin", "-leading", "trailing-", "UPPER", "has space", "ab", "x".repeat(41), "under_score", "dot.dot"]) {
        const r = await call("POST", `${PLATFORM}/${w3.id}/approve`, { token: tokens.super, body: { slug } });
        expect([400, 409], `${slug} -> ${r.statusCode}`).toContain(r.statusCode);
        expect(r.statusCode, slug).not.toBe(200);
      }
      // none of the refusals changed the request
      expect((await rows(w3.body.admin_email))[0].status).toBe("pending_review");
      const chosen = await call("POST", `${PLATFORM}/${w3.id}/approve`, { token: tokens.super, body: { slug: `chosen-${randomUUID().slice(0, 8)}` } });
      expect(chosen.statusCode, chosen.body).toBe(200);
    });

    it("makes an address from a name with nothing usable in it, and keeps the platform's own words out", async () => {
      const w1 = await waiting({ name: "Platform" });
      const w2 = await waiting({ name: "Écoles ★★" });
      const a = await call("POST", `${PLATFORM}/${w1.id}/approve`, { token: tokens.super, body: {} });
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json().organization.slug).toBe("platform-org");
      const b = await call("POST", `${PLATFORM}/${w2.id}/approve`, { token: tokens.super, body: {} });
      expect(b.statusCode, b.body).toBe(200);
      expect(b.json().organization.slug).toMatch(/^coles(-\d+)?$/);
    });

    it("refuses a request whose address is not confirmed, one already decided, one whose address already has an account, and an unknown one", async () => {
      const unconfirmed = fresh();
      await submit(unconfirmed);
      const u = (await rows(unconfirmed.admin_email))[0];
      const r1 = await call("POST", `${PLATFORM}/${u.id}/approve`, { token: tokens.super, body: {} });
      expect(r1.statusCode).toBe(409);

      const done = await waiting();
      expect((await call("POST", `${PLATFORM}/${done.id}/approve`, { token: tokens.super, body: {} })).statusCode).toBe(200);
      const again = await call("POST", `${PLATFORM}/${done.id}/approve`, { token: tokens.super, body: {} });
      expect(again.statusCode).toBe(409);
      expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM organizations WHERE name = $1`, [done.body.name])).rows[0].n).toBe(1);

      const orgsBefore = Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n);
      const taken = await waiting({ admin_email: "admin-a@example.com" });
      const usersBefore = Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n);
      const r3 = await call("POST", `${PLATFORM}/${taken.id}/approve`, { token: tokens.super, body: {} });
      expect(r3.statusCode, r3.body).toBe(409);
      expect(Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n)).toBe(orgsBefore);
      expect(Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM users`)).rows[0].n)).toBe(usersBefore);
      expect((await rows("admin-a@example.com")).find((r) => r.id === taken.id)!.status).toBe("pending_review");
      // leave the address free for the next test
      expect((await call("POST", `${PLATFORM}/${taken.id}/reject`, { token: tokens.super, body: {} })).statusCode).toBe(200);

      expect((await call("POST", `${PLATFORM}/${randomUUID()}/approve`, { token: tokens.super, body: {} })).statusCode).toBe(404);
      for (const bad of [{ slug: 5 }, { slug: "ab" }, { extra: true }]) {
        expect((await call("POST", `${PLATFORM}/${done.id}/approve`, { token: tokens.super, body: bad })).statusCode).toBe(400);
      }
      expect((await call("POST", `${PLATFORM}/not-a-uuid/approve`, { token: tokens.super, body: {} })).statusCode).toBe(400);
    });

    it("an address that has an account is refused even when its case differs, and a super administrator's address is refused too", async () => {
      const orgsBefore = Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n);
      for (const email of ["Admin-A@Example.com", "SUPER@example.com", "orgadmin@example.com"]) {
        const w = await waiting({ admin_email: email });
        const r = await call("POST", `${PLATFORM}/${w.id}/approve`, { token: tokens.super, body: {} });
        expect(r.statusCode, email).toBe(409);
        expect(r.json().error.message).toMatch(/already has an account/);
        // reject it so the next loop (and test) can use the address again
        await call("POST", `${PLATFORM}/${w.id}/reject`, { token: tokens.super, body: {} });
      }
      expect(Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM organizations`)).rows[0].n)).toBe(orgsBefore);
    });

    it("without an e-mail provider the link comes back once, to the reviewer, and works", async () => {
      const w = await waiting();
      delivery = "not_configured";
      const res = await call("POST", `${PLATFORM}/${w.id}/approve`, { token: tokens.super, body: {} });
      expect(res.statusCode, res.body).toBe(200);
      conforms("POST", `${PLATFORM}/{signupId}/approve`, 200, res.json());
      expect(res.json().setup.delivery).toBe("not_configured");
      const link = res.json().setup.token as string;
      expect(link).toBe(tokenFor(w.body.admin_email, "org_signup_approved"));
      const done = await call("POST", "/v1/auth/password-reset/complete", { body: { token: link, password: NEW_PASSWORD } });
      expect(done.statusCode, done.body).toBe(200);
    });
  });

  describe("rejecting", () => {
    it("a confirmed request is rejected, the reason is kept for the platform only, and a plain notice is e-mailed", async () => {
      const w = await waiting();
      const res = await call("POST", `${PLATFORM}/${w.id}/reject`, { token: tokens.super, body: { reason: "  Not a school body we can verify  " } });
      expect(res.statusCode, res.body).toBe(200);
      conforms("POST", `${PLATFORM}/{signupId}/reject`, 200, res.json());
      expect(res.json()).toMatchObject({ notified: true, signup: { id: w.id, status: "rejected", decisionReason: "Not a school body we can verify", decidedByName: "Super Admin" } });
      const notice = sent.filter((m) => m.kind === "org_signup_rejected");
      expect(notice).toHaveLength(1);
      expect(notice[0]).toMatchObject({ email: w.body.admin_email, token: "" });
      const a = (await audits("platform.org_signup.rejected")).find((r) => r.detail.signupId === w.id);
      expect(a!.detail).toEqual({ signupId: w.id, verified: true, hasReason: true });
      expect(JSON.stringify(a!.detail)).not.toContain("verify");
      // no organisation, no account
      expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = $1`, [w.body.admin_email])).rows[0].n).toBe(0);
      expect((await call("POST", `${PLATFORM}/${w.id}/approve`, { token: tokens.super, body: {} })).statusCode).toBe(409);
      expect((await call("POST", `${PLATFORM}/${w.id}/reject`, { token: tokens.super, body: {} })).statusCode).toBe(409);
      // the person may ask again afterwards
      expect((await submit(w.body)).statusCode).toBe(202);
      expect((await rows(w.body.admin_email)).map((r) => r.status).sort()).toEqual(["pending_email", "rejected"]);
    });

    it("an unconfirmed request is rejected without writing to the address, which may be somebody else's, and its link stops working", async () => {
      const body = fresh();
      await submit(body);
      const link = tokenFor(body.admin_email, "org_signup_verify");
      const row = (await rows(body.admin_email))[0];
      sent = [];
      const res = await call("POST", `${PLATFORM}/${row.id}/reject`, { token: tokens.super, body: {} });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ notified: false, signup: { status: "rejected", decisionReason: null } });
      expect(sent).toEqual([]);
      expect((await call("POST", VERIFY, { body: { token: link } })).statusCode).toBe(400);
      expect((await rows(body.admin_email))[0]).toMatchObject({ status: "rejected", verify_token_hash: null, verified_at: null });
    });

    it("refuses a reason over 500 characters, a lapsed unconfirmed request, an approved one and an unknown id", async () => {
      const w = await waiting();
      expect((await call("POST", `${PLATFORM}/${w.id}/reject`, { token: tokens.super, body: { reason: "x".repeat(501) } })).statusCode).toBe(400);
      expect((await call("POST", `${PLATFORM}/${w.id}/reject`, { token: tokens.super, body: { extra: 1 } })).statusCode).toBe(400);
      expect((await rows(w.body.admin_email))[0].status).toBe("pending_review");

      const lapsed = fresh();
      await submit(lapsed);
      await ctx.pool.query(`UPDATE organization_signups SET verify_expires_at = now() - interval '1 second' WHERE admin_email = $1`, [lapsed.admin_email]);
      const lapsedRow = (await rows(lapsed.admin_email))[0];
      expect((await call("POST", `${PLATFORM}/${lapsedRow.id}/reject`, { token: tokens.super, body: {} })).statusCode).toBe(409);

      const approved = await waiting();
      expect((await call("POST", `${PLATFORM}/${approved.id}/approve`, { token: tokens.super, body: {} })).statusCode).toBe(200);
      expect((await call("POST", `${PLATFORM}/${approved.id}/reject`, { token: tokens.super, body: {} })).statusCode).toBe(409);
      expect((await call("POST", `${PLATFORM}/${randomUUID()}/reject`, { token: tokens.super, body: {} })).statusCode).toBe(404);
    });
  });

  describe("re-issuing the first administrator's password link", () => {
    it("sends a new link to an administrator who has not chosen a password, and the old links stop working", async () => {
      const w = await waiting();
      expect((await call("POST", `${PLATFORM}/${w.id}/approve`, { token: tokens.super, body: {} })).statusCode).toBe(200);
      const oldLink = tokenFor(w.body.admin_email, "org_signup_approved");
      sent = [];
      const res = await call("POST", `${PLATFORM}/${w.id}/reissue-setup`, { token: tokens.super });
      expect(res.statusCode, res.body).toBe(200);
      conforms("POST", `${PLATFORM}/{signupId}/reissue-setup`, 200, res.json());
      expect(res.json().setup.delivery).toBe("sent");
      expect(res.json().setup.token).toBeUndefined();
      const newLink = tokenFor(w.body.admin_email, "org_signup_approved");
      expect(newLink).not.toBe(oldLink);
      expect((await call("POST", "/v1/auth/password-reset/complete", { body: { token: oldLink, password: NEW_PASSWORD } })).statusCode).toBe(400);
      const a = (await audits("platform.org_signup.setup_reissued")).find((r) => r.detail.signupId === w.id);
      expect(Object.keys(a!.detail).sort()).toEqual(["adminUserId", "organizationId", "signupId"]);
      expect((await call("POST", "/v1/auth/password-reset/complete", { body: { token: newLink, password: NEW_PASSWORD } })).statusCode).toBe(200);
      // the person has now chosen a password: nothing more to send
      sent = [];
      const after = await call("POST", `${PLATFORM}/${w.id}/reissue-setup`, { token: tokens.super });
      expect(after.statusCode).toBe(409);
      expect(sent).toEqual([]);
    });

    it("refuses a request that was not approved, and an unknown id", async () => {
      const w = await waiting();
      expect((await call("POST", `${PLATFORM}/${w.id}/reissue-setup`, { token: tokens.super })).statusCode).toBe(409);
      expect((await call("POST", `${PLATFORM}/${randomUUID()}/reissue-setup`, { token: tokens.super })).statusCode).toBe(404);
      expect((await call("POST", `${PLATFORM}/not-a-uuid/reissue-setup`, { token: tokens.super })).statusCode).toBe(400);
      expect(sent.filter((m) => m.kind === "org_signup_approved")).toEqual([]);
    });
  });

  describe("the e-mails", () => {
    const base = "https://app.example.org";
    it("carry a link to the right page, and no text the person typed", () => {
      const verify = accountEmail({ kind: "org_signup_verify", email: "a@example.org", token: "tok/en+1" }, base)!;
      expect(verify.text).toContain(`${base}/signup/verify?token=tok%2Fen%2B1`);
      expect(verify.html).toContain(`${base}/signup/verify?token=tok%2Fen%2B1`);
      expect(verify.text).toContain("24 hours");
      const approved = accountEmail({ kind: "org_signup_approved", email: "a@example.org", token: "tok" }, base)!;
      expect(approved.text).toContain(`${base}/reset-password?token=tok`);
      expect(approved.text).toContain("7 days");
      const rejected = accountEmail({ kind: "org_signup_rejected", email: "a@example.org", token: "" }, base)!;
      expect(rejected.text).not.toContain("http");
      expect(rejected.html).not.toContain("href");
      for (const m of [verify, approved, rejected]) expect(m.subject).not.toMatch(/[<>]/);
    });
  });
});
