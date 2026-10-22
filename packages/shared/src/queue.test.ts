import { describe, expect, it } from "vitest";
import { WriteQueue, conflictKeyFor, type QueuedWrite } from "./queue";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe("conflictKeyFor", () => {
  it("gives the upsert key for tables whose rows are re-sent over existing ones", () => {
    expect(conflictKeyFor("attendance")).toBe("student_id,taken_on");
    expect(conflictKeyFor("marks")).toBe("exam_id,student_id,subject_id");
  });

  it("has no key for insert-only tables", () => {
    expect(conflictKeyFor("announcements")).toBeUndefined();
    expect(conflictKeyFor("vehicle_locations")).toBeUndefined();
  });
});

describe("WriteQueue.flush", () => {
  it("stops at the first failure and keeps it at the head for the next try", async () => {
    const seen: string[] = [];
    const q = new WriteQueue(memoryStore(), async (w: QueuedWrite) => {
      seen.push(w.table);
      if (w.table === "marks") throw new Error("duplicate key");
    });
    await q.enqueue("attendance", [{}]);
    await q.enqueue("marks", [{}]);
    await q.enqueue("attendance", [{}]);
    expect(await q.flush()).toEqual({ sent: 1, remaining: 2 });
    expect(seen).toEqual(["attendance", "marks"]);
    const [head] = await q.pending();
    expect(head).toMatchObject({ table: "marks", attempts: 1, lastError: "duplicate key" });
  });
});
