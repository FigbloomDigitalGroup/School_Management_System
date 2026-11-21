/**
 * A stand-in for the Supabase client, for data-access module tests: tables in memory, `eq` and `in` filters, `order` and
 * `range` really applied, a 1,000-row cap per request like PostgREST's (so paging is tested for real), and inserts,
 * updates, deletes and RPC calls recorded.
 *
 * How to wire it into a test file: see `fakeSupabase` at the bottom.
 */
export type Row = Record<string, unknown>;

export const MAX_ROWS = 1000;

export interface FakeSupabase {
  /** Rows per table. */
  tables: Record<string, Row[]>;
  /** A table whose every request fails with this message. */
  error: Record<string, string>;
  /** What the next RPC answers. */
  rpc: { data: unknown; error: string | null };
  /** Answer an insert with `.select().single()` using this row. */
  inserted: Record<string, Row>;
  calls: {
    inserts: { table: string; row: Row }[];
    updates: { table: string; patch: Row; filters: [string, unknown][] }[];
    deletes: { table: string; filters: [string, unknown][] }[];
    rpc: { name: string; args: Row }[];
  };
  client: { from(table: string): unknown; rpc(name: string, args: Row): Promise<unknown> };
  reset(): void;
}

export function createFakeSupabase(): FakeSupabase {
  const fake: FakeSupabase = {
    tables: {}, error: {}, rpc: { data: null, error: null }, inserted: {},
    calls: { inserts: [], updates: [], deletes: [], rpc: [] },
    client: {
      from: (table: string) => builder(table),
      rpc: (name: string, args: Row) => {
        fake.calls.rpc.push({ name, args });
        return Promise.resolve(fake.rpc.error ? { data: null, error: { message: fake.rpc.error } } : { data: fake.rpc.data, error: null });
      },
    },
    reset() {
      fake.tables = {}; fake.error = {}; fake.rpc = { data: null, error: null }; fake.inserted = {};
      fake.calls.inserts.length = 0; fake.calls.updates.length = 0; fake.calls.deletes.length = 0; fake.calls.rpc.length = 0;
    },
  };

  function builder(table: string) {
    const filters: [string, unknown][] = [];
    const inFilters: [string, unknown[]][] = [];
    const sorts: string[] = [];
    let window: [number, number] | null = null;
    let op: { kind: "select" } | { kind: "insert"; row: Row } | { kind: "update"; patch: Row } | { kind: "delete" } = { kind: "select" };
    const rows = () => {
      let out = (fake.tables[table] ?? []).filter((r) => filters.every(([c, v]) => r[c] === v) && inFilters.every(([c, vs]) => vs.includes(r[c])));
      if (sorts.length) out = [...out].sort((a, b) => { for (const c of sorts) { const d = String(a[c]).localeCompare(String(b[c])); if (d) return d; } return 0; });
      if (window) out = out.slice(window[0], window[1] + 1);
      return out.slice(0, MAX_ROWS);
    };
    const settle = () => {
      if (fake.error[table]) return { data: null, error: { message: fake.error[table] } };
      if (op.kind === "insert") { fake.calls.inserts.push({ table, row: op.row }); return { data: [fake.inserted[table] ?? {}], error: null }; }
      if (op.kind === "update") { fake.calls.updates.push({ table, patch: op.patch, filters: [...filters] }); return { data: null, error: null }; }
      if (op.kind === "delete") { fake.calls.deletes.push({ table, filters: [...filters] }); return { data: null, error: null }; }
      return { data: rows(), error: null };
    };
    const first = () => {
      const a = settle();
      return Promise.resolve(a.error ? a : { data: (a.data as Row[] | null)?.[0] ?? null, error: null });
    };
    const proxy: unknown = new Proxy({}, {
      get(_t, method: string) {
        if (method === "then") return (resolve: (v: unknown) => unknown) => resolve(settle());
        if (method === "maybeSingle" || method === "single") return first;
        return (...args: unknown[]) => {
          if (method === "eq") filters.push([String(args[0]), args[1]]);
          if (method === "in") inFilters.push([String(args[0]), args[1] as unknown[]]);
          if (method === "order") sorts.push(String(args[0]));
          if (method === "range") window = [Number(args[0]), Number(args[1])];
          if (method === "insert") op = { kind: "insert", row: args[0] as Row };
          if (method === "update") op = { kind: "update", patch: args[0] as Row };
          if (method === "delete") op = { kind: "delete" };
          return proxy;
        };
      },
    });
    return proxy;
  }

  return fake;
}

/**
 * One fake per test file (vitest isolates files). Wire it up with:
 *   vi.mock("./supabase", async () => {
 *     const { fakeSupabase } = await import("./testing/fakeSupabase");
 *     return { supabase: () => fakeSupabase.client };
 *   });
 * and import `fakeSupabase` normally to set tables and read calls; both see the same instance.
 */
export const fakeSupabase = createFakeSupabase();
