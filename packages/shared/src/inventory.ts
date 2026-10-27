import { supabase } from "./supabase";
import { toCsv } from "./csv";

/**
 * The school's inventory register and who has what (20261027080000). An
 * item is one tracked asset or a stock line of identical copies; an issue
 * is one hand-out to a learner or a member of staff, closed as returned,
 * returned damaged, or lost. Availability is enforced in the database; the
 * counts here are for showing it.
 */

export type InventoryCategory =
  | "textbooks" | "furniture" | "lab_equipment" | "sports" | "ict" | "uniforms"
  | "music" | "kitchen" | "stationery" | "tools" | "medical" | "other";
export type InventoryTracking = "asset" | "stock";
export type ItemCondition = "new" | "good" | "fair" | "poor" | "broken";
export type IssueStatus = "out" | "returned" | "damaged" | "lost";

export const INVENTORY_CATEGORY_LABEL: Record<InventoryCategory, string> = {
  textbooks: "Textbooks",
  furniture: "Furniture",
  lab_equipment: "Lab equipment",
  sports: "Sports & games",
  ict: "ICT",
  uniforms: "Uniforms",
  music: "Music",
  kitchen: "Kitchen & dining",
  stationery: "Stationery",
  tools: "Tools & workshop",
  // the sick bay's medicines and supplies: a medicine given can come off a stock line (20261101300001)
  medical: "Medical supplies",
  other: "Other",
};

export const ITEM_CONDITION_LABEL: Record<ItemCondition, string> = {
  new: "New", good: "Good", fair: "Fair", poor: "Poor", broken: "Broken",
};

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  out: "Out", returned: "Returned", damaged: "Returned damaged", lost: "Lost",
};

export interface InventoryItem {
  id: string;
  tenant_id: string;
  name: string;
  category: InventoryCategory;
  tracking: InventoryTracking;
  quantity: number;
  asset_tag: string | null;
  condition: ItemCondition;
  location: string | null;
  purchased_on: string | null;
  unit_cost_cents: number | null;
  notes: string | null;
  retired_at: string | null;
  created_at: string;
}

/** An item with how many copies are out with people right now. */
export interface InventoryItemRow extends InventoryItem {
  out: number;
  available: number;
}

export interface InventoryIssue {
  id: string;
  tenant_id: string;
  item_id: string;
  student_id: string | null;
  profile_id: string | null;
  quantity: number;
  issued_by: string | null;
  issued_at: string;
  due_on: string | null;
  condition_out: ItemCondition | null;
  status: IssueStatus;
  returned_condition: ItemCondition | null;
  closed_at: string | null;
  note: string | null;
}

/** An issue with the names a screen shows beside it. */
export interface InventoryIssueRow extends InventoryIssue {
  itemName: string;
  itemCategory: InventoryCategory;
  assetTag: string | null;
  holderName: string;
  holderKind: "learner" | "staff";
  /** A learner's admission number, a staff member's title. */
  holderDetail: string | null;
  issuedByName: string | null;
}

export type IssueHolder = { kind: "learner"; studentId: string } | { kind: "staff"; profileId: string };

// ---------------------------------------------------------------- pure

/** Copies on the shelf: what's owned less what's out. A written-off item has none to give. */
export function availableCount(item: Pick<InventoryItem, "quantity" | "retired_at">, out: number): number {
  if (item.retired_at) return 0;
  return Math.max(item.quantity - out, 0);
}

/** Today as YYYY-MM-DD in local time, which is what a due_on date is compared against. */
export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Still out and past its due date. Due today is not overdue yet. */
export function isOverdue(issue: Pick<InventoryIssue, "status" | "due_on">, now = new Date()): boolean {
  return issue.status === "out" && issue.due_on != null && issue.due_on < todayIso(now);
}

/** Whole days past due (0 when not overdue). */
export function daysOverdue(issue: Pick<InventoryIssue, "status" | "due_on">, now = new Date()): number {
  if (!isOverdue(issue, now) || !issue.due_on) return 0;
  const due = new Date(`${issue.due_on}T00:00:00`);
  const today = new Date(`${todayIso(now)}T00:00:00`);
  return Math.round((today.getTime() - due.getTime()) / 86_400_000);
}

/** Textbooks go out for the school year: back by the last day of it (31 December). */
export function endOfSchoolYear(now = new Date()): string {
  return `${now.getFullYear()}-12-31`;
}

/** Out first (overdue at the top, then soonest due), then closed ones, newest first. */
export function sortIssues<T extends Pick<InventoryIssue, "status" | "due_on" | "issued_at">>(issues: T[], now = new Date()): T[] {
  const rank = (i: T) => (i.status !== "out" ? 2 : isOverdue(i, now) ? 0 : 1);
  return [...issues].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.status === "out") {
      if (a.due_on !== b.due_on) return (a.due_on ?? "9999") < (b.due_on ?? "9999") ? -1 : 1;
    }
    return a.issued_at < b.issued_at ? 1 : a.issued_at > b.issued_at ? -1 : 0;
  });
}

