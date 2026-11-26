import { NotOnApiError } from "../capabilities";
import {
  availableCount,
  type InventoryCategory,
  type InventoryIssue,
  type InventoryIssueRow,
  type InventoryItem,
  type InventoryItemInput,
  type InventoryItemRow,
  type InventoryPeople,
  type IssueHolder,
  type IssueStatus,
  type ItemCondition,
} from "../inventory";
import { apiClient } from "./client";
import { isApiError } from "./errors";
import { API_PAGE_LIMIT, listAllPages } from "./paging";
import { activeTenantId } from "./peopleApi";
import { settlePool } from "./pool";
import type { components } from "./schema";
import { byYear, classGroupFromApi, currentAcademicYear } from "./setupApi";

/**
 * Inventory on apps/api: the API side of inventory.ts.
 *
 * Differences from Supabase, handled here rather than in the screens:
 *  - `InventoryItem` on the API has no `purchased_on`, `unit_cost_cents`, or `notes` fields; they map to `null`
 *    and are hidden by `inventoryCapabilities().itemCostAndNotes`.
 *  - There is no PATCH endpoint for inventory items and no unretire endpoint (`editItem` and `unretireItem` are
 *    false on API, and those calls throw `NotOnApiError`).
 *  - `GET /inventory/issues` returns open issues (`status = "out"`) only, so closed-issue history and the Lost
 *    counter are hidden (`issueHistory: false`), and `POST /inventory/issues` does not take a hand-out note.
 *  - `POST /inventory/issues` requires `holder_user_id` to be a school membership `user_id`, so `fetchInventoryPeople`
 *    lists only staff records linked to a user account (`userId != null`) with `id = userId`.
 *  - `issueInventoryToClass` checks active learners in the class who do not already hold an open copy, verifies
 *    availability before issuing any copy, and sends individual POSTs 4 at a time via `settlePool`.
 *  - `GET /inventory/issues` requires `resource.inventory.read`, which regular teachers do not hold yet, so
 *    `teacher/items` stays hidden until the API adds a self-scoped issue read.
 */

type ApiItem = components["schemas"]["InventoryItem"];
type ApiIssue = components["schemas"]["InventoryIssue"];
type ApiLearner = components["schemas"]["Learner"];
type ApiStaff = components["schemas"]["StaffMember"];

export const INVENTORY_ISSUE_CONCURRENCY = 4;

export function inventoryItemFromApi(i: ApiItem): InventoryItem {
  return {
    id: i.id,
    tenant_id: i.tenant_id,
    name: i.name,
    category: i.category as InventoryCategory,
    tracking: i.tracking,
    quantity: i.quantity,
    asset_tag: i.asset_tag ?? null,
    condition: i.condition as ItemCondition,
    location: i.location ?? null,
    purchased_on: null,
    unit_cost_cents: null,
    notes: null,
    // Stock in and out (apps/api/docs/INVENTORY-STOCK.md); `?? null` keeps an older API that does not send them readable.
    unit: i.unit ?? null,
    consumable: i.consumable ?? false,
    reorder_level: i.reorder_level ?? null,
    retired_at: i.retired_at ?? null,
    created_at: i.created_at,
  };
}

export function inventoryIssueFromApi(r: ApiIssue): InventoryIssue {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    item_id: r.item_id,
    student_id: r.learner_id ?? null,
    profile_id: r.holder_user_id ?? null,
    quantity: r.quantity,
    issued_by: null,
    issued_at: r.issued_at,
    due_on: r.due_on ?? null,
    condition_out: null,
    status: r.status as IssueStatus,
    returned_condition: null,
    closed_at: r.closed_at ?? null,
    note: null,
  };
}

async function tolerant<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (isApiError(err) && err.code === "forbidden") return fallback;
    throw err;
  }
}

export function listApiItems(tenantId: string): Promise<ApiItem[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/items", {
      path: { tenantId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.items, page: r.page };
  });
}

export function listApiIssues(tenantId: string): Promise<ApiIssue[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/inventory/issues", {
      path: { tenantId },
      query: { limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.issues, page: r.page };
  });
}

function listAllLearners(tenantId: string, active?: boolean): Promise<ApiLearner[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/learners", {
      path: { tenantId },
      query: { active, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.learners, page: r.page };
  });
}

function listAllStaff(tenantId: string, active?: boolean): Promise<ApiStaff[]> {
  return listAllPages(async (cursor) => {
    const r = await apiClient().get("/v1/tenants/{tenantId}/staff", {
      path: { tenantId },
      query: { active, limit: API_PAGE_LIMIT, cursor },
      tenantId,
    });
    return { items: r.staff, page: r.page };
  });
}

