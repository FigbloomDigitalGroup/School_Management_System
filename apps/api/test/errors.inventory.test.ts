import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { financeHarness } from "./support/financeHarness.js";

/**
 * Residual closure workstream 6: the explicit raw-error inventory. The earlier audit counted ~15 request-path `throw new Error(...)`
 * sites (auth/sessionProof 2, directory documents/guardians/learners/staff 1 each, finance money 1, mpesa 2, mpesaProvider 6).
 * Each is classified here, the set is PINNED (a new raw throw outside startup/ops code fails this test until it is classified), and the
 * ones that could plausibly be reached by a client are exercised. A raw `Error` becomes an opaque 500 by design: that is correct for an
 * invariant violation and wrong for anything a client can cause; the hostile-input sweep (errors.sweep) proves the latter class is empty.
 *
 * | file                              | n | condition                                         | class       | reachable by a client? |
 * | modules/auth/sessionProof.ts      | 2 | server-generated Date not ISO; missing HMAC key    | invariant / startup config | no |
 * | modules/directory/documents.ts    | 1 | INSERT ... RETURNING returned no row               | invariant   | no (a refused insert throws, never returns zero rows) |
 * | modules/directory/guardians.ts    | 1 | same                                               | invariant   | no |
 * | modules/directory/learners.ts     | 1 | same                                               | invariant   | no |
 * | modules/directory/staffMembers.ts | 1 | same                                               | invariant   | no |
 * | modules/finance/money.ts          | 1 | database money value is not a safe integer         | invariant   | no: finance_payments CHECK caps amounts at 1e11 |
 * | modules/finance/mpesa.ts          | 2 | operator context mismatch; settle without checkout | invariant   | no: the operator path answers 'inconclusive' first; callbacks and the job locate the payment BY checkout id |
 * | modules/finance/mpesaProvider.ts  | 6 | provider unconfigured / auth / push / query failed | operational | no: every caller catches it (503 / inconclusive / retry) |
 * | modules/account/resendNotifier.ts | 4 | RESEND_API_KEY set but ACCOUNT_EMAIL_FROM / ACCOUNT_LINK_BASE_URL unusable | startup config | no: only index.ts main() calls resendNotifierFromEnv, before the server listens |
 * | modules/identity/password.ts      | 1 | crypto.argon2 unavailable (Node < 24.7)            | startup/environment | no |
 * | src/worker/index.ts               | 1 | worker configuration                               | startup     | n/a (not an HTTP path) |
 */
const EXPECTED: Record<string, number> = {
  "config.ts": 33, // +3 startup refusals (088): MFA; +1 startup refusal (PayHero HTTPS callback URL outside local/test)
  "db/migrate.ts": 7,
  "db/pool.ts": 2,
  "db/roleAssert.ts": 14,
  "db/tenantContext.ts": 1,
  "db/tenantTransaction.ts": 1,
  "modules/account/resendNotifier.ts": 4, // startup refusals: e-mail on (RESEND_API_KEY) but the sender or link origin is unusable
  "modules/auth/sessionProof.ts": 2,
  "modules/directory/documents.ts": 1,
  "modules/directory/guardians.ts": 1,
  "modules/directory/learners.ts": 1,
  "modules/directory/staffMembers.ts": 1,
  "modules/finance/money.ts": 1,
  "modules/finance/mpesa.ts": 2,
  "modules/finance/mpesaProvider.ts": 6,
  "modules/finance/payheroProvider.ts": 4,
  "modules/identity/password.ts": 1,
  "worker/index.ts": 1,
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("raw error inventory", () => {
  it("the set of raw `throw new Error` sites in src is exactly the classified inventory", () => {
    const src = join(process.cwd(), "src");
    const actual: Record<string, number> = {};
    for (const f of walk(src)) {
      const n = (readFileSync(f, "utf8").match(/throw new Error\(/g) ?? []).length;
      if (n > 0) actual[f.slice(src.length + 1).replace(/\\/g, "/")] = n;
    }
    expect(actual, "a new raw throw must be classified here (invariant vs client-caused) or replaced by an AppError helper").toEqual(EXPECTED);
  });

  describe("the plausible client-reachable ones, exercised", () => {
    const h = financeHarness();
    const F = (p: string) => `/v1/tenants/${h.A()}/finance${p}`;

    it("operator reconciliation of a pending M-Pesa payment with NO checkout id never reaches the settle invariant: every action is an inconclusive 200", async () => {
      const inv = await h.freshInvoice(1_000_000);
      const id = (await h.owner(`INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn) VALUES ($1, $2, 100000, 'mpesa', 'pending', '254712345678') RETURNING id`, [h.A(), inv]))[0]!.id as string;
      for (const body of [{ action: "refresh", note: "reconcile without a checkout id" }, { action: "settle_success", receipt: "ABC123XYZ9", note: "reconcile without a checkout id" }, { action: "mark_failed", note: "reconcile without a checkout id" }]) {
        const r = await h.call("POST", F(`/payments/${id}/mpesa-reconciliation`), h.admin, body, { "x-tenant-id": h.A() });
        expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
        expect(r.json().outcome).toBe("inconclusive");
      }
      expect((await h.payment(id)).status).toBe("pending");
    });

    it("an unconfigured or unreachable provider is an inconclusive answer, never a 500", async () => {
      const inv = await h.freshInvoice(1_000_000);
      const p = await h.startPrompt(inv, 100_000);
      h.fake.queries.set(p.checkout, "throw");
      const r = await h.call("POST", F(`/payments/${p.payment.id}/mpesa-reconciliation`), h.admin, { action: "refresh", note: "provider is down right now" }, { "x-tenant-id": h.A() });
      expect(r.statusCode, JSON.stringify(r.json())).toBe(200);
      expect(r.json().outcome).toBe("inconclusive");
    });

    it("the money invariant is unreachable: the database caps every amount well below 2^53", async () => {
      const def = (await h.owner(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'finance_payments_amount_chk'`))[0]!.d as string;
      expect(def).toMatch(/100000000000/);
      expect(100_000_000_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
    });
  });
});
