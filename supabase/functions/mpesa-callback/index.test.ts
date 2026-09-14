import { describe, it } from "jsr:@std/testing/bdd";
import { assertEquals } from "jsr:@std/assert";
import { FakeSupabaseClient } from "../_shared/fakeSupabase.ts";
import { handle } from "./index.ts";

const PAYMENT_ID = "payment-1";
const CHECKOUT_ID = "ws_CO_1234";

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

function request(body: unknown) {
  return new Request("https://example.com/mpesa-callback", {
    method: "POST",
    body: JSON.stringify(body),
  });
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
  it("returns 200 on malformed JSON without touching any payment", async () => {
    const admin = makeAdmin();
    const res = await handle(new Request("https://x", { method: "POST", body: "not json" }), admin);
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("returns 200 when the callback body has no stkCallback", async () => {
    const admin = makeAdmin();
    const res = await handle(request({ nothing: true }), admin);
    assertEquals(res.status, 200);
  });

  it("is a no-op for an unknown checkout request id", async () => {
    const admin = makeAdmin();
    const res = await handle(request(successCallback({ CheckoutRequestID: "unknown" })), admin);
    assertEquals(res.status, 200);
    assertEquals(admin.rowsIn("payments")[0].status, "pending");
  });

  it("ignores a retry for a payment that already settled", async () => {
    const admin = makeAdmin({ status: "success" });
    await handle(request(successCallback()), admin);
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "success");
    assertEquals(admin.rowsIn("audit_events").length, 0);
  });

  it("marks a successful payment, converts shillings to cents, and logs an audit event", async () => {
    const admin = makeAdmin();
    await handle(request(successCallback()), admin);

    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "success");
    assertEquals(payment.mpesa_receipt, "SFC1234ABC");
    assertEquals(payment.amount_cents, 50000);

    const audit = admin.rowsIn("audit_events")[0];
    assertEquals(audit.category, "financial");
    assertEquals(audit.metadata.invoice_id, "invoice-1");
  });

  it("maps a cancelled result code to a cancelled status", async () => {
    const admin = makeAdmin();
    await handle(request({ Body: { stkCallback: { CheckoutRequestID: CHECKOUT_ID, ResultCode: 1032 } } }), admin);
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "cancelled");
    assertEquals(payment.failure_reason, "cancelled");
  });

  it("maps a timeout result code to a timeout status", async () => {
    const admin = makeAdmin();
    await handle(request({ Body: { stkCallback: { CheckoutRequestID: CHECKOUT_ID, ResultCode: 1037 } } }), admin);
    assertEquals(admin.rowsIn("payments")[0].status, "timeout");
  });

  it("maps any other non-zero result code to failed / unreachable", async () => {
    const admin = makeAdmin();
    await handle(request({ Body: { stkCallback: { CheckoutRequestID: CHECKOUT_ID, ResultCode: 9999 } } }), admin);
    const payment = admin.rowsIn("payments")[0];
    assertEquals(payment.status, "failed");
    assertEquals(payment.failure_reason, "unreachable");
  });
});