export async function apiFetchInventory(tenantId: string): Promise<InventoryItemRow[]> {
  const [items, issues] = await Promise.all([listApiItems(tenantId), listApiIssues(tenantId)]);
  const outBy = new Map<string, number>();
  for (const r of issues) {
    if (r.status === "out") outBy.set(r.item_id, (outBy.get(r.item_id) ?? 0) + r.quantity);
  }
  return items
    .map(inventoryItemFromApi)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((item) => {
      const out = outBy.get(item.id) ?? 0;
      return { ...item, out, available: availableCount(item, out) };
    });
}

function hydrateIssues(
  issues: ApiIssue[],
  items: ApiItem[],
  learners: ApiLearner[],
  staff: ApiStaff[],
): InventoryIssueRow[] {
  const itemBy = new Map(items.map((i) => [i.id, i]));
  const learnerBy = new Map(learners.map((l) => [l.id, l]));
  const staffByUser = new Map<string, ApiStaff>();
  for (const s of staff) {
    if (s.userId) staffByUser.set(s.userId, s);
  }

  return issues.map((raw) => {
    const issue = inventoryIssueFromApi(raw);
    const item = itemBy.get(raw.item_id);
    const learner = raw.learner_id ? learnerBy.get(raw.learner_id) : undefined;
    const holder = raw.holder_user_id ? staffByUser.get(raw.holder_user_id) : undefined;
    return {
      ...issue,
      itemName: item?.name ?? "Unknown item",
      itemCategory: (item?.category as InventoryCategory | undefined) ?? "other",
      assetTag: item?.asset_tag ?? null,
      holderName: learner?.full_name ?? holder?.full_name ?? "Unknown",
      holderKind: raw.learner_id ? "learner" : "staff",
      holderDetail: learner ? `ADM ${learner.admission_no}` : holder?.staff_title ?? null,
      issuedByName: null,
    };
  });
}

export async function apiFetchInventoryIssues(tenantId: string): Promise<InventoryIssueRow[]> {
  const [issues, items, learners, staff] = await Promise.all([
    listApiIssues(tenantId),
    listApiItems(tenantId),
    tolerant(() => listAllLearners(tenantId), []),
    tolerant(() => listAllStaff(tenantId), []),
  ]);
  return hydrateIssues(issues, items, learners, staff);
}

export async function apiFetchMyInventory(profileId: string): Promise<InventoryIssueRow[]> {
  const tenantId = activeTenantId();
  const [issues, items] = await Promise.all([listApiIssues(tenantId), listApiItems(tenantId)]);
  const mine = issues.filter((r) => r.holder_user_id === profileId);
  return hydrateIssues(mine, items, [], []);
}

export async function apiSaveInventoryItem(tenantId: string, input: InventoryItemInput, id?: string): Promise<void> {
  // No PATCH on an item: not even a stock line's unit, consumable flag or reorder level can be changed once it is made.
  if (id) throw new NotOnApiError("Editing an inventory item");
  const stock = input.tracking === "stock";
  const quantity = stock ? input.quantity : 1;
  // A stock line may start at 0 (a consumable before its first delivery); an asset is always 1.
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error("Quantity must be a whole number, 0 or more.");
  try {
    await apiClient().post("/v1/tenants/{tenantId}/inventory/items", {
      path: { tenantId },
      body: {
        name: input.name.trim(),
        category: input.category,
        tracking: input.tracking,
        quantity,
        asset_tag: input.asset_tag?.trim() || null,
        condition: input.condition,
        location: input.location?.trim() || null,
        // stock lines only: the API refuses a unit, a consumable flag or a reorder level on an asset
        ...(stock ? { unit: input.unit?.trim() || null, consumable: input.consumable ?? false, reorder_level: input.reorder_level ?? null } : {}),
      },
      tenantId,
    });
  } catch (err) {
    if (isApiError(err) && err.code === "conflict" && /asset_tag/i.test(err.message)) {
      throw new Error("Another item already has that asset tag.");
    }
    throw err;
  }
}

export async function apiSetItemRetired(id: string, retired: boolean): Promise<void> {
  if (!retired) throw new NotOnApiError("Restoring a written-off item");
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/inventory/items/{itemId}/retire", {
    path: { tenantId, itemId: id },
    tenantId,
  });
}

export async function apiIssueInventoryItem(input: {
  tenantId: string;
  itemId: string;
  holder: IssueHolder;
  quantity: number;
  dueOn: string | null;
  note: string;
}): Promise<void> {
  await apiClient().post("/v1/tenants/{tenantId}/inventory/issues", {
    path: { tenantId: input.tenantId },
    body: {
      item_id: input.itemId,
      learner_id: input.holder.kind === "learner" ? input.holder.studentId : null,
      holder_user_id: input.holder.kind === "staff" ? input.holder.profileId : null,
      quantity: input.quantity,
      due_on: input.dueOn,
    },
    tenantId: input.tenantId,
  });
}

