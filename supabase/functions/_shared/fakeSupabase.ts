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

type Filter = { col: string; op: "eq" | "gte" | "in" | "ilike" | "is"; val: unknown };

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

type UniqueIndex = { cols: string[]; where?: (row: Row) => boolean };
type FakeError = { message: string; code?: string };

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

  /** Unique indexes, set with FakeSupabaseClient.uniqueIndex (a partial one has `where`). */
  uniques: UniqueIndex[] = [];

  /** Returns null when a unique index refuses the row, as Postgres would with 23505. */
  insert(payload: Row): Row | null {
    // created_at as the column default would set it
    const row: Row = { id: payload.id ?? crypto.randomUUID(), created_at: new Date().toISOString(), ...payload };
    for (const u of this.uniques) {
      if (u.where && !u.where(row)) continue;
      if (this.rows.some((r) => (!u.where || u.where(r)) && u.cols.every((c) => r[c] === row[c]))) return null;
    }
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
  private wantCount = false;

  constructor(private table: FakeTable) {}

  // _cols is intentionally unused -- the fake always returns the full row
  // regardless of the column list. Real supabase-js's embedded-relation
  // select syntax ("classes(form_level)") makes column projection genuinely
  // hard to replicate correctly here; the real Postgres API is what
  // actually enforces "only these columns come back", not this fake.
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (!this.op) this.op = "select";
    if (opts?.count) this.wantCount = true;
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
  /** Only `.is(col, null)` is used: a missing column counts as null, as it would in Postgres. */
  is(col: string, val: null) {
    this.filters.push({ col, op: "is", val });
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
      if (f.op === "is") return (row[f.col] ?? null) === f.val;
      if (f.op === "ilike") return ilikeToRegExp(f.val as string).test(String(row[f.col] ?? ""));
      return (row[f.col] as never) >= (f.val as never);
    });
  }

  private run(): { rows: Row[]; error: FakeError | null } {
    const err = this.table.consumeError(this.op ?? "select");
    if (err) return { rows: [], error: { message: err } };
    if (this.op === "insert") {
      const payloads = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const inserted = payloads.map((p) => this.table.insert(p));
      if (inserted.some((r) => r === null)) {
        return { rows: [], error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      }
      return { rows: inserted as Row[], error: null };
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

  /** Like PostgREST: more than one row is an error, not the first row. */
  async maybeSingle() {
    const { rows, error } = this.run();
    if (error) return { data: null, error };
    if (rows.length > 1) {
      return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
    }
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
    const result = { data: error ? null : rows, error, ...(this.wantCount ? { count: error ? null : rows.length } : {}) };
    return Promise.resolve(result).then(onfulfilled, onrejected);
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
  /** Auth users getUserById can find (id -> user), and the ones generateLink creates. */
  authUsers = new Map<string, Row>();
  /** What auth.admin.generateLink answers; by default it creates an unconfirmed user with a link. */
  onGenerateLink: (params: Row) => { data: { user: Row | null; properties: Row | null }; error: { message: string } | null } = (params) => {
    const user = { id: crypto.randomUUID(), email: params.email, email_confirmed_at: null };
    this.authUsers.set(user.id, user);
    return { data: { user, properties: { action_link: `https://auth.example.test/verify?token=t-${user.id}` } }, error: null };
  };
  /** Every generateLink call, in order. */
  generatedLinks: Row[] = [];
  /** Every auth.admin.updateUserById call, in order. */
  updatedUsers: { id: string; attrs: Row }[] = [];
  /** Set to make the next updateUserById fail with this message. */
  failNextUserUpdate: string | null = null;

  auth = {
    getUser: async () => ({ data: { user: this.authUser } }),
    admin: {
      createUser: async (attrs: Row) => this.onCreateUser(attrs),
      updateUserById: async (id: string, attrs: Row) => {
        if (this.failNextUserUpdate) {
          const message = this.failNextUserUpdate;
          this.failNextUserUpdate = null;
          return { data: { user: null }, error: { message } };
        }
        this.updatedUsers.push({ id, attrs });
        return { data: { user: { id } }, error: null };
      },
      deleteUser: async (id: string) => {
        this.deletedUserIds.push(id);
        this.authUsers.delete(id);
        return { error: null };
      },
      generateLink: async (params: Row) => {
        this.generatedLinks.push(params);
        return this.onGenerateLink(params);
      },
      getUserById: async (id: string) => {
        const user = this.authUsers.get(id) ?? null;
        return { data: { user }, error: user ? null : { message: "User not found" } };
      },
    },
  };

  /** Storage objects, keyed "<bucket>/<path>". */
  files = new Map<string, Uint8Array<ArrayBuffer>>();

  storage = {
    from: (bucket: string) => ({
      download: async (path: string) => {
        const bytes = this.files.get(`${bucket}/${path}`);
        return bytes ? { data: new Blob([bytes]), error: null } : { data: null, error: { message: "Object not found" } };
      },
      remove: async (paths: string[]) => {
        for (const path of paths) this.files.delete(`${bucket}/${path}`);
        return { data: [], error: null };
      },
    }),
  };

  private uniques = new Map<string, UniqueIndex[]>();

  seed(table: string, rows: Row[]) {
    const t = new FakeTable(rows);
    t.uniques = this.uniques.get(table) ?? [];
    this.tables.set(table, t);
  }

  /** A unique index (partial, with `where`) that inserts into this table must respect. */
  uniqueIndex(table: string, cols: string[], where?: (row: Row) => boolean) {
    const list = this.uniques.get(table) ?? [];
    list.push({ cols, where });
    this.uniques.set(table, list);
    this.table(table).uniques = list;
  }

  rowsIn(table: string): Row[] {
    return this.tables.get(table)?.rows ?? [];
  }

  private table(table: string): FakeTable {
    if (!this.tables.has(table)) {
      const t = new FakeTable();
      t.uniques = this.uniques.get(table) ?? [];
      this.tables.set(table, t);
    }
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

  private pendingRpcError: string | null = null;

  /** What ai_tutor_blocked() answers: a reason, or null when the study helper is open. */
  tutorBlocked: string | null = null;

  /**
   * ai_helper_allowed() (20261101100000_ai_helper_optin.sql): the school's
   * switches, its access mode and the learner's opt-in (ai_helper_optins
   * rows, by student_id), then tutorBlocked.
   */
  private helperAllowed(profileId: string): { code: string; message: string } | null {
    const profile = this.rowsIn("profiles").find((p) => p.id === profileId);
    const t = this.rowsIn("tenants").find((r) => r.id === profile?.tenant_id);
    if (!t || !t.ai_enabled || !t.ai_tutor_enabled) return { code: "school_off", message: "Bloom isn't turned on for learners at your school." };
    if (t.ai_tutor_access === "opt_in") {
      const mine = this.rowsIn("students").filter((s) => s.profile_id === profileId && s.active !== false).map((s) => s.id);
      const current = this.rowsIn("terms").find((r) => r.tenant_id === t.id && r.is_current)?.id ?? null;
      const on = this.rowsIn("ai_helper_optins").some((o) => mine.includes(o.student_id) && o.status === "on"
        && (!t.ai_helper_billing_enabled || (o.term_id != null && o.term_id === current)));
      if (!on) return { code: "needs_optin", message: "Ask your parent or guardian to turn on the study helper for you (in their Figbloom app)." };
    }
    return this.tutorBlocked ? { code: "exam", message: this.tutorBlocked } : null;
  }

  /** Makes the next rpc() resolve with this error. */
  failNextRpc(message: string) {
    this.pendingRpcError = message;
  }

  /** Only the database functions the edge functions call; mirrors their SQL. */
  rpc(name: string, args: Row): Promise<{ data: unknown; error: { message: string } | null }> {
    if (this.pendingRpcError) {
      const message = this.pendingRpcError;
      this.pendingRpcError = null;
      return Promise.resolve({ data: null, error: { message } });
    }
    if (name === "next_login_number") {
      const numbers = this.rowsIn("profiles")
        .filter((r) => r.tenant_id === args.p_tenant_id && r.role === args.p_role)
        .map((r) => /(\d+)$/.exec(String(r.login_id ?? ""))?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number);
      return Promise.resolve({ data: Math.max(0, ...numbers) + 1, error: null });
    }
    if (name === "ai_month_tokens") {
      const used = this.rowsIn("ai_usage").filter((r) => r.tenant_id === args.p_tenant_id)
        // a web search counts as ai_tokens_per_search() tokens (20261029100000_bloom_web_search.sql)
        .reduce((n, r) => n + Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0) + Number(r.searches ?? 0) * 2500, 0);
      return Promise.resolve({ data: used, error: null });
    }
    if (name === "ai_tutor_blocked") return Promise.resolve({ data: this.tutorBlocked, error: null });
    if (name === "ai_helper_allowed") return Promise.resolve({ data: this.helperAllowed(String(args.p_profile_id)), error: null });
    if (name === "announcement_recipients") {
      const a = this.rowsIn("announcements").find((r) => r.id === args.p_announcement_id);
      const ids = a
        ? this.rowsIn("profiles").filter((p) => p.tenant_id === a.tenant_id && this.audienceReaches(a, p)).map((p) => p.id)
        : [];
      return Promise.resolve({ data: ids, error: null });
    }
    const answer = this.rpcAnswers[name];
    if (answer) return Promise.resolve({ data: answer(args), error: null });
    return Promise.resolve({ data: null, error: { message: `rpc ${name} is not configured in the fake` } });
  }

  /** A test's own stand-in for a database function this fake doesn't model. */
  rpcAnswers: Record<string, (args: Row) => unknown> = {};

  /** audience_reaches() in 20261026030000_announcement_audiences.sql, for the fake. */
  private audienceReaches(a: Row, p: Row): boolean {
    // deno-lint-ignore no-explicit-any
    const au = (a.audience ?? {}) as any;
    const role = String(p.role);
    switch (au.kind) {
      case "whole_school": return true;
      case "role": return au.role === role;
      case "roles": return Array.isArray(au.roles) && au.roles.includes(role);
      case "user": return au.user_id === p.id;
      case "people": return Array.isArray(au.profile_ids) && au.profile_ids.includes(p.id);
      case "class":
      case "form_level": break;
      default: return false;
    }
    const side = role === "parent" ? "guardians" : role === "student" ? "students" : null;
    const recipients = au.recipients ?? "both";
    if (!side || (recipients !== "both" && recipients !== side)) return false;
    return this.rowsIn("students").some((s) => {
      if (s.tenant_id !== a.tenant_id || s.active === false) return false;
      const mine = side === "students"
        ? s.profile_id === p.id
        : this.rowsIn("guardians").some((g) => g.student_id === s.id && g.profile_id === p.id);
      if (!mine) return false;
      if (au.kind === "class") return s.class_id === au.class_id;
      // deno-lint-ignore no-explicit-any
      const cls = (this.rowsIn("classes").find((c) => c.id === s.class_id) ?? s.classes ?? {}) as any;
      return cls.form_level === au.form_level && (!au.level || cls.level === au.level);
    });
  }

  from(table: string) {
    return new FakeBuilder(this.table(table));
  }
}
