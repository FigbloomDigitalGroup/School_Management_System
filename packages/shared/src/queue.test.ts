import { describe, expect, it } from "vitest";
import { WriteError, WriteQueue, conflictKeyFor, isRetryable, isRetryableStatus, syncLabel, writeErrorFrom, type QueuedWrite } from "./queue";

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

/** A store whose reads and writes take a tick, like AsyncStorage, so interleaving can happen. */
function slowStore() {
  const m = new Map<string, string>();
  return {
    getItem: async (k: string) => { await Promise.resolve(); return m.get(k) ?? null; },
    setItem: async (k: string, v: string) => { await Promise.resolve(); m.set(k, v); },
  };
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

describe("what counts as worth retrying", () => {
  it("retries no answer, timeouts, rate limits, an expiring login and server errors", () => {
    for (const status of [undefined, 0, 401, 408, 425, 429, 500, 502, 503]) expect(isRetryableStatus(status)).toBe(true);
  });
  it("does not retry what the server decided on purpose", () => {
    for (const status of [400, 403, 404, 409, 413, 422]) expect(isRetryableStatus(status)).toBe(false);
  });
  it("builds an error that carries the verdict", () => {
    expect(writeErrorFrom({ message: "TypeError: Failed to fetch" }, 0)).toMatchObject({ retryable: true, status: 0 });
    expect(writeErrorFrom({ message: "new row violates row-level security policy" }, 403)).toMatchObject({ retryable: false, status: 403 });
  });
  it("treats an error it knows nothing about as retryable, so nothing is dropped", () => {
    expect(isRetryable(new Error("boom"))).toBe(true);
    expect(isRetryable("boom")).toBe(true);
    expect(isRetryable(new WriteError("no", false))).toBe(false);
  });
});

describe("WriteQueue.flush", () => {
  it("stops at a failure waiting could fix and keeps it at the head for the next try", async () => {
    const seen: string[] = [];
    const q = new WriteQueue(memoryStore(), async (w: QueuedWrite) => {
      seen.push(w.table);
      if (w.table === "marks") throw new Error("Failed to fetch");
    });
    await q.enqueue("attendance", [{}]);
    await q.enqueue("marks", [{}]);
    await q.enqueue("attendance", [{}]);
    expect(await q.flush()).toEqual({ sent: 1, remaining: 2 });
    expect(seen).toEqual(["attendance", "marks"]);
    const [head] = await q.pending();
    expect(head).toMatchObject({ table: "marks", attempts: 1, lastError: "Failed to fetch" });
  });

  it("sets aside a write the server refuses, instead of letting it block the rest", async () => {
    const sent: string[] = [];
    const q = new WriteQueue(memoryStore(), async (w: QueuedWrite) => {
      if (w.table === "marks") throw new WriteError("new row violates row-level security policy", false, 403);
      sent.push(w.table);
    });
    await q.enqueue("attendance", [{}]);
    await q.enqueue("marks", [{}]);
    await q.enqueue("announcements", [{}]);
    expect(await q.flush()).toEqual({ sent: 2, remaining: 0 });
    expect(sent).toEqual(["attendance", "announcements"]);

    const rejected = await q.rejected();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ table: "marks", attempts: 1, rejected: { message: "new row violates row-level security policy" } });
    // It is kept for someone to see, and never sent again.
    expect(await q.pending()).toEqual([]);
    expect(await q.flush()).toEqual({ sent: 0, remaining: 0 });
    expect(sent).toEqual(["attendance", "announcements"]);
  });

  it("lets someone throw a refused write away once they have seen why", async () => {
    const q = new WriteQueue(memoryStore(), async () => { throw new WriteError("no", false, 400); });
    await q.enqueue("marks", [{}]);
    await q.flush();
    const [item] = await q.rejected();
    await q.discard(item!.id);
    expect(await q.rejected()).toEqual([]);
  });

  it("keeps a write queued while another is being sent", async () => {
    const store = slowStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const q = new WriteQueue(store, async (w: QueuedWrite) => {
      if (w.table === "attendance") await gate;
      else throw new Error("Failed to fetch"); // signal drops just after the first one lands
    });

    await q.enqueue("attendance", [{ n: 1 }]);
    const flushing = q.flush();
    // The teacher submits another register while the first is still on the wire.
    await new Promise((r) => setTimeout(r, 5));
    await q.enqueue("marks", [{ n: 2 }]);
    release();
    const result = await flushing;

    // The first went out; the second was picked up by the same run, couldn't be
    // sent, and is still waiting (it used to be overwritten when the run saved its snapshot).
    expect(result).toEqual({ sent: 1, remaining: 1 });
    expect((await q.pending()).map((w) => w.table)).toEqual(["marks"]);
  });

  it("sends a write queued mid-flush in the same run when it can", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const sent: string[] = [];
    const q = new WriteQueue(slowStore(), async (w: QueuedWrite) => { if (w.table === "attendance") await gate; sent.push(w.table); });

    await q.enqueue("attendance", [{}]);
    const flushing = q.flush();
    await new Promise((r) => setTimeout(r, 5));
    await q.enqueue("marks", [{}]);
    release();
    expect(await flushing).toEqual({ sent: 2, remaining: 0 });
    expect(sent).toEqual(["attendance", "marks"]);
  });

  it("runs one drain at a time, so a second call never sends the same write twice", async () => {
    let sends = 0;
    const q = new WriteQueue(slowStore(), async () => { sends += 1; await new Promise((r) => setTimeout(r, 5)); });
    await q.enqueue("attendance", [{}]);
    const [a, b] = await Promise.all([q.flush(), q.flush()]);
    expect(sends).toBe(1);
    expect(a).toEqual(b);
    expect(a).toEqual({ sent: 1, remaining: 0 });
  });
});

