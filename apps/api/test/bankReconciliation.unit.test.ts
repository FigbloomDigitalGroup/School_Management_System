import { describe, expect, it } from "vitest";
import {
  extractInvoicePrefix,
  normalizeBankReference,
  parseBankDate,
  parseBankStatementCsv,
  parseMoneyToMinor,
} from "../src/modules/finance/bankReconciliation.js";

describe("Bank Statement Reconciliation CSV & Normalizers", () => {
  it("parses money strings with currency prefixes, commas, and parentheses", () => {
    expect(parseMoneyToMinor("KES 15,000.00")).toBe(1_500_000);
    expect(parseMoneyToMinor("KSh 250.5")).toBe(25_050);
    expect(parseMoneyToMinor("(1,200.00)")).toBe(-120_000);
    expect(parseMoneyToMinor("-")).toBeNull();
  });

  it("parses ISO and DD/MM/YYYY bank dates", () => {
    expect(parseBankDate("2026-02-10")).toBe("2026-02-10");
    expect(parseBankDate("05/02/2026")).toBe("2026-02-05");
    expect(parseBankDate("15-03-2026")).toBe("2026-03-15");
    expect(parseBankDate("invalid")).toBeNull();
  });

  it("extracts FIG invoice prefixes and normalizes bank references", () => {
    expect(extractInvoicePrefix("FEES PAYMENT FIG-1234ABCD AMINA")).toBe("1234abcd");
    expect(extractInvoicePrefix("School fees FIG 99aa00bb")).toBe("99aa00bb");
    expect(extractInvoicePrefix("No invoice ref here")).toBeNull();
    expect(normalizeBankReference("FT-26041/9988")).toBe("FT260419988");
  });

  it("parses Kenyan bank statement CSV with separate Credit/Debit columns", () => {
    const csv = [
      "Transaction Date,Reference,Narration,Debit,Credit,Balance",
      '10/02/2026,QWE123RTY4,"MPESA PAYBILL FIG-1234ABCD",,"15,000.00","115,000.00"',
      '11/02/2026,CHG-001,"Monthly ledger fee","500.00",,"114,500.00"',
    ].join("\r\n");

    const lines = parseBankStatementCsv(csv);
    expect(lines).toEqual([
      {
        txn_date: "2026-02-10",
        reference: "QWE123RTY4",
        description: "MPESA PAYBILL FIG-1234ABCD",
        amount_minor: 1_500_000,
        direction: "credit",
        balance_minor: 11_500_000,
      },
      {
        txn_date: "2026-02-11",
        reference: "CHG-001",
        description: "Monthly ledger fee",
        amount_minor: 50_000,
        direction: "debit",
        balance_minor: 11_450_000,
      },
    ]);
  });

  it("parses single signed Amount column CSV", () => {
    const csv = [
      "Date,Ref,Details,Amount",
      "2026-02-12,DEP-991,Parent transfer,25000.00",
      "2026-02-12,FEE-002,Bank charge,-150.00",
    ].join("\n");

    const lines = parseBankStatementCsv(csv);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ direction: "credit", amount_minor: 2_500_000 });
    expect(lines[1]).toMatchObject({ direction: "debit", amount_minor: 15_000 });
  });
});