export interface InventorySummary {
  items: number;
  copiesOwned: number;
  out: number;
  overdue: number;
  lost: number;
}

export function summariseInventory(items: InventoryItemRow[], issues: InventoryIssue[], now = new Date()): InventorySummary {
  const live = items.filter((i) => !i.retired_at);
  return {
    items: live.length,
    copiesOwned: live.reduce((a, i) => a + i.quantity, 0),
    out: issues.filter((i) => i.status === "out").reduce((a, i) => a + i.quantity, 0),
    overdue: issues.filter((i) => isOverdue(i, now)).length,
    lost: issues.filter((i) => i.status === "lost").reduce((a, i) => a + i.quantity, 0),
  };
}

/** Case-insensitive match on the item, its tag, or who has it. */
export function issueMatches(issue: Pick<InventoryIssueRow, "itemName" | "assetTag" | "holderName" | "holderDetail">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [issue.itemName, issue.assetTag, issue.holderName, issue.holderDetail].some((s) => s?.toLowerCase().includes(q));
}

export function registerCsv(items: InventoryItemRow[]): string {
  return toCsv(
    ["name", "category", "tracking", "asset_tag", "quantity", "out", "available", "condition", "location", "purchased_on", "unit_cost", "written_off", "notes"],
    items.map((i) => [
      i.name, INVENTORY_CATEGORY_LABEL[i.category], i.tracking, i.asset_tag, i.quantity, i.out, i.available,
      ITEM_CONDITION_LABEL[i.condition], i.location, i.purchased_on,
      i.unit_cost_cents == null ? null : (i.unit_cost_cents / 100).toFixed(2),
      i.retired_at ? i.retired_at.slice(0, 10) : null, i.notes,
    ]),
  );
}

export function issuesCsv(issues: InventoryIssueRow[], now = new Date()): string {
  return toCsv(
    ["item", "asset_tag", "holder", "holder_type", "adm_or_title", "quantity", "issued_on", "due_on", "status", "days_overdue", "returned_on", "returned_condition", "note"],
    issues.map((i) => [
      i.itemName, i.assetTag, i.holderName, i.holderKind, i.holderDetail, i.quantity, i.issued_at.slice(0, 10), i.due_on,
      ISSUE_STATUS_LABEL[i.status], daysOverdue(i, now) || null, i.closed_at?.slice(0, 10) ?? null,
      i.returned_condition ? ITEM_CONDITION_LABEL[i.returned_condition] : null, i.note,
    ]),
  );
}

// ---------------------------------------------------------------- data

const PAGE = 1000; // PostgREST's default max-rows; a school issuing textbooks per learner passes that quickly

/** Every row of a query, a page at a time. */
async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

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

/** The whole register, each item with its out and available counts. */
export async function fetchInventory(tenantId: string): Promise<InventoryItemRow[]> {
  const sb = supabase();
  const [items, out] = await Promise.all([
    allRows<InventoryItem>((from, to) =>
      sb.from("inventory_items").select("*").eq("tenant_id", tenantId).order("name").order("id").range(from, to).returns<InventoryItem[]>()),
    allRows<{ item_id: string; quantity: number }>((from, to) =>
      sb.from("inventory_issues").select("item_id, quantity").eq("tenant_id", tenantId).eq("status", "out")
        .order("id").range(from, to).returns<{ item_id: string; quantity: number }[]>()),
  ]);
  const outBy = new Map<string, number>();
  for (const r of out) outBy.set(r.item_id, (outBy.get(r.item_id) ?? 0) + r.quantity);
  return items.map((i) => {
    const n = outBy.get(i.id) ?? 0;
    return { ...i, out: n, available: availableCount(i, n) };
  });
}

/** Every issue in the school (out and closed), with names. */
export async function fetchInventoryIssues(tenantId: string): Promise<InventoryIssueRow[]> {
  const rows = await allRows<IssueJoin>((from, to) =>
    supabase().from("inventory_issues").select(ISSUE_SELECT).eq("tenant_id", tenantId)
      .order("issued_at", { ascending: false }).order("id").range(from, to).returns<IssueJoin[]>());
  return rows.map(toIssueRow);
}

/** What a member of staff has been issued, out and returned. */
export async function fetchMyInventory(profileId: string): Promise<InventoryIssueRow[]> {
  const { data, error } = await supabase()
    .from("inventory_issues").select(ISSUE_SELECT).eq("profile_id", profileId)
    .order("issued_at", { ascending: false }).returns<IssueJoin[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toIssueRow);
}