describe("WriteQueue per user", () => {
  it("only shows and sends the signed-in user's writes", async () => {
    const store = memoryStore();
    const sent: string[] = [];
    const flushFn = async (w: QueuedWrite) => { sent.push(`${w.userId}:${w.table}`); };

    const asAnn = new WriteQueue(store, flushFn);
    asAnn.setUser("ann");
    await asAnn.enqueue("attendance", [{}]);

    // Another teacher signs in on the same phone.
    const asBen = new WriteQueue(store, flushFn);
    asBen.setUser("ben");
    expect(await asBen.pending()).toEqual([]);
    await asBen.enqueue("marks", [{}]);
    expect(await asBen.flush()).toEqual({ sent: 1, remaining: 0 });
    expect(sent).toEqual(["ben:marks"]);

    // Ann's register is still there for her.
    expect((await asAnn.pending()).map((w) => w.table)).toEqual(["attendance"]);
    expect(await asAnn.flush()).toEqual({ sent: 1, remaining: 0 });
    expect(sent).toEqual(["ben:marks", "ann:attendance"]);
  });

  it("gives a write queued before users were recorded to whoever signs in next", async () => {
    const store = memoryStore();
    const old = new WriteQueue(store, async () => {});
    await old.enqueue("attendance", [{}]); // no user set: no userId stamped

    const q = new WriteQueue(store, async () => {});
    q.setUser("ann");
    expect((await q.pending()).map((w) => w.table)).toEqual(["attendance"]);
  });

  it("shows and sends nothing while nobody is signed in", async () => {
    const store = memoryStore();
    const q = new WriteQueue(store, async () => { throw new Error("should not send"); });
    q.setUser("ann");
    await q.enqueue("attendance", [{}]);
    q.setUser(null);
    expect(await q.pending()).toEqual([]);
    expect(await q.flush()).toEqual({ sent: 0, remaining: 0 });
  });
});

describe("syncLabel", () => {
  it("is empty with nothing to say", () => {
    expect(syncLabel(0, true)).toBeNull();
    expect(syncLabel(0, false, 0)).toBeNull();
  });
  it("says what is waiting, and never calls it failed while a retry is coming", () => {
    expect(syncLabel(2, false)).toBe("2 saved on this phone. They will send when you have network.");
    expect(syncLabel(2, true)).toBe("Sending 2…");
  });
  it("flags what the server refused", () => {
    expect(syncLabel(0, true, 1)).toBe("1 could not be sent and needs your attention.");
    expect(syncLabel(3, true, 2)).toBe("Sending 3… 2 could not be sent and need your attention.");
  });
});