export async function apiIssueInventoryToClass(itemId: string, classId: string, dueOn: string | null): Promise<number> {
  const tenantId = activeTenantId();
  const [itemRes, memberships, learners, openIssues] = await Promise.all([
    apiClient().get("/v1/tenants/{tenantId}/inventory/items/{itemId}", {
      path: { tenantId, itemId },
      tenantId,
    }),
    listAllPages(async (cursor) => {
      const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", {
        path: { tenantId },
        query: { classId, active: true, limit: API_PAGE_LIMIT, cursor },
        tenantId,
      });
      return { items: r.memberships, page: r.page };
    }),
    listAllLearners(tenantId, true),
    listApiIssues(tenantId),
  ]);

  const item = inventoryItemFromApi(itemRes.item);
  if (item.retired_at) throw new Error("Retired items cannot be issued.");

  const activeLearnerIds = new Set(learners.map((l) => l.id));
  const alreadyHolding = new Set(
    openIssues.filter((r) => r.item_id === itemId && r.status === "out" && r.learner_id).map((r) => r.learner_id!),
  );
  const targets = memberships
    .map((m) => m.learner_id)
    .filter((id) => activeLearnerIds.has(id) && !alreadyHolding.has(id));

  if (targets.length === 0) return 0;

  const outCount = openIssues
    .filter((r) => r.item_id === itemId && r.status === "out")
    .reduce((sum, r) => sum + r.quantity, 0);
  const available = availableCount(item, outCount);
  if (targets.length > available) {
    throw new Error(`Not enough copies on the shelf (${available} available, ${targets.length} learners need one).`);
  }

  const results = await settlePool(targets, INVENTORY_ISSUE_CONCURRENCY, async (learnerId) => {
    await apiClient().post("/v1/tenants/{tenantId}/inventory/issues", {
      path: { tenantId },
      body: { item_id: itemId, learner_id: learnerId, holder_user_id: null, quantity: 1, due_on: dueOn },
      tenantId,
    });
  });

  const failed = results.filter((r): r is { ok: false; error: unknown } => !r.ok);
  const done = results.length - failed.length;
  if (failed.length > 0) {
    const first = failed[0]!;
    const msg = first.error instanceof Error ? first.error.message : "Could not issue to every learner.";
    throw new Error(done > 0 ? `Issued to ${done} of ${targets.length} learners before failing: ${msg}` : msg);
  }
  return done;
}

export async function apiCloseInventoryIssue(
  id: string,
  status: Exclude<IssueStatus, "out">,
  returnedCondition: ItemCondition | null,
  note: string,
): Promise<void> {
  const tenantId = activeTenantId();
  await apiClient().post("/v1/tenants/{tenantId}/inventory/issues/{issueId}/close", {
    path: { tenantId, issueId: id },
    body: {
      status,
      returned_condition: status === "lost" ? null : returnedCondition,
      note: note.trim() || null,
    },
    tenantId,
  });
}

export async function apiFetchInventoryPeople(tenantId: string): Promise<InventoryPeople> {
  const [learners, staff, classesAndMemberships] = await Promise.all([
    tolerant(() => listAllLearners(tenantId, true), []),
    tolerant(() => listAllStaff(tenantId, true), []),
    tolerant(async () => {
      const year = await currentAcademicYear(tenantId);
      const [classes, memberships] = await Promise.all([
        listAllPages(async (cursor) => {
          const r = await apiClient().get("/v1/tenants/{tenantId}/classes", {
            path: { tenantId },
            query: { academicYearId: year?.id, active: true, limit: API_PAGE_LIMIT, cursor },
            tenantId,
          });
          return { items: r.classes, page: r.page };
        }),
        listAllPages(async (cursor) => {
          const r = await apiClient().get("/v1/tenants/{tenantId}/class-memberships", {
            path: { tenantId },
            query: { active: true, limit: API_PAGE_LIMIT, cursor },
            tenantId,
          });
          return { items: r.memberships, page: r.page };
        }),
      ]);
      return { classes, memberships };
    }, { classes: [], memberships: [] }),
  ]);

  const currentClassIds = new Set(classesAndMemberships.classes.map((c) => c.id));
  const classByLearner = new Map<string, string>();
  for (const m of classesAndMemberships.memberships) {
    if (currentClassIds.has(m.class_id)) classByLearner.set(m.learner_id, m.class_id);
  }

  return {
    learners: learners
      .map((l) => ({
        id: l.id,
        full_name: l.full_name,
        admission_no: l.admission_no,
        class_id: classByLearner.get(l.id) ?? null,
      }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id)),
    // POST /inventory/issues validates holder_user_id against active school_memberships.
    staff: staff
      .filter((s): s is ApiStaff & { userId: string } => Boolean(s.userId))
      .map((s) => ({
        id: s.userId,
        full_name: s.full_name,
        role: s.classification,
        staff_title: s.staff_title ?? null,
      }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    classes: classesAndMemberships.classes
      .map((c) => classGroupFromApi(c, tenantId))
      .sort(byYear)
      .map((c) => ({ id: c.id, name: c.name })),
  };
}