/** What these learners have been issued: a parent's children, or a learner themself. */
export async function fetchLearnerInventory(studentIds: string[]): Promise<InventoryIssueRow[]> {
  if (studentIds.length === 0) return [];
  const { data, error } = await supabase()
    .from("inventory_issues").select(ISSUE_SELECT).in("student_id", studentIds)
    .order("issued_at", { ascending: false }).returns<IssueJoin[]>();
  if (error) throw new Error(error.message);
  return (data ?? []).map(toIssueRow);
}

/** A learner's own issues; RLS narrows the query to the signed-in learner's record. */
export async function fetchOwnLearnerInventory(profileId: string): Promise<InventoryIssueRow[]> {
  const { data, error } = await supabase().from("students").select("id").eq("profile_id", profileId).returns<{ id: string }[]>();
  if (error) throw new Error(error.message);
  return fetchLearnerInventory((data ?? []).map((s) => s.id));
}

export type InventoryItemInput = Pick<
  InventoryItem,
  "name" | "category" | "tracking" | "quantity" | "asset_tag" | "condition" | "location" | "purchased_on" | "unit_cost_cents" | "notes"
>;

export async function saveInventoryItem(tenantId: string, input: InventoryItemInput, id?: string): Promise<void> {
  const row = { ...input, quantity: input.tracking === "asset" ? 1 : input.quantity };
  const { error } = id
    ? await supabase().from("inventory_items").update(row).eq("id", id)
    : await supabase().from("inventory_items").insert({ ...row, tenant_id: tenantId });
  if (error) throw new Error(friendlyInventoryError(error.message));
}

/** Writes an item off (disposed of, beyond repair), or brings it back. */
export async function setItemRetired(id: string, retired: boolean): Promise<void> {
  const { error } = await supabase().from("inventory_items").update({ retired_at: retired ? new Date().toISOString() : null }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function issueInventoryItem(input: {
  tenantId: string; itemId: string; holder: IssueHolder; quantity: number; dueOn: string | null; note: string;
}): Promise<void> {
  const { error } = await supabase().from("inventory_issues").insert({
    tenant_id: input.tenantId,
    item_id: input.itemId,
    student_id: input.holder.kind === "learner" ? input.holder.studentId : null,
    profile_id: input.holder.kind === "staff" ? input.holder.profileId : null,
    quantity: input.quantity,
    due_on: input.dueOn,
    note: input.note.trim() || null,
  });
  if (error) throw new Error(friendlyInventoryError(error.message));
}

/** One copy to every learner in the class who hasn't got one. Returns how many were issued. */
export async function issueInventoryToClass(itemId: string, classId: string, dueOn: string | null): Promise<number> {
  const { data, error } = await supabase().rpc("issue_item_to_class", { p_item_id: itemId, p_class_id: classId, p_due_on: dueOn });
  if (error) throw new Error(error.message);
  return (data as number | null) ?? 0;
}

export async function closeInventoryIssue(id: string, status: Exclude<IssueStatus, "out">, returnedCondition: ItemCondition | null, note: string): Promise<void> {
  const patch: Record<string, unknown> = { status, returned_condition: status === "lost" ? null : returnedCondition };
  if (note.trim()) patch.note = note.trim();
  const { error } = await supabase().from("inventory_issues").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface InventoryPeople {
  learners: { id: string; full_name: string; admission_no: string; class_id: string | null }[];
  staff: { id: string; full_name: string; role: string; staff_title: string | null }[];
  classes: { id: string; name: string }[];
}

/** Who something can be issued to: the school's active learners and staff, and its classes. */
export async function fetchInventoryPeople(tenantId: string): Promise<InventoryPeople> {
  const sb = supabase();
  const [learners, staff, classes] = await Promise.all([
    allRows<InventoryPeople["learners"][number]>((from, to) =>
      sb.from("students").select("id, full_name, admission_no, class_id").eq("tenant_id", tenantId).eq("active", true)
        .order("full_name").order("id").range(from, to).returns<InventoryPeople["learners"]>()),
    sb.from("profiles").select("id, full_name, role, staff_title").eq("tenant_id", tenantId).not("role", "in", "(parent,student)").order("full_name"),
    sb.from("classes").select("id, name").eq("tenant_id", tenantId).order("form_level").order("name"),
  ]);
  for (const r of [staff, classes]) if (r.error) throw new Error(r.error.message);
  return {
    learners,
    staff: (staff.data ?? []) as InventoryPeople["staff"],
    classes: (classes.data ?? []) as InventoryPeople["classes"],
  };
}

/** The unique tag index's raw error means nothing to an office user. */
export function friendlyInventoryError(message: string): string {
  if (message.includes("inventory_items_tag_unique")) return "Another item already has that asset tag.";
  return message;
}
