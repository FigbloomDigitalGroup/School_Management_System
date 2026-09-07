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
}

const KEY = "figbloom.queue.v1";

export class WriteQueue {
  constructor(
    private store: KeyValueStore,
    private flushFn: (w: QueuedWrite) => Promise<void>,
  ) {}

  private async read(): Promise<QueuedWrite[]> {
    const raw = await this.store.getItem(KEY);
    if (!raw) return [];
    try { return JSON.parse(raw) as QueuedWrite[]; } catch { return []; }
  }

  private async write(q: QueuedWrite[]): Promise<void> {
    await this.store.setItem(KEY, JSON.stringify(q));
  }

  async enqueue(table: string, rows: unknown[]): Promise<QueuedWrite> {
    const item: QueuedWrite = {
      id: `${table}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      table, rows, queuedAt: new Date().toISOString(), attempts: 0,
    };
    await this.write([...(await this.read()), item]);
    return item;
  }

  async pending(): Promise<QueuedWrite[]> { return this.read(); }

  async pendingFor(table: string): Promise<QueuedWrite[]> {
    return (await this.read()).filter((w) => w.table === table);
  }

  /** Drains in order. Stops at the first failure so writes stay sequential. */
  async flush(): Promise<{ sent: number; remaining: number }> {
    const queue = await this.read();
    let sent = 0;
    while (queue.length) {
      const head = queue[0]!;
      try {
        await this.flushFn(head);
        queue.shift();
        sent += 1;
      } catch (err) {
        head.attempts += 1;
        head.lastError = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    await this.write(queue);
    return { sent, remaining: queue.length };
  }
}

/** Copy for the sync banner. Never says "failed" while a retry is still coming. */
export function syncLabel(pending: number, online: boolean): string | null {
  if (pending === 0) return null;
  if (!online) return `${pending} saved on this phone. They will send when you have network.`;
  return `Sending ${pending}…`;
}
