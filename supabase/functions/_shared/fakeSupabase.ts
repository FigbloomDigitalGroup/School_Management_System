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
  /** Rows from..to inclusive, as PostgREST pages them (insertion order stands in for .order()). */
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.limitN = to - from + 1;
    return this;
  }
  private rangeFrom = 0;
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
    const from = rows.slice(this.rangeFrom);
    return { rows: this.limitN !== null ? from.slice(0, this.limitN) : from, error: null };
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
    if (name.startsWith("platform_") && name in this.platformRpcs) {
      try {
        return Promise.resolve({ data: this.platformRpcs[name](args), error: null });
      } catch (err) {
        return Promise.resolve({ data: null, error: { message: err instanceof Error ? err.message : String(err) } });
      }
    }
    if (name === "platform_console_schools") {
      return Promise.resolve({ data: this.platformSchools(args.p_school_id ?? null), error: null });
    }
    if (name === "platform_console_set_school_status") {
      return Promise.resolve({ data: this.platformSetSchoolStatus(args), error: null });
    }
    const answer = this.rpcAnswers[name];
    if (answer) return Promise.resolve({ data: answer(args), error: null });
    return Promise.resolve({ data: null, error: { message: `rpc ${name} is not configured in the fake` } });
  }

  /** A test's own stand-in for a database function this fake doesn't model. */
  rpcAnswers: Record<string, (args: Row) => unknown> = {};

  // ------------------------------------------------------------ platform registration (20261104900000)
  /** platform_settings 'PLATFORM_DECISIONS_ENABLED'. */
  platformDecisionsEnabled = false;
  /** The database's clock, for the queue's due times and leases. */
  clock: () => number = () => Date.now();
  private queueSeq = 0;

  private iso(ms = this.clock()) { return new Date(ms).toISOString(); }

  private platformLink(kind: string, localId: string, platformId: string | null) {
    const links = this.table("platform_links");
    const existing = links.rows.find((l) => l.kind === kind && l.local_id === localId);
    if (existing) { existing.platform_id = platformId ?? existing.platform_id; existing.registered_at = this.iso(); }
    else links.rows.push({ kind, local_id: localId, platform_id: platformId, registered_at: this.iso() });
  }

  /** The SQL functions of 20261104900000_platform_registration.sql, for the fake. */
  platformRpcs: Record<string, (args: Row) => unknown> = {
    platform_decisions_enabled: () => this.platformDecisionsEnabled,

    platform_sync_enqueue: ({ p_kind, p_local_id }) => {
      const q = this.table("platform_sync_queue");
      if (q.rows.some((r) => r.kind === p_kind && r.local_id === p_local_id && !r.done_at)) return null;
      q.rows.push({ id: ++this.queueSeq, kind: p_kind, local_id: p_local_id, enqueued_at: this.iso(), attempts: 0,
        next_attempt_at: this.iso(), locked_until: null, last_error: null, done_at: null });
      return null;
    },

    platform_sync_claim: ({ p_limit }) => {
      const now = this.clock();
      const due = this.rowsIn("platform_sync_queue")
        .filter((r) => !r.done_at && Date.parse(r.next_attempt_at) <= now && (!r.locked_until || Date.parse(r.locked_until) < now))
        .sort((a, b) => Number(b.kind === "organization") - Number(a.kind === "organization") || a.id - b.id)
        .slice(0, Math.max(0, Number(p_limit ?? 50)));
      for (const r of due) { r.locked_until = this.iso(now + 5 * 60_000); r.attempts += 1; }
      return due.map((r) => ({ ...r }));
    },

    platform_sync_done: ({ p_id, p_platform_id }) => {
      const r = this.rowsIn("platform_sync_queue").find((x) => x.id === p_id && !x.done_at);
      if (!r) return null;
      Object.assign(r, { done_at: this.iso(), locked_until: null, last_error: null });
      this.platformLink(r.kind, r.local_id, p_platform_id ?? null);
      return null;
    },

    platform_sync_failed: ({ p_id, p_error, p_retry_in_seconds }) => {
      const r = this.rowsIn("platform_sync_queue").find((x) => x.id === p_id && !x.done_at);
      if (!r) return null;
      const secs = p_retry_in_seconds ?? Math.min(3600, 60 * 2 ** Math.max(r.attempts - 1, 0));
      Object.assign(r, { locked_until: null, last_error: String(p_error).slice(0, 500), next_attempt_at: this.iso(this.clock() + secs * 1000) });
      return null;
    },

    platform_sync_mark_sent: ({ p_kind, p_local_id, p_since, p_platform_id }) => {
      for (const r of this.rowsIn("platform_sync_queue")) {
        if (r.kind === p_kind && r.local_id === p_local_id && !r.done_at && Date.parse(r.enqueued_at) <= Date.parse(p_since)) {
          Object.assign(r, { done_at: this.iso(), locked_until: null, last_error: null });
        }
      }
      this.platformLink(p_kind, p_local_id, p_platform_id ?? null);
      return null;
    },

    platform_create_school_organization: ({ p_tenant_id }) => {
      const t = this.rowsIn("tenants").find((x) => x.id === p_tenant_id);
      if (!t) throw new Error(`no school ${p_tenant_id}`);
      if (t.organization_id) return t.organization_id;
      const taken = (slug: string) => this.rowsIn("organizations").some((o) => o.slug === slug);
      let slug = t.slug;
      for (let n = 1; taken(slug); n++) slug = `${String(t.slug).slice(0, 28).replace(/-+$/, "")}-school${n === 1 ? "" : `-${n}`}`;
      const admin = this.rowsIn("profiles")
        .filter((p) => p.tenant_id === t.id && p.role === "school_admin")
        .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id).localeCompare(String(b.id)))
        .map((p) => (String(p.email ?? "").trim() || this.authUsers.get(p.id)?.email) as string | undefined)
        .find((e) => e && !e.endsWith(".figbloom.internal"));
      const id = crypto.randomUUID();
      this.table("organizations").rows.push({ id, name: t.name, slug, kind: "group_owner", county: t.county ?? null,
        contact_email: admin ?? null, status: "active", created_at: this.iso() });
      this.platformRpcs.platform_sync_enqueue({ p_kind: "organization", p_local_id: id });     // the insert trigger
      t.organization_id = id;
      this.platformRpcs.platform_sync_enqueue({ p_kind: "tenant", p_local_id: t.id });         // the update trigger
      return id;
    },

    platform_apply_organization_decision: (a) => {
      const deliveries = this.table("platform_webhook_deliveries");
      const note = (outcome: string) => {
        const d = deliveries.rows.find((x) => x.delivery_id === a.p_delivery_id);
        if (d) d.outcome = outcome;
      };
      if (a.p_delivery_id) {
        if (deliveries.rows.some((d) => d.delivery_id === a.p_delivery_id)) return { outcome: "duplicate" };
        deliveries.rows.push({ delivery_id: a.p_delivery_id, organization_id: a.p_organization_id, outcome: "received", received_at: this.iso() });
      }
      if (!["pending", "active", "suspended", "rejected"].includes(a.p_status)) { note("invalid"); return { outcome: "invalid" }; }
      const o = this.rowsIn("organizations").find((x) => x.id === a.p_organization_id);
      if (!o) { note("not_found"); return { outcome: "not_found" }; }
      const decisions = this.table("platform_organization_decisions");
      let d = decisions.rows.find((x) => x.organization_id === o.id);
      if (d?.decided_at && a.p_decided_at && Date.parse(a.p_decided_at) < Date.parse(d.decided_at)) { note("stale"); return { outcome: "stale", status: o.status }; }
      const reason = (String(a.p_reason ?? "").trim() || null)?.slice(0, 500) ?? null;
      const by = (String(a.p_decided_by ?? "").trim() || "platform").slice(0, 200);
      if (!d) { d = { organization_id: o.id }; decisions.rows.push(d); }
      Object.assign(d, { status: a.p_status, status_reason: reason, decided_at: a.p_decided_at ?? d.decided_at ?? null,
        applied_at: this.iso(), last_checked_at: this.iso(), needs_check: false });
      if (o.status === a.p_status) { note("unchanged"); return { outcome: "unchanged", status: o.status }; }
      const from = o.status;
      o.status = a.p_status;
      const changes = { status: { from, to: a.p_status } };
      const verb = a.p_status === "active" ? (from === "pending" ? "approved" : "reactivated")
        : a.p_status === "suspended" ? "suspended" : a.p_status === "rejected" ? "not approved" : "set to pending";
      for (const t of this.rowsIn("tenants").filter((x) => x.organization_id === o.id)) {
        this.table("audit_events").insert({ tenant_id: t.id, actor_id: null, actor_label: "Figbloom (via Figbloom platform)",
          event: `Organization "${o.name}" ${verb} by Figbloom${reason ? `: ${reason}` : ""}`, category: "access",
          metadata: { table: "organizations", op: "update", via: "Figbloom platform", organization_id: o.id, reason, changes } });
      }
      this.table("audit_events").insert({ tenant_id: null, actor_id: null, actor_label: `${by} via Figbloom platform`,
        event: `Organization "${o.name}" ${verb} via Figbloom platform`, category: "access",
        metadata: { table: "organizations", op: "update", via: "Figbloom platform", organization_id: o.id, decided_by: by,
          decided_at: a.p_decided_at ?? null, delivery_id: a.p_delivery_id ?? null, source: a.p_source ?? "webhook", reason, changes } });
      note("applied");
      return { outcome: "applied", status: a.p_status, previous: from };
    },

    platform_note_unapplied_delivery: ({ p_delivery_id, p_organization_id }) => {
      const deliveries = this.table("platform_webhook_deliveries");
      if (!deliveries.rows.some((d) => d.delivery_id === p_delivery_id)) {
        deliveries.rows.push({ delivery_id: p_delivery_id, organization_id: p_organization_id, outcome: "not_enabled", received_at: this.iso() });
      }
      const o = this.rowsIn("organizations").find((x) => x.id === p_organization_id);
      if (o) {
        const decisions = this.table("platform_organization_decisions");
        const d = decisions.rows.find((x) => x.organization_id === o.id);
        if (d) d.needs_check = true;
        else decisions.rows.push({ organization_id: o.id, status: o.status, needs_check: true, last_checked_at: null });
      }
      return { outcome: "not_enabled" };
    },

    platform_reconcile_candidates: ({ p_limit }) => {
      const decisions = this.rowsIn("platform_organization_decisions");
      return this.rowsIn("organizations")
        .filter((o) => this.rowsIn("platform_links").some((l) => l.kind === "organization" && l.local_id === o.id))
        .map((o) => ({ o, d: decisions.find((x) => x.organization_id === o.id) }))
        .sort((x, y) => Number(!!y.d?.needs_check) - Number(!!x.d?.needs_check)
          || (x.d?.last_checked_at ? Date.parse(x.d.last_checked_at) : -Infinity) - (y.d?.last_checked_at ? Date.parse(y.d.last_checked_at) : -Infinity))
        .slice(0, Math.max(0, Number(p_limit ?? 50)))
        .map(({ o }) => ({ organization_id: o.id, status: o.status }));
    },

    platform_mark_checked: ({ p_organization_id }) => {
      const o = this.rowsIn("organizations").find((x) => x.id === p_organization_id);
      if (!o) return null;
      const decisions = this.table("platform_organization_decisions");
      const d = decisions.rows.find((x) => x.organization_id === o.id);
      if (d) Object.assign(d, { last_checked_at: this.iso(), needs_check: false });
      else decisions.rows.push({ organization_id: o.id, status: o.status, last_checked_at: this.iso(), needs_check: false });
      return null;
    },
  };

  /**
   * platform_console_schools() (20261104600000_platform_console_schools.sql):
   * one row per school, ordered by name. Emails and last sign-ins come from
   * authUsers (auth.users), keyed by profile id.
   */
  private platformSchools(schoolId: string | null): Row[] {
    const iso = (v: unknown) => (v ? new Date(String(v)).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
    return this.rowsIn("tenants")
      .filter((t) => schoolId === null || t.id === schoolId)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)))
      .map((t) => {
        const people = this.rowsIn("profiles").filter((p) => p.tenant_id === t.id);
        const signIns = people.map((p) => this.authUsers.get(p.id)?.last_sign_in_at).filter(Boolean).map((v) => String(v)).sort();
        const admin = people
          .filter((p) => p.role === "school_admin")
          .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || String(a.id).localeCompare(String(b.id)))
          .map((p) => (String(p.email ?? "").trim() || this.authUsers.get(p.id)?.email) as string | undefined)
          .find((e) => e && !e.endsWith(".figbloom.internal"));
        const org = this.rowsIn("organizations").find((o) => o.id === t.organization_id);
        return {
          id: t.id, name: t.name, slug: t.slug, status: t.status, status_reason: t.status_reason ?? null,
          organization: org ? { id: org.id, name: org.name } : null,
          created_at: iso(t.created_at),
          admin_email: admin ?? null,
          students: this.rowsIn("students").filter((s) => s.tenant_id === t.id && s.active !== false).length,
          teachers: people.filter((p) => p.role === "teacher").length,
          parents: people.filter((p) => p.role === "parent").length,
          last_activity_at: iso(signIns.at(-1)),
        };
      });
  }

  /** platform_console_set_school_status(), same file: the tenants update and its own audit event. */
  private platformSetSchoolStatus(args: Row): Row {
    const reason = String(args.p_reason ?? "").trim() || null;
    const actor = String(args.p_actor_email ?? "").trim();
    const status = args.p_status;
    if (status !== "active" && status !== "suspended") return { outcome: "not_settable" };
    const t = this.rowsIn("tenants").find((r) => r.id === args.p_school_id);
    if (!t) return { outcome: "not_found" };
    if (status === "suspended" && t.status === "suspended") return { outcome: "already" };
    if (status === "active" && t.status !== "suspended") return { outcome: "not_suspended" };
    // 20261104800000: only a working school is the console's to suspend
    if (status === "suspended" && !["active", "trial", "overdue"].includes(t.status)) return { outcome: "not_settable" };
    const from = t.status;
    // tenants_status_bookkeeping: remember the status on the way in, restore and forget it on the way out
    const to = status === "suspended" ? "suspended" : (t.status_before_suspension ?? "active");
    this.table("tenants").update({
      status: to, status_reason: reason, status_before_suspension: to === "suspended" ? from : null,
    }, (r) => r.id === t.id);
    const changes = { status: { from, to } };
    // what the school reads: no staff member's address
    this.table("audit_events").insert({
      tenant_id: t.id, actor_id: null, actor_label: "Figbloom (via Figbloom console)",
      event: `${status === "suspended" ? "School suspended by Figbloom" : "School reactivated by Figbloom"}${reason ? `: ${reason}` : ""}`,
      category: "access",
      metadata: { table: "tenants", op: "update", via: "Figbloom console", reason, changes },
    });
    // what only Figbloom staff read (no school)
    this.table("audit_events").insert({
      tenant_id: null, actor_id: null, actor_label: `${actor} via Figbloom console`,
      event: `${status === "suspended" ? "Suspended" : "Reactivated"} "${t.name}" via Figbloom console`,
      category: "access",
      metadata: { table: "tenants", op: "update", via: "Figbloom console", school_id: t.id, actor_email: actor, reason, changes },
    });
    return { outcome: "ok", school: this.platformSchools(t.id)[0] };
  }

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
