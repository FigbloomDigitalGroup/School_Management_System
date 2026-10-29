import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import type { StkOutcome } from "../_shared/daraja.ts";
import { handle } from "./index.ts";

const PAYMENT_ID = "payment-1";
const CHECKOUT_ID = "ws_CO_1234";
const SECRET = "callback-secret";

function makeAdmin(paymentOverrides: Record<string, unknown> = {}) {
  const admin = new FakeSupabaseClient();
  admin.seed("payments", [{
    id: PAYMENT_ID,
    tenant_id: "tenant-1",
    invoice_id: "invoice-1",
    checkout_request_id: CHECKOUT_ID,
    status: "pending",
    amount_cents: 50000,
    ...paymentOverrides,
  }]);
  return admin;
}

/** Daraja's answer to the STK query, whatever the callback body claims. */
function daraja(outcome: StkOutcome | Error) {
  const asked: string[] = [];
  const queryStk = (id: string) => {
    asked.push(id);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  return { queryStk, asked };
}

function deps(admin: FakeSupabaseClient, outcome: StkOutcome | Error = { done: true, resultCode: 0 }) {
  return { admin, callbackSecret: SECRET as string | undefined, ...daraja(outcome) };
}

function request(body: unknown, token: string | null = SECRET) {
  const url = token === null ? "https://example.com/mpesa-callback" : `https://example.com/mpesa-callback?token=${token}`;
  return new Request(url, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

function successCallback(overrides: Record<string, unknown> = {}) {
  return {
    Body: {
      stkCallback: {
        CheckoutRequestID: CHECKOUT_ID,
        ResultCode: 0,
        CallbackMetadata: {
          Item: [
            { Name: "MpesaReceiptNumber", Value: "SFC1234ABC" },
            { Name: "Amount", Value: 500 },
          ],
        },
        ...overrides,
      },
    },
  };
}

describe("mpesa-callback handle", () => {
  describe("callback secret", () => {
    it("refuses a callback without the secret token", async () => {
      const admin = makeAdmin();
      const res = await handle(request(successCallback(), null), deps(admin));
      assertEquals(res.status, 403);
      assertEquals(admin.rowsIn("payments")[0].status, "pending");
    });

    it("refuses a callback with the wrong token", async () => {
      const admin = makeAdmin();
      const res = await handle(request(successCallback(), "guess"), deps(admin));
      assertEquals(res.status, 403);
      assertEquals(admin.rowsIn("payments")[0].status, "pending");
    });

    it("refuses every callback when no secret is configured", async () => {
      const admin = makeAdmin();
      const res = await handle(request(successCallback(), ""), { ...deps(admin), callbackSecret: undefined });
      assertEquals(res.status, 403);
      assertEquals(admin.rowsIn("payments")[0].status, "pending");
    });
  });

  it("returns 200 on malformed JSON without touching any payment", async () => {
    const admin = makeAdmin();
    const res = await handle(request("not json"), deps(admin));
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("returns 200 when the callback body has no stkCallback", async () => {
    const admin = makeAdmin();
    const res = await handle(request({ nothing: true }), deps(admin));
    assertEquals(res.status, 200);
  });

  it("is a no-op for an unknown checkout request id, without asking Daraja", async () => {
    const admin = makeAdmin();
    const d = deps(admin);
    const res = await handle(request(successCallback({ CheckoutRequestID: "unknown" })), d);
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
    assertEquals(d.asked, []);
  });

  it("ignores a retry for a payment that already settled", async () => {
    const admin = makeAdmin({ status: "success" });
    await handle(request(successCallback()), deps(admin));
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "success");
    assertEquals(admin.rowsIn("audit_events").length, 0);
  });

  it("marks a payment Daraja confirms, keeps the prompt's amount, and logs an audit event", async () => {
    const admin = makeAdmin();
    const d = deps(admin);
    await handle(request(successCallback()), d);

    assertEquals(d.asked, [CHECKOUT_ID]);
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "success");
    assertEquals(payment.mpesa_receipt, "SFC1234ABC");
    assertEquals(payment.amount_cents, 50000);

    const audit = admin.rowsIn("audit_events")[0];
    assertEquals(audit.category, "financial");
    assertEquals(audit.metadata.invoice_id, "invoice-1");
  });

  it("never takes the callback's Amount", async () => {
    const admin = makeAdmin();
    const forged = successCallback({
      CallbackMetadata: { Item: [{ Name: "MpesaReceiptNumber", Value: "SFC1234ABC" }, { Name: "Amount", Value: 999999 }] },
    });
    await handle(request(forged), deps(admin));
    assertEquals(admin.rowsIn("payments")[0].amount_cents, 50000);
  });

  it("does not credit a 'success' callback that Daraja says was cancelled", async () => {
    const admin = makeAdmin();
    await handle(request(successCallback()), deps(admin, { done: true, resultCode: 1032 }));
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "cancelled");
    assertEquals(admin.rowsIn("audit_events").length, 0);
  });

  it("credits a payment Daraja confirms even if the callback said it failed", async () => {
    const admin = makeAdmin();
    await handle(request({ Body: { stkCallback: { CheckoutRequestID: CHECKOUT_ID, ResultCode: 1 } } }), deps(admin));
    assertEquals(admin.rowsIn("payments")[0].status, "success");
  });

  it("asks for a retry, and leaves the payment pending, while Daraja is still processing", async () => {
    const admin = makeAdmin();
    const res = await handle(request(successCallback()), deps(admin, { done: false }));
    assertEquals(res.status, 500);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("asks for a retry when Daraja can't be reached", async () => {
    const admin = makeAdmin();
    const res = await handle(request(successCallback()), deps(admin, new Error("network down")));
    assertEquals(res.status, 500);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("asks for a retry when the payment can't be saved", async () => {
    const admin = makeAdmin();
    admin.failNextWrite("payments", "database unavailable");
    const res = await handle(request(successCallback()), deps(admin));
    assertEquals(res.status, 500);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("maps a cancelled result code to a cancelled status", async () => {
    const admin = makeAdmin();
    await handle(request(successCallback()), deps(admin, { done: true, resultCode: 1032 }));
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "cancelled");
    assertEquals(payment.failure_reason, "cancelled");
  });

  it("maps a timeout result code to a timeout status", async () => {
    const admin = makeAdmin();
    await handle(request(successCallback()), deps(admin, { done: true, resultCode: 1037 }));
    assertEquals(admin.rowsIn("payments")[0].status, "timeout");
  });

  it("maps any other non-zero result code to failed / unreachable", async () => {
    const admin = makeAdmin();
    await handle(request(successCallback()), deps(admin, { done: true, resultCode: 9999 }));
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "failed");
    assertEquals(payment.failure_reason, "unreachable");
  });
});

describe("two deliveries of the same callback (FIG-1323)", () => {
  it("arriving together, credit once and log one 'Fee payment received' event", async () => {
    const admin = makeAdmin();
    const d = deps(admin);
    const [a, b] = await Promise.all([handle(request(successCallback()), d), handle(request(successCallback()), d)]);
    assertEquals([a.status, b.status], [200, 200]);
    assertEquals(admin.rowsIn("payments")[0].status, "success");
    assertEquals(admin.rowsIn("audit_events").length, 1);
  });

  it("arriving together for a cancelled prompt, settle it once", async () => {
    const admin = makeAdmin();
    const d = deps(admin, { done: true, resultCode: 1032 });
    const [a, b] = await Promise.all([handle(request(successCallback()), d), handle(request(successCallback()), d)]);
    assertEquals([a.status, b.status], [200, 200]);
    assertEquals(admin.rowsIn("payments")[0].status, "cancelled");
    assertEquals(admin.rowsIn("audit_events").length, 0);
  });
});
