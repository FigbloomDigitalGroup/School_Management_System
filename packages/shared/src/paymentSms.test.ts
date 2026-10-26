import { describe, expect, it } from "vitest";
import { parsePaymentSms, paymentSmsFlags } from "./paymentSms";

describe("parsePaymentSms: M-Pesa", () => {
  it("reads a paybill payment", () => {
    const p = parsePaymentSms(
      "SJQ4ABC12D Confirmed. Ksh15,000.00 sent to ST MARYS GIRLS SCHOOL for account ADM1234 on 26/10/26 at 10:15 AM New M-PESA balance is Ksh2,340.50. Transaction cost, Ksh0.00.Amount you can transact within the day is 484,000.00.",
    );
    expect(p).toEqual({
      source: "mpesa",
      code: "SJQ4ABC12D",
      amountCents: 1_500_000,
      paidAt: "2026-10-26T10:15:00+03:00",
      payee: "ST MARYS GIRLS SCHOOL",
      payeeNumber: null,
      account: "ADM1234",
    });
  });

  it("reads a till (Buy Goods) payment", () => {
    const p = parsePaymentSms(
      "SJR7XY34ZQ Confirmed. Ksh500.00 paid to KIJANI ACADEMY CANTEEN. on 3/9/26 at 1:05 PM.New M-PESA balance is Ksh1,200.00. Transaction cost, Ksh0.00.",
    );
    expect(p.code).toBe("SJR7XY34ZQ");
    expect(p.amountCents).toBe(50_000);
    expect(p.payee).toBe("KIJANI ACADEMY CANTEEN");
    expect(p.paidAt).toBe("2026-09-03T13:05:00+03:00");
    expect(p.account).toBeNull();
  });

  it("reads money sent to a person, with their phone", () => {
    const p = parsePaymentSms(
      "QJK3ABC12D Confirmed. Ksh5,000.00 sent to JOHN KAMAU 0712345678 on 26/10/26 at 12:40 AM. New M-PESA balance is Ksh320.00. Transaction cost, Ksh57.00.",
    );
    expect(p.amountCents).toBe(500_000);
    expect(p.payee).toBe("JOHN KAMAU");
    expect(p.payeeNumber).toBe("0712345678");
    expect(p.paidAt).toBe("2026-10-26T00:40:00+03:00");
  });

  it("reads a paybill SMS that names the paybill number", () => {
    const p = parsePaymentSms(
      "TKA1B2C3D4 Confirmed. Ksh12,500.00 sent to 247247 - EQUITY PAYBILL ACCOUNT for account 0712345678 on 01/11/2026 at 9:02 AM.",
    );
    expect(p.payeeNumber).toBe("247247");
    expect(p.payee).toBe("EQUITY PAYBILL ACCOUNT");
    expect(p.account).toBe("0712345678");
    expect(p.paidAt).toBe("2026-11-01T09:02:00+03:00");
  });

  it("does not take the balance or cost as the amount", () => {
    const p = parsePaymentSms("New M-PESA balance is Ksh9,999.00. SJQ4ABC12D Confirmed. Ksh700.00 sent to X SCHOOL for account 12 on 26/10/26 at 10:15 AM");
    expect(p.amountCents).toBe(70_000);
  });

  it("finds the code when the message was forwarded with a prefix", () => {
    const p = parsePaymentSms("Fwd: SJQ4ABC12D Confirmed. Ksh700.00 sent to X SCHOOL for account 12 on 26/10/26 at 10:15 AM");
    expect(p.code).toBe("SJQ4ABC12D");
    expect(p.source).toBe("mpesa");
  });
});

describe("parsePaymentSms: Airtel Money", () => {
  it("reads a Trans. ID message", () => {
    const p = parsePaymentSms(
      "Trans. ID: MP241026.1015.A12345. You have sent KES 5,000 to ST MARYS SCHOOL 0733123456 on 26/10/2026 10:15. Your Airtel Money balance is KES 1,234.",
    );
    expect(p.source).toBe("airtel");
    expect(p.code).toBe("MP241026.1015.A12345");
    expect(p.amountCents).toBe(500_000);
    expect(p.payee).toBe("ST MARYS SCHOOL");
    expect(p.payeeNumber).toBe("0733123456");
    expect(p.paidAt).toBe("2026-10-26T10:15:00+03:00");
  });

  it("reads a TID message paid to a business number", () => {
    const p = parsePaymentSms("TID:CI241026.1234.H56789. Sent Ksh 8000.00 to 123456 KIJANI ACADEMY on 26/10/2026 14:30. Bal Ksh 200.00. Airtel Money");
    expect(p.code).toBe("CI241026.1234.H56789");
    expect(p.amountCents).toBe(800_000);
    expect(p.payeeNumber).toBe("123456");
    expect(p.payee).toBe("KIJANI ACADEMY");
  });
});

