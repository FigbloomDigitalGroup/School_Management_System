import { describe, expect, it } from "vitest";
import { csvLines, splitCsvLine, toCsv } from "./csv";
import {
  availableCount, daysOverdue, endOfSchoolYear, friendlyInventoryError, isOverdue, issueMatches, issuesCsv, registerCsv,
  sortIssues, summariseInventory, todayIso, type InventoryIssueRow, type InventoryItemRow,
} from "./inventory";

const NOW = new Date(2026, 9, 27, 10, 0); // 27 Oct 2026, local

function item(over: Partial<InventoryItemRow> = {}): InventoryItemRow {
  return {
    id: "i1", tenant_id: "t", name: "KLB Biology F2", category: "textbooks", tracking: "stock", quantity: 10,
    asset_tag: null, condition: "good", location: null, purchased_on: null, unit_cost_cents: 85000, notes: null,
    retired_at: null, created_at: "2026-01-01T00:00:00Z", out: 0, available: 10, ...over,
  };
}

function issue(over: Partial<InventoryIssueRow> = {}): InventoryIssueRow {
  return {
    id: "x", tenant_id: "t", item_id: "i1", student_id: "s1", profile_id: null, quantity: 1, issued_by: null,
    issued_at: "2026-02-01T08:00:00Z", due_on: "2026-12-31", condition_out: "good", status: "out",
    returned_condition: null, closed_at: null, note: null,
    itemName: "KLB Biology F2", itemCategory: "textbooks", assetTag: null, holderName: "Amani Otieno",
    holderKind: "learner", holderDetail: "ADM 1042", issuedByName: null, ...over,
  };
}

describe("availableCount", () => {
  it("is what's owned less what's out, never negative", () => {
    expect(availableCount({ quantity: 10, retired_at: null }, 3)).toBe(7);
    expect(availableCount({ quantity: 2, retired_at: null }, 5)).toBe(0);
  });
  it("is zero for a written-off item", () => {
    expect(availableCount({ quantity: 1, retired_at: "2026-05-01T00:00:00Z" }, 0)).toBe(0);
  });
});

describe("overdue", () => {
  it("only counts issues still out and past their date", () => {
    expect(isOverdue({ status: "out", due_on: "2026-10-26" }, NOW)).toBe(true);
    expect(isOverdue({ status: "out", due_on: "2026-10-27" }, NOW)).toBe(false); // due today
    expect(isOverdue({ status: "returned", due_on: "2026-01-01" }, NOW)).toBe(false);
    expect(isOverdue({ status: "out", due_on: null }, NOW)).toBe(false);
  });
  it("counts whole days", () => {
    expect(daysOverdue({ status: "out", due_on: "2026-10-20" }, NOW)).toBe(7);
    expect(daysOverdue({ status: "out", due_on: "2026-11-20" }, NOW)).toBe(0);
  });
  it("uses the local date", () => {
    expect(todayIso(NOW)).toBe("2026-10-27");
    expect(endOfSchoolYear(NOW)).toBe("2026-12-31");
  });
});

describe("sortIssues", () => {
  it("puts overdue first, then soonest due, then closed newest first", () => {
    const rows = [
      issue({ id: "closed-old", status: "returned", closed_at: "x", issued_at: "2026-01-01T00:00:00Z" }),
      issue({ id: "later", due_on: "2026-12-31" }),
      issue({ id: "overdue", due_on: "2026-10-01" }),
      issue({ id: "closed-new", status: "lost", closed_at: "x", issued_at: "2026-06-01T00:00:00Z" }),
      issue({ id: "soon", due_on: "2026-11-01" }),
      issue({ id: "no-date", due_on: null }),
    ];
    expect(sortIssues(rows, NOW).map((r) => r.id)).toEqual(["overdue", "soon", "later", "no-date", "closed-new", "closed-old"]);
  });
});

describe("summariseInventory", () => {
  it("counts live items, copies out, overdue issues and lost copies", () => {
    const s = summariseInventory(
      [item({ quantity: 10 }), item({ id: "i2", tracking: "asset", quantity: 1 }), item({ id: "gone", retired_at: "2026-01-01T00:00:00Z" })],
      [issue({ quantity: 2 }), issue({ due_on: "2026-10-01" }), issue({ status: "lost", quantity: 3, closed_at: "x" })],
      NOW,
    );
    expect(s).toEqual({ items: 2, copiesOwned: 11, out: 3, overdue: 1, lost: 3 });
  });
});

describe("issueMatches", () => {
  it("matches item, tag or holder, ignoring case", () => {
    const r = issue({ assetTag: "PRJ-07" });
    expect(issueMatches(r, "biology")).toBe(true);
    expect(issueMatches(r, "prj")).toBe(true);
    expect(issueMatches(r, "amani")).toBe(true);
    expect(issueMatches(r, "1042")).toBe(true);
    expect(issueMatches(r, "chemistry")).toBe(false);
    expect(issueMatches(r, "  ")).toBe(true);
  });
});

describe("CSV export", () => {
  it("quotes only what needs quoting, and reads back with splitCsvLine", () => {
    const text = toCsv(["a", "b", "c"], [["plain", 'say "hi", ok', null], [1, 2.5, "x"]]);
    const lines = csvLines(text);
    expect(lines[1]).toBe('plain,"say ""hi"", ok",');
    expect(splitCsvLine(lines[1]!)).toEqual(["plain", 'say "hi", ok', ""]);
    expect(splitCsvLine(lines[2]!)).toEqual(["1", "2.5", "x"]);
  });

  it("writes the register with money in units", () => {
    const [header, row] = csvLines(registerCsv([item({ out: 3, available: 7 })]));
    expect(header).toContain("unit_cost");
    expect(splitCsvLine(row!)).toEqual(["KLB Biology F2", "Textbooks", "stock", "", "10", "3", "7", "Good", "", "", "850.00", "", ""]);
  });

  it("writes issues with days overdue", () => {
    const [, row] = csvLines(issuesCsv([issue({ due_on: "2026-10-20" })], NOW));
    const cells = splitCsvLine(row!);
    expect(cells[2]).toBe("Amani Otieno");
    expect(cells[8]).toBe("Out");
    expect(cells[9]).toBe("7");
  });
});

describe("friendlyInventoryError", () => {
  it("explains a duplicate tag", () => {
    expect(friendlyInventoryError('duplicate key value violates unique constraint "inventory_items_tag_unique"')).toBe("Another item already has that asset tag.");
    expect(friendlyInventoryError("something else")).toBe("something else");
  });
});
