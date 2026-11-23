import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { buildApp } from "../src/app.js";
import { ALLOWED_LOG_FIELDS, acceptableRequestId, log, setLogSink } from "../src/log.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const SECRETS = {
  password: "correct-horse-battery",
  wrongPassword: "S3cretWrongPassw0rd!",
  email: "admin-a@example.com",
  emailLocal: "leak-local-part",
  queryToken: "QS-SECRET-TOKEN-123",
  learnerName: "Wanjiku Mwangi",
  admission: "ADM-LEAK-77",
  dob: "2012-03-04",
  rawException: "boom postgres://dbuser:dbpass@dbhost:5432/db secret-detail",
  driverMessage: 'relation "secret_table" does not exist at character 15',
};

function listTs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** FIG-1620: structured logging, correlation ids and redaction. */
describe("structured logging and redaction", () => {
  let ctx: Ctx;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let lines: string[];
  let restore: () => void;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    app = await buildApp(ctx.config, ctx.runtimePool);
    app.get("/__test/boom", async () => {
      throw new Error(SECRETS.rawException);
    });
    app.get("/__test/db-error", async () => {
      throw Object.assign(new Error(SECRETS.driverMessage), { code: "42P01" });
    });
    app.get("/__test/db-timeout", async () => {
      throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
    });
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: SECRETS.email, password: SECRETS.password },
    });
    adminToken = login.json().token as string;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await ctx.app.close();
    await ctx.pool.end();
  });

  beforeAll(() => {
    lines = [];
    restore = setLogSink((l) => lines.push(l));
  });
  afterAll(() => restore());

  it("a mix of requests (credentials, personal data, query strings, failures) leaves no sensitive value in the log stream", async () => {
    lines.length = 0;
    const bearer = { authorization: `Bearer ${adminToken}`, "x-tenant-id": ctx.ids.tenantA };
    const responses = [
      await app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: SECRETS.email, password: SECRETS.password } }),
      await app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email: SECRETS.email, password: SECRETS.wrongPassword } }),
      await app.inject({ method: "GET", url: `/v1/auth/me?token=${SECRETS.queryToken}&email=${SECRETS.emailLocal}@example.com`, headers: bearer }),
      await app.inject({
        method: "POST",
        url: `/v1/tenants/${ctx.ids.tenantA}/learners`,
        headers: bearer,
        payload: { admission_no: SECRETS.admission, full_name: SECRETS.learnerName, gender: "female", date_of_birth: SECRETS.dob },
      }),
      await app.inject({ method: "GET", url: "/nope?secret=" + SECRETS.queryToken }),
      await app.inject({ method: "GET", url: "/__test/boom" }),
      await app.inject({ method: "GET", url: "/__test/db-error" }),
      await app.inject({ method: "GET", url: "/__test/db-timeout" }),
    ];
    expect(responses.map((r) => r.statusCode)).toEqual([200, 401, 200, 201, 404, 500, 500, 503]);

    const out = lines.join("\n");
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(out, `log must not contain ${name}`).not.toContain(value);
    }
    expect(out).not.toContain(adminToken);
    expect(out).not.toMatch(/bearer|authorization|scrypt|password|dbpass|dbhost|127\.0\.0\.1/i);
    expect(out).not.toContain("?"); // no query string at all

    // Every line is JSON with only allowlisted keys.
    const allowed = new Set<string>(["level", "time", "msg", ...ALLOWED_LOG_FIELDS]);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const entry of parsed) {
      for (const key of Object.keys(entry)) expect(allowed.has(key), key).toBe(true);
    }

    // Correlation: each response's request id appears in an access-log line with route template and status.
    for (const r of responses) {
      const id = r.headers["x-request-id"] as string;
      expect(id).toBeTruthy();
      const entry = parsed.find((p) => p.msg === "request" && p.request_id === id);
      expect(entry, `access log for ${id}`).toBeTruthy();
      expect(entry!.status).toBe(r.statusCode);
      expect(typeof entry!.duration_ms).toBe("number");
    }
    // Route is the template, not the concrete URL (no ids, no query values).
    const learner = parsed.find((p) => p.route === "/v1/tenants/:tenantId/learners");
    expect(learner).toBeTruthy();
    expect(learner!.tenant_id).toBe(ctx.ids.tenantA);
    expect(learner!.user_id).toBe(ctx.ids.adminA);
    const unmatched = parsed.find((p) => p.route === "unmatched");
    expect(unmatched).toBeTruthy();
  });

  it("5xx are logged by class and SQLSTATE, never by exception or driver message", async () => {
    lines.length = 0;
    await app.inject({ method: "GET", url: "/__test/boom" });
    await app.inject({ method: "GET", url: "/__test/db-error" });
    await app.inject({ method: "GET", url: "/__test/db-timeout" });
    const failures = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === "request_failed");
    expect(failures).toHaveLength(3);
    expect(failures[0]).toMatchObject({ level: "error", status: 500, error_code: "internal_error", error_class: "Error" });
    expect(failures[0].sqlstate).toBeUndefined();
    expect(failures[1]).toMatchObject({ status: 500, sqlstate: "42P01" });
    expect(failures[2]).toMatchObject({ status: 503, error_code: "service_unavailable", sqlstate: "57014" });
    const out = lines.join("\n");
    expect(out).not.toContain("secret-detail");
    expect(out).not.toContain("secret_table");
  });

  it("error bodies carry the same request_id as the X-Request-Id header; the required fields are unchanged", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/auth/me" });
    expect(r.statusCode).toBe(401);
    const body = r.json();
    expect(body.error.code).toBe("unauthorized");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.request_id).toBe(r.headers["x-request-id"]);
    const nf = await app.inject({ method: "GET", url: "/nope" });
    expect(nf.json().error.request_id).toBe(nf.headers["x-request-id"]);
  });

  it("an inbound X-Request-Id is honoured only when it is a short safe token", async () => {
    const good = await app.inject({ method: "GET", url: "/livez", headers: { "x-request-id": "client-req-1234.ABC_x" } });
    expect(good.headers["x-request-id"]).toBe("client-req-1234.ABC_x");
    for (const bad of ["short", "has space in it 1234", "x".repeat(65), "inject\\nline-1234", "<script>12345678"]) {
      const r = await app.inject({ method: "GET", url: "/livez", headers: { "x-request-id": bad } });
      expect(r.headers["x-request-id"], bad).not.toBe(bad);
      expect(String(r.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(acceptableRequestId("ok-id-12345")).toBe("ok-id-12345");
    expect(acceptableRequestId(undefined)).toBeUndefined();
  });

  it("the logger itself drops non-allowlisted fields and coerces values (it cannot be made to log a body or token)", () => {
    const local: string[] = [];
    const undo = setLogSink((l) => local.push(l));
    try {
      log("info", "probe", {
        request_id: "abc",
        password: "hunter2",
        authorization: "Bearer xyz",
        body: { a: 1 },
        route: "x".repeat(500),
      } as never);
    } finally {
      undo();
    }
    const entry = JSON.parse(local[0]!);
    expect(entry.password).toBeUndefined();
    expect(entry.authorization).toBeUndefined();
    expect(entry.body).toBeUndefined();
    expect(entry.request_id).toBe("abc");
    expect(entry.route.length).toBe(200);
  });

  it("no console.* remains in request-serving code (migrate CLI and the logger are the only exceptions)", () => {
    const src = join(process.cwd(), "src");
    const offenders = listTs(src)
      .filter((f) => {
        const rel = relative(src, f).split("\\").join("/");
        return !["db/migrate.ts", "log.ts"].includes(rel) && !rel.startsWith("openapi/");
      })
      .filter((f) => /\bconsole\.(log|error|warn|info|debug)\b/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f));
    expect(offenders).toEqual([]);
  });
});
