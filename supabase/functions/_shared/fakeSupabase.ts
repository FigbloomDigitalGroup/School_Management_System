/**
 * A minimal in-memory stand-in for @supabase/supabase-js, used only in tests.
 * Supports the slice of the query-builder and auth APIs the edge functions
 * actually call: .from(table).select/insert/update/delete, .eq/.gte/.in/.ilike,
 * .single/.maybeSingle, and auth.getUser / auth.admin.createUser / deleteUser.
 *
 * Not published (the "_shared" prefix keeps the Supabase CLI from deploying
 * it as its own function).
 */

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

type Filter = { col: string; op: "eq" | "gte" | "in" | "ilike"; val: unknown };

/** Turns a SQL LIKE/ILIKE pattern (%, _, backslash-escaped literals) into a
 *  case-insensitive RegExp -- just enough for search-schools' `%query%`
 *  usage, not a full LIKE implementation. */
function ilikeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) { out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") { out += ".*"; continue; }
    if (c === "_") { out += "."; continue; }
    out += c!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

type OpKind = "select" | "insert" | "update" | "delete";

class FakeTable {
  rows: Row[];
  /** One-shot errors, set by failNextRead/failNextWrite — scoped by op kind so
   *  failing an insert doesn't also fail an earlier select on the same table. */
  private pendingReadError: string | null = null;
  private pendingWriteError: string | null = null;

  constructor(rows: Row[] = []) {
    this.rows = rows.map((r) => ({ ...r }));
  }

  failNextRead(message: string) {
    this.pendingReadError = message;
  }

  failNextWrite(message: string) {
    this.pendingWriteError = message;
  }

  consumeError(op: OpKind): string | null {
    if (op === "select") {
      const err = this.pendingReadError;
      this.pendingReadError = null;
      return err;
    }
    const err = this.pendingWriteError;
    this.pendingWriteError = null;
    return err;
  }

  insert(payload: Row): Row {
    const row = { id: payload.id ?? crypto.randomUUID(), ...payload };
    this.rows.push(row);
    return { ...row };
  }
  update(payload: Row, matches: (r: Row) => boolean): Row[] {
    const updated: Row[] = [];
    this.rows = this.rows.map((r) => {
      if (!matches(r)) return r;
      const next = { ...r, ...payload };
      updated.push({ ...next });
      return next;
    });
    return updated;
  }
  delete(matches: (r: Row) => boolean): Row[] {
    const deleted = this.rows.filter(matches);
    this.rows = this.rows.filter((r) => !matches(r));
    return deleted.map((r) => ({ ...r }));
  }
}

class FakeBuilder implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private filters: Filter[] = [];
  private op: OpKind | null = null;
  private payload?: Row | Row[];
  private limitN: number | null = null;

  constructor(private table: FakeTable) {}

  // _cols is intentionally unused -- the fake always returns the full row
  // regardless of the column list. Real supabase-js's embedded-relation
  // select syntax ("classes(form_level)") makes column projection genuinely
  // hard to replicate correctly here; the real Postgres API is what
  // actually enforces "only these columns come back", not this fake.
  select(_cols?: string) {
    if (!this.op) this.op = "select";
    return this;
  }
  insert(payload: Row | Row[]) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push({ col, op: "eq", val });
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push({ col, op: "gte", val });
    return this;
  }
  in(col: string, vals: unknown[]) {
    this.filters.push({ col, op: "in", val: vals });
    return this;
  }
  ilike(col: string, pattern: string) {
    this.filters.push({ col, op: "ilike", val: pattern });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  /** No-op, same as supabase-js .order(col) — insertion order is fine for tests. */
  order(_col: string) {
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      if (f.op === "eq") return row[f.col] === f.val;
      if (f.op === "in") return (f.val as unknown[]).includes(row[f.col]);
      if (f.op === "ilike") return ilikeToRegExp(f.val as string).test(String(row[f.col] ?? ""));
      return (row[f.col] as never) >= (f.val as never);
    });
  }

  private run(): { rows: Row[]; error: { message: string } | null } {
    const err = this.table.consumeError(this.op ?? "select");
    if (err) return { rows: [], error: { message: err } };
    if (this.op === "insert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload!];
      return { rows: payloads.map((p) => this.table.insert(p)), error: null };
    }
    if (this.op === "update") {
      return { rows: this.table.update(this.payload as Row, (r) => this.matches(r)), error: null };
    }
    if (this.op === "delete") {
      return { rows: this.table.delete((r) => this.matches(r)), error: null };
    }
    const rows = this.table.rows.filter((r) => this.matches(r)).map((r) => ({ ...r }));
    return { rows: this.limitN !== null ? rows.slice(0, this.limitN) : rows, error: null };
  }

  async maybeSingle() {
    const { rows, error } = this.run();
    if (error) return { data: null, error };
    return { data: rows[0] ?? null, error: null };
  }

  async single() {
    const { rows, error } = this.run();
    if (error) return { data: null, error };
    if (!rows[0]) return { data: null, error: { message: "Row not found" } };
    return { data: rows[0], error: null };
  }

  // Query builders in supabase-js are themselves thenable, so `await
  // client.from(t).update(x).eq(...)` resolves without an explicit .single().
  then<TResult1, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    const { rows, error } = this.run();
    return Promise.resolve({ data: error ? null : rows, error }).then(onfulfilled, onrejected);
  }
}

export class FakeSupabaseClient {
  private tables = new Map<string, FakeTable>();
  authUser: Row | null = null;
  onCreateUser: (attrs: Row) => { data: { user: Row | null }; error: { message: string } | null } = () => ({
    data: { user: null },
    error: { message: "onCreateUser not configured" },
  });
  deletedUserIds: string[] = [];

  auth = {
    getUser: async () => ({ data: { user: this.authUser } }),
    admin: {
      createUser: async (attrs: Row) => this.onCreateUser(attrs),
      deleteUser: async (id: string) => {
        this.deletedUserIds.push(id);
        return { error: null };
      },
    },
  };

  seed(table: string, rows: Row[]) {
    this.tables.set(table, new FakeTable(rows));
  }

  rowsIn(table: string): Row[] {
    return this.tables.get(table)?.rows ?? [];
  }

  private table(table: string): FakeTable {
    if (!this.tables.has(table)) this.tables.set(table, new FakeTable());
    return this.tables.get(table)!;
  }

  /** Makes the next select against `table` resolve with this error. */
  failNextRead(table: string, message: string) {
    this.table(table).failNextRead(message);
  }

  /** Makes the next insert/update against `table` resolve with this error. */
  failNextWrite(table: string, message: string) {
    this.table(table).failNextWrite(message);
  }

  from(table: string) {
    return new FakeBuilder(this.table(table));
  }
}
