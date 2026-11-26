import { supabase } from "./supabase";
import { fetchAllPages, pageError } from "./paging";
import {
  availableCount, INVENTORY_CATEGORY_LABEL, isOverdue, todayIso,
  type InventoryCategory, type InventoryIssue, type InventoryIssueRow, type InventoryItem, type InventoryItemRow, type InventorySummary,
} from "./inventory";
import { storeOf, type ConsumptionFlag, type FlagSeverity, type StoreKey } from "./inventoryStock";

/**
 * Server-side paging for the inventory screens. The register and the issue
 * lists used to load every row (thousands of issues with four joins each,
 * a page of 1000 at a time) before showing anything; these read one page with
 * its total, and the summary cards read only the columns they add up.
 */

export interface Page<T> { rows: T[]; total: number }

/** A search typed by a person, made safe for a PostgREST or=() filter: no commas, brackets, quotes or wildcards. */
export function searchTerm(query: string): string {
  return query.trim().replace(/[,()"*\\%:]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** The categories whose label matches the search ("uni" finds Uniforms). */
export function categoriesMatching(term: string): InventoryCategory[] {
  const t = term.toLowerCase();
  if (!t) return [];
  return (Object.keys(INVENTORY_CATEGORY_LABEL) as InventoryCategory[]).filter((c) => INVENTORY_CATEGORY_LABEL[c].toLowerCase().includes(t));
}

/** The or=() filter for the register search: name, tag, location, or a category whose label matches. */
export function registerFilter(query: string): string | null {
  const t = searchTerm(query);
  if (!t) return null;
  const like = `"*${t}*"`;
  const cats = categoriesMatching(t);
  return [`name.ilike.${like}`, `asset_tag.ilike.${like}`, `location.ilike.${like}`, ...(cats.length ? [`category.in.(${cats.join(",")})`] : [])].join(",");
}

async function outCounts(tenantId: string, itemIds: string[]): Promise<Map<string, number>> {
  const by = new Map<string, number>();
  if (itemIds.length === 0) return by;
  const rows = await fetchAllPages<{ item_id: string; quantity: number }>((from, to) =>
    supabase().from("inventory_issues").select("item_id, quantity").eq("tenant_id", tenantId).eq("status", "out").in("item_id", itemIds)
      .order("id").range(from, to).returns<{ item_id: string; quantity: number }[]>());
  for (const r of rows) by.set(r.item_id, (by.get(r.item_id) ?? 0) + r.quantity);
  return by;
}

/** One page of the register (by name), with the total that matches, and each item's out / available counts. */
export async function fetchRegisterPage(tenantId: string, opts: { query?: string; offset: number; limit: number }): Promise<Page<InventoryItemRow>> {
  let q = supabase().from("inventory_items").select("*", { count: "exact" }).eq("tenant_id", tenantId);
  const filter = registerFilter(opts.query ?? "");
  if (filter) q = q.or(filter);
  const { data, error, count, status } = await q.order("name").order("id").range(opts.offset, opts.offset + opts.limit - 1).returns<InventoryItem[]>();
  if (error) throw pageError(error, status);
  const items = data ?? [];
  const out = await outCounts(tenantId, items.map((i) => i.id));
  return {
    total: count ?? items.length,
    rows: items.map((i) => { const n = out.get(i.id) ?? 0; return { ...i, out: n, available: availableCount(i, n) }; }),
  };
}

/** One item with its counts (opening an item from the stock pages). */
export async function fetchInventoryItem(itemId: string): Promise<InventoryItemRow> {
  const { data, error } = await supabase().from("inventory_items").select("*").eq("id", itemId).single<InventoryItem>();
  if (error) throw new Error(error.message);
  const out = await outCounts(data.tenant_id, [data.id]);
  const n = out.get(data.id) ?? 0;
  return { ...data, out: n, available: availableCount(data, n) };
}

/** Every item's name, store and unit: what the stock pages label their rows with. Light: no counts, no notes. */
export type ItemIndexRow = Pick<InventoryItem, "id" | "name" | "category" | "unit" | "consumable" | "tracking" | "retired_at">;
export async function fetchItemIndex(tenantId: string): Promise<ItemIndexRow[]> {
  return fetchAllPages<ItemIndexRow>((from, to) =>
    supabase().from("inventory_items").select("id, name, category, unit, consumable, tracking, retired_at").eq("tenant_id", tenantId)
      .order("name").order("id").range(from, to).returns<ItemIndexRow[]>());
}

/** The four cards on top of the register, from the columns they need and nothing else. */
export async function fetchInventorySummary(tenantId: string, now = new Date()): Promise<InventorySummary> {
  const sb = supabase();
  const [items, out, lost] = await Promise.all([
    fetchAllPages<Pick<InventoryItem, "quantity" | "consumable" | "retired_at">>((from, to) =>
      sb.from("inventory_items").select("quantity, consumable, retired_at").eq("tenant_id", tenantId).order("id").range(from, to)
        .returns<Pick<InventoryItem, "quantity" | "consumable" | "retired_at">[]>()),
    fetchAllPages<Pick<InventoryIssue, "quantity" | "due_on" | "status">>((from, to) =>
      sb.from("inventory_issues").select("quantity, due_on, status").eq("tenant_id", tenantId).eq("status", "out").order("id").range(from, to)
        .returns<Pick<InventoryIssue, "quantity" | "due_on" | "status">[]>()),
    fetchAllPages<Pick<InventoryIssue, "quantity">>((from, to) =>
      sb.from("inventory_issues").select("quantity").eq("tenant_id", tenantId).eq("status", "lost").order("id").range(from, to)
        .returns<Pick<InventoryIssue, "quantity">[]>()),
  ]);
  const live = items.filter((i) => !i.retired_at);
  return {
    items: live.length,
    copiesOwned: live.filter((i) => !i.consumable).reduce((a, i) => a + i.quantity, 0),
    out: out.reduce((a, i) => a + i.quantity, 0),
    overdue: out.filter((i) => isOverdue(i, now)).length,
    lost: lost.reduce((a, i) => a + i.quantity, 0),
  };
}

// ---------------------------------------------------------------- issues

const ISSUE_SELECT =
  "*, inventory_items(name, category, asset_tag), students(full_name, admission_no), " +
  "holder:profiles!inventory_issues_profile_id_fkey(full_name, staff_title), " +
  "issuer:profiles!inventory_issues_issued_by_fkey(full_name)";

type IssueJoin = InventoryIssue & {
  inventory_items: { name: string; category: InventoryCategory; asset_tag: string | null } | null;
  students: { full_name: string; admission_no: string } | null;
  holder: { full_name: string; staff_title: string | null } | null;
  issuer: { full_name: string } | null;
};

function toIssueRow(r: IssueJoin): InventoryIssueRow {
  const { inventory_items: item, students: student, holder, issuer, ...issue } = r;
  return {
    ...issue,
    itemName: item?.name ?? "Unknown item",
    itemCategory: item?.category ?? "other",
    assetTag: item?.asset_tag ?? null,
    holderName: student?.full_name ?? holder?.full_name ?? "Unknown",
    holderKind: issue.student_id ? "learner" : "staff",
    holderDetail: student ? `ADM ${student.admission_no}` : holder?.staff_title ?? null,
    issuedByName: issuer?.full_name ?? null,
  };
}

export type IssueFilter = "out" | "overdue" | "all";

/**
 * Who a search could mean: the items, learners and staff it matches (at most a
 * couple of hundred of each, so the filter stays a short URL). Null when there's no search.
 */
async function searchIds(tenantId: string, query: string): Promise<{ items: string[]; students: string[]; staff: string[] } | null> {
  const t = searchTerm(query);
  if (!t) return null;
  const like = `"*${t}*"`;
  const sb = supabase();
  const [items, students, staff] = await Promise.all([
    sb.from("inventory_items").select("id").eq("tenant_id", tenantId).or(`name.ilike.${like},asset_tag.ilike.${like}`).limit(150),
    sb.from("students").select("id").eq("tenant_id", tenantId).or(`full_name.ilike.${like},admission_no.ilike.${like}`).limit(150),
    sb.from("profiles").select("id").eq("tenant_id", tenantId).ilike("full_name", `%${t}%`).not("role", "in", "(parent,student)").limit(100),
  ]);
  for (const r of [items, students, staff]) if (r.error) throw new Error(r.error.message);
  const ids = (r: { data: { id: string }[] | null }) => (r.data ?? []).map((x) => x.id);
  return { items: ids(items), students: ids(students), staff: ids(staff) };
}

/** One page of issues: what's out, what's overdue, or the whole history; optionally narrowed by a search. */
export async function fetchIssuesPage(tenantId: string, opts: { filter: IssueFilter; query?: string; offset: number; limit: number; now?: Date }): Promise<Page<InventoryIssueRow>> {
  const ids = await searchIds(tenantId, opts.query ?? "");
  if (ids && !ids.items.length && !ids.students.length && !ids.staff.length) return { rows: [], total: 0 };
  let q = supabase().from("inventory_issues").select(ISSUE_SELECT, { count: "exact" }).eq("tenant_id", tenantId);
  if (opts.filter !== "all") q = q.eq("status", "out");
  if (opts.filter === "overdue") q = q.lt("due_on", todayIso(opts.now));
  if (ids) {
    const parts = [
      ids.items.length ? `item_id.in.(${ids.items.join(",")})` : null,
      ids.students.length ? `student_id.in.(${ids.students.join(",")})` : null,
      ids.staff.length ? `profile_id.in.(${ids.staff.join(",")})` : null,
    ].filter(Boolean);
    q = q.or(parts.join(","));
  }
  q = opts.filter === "all"
    ? q.order("issued_at", { ascending: false })
    : q.order("due_on", { ascending: true, nullsFirst: false }).order("issued_at", { ascending: false });
  const { data, error, count, status } = await q.order("id").range(opts.offset, opts.offset + opts.limit - 1).returns<IssueJoin[]>();
  if (error) throw pageError(error, status);
  return { rows: (data ?? []).map(toIssueRow), total: count ?? (data ?? []).length };
}

/** Every issue of one item (its history), newest first. Loaded when the item is opened. */
export async function fetchItemIssues(itemId: string): Promise<InventoryIssueRow[]> {
  const rows = await fetchAllPages<IssueJoin>((from, to) =>
    supabase().from("inventory_issues").select(ISSUE_SELECT).eq("item_id", itemId)
      .order("issued_at", { ascending: false }).order("id").range(from, to).returns<IssueJoin[]>());
  return rows.map(toIssueRow);
}

// ---------------------------------------------------------------- uniforms

export interface UniformIssueRow { id: string; item_id: string; quantity: number; issued_at: string; student_id: string | null; name: string }

/** Uniforms handed out in the period (to learners and staff), for the Uniforms page. */
export async function fetchUniformIssues(tenantId: string, from: string, to: string): Promise<UniformIssueRow[]> {
  type Row = { id: string; item_id: string; quantity: number; issued_at: string; student_id: string | null; inventory_items: { name: string } | null };
  const rows = await fetchAllPages<Row>((a, b) =>
    supabase().from("inventory_issues").select("id, item_id, quantity, issued_at, student_id, inventory_items!inner(name, category)")
      .eq("tenant_id", tenantId).eq("inventory_items.category", "uniforms")
      .gte("issued_at", `${from}T00:00:00`).lte("issued_at", `${to}T23:59:59`)
      .order("id").range(a, b).returns<Row[]>());
  return rows.map(({ inventory_items, ...r }) => ({ ...r, name: inventory_items?.name ?? "Uniform" }));
}

// ---------------------------------------------------------------- flags, made readable

/**
 * A sick-bay flag on tiny counts: 8 plasters against 4 expected is "double",
 * but not news. Both sides under `under` units on a clinic use flag. The
 * database still raises them (its severity is relative); the screen groups
 * them as small changes behind a toggle. A real fix (a minimum absolute
 * change before a weekly clinic rise counts) belongs in the SQL later.
 */
export function isSmallClinicChange(f: Pick<ConsumptionFlag, "category" | "kind" | "expected" | "actual">, under = 10): boolean {
  if (storeOf(f.category) !== "clinic") return false;
  if (f.kind !== "usage_up" && f.kind !== "usage_down" && f.kind !== "usage_trend") return false;
  return Math.abs(f.expected ?? 0) < under && Math.abs(f.actual ?? 0) < under;
}

const SEVERITY_RANK: Record<FlagSeverity, number> = { high: 0, medium: 1, low: 2 };

/** How big a flag is, for ordering within a severity: the absolute change, or the amount when there's nothing to compare. */
export function flagSize(f: Pick<ConsumptionFlag, "expected" | "actual">): number {
  if (f.expected != null && f.actual != null) return Math.abs(f.actual - f.expected);
  return Math.abs(f.actual ?? f.expected ?? 0);
}

/** Most severe first, then the biggest change, then newest. */
export function sortFlagsBySize<T extends Pick<ConsumptionFlag, "severity" | "expected" | "actual" | "occurred_on">>(flags: T[]): T[] {
  return [...flags].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || flagSize(b) - flagSize(a)
    || (a.occurred_on < b.occurred_on ? 1 : a.occurred_on > b.occurred_on ? -1 : 0));
}

export interface FlagGroups<T> {
  /** Unexplained and not small: what the screen leads with. */
  alarms: T[];
  /** Low-volume clinic changes, hidden behind a toggle. */
  small: T[];
  /** Rises that more people eating explains. */
  explained: T[];
}

export function groupFlags<T extends ConsumptionFlag>(flags: T[], under = 10): FlagGroups<T> {
  const alarms: T[] = [];
  const small: T[] = [];
  const explained: T[] = [];
  for (const f of flags) {
    if (f.explained) explained.push(f);
    else if (isSmallClinicChange(f, under)) small.push(f);
    else alarms.push(f);
  }
  return { alarms: sortFlagsBySize(alarms), small: sortFlagsBySize(small), explained: sortFlagsBySize(explained) };
}

export type SeverityCounts = Record<FlagSeverity, number>;

/** Unexplained, not-small flags counted by store and severity, for the summary on top of the flags. */
export function flagCountsByStore(flags: ConsumptionFlag[], under = 10): { store: Exclude<StoreKey, "all">; counts: SeverityCounts; total: number }[] {
  const by = new Map<Exclude<StoreKey, "all">, SeverityCounts>();
  for (const f of flags) {
    if (f.explained || isSmallClinicChange(f, under)) continue;
    const s = storeOf(f.category);
    const c = by.get(s) ?? { high: 0, medium: 0, low: 0 };
    c[f.severity] += 1;
    by.set(s, c);
  }
  return [...by.entries()]
    .map(([store, counts]) => ({ store, counts, total: counts.high + counts.medium + counts.low }))
    .sort((a, b) => b.counts.high - a.counts.high || b.total - a.total);
}

export function severityCounts(flags: Pick<ConsumptionFlag, "severity">[]): SeverityCounts {
  const c: SeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const f of flags) c[f.severity] += 1;
  return c;
}

/** The rows of one page (1-based) of a list already in memory. */
export function pageOf<T>(rows: T[], page: number, size: number): T[] {
  return rows.slice((page - 1) * size, page * size);
}

// ---------------------------------------------------------------- trends

export interface HeadcountDay { day: string; learners: number; staff: number; visitors: number; total: number }

/** Who was in school each day (learners present, staff, visitors): what kitchen use is measured per head against. */
export async function fetchHeadcount(tenantId: string, from: string, to: string): Promise<HeadcountDay[]> {
  const { data, error } = await supabase().rpc("inventory_headcount", { p_tenant_id: tenantId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => {
    const learners = Number(r.learners ?? 0), staff = Number(r.staff ?? 0), visitors = Number(r.visitors ?? 0);
    return { day: String(r.day).slice(0, 10), learners, staff, visitors, total: learners + staff + visitors };
  }).sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Monday of the ISO week a day falls in, as YYYY-MM-DD. */
export function isoWeekStart(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return todayIso(d);
}

export interface PerHeadPoint { period: string; used: number; heads: number; perHead: number | null }

/**
 * An item's use next to how many people were in: per day (kitchen, against
 * that day's headcount) or per week (against the week's average daily
 * headcount). Days nobody was in have no per-head figure.
 */
export function perHeadSeries(use: { period_start: string; used: number }[], heads: HeadcountDay[], bucket: "day" | "week"): PerHeadPoint[] {
  const usedBy = new Map<string, number>();
  for (const u of use) {
    const k = bucket === "day" ? u.period_start.slice(0, 10) : isoWeekStart(u.period_start.slice(0, 10));
    usedBy.set(k, (usedBy.get(k) ?? 0) + u.used);
  }
  const headsBy = new Map<string, { sum: number; days: number }>();
  for (const h of heads) {
    if (h.total <= 0) continue;
    const k = bucket === "day" ? h.day : isoWeekStart(h.day);
    const a = headsBy.get(k) ?? { sum: 0, days: 0 };
    a.sum += h.total; a.days += 1;
    headsBy.set(k, a);
  }
  const keys = [...new Set([...usedBy.keys(), ...headsBy.keys()])].sort();
  return keys.map((k) => {
    const h = headsBy.get(k);
    const heads = h ? Math.round(h.sum / h.days) : 0;
    const used = usedBy.get(k) ?? 0;
    return { period: k, used, heads, perHead: heads > 0 ? used / heads : null };
  });
}

/** Per item, this month's delivery spend against last month's, biggest rise first (only rises). */
export function spendIncreases(rows: { item_id: string; period_start: string; spend_cents: number }[], thisMonth: string, lastMonth: string): { item_id: string; now: number; before: number; rise: number }[] {
  const by = new Map<string, { now: number; before: number }>();
  for (const r of rows) {
    const m = r.period_start.slice(0, 7);
    const a = by.get(r.item_id) ?? { now: 0, before: 0 };
    if (m === thisMonth.slice(0, 7)) a.now += r.spend_cents;
    else if (m === lastMonth.slice(0, 7)) a.before += r.spend_cents;
    by.set(r.item_id, a);
  }
  return [...by.entries()].map(([item_id, a]) => ({ item_id, ...a, rise: a.now - a.before }))
    .filter((x) => x.rise > 0).sort((a, b) => b.rise - a.rise);
}