describe("parsePaymentSms: banks", () => {
  it("reads a debit alert with a reference", () => {
    const p = parsePaymentSms(
      "Dear Customer, your account 01xxxx5678 has been debited with KES 15,000.00 on 26-10-2026. Ref: FT24300ABC12. Desc: School fees ADM1234. Avail bal KES 3,210.00",
    );
    expect(p.source).toBe("bank");
    expect(p.code).toBe("FT24300ABC12");
    expect(p.amountCents).toBe(1_500_000);
    expect(p.paidAt).toBe("2026-10-26T00:00:00+03:00");
  });

  it("reads an Equity-style transfer", () => {
    const p = parsePaymentSms("Confirmed KES 22,000.00 paid to ST MARYS SCHOOL A/C 1100223344 Ref No. S12345678 on 26-10-2026 10:15. Bank charges KES 50.00");
    expect(p.code).toBe("S12345678");
    expect(p.amountCents).toBe(2_200_000);
    expect(p.payee).toBe("ST MARYS SCHOOL");
    expect(p.account).toBe("1100223344");
  });

  it("reads Kshs and amounts without decimals", () => {
    expect(parsePaymentSms("Kshs 3,500 deposited to your school account. Ref: DP99887766A").amountCents).toBe(350_000);
  });
});

describe("parsePaymentSms: edge cases", () => {
  it("returns nulls for text that isn't a payment", () => {
    expect(parsePaymentSms("Hello, I paid yesterday, please check")).toEqual({
      source: "unknown", code: null, amountCents: null, paidAt: null, payee: null, payeeNumber: null, account: null,
    });
  });

  it("refuses impossible dates", () => {
    expect(parsePaymentSms("SJQ4ABC12D Confirmed. Ksh700.00 sent to X on 31/02/26 at 10:15 AM").paidAt).toBeNull();
    expect(parsePaymentSms("SJQ4ABC12D Confirmed. Ksh700.00 sent to X on 12/13/26").paidAt).toBeNull();
  });

  it("doesn't take a bare number as the code", () => {
    expect(parsePaymentSms("Ref: 1234567890 paid KES 100").code).toBeNull();
  });

  it("copes with line breaks and extra spaces", () => {
    const p = parsePaymentSms("SJQ4ABC12D  Confirmed.\r\nKsh1,000.00 sent to   X SCHOOL\nfor account 9 on 26/10/26 at 10:15 AM");
    expect(p.code).toBe("SJQ4ABC12D");
    expect(p.amountCents).toBe(100_000);
    expect(p.account).toBe("9");
  });
});

describe("paymentSmsFlags", () => {
  const school = { balanceCents: 1_500_000, paybill: "123456", till: null };
  const ok = { code: "SJQ4ABC12D", amountCents: 1_500_000, payeeNumber: null, paidAt: "2026-10-26T10:15:00+03:00" };
  const now = new Date("2026-10-27T00:00:00Z");

  it("flags nothing on a clean full payment", () => {
    expect(paymentSmsFlags(ok, school, now)).toEqual([]);
  });

  it("flags a part payment and a missing code", () => {
    expect(paymentSmsFlags({ ...ok, code: null, amountCents: 500_000 }, school, now)).toEqual(["no_code", "amount_differs"]);
  });

  it("flags a payee number that isn't the school's paybill or till", () => {
    expect(paymentSmsFlags({ ...ok, payeeNumber: "247247" }, school, now)).toEqual(["wrong_payee_number"]);
    expect(paymentSmsFlags({ ...ok, payeeNumber: "123456" }, school, now)).toEqual([]);
    expect(paymentSmsFlags({ ...ok, payeeNumber: "555555" }, { ...school, till: "555555" }, now)).toEqual([]);
  });

  it("doesn't flag a payee number when the school has none configured", () => {
    expect(paymentSmsFlags({ ...ok, payeeNumber: "247247" }, { balanceCents: null, paybill: null, till: null }, now)).toEqual([]);
  });

  it("flags a missing amount and a future date", () => {
    expect(paymentSmsFlags({ ...ok, amountCents: null, paidAt: "2026-11-05T10:00:00+03:00" }, school, now)).toEqual(["no_amount", "future_date"]);
  });
});
