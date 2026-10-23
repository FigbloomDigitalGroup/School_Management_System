/**
 * Offline-first write queue.
 *
 * Rural schools lose connectivity mid-lesson. A teacher who taps Submit must be
 * told the register is SAVED, not asked to retry — so writes land in a local
 * queue first and drain when the network returns. The UI reads the queue so a
 * pending register still shows today's marks, not yesterday's.
 *
 * Storage is injected: localStorage on web, AsyncStorage on React Native.
 */

export interface KeyValueStore {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
}

export interface QueuedWrite {
  id: string;
  table: string;
  rows: unknown[];
  queuedAt: string;
  attempts: number;
  lastError?: string;
  /** Who queued it. One without (queued before this was recorded) goes to whoever signs in next. */
  userId?: string;
  /**
   * The server refused this write and will keep refusing it (a rule, a missing
   * row, bad data). It is kept so someone can see what was lost and why, and is
   * never sent again.
   */
  rejected?: { at: string; message: string };
}

/**
 * A write that did not go through. `retryable` says whether waiting can help:
 * true for no answer or a server in trouble, false when the server looked at
 * the write and said no.
 */
export class WriteError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) {
    super(message);
    this.name = "WriteError";
  }
}

/**
 * No answer at all (0), a timeout, a rate limit, a login that is about to
 * refresh (401) and server errors are worth another try. Everything else the
 * server decided on purpose, and sending the same rows again won't change it.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 0 || status === 401 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export function writeErrorFrom(error: { message: string }, status?: number): WriteError {
  return new WriteError(error.message, isRetryableStatus(status), status);
}

/** Unknown failures count as retryable: better to hold a register than to drop it. */
export function isRetryable(err: unknown): boolean {
  return !(err instanceof WriteError) || err.retryable;
}

const KEY = "figbloom.queue.v1";

/**
 * The natural key each queued table upserts on. Replaying a write without it
 * makes Postgres treat the rows as new inserts, so a register or a marks
 * draft that was already partly saved fails on the unique constraint and the
 * queue stalls behind it forever. Tables that only ever insert fresh rows
 * (announcements, vehicle_locations) have no entry.
 */
export const QUEUE_CONFLICT_KEYS: Readonly<Record<string, string>> = {
  attendance: "student_id,taken_on",
  marks: "exam_id,student_id,subject_id",
  cbe_results: "assessment_id,student_id,strand_id",
  cbe_assessment_comments: "assessment_id,student_id",
};

export const conflictKeyFor = (table: string): string | undefined => QUEUE_CONFLICT_KEYS[table];

export class WriteQueue {
  /** undefined: not scoped to anyone (everything is visible). null: nobody is signed in. */
  private user: string | null | undefined = undefined;
  /** Serialises every read-modify-write of the stored list, so two of them can't overwrite each other. */
  private lock: Promise<unknown> = Promise.resolve();
  private draining: Promise<{ sent: number; remaining: number }> | null = null;

  constructor(
    private store: KeyValueStore,
    private flushFn: (w: QueuedWrite) => Promise<void>,
  ) {}

  /**
   * Scopes the queue to the signed-in user: it only sends and shows that
   * user's writes, so a second teacher on the same device never sends (or
   * sees) the first one's register.
   */
  setUser(userId: string | null): void {
    this.user = userId;
  }

  private mine(all: QueuedWrite[]): QueuedWrite[] {
    if (this.user === undefined) return all;
    const me = this.user;
    return all.filter((w) => !w.userId || w.userId === me);
  }

  private async readAll(): Promise<QueuedWrite[]> {
    const raw = await this.store.getItem(KEY);
    if (!raw) return [];
    try { return JSON.parse(raw) as QueuedWrite[]; } catch { return []; }
  }

  private async writeAll(q: QueuedWrite[]): Promise<void> {
    await this.store.setItem(KEY, JSON.stringify(q));
  }

  /** Re-reads the stored list inside the lock, so anything queued while a send was in flight is kept. */
  private change(fn: (all: QueuedWrite[]) => QueuedWrite[]): Promise<void> {
    const run = this.lock.then(async () => { await this.writeAll(fn(await this.readAll())); });
    this.lock = run.catch(() => undefined);
    return run;
  }

  async enqueue(table: string, rows: unknown[]): Promise<QueuedWrite> {
    const item: QueuedWrite = {
      id: `${table}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      table, rows, queuedAt: new Date().toISOString(), attempts: 0,
      ...(typeof this.user === "string" ? { userId: this.user } : {}),
    };
    await this.change((all) => [...all, item]);
    return item;
  }

  /** Writes still waiting to go out. */
  async pending(): Promise<QueuedWrite[]> {
    return this.mine(await this.readAll()).filter((w) => !w.rejected);
  }

  async pendingFor(table: string): Promise<QueuedWrite[]> {
    return (await this.pending()).filter((w) => w.table === table);
  }

  /** Writes the server refused for good, so they can be shown rather than silently kept or lost. */
  async rejected(): Promise<QueuedWrite[]> {
    return this.mine(await this.readAll()).filter((w) => w.rejected);
  }

  /** Throws a refused write away, once someone has seen why. */
  async discard(id: string): Promise<void> {
    await this.change((all) => all.filter((w) => w.id !== id));
  }

  private update(id: string, patch: (w: QueuedWrite) => QueuedWrite): Promise<void> {
    return this.change((all) => all.map((w) => (w.id === id ? patch(w) : w)));
  }

  /**
   * Sends what is waiting, oldest first. A failure that waiting could fix (no
   * signal, a server error) stops the run so writes stay in order and retry
   * later; a write the server refuses is set aside so it can't hold up the
   * ones behind it. Only one run happens at a time: a second call shares it.
   */
  flush(): Promise<{ sent: number; remaining: number }> {
    if (!this.draining) {
      this.draining = this.drain().finally(() => { this.draining = null; });
    }
    return this.draining;
  }

  private async drain(): Promise<{ sent: number; remaining: number }> {
    let sent = 0;
    for (;;) {
      const next = (await this.pending())[0];
      if (!next) break;
      try {
        await this.flushFn(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isRetryable(err)) {
          await this.update(next.id, (w) => ({ ...w, attempts: w.attempts + 1, lastError: message }));
          break;
        }
        await this.update(next.id, (w) => ({
          ...w, attempts: w.attempts + 1, lastError: message, rejected: { at: new Date().toISOString(), message },
        }));
        continue;
      }
      await this.change((all) => all.filter((w) => w.id !== next.id));
      sent += 1;
    }
    return { sent, remaining: (await this.pending()).length };
  }
}

/** Copy for the sync banner. Never says "failed" while a retry is still coming. */
export function syncLabel(pending: number, online: boolean, rejected = 0): string | null {
  const parts: string[] = [];
  if (pending > 0) {
    parts.push(online ? `Sending ${pending}…` : `${pending} saved on this phone. They will send when you have network.`);
  }
  if (rejected > 0) {
    parts.push(`${rejected} could not be sent and need${rejected === 1 ? "s" : ""} your attention.`);
  }
  return parts.length ? parts.join(" ") : null;
}
