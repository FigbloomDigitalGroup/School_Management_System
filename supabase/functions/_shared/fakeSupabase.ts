/**
 * A minimal in-memory stand-in for @supabase/supabase-js, used only in tests.
 * Supports the slice of the query-builder and auth APIs the edge functions
 * actually call: .from(table).select/insert/update, .eq/.gte, .single/
 * .maybeSingle, and auth.getUser / auth.admin.createUser / deleteUser.
 *
 * Not published (the "_shared" prefix keeps the Supabase CLI from deploying
 * it as its own function).
 */

// deno-lint-ignore no-explicit-any
export type Row = Record<string, any>;

type Filter = { col: string; op: "eq" | "gte"; val: unknown };

class FakeTable {
  rows: Row[];
  /** One-shot error for the next insert/update, set by `failNext`. */
  private pendingError: string | null = null;

  constructor(rows: Row[] = []) {
    this.rows = rows.map((r) => ({ ...r }));
  }

  failNext(message: string) {
    this.pendingError = message;
  }

  consumeError(): string | null {
    const err = this.pendingError;
    this.pendingError = null;
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
}

class FakeBuilder implements PromiseLike<{ data: Row[] | null; error: { message: string } | null }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | null = null;
  private payload?: Row;

  constructor(private table: FakeTable) {}

  select(_cols?: string) {
    if (!this.op) this.op = "select";
    return this;
  }
  insert(payload: Row) {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: Row) {
    this.op = "update";
    this.payload = payload;
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

  private matches(row: Row): boolean {
    return this.filters.every((f) =>
      f.op === "eq" ? row[f.col] === f.val : (row[f.col] as never) >= (f.val as never)
    );
  }

  private run(): { rows: Row[]; error: { message: string } | null } {
    if (this.op === "insert" || this.op === "update") {
      const err = this.table.consumeError();
      if (err) return { rows: [], error: { message: err } };
    }
    if (this.op === "insert") return { rows: [this.table.insert(this.payload!)], error: null };
    if (this.op === "update") {
      return { rows: this.table.update(this.payload!, (r) => this.matches(r)), error: null };
    }
    return { rows: this.table.rows.filter((r) => this.matches(r)).map((r) => ({ ...r })), error: null };
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

  /** Makes the next insert/update against `table` resolve with this error. */
  failNextWrite(table: string, message: string) {
    this.table(table).failNext(message);
  }

  from(table: string) {
    return new FakeBuilder(this.table(table));
  }
}
