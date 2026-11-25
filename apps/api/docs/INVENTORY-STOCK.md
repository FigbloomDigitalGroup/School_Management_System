# Inventory stock: movements, stock levels and the stock reports

Slice S1 of `docs/handoffs/WEB-ON-API-ROADMAP.md`. A **port** of the live Supabase feature "Inventory: stock in and out"
(`CHANGELOG.md`, 2026-11-24): `supabase/migrations/20261124200000_inventory_movements.sql` and the guards of
`20261125000000_behaviour_inventory_guards.sql`. Same rules; where a rule could not be kept the same, it is listed under
"What differs from Supabase" with the reason.

- **S1a** (this change): migration 115, recording and listing movements, stock levels, and three new item columns.
- **S1b** (next PR): the other reports (ledger, usage, spend by month, cost per meal, headcount, consumption flags) and
  the `stock_insights` question.

## Tables (migration 115)

**`inventory_items`** gains three columns. Assets never use them.

| Column | Type | Rule |
|---|---|---|
| `unit` | text, null | 1 to 20 characters: kg, litres, bags. Trimmed. |
| `consumable` | boolean, default false | Used up rather than handed out and returned: kitchen food, chalk, printer paper. |
| `reorder_level` | integer, null | 0 or more. Warn when stock falls to this. |

**`inventory_movements`**: one delivery, one day's use, waste, or a stock-take correction.

| Column | Rule |
|---|---|
| `kind` | `received`, `used`, `wasted` or `adjusted` |
| `quantity` | not 0. `received`, `used` and `wasted` are positive; `adjusted` is signed |
| `unit_cost_cents`, `supplier` | `received` only. Cost 0 or more, supplier at most 160 characters |
| `meals_served` | `used` only, 0 or more |
| `reference` (80), `purpose` (120), `note` (1,000) | any kind; trimmed, blank is null |
| `occurred_on` | the day it happened; the API fills in the school's today (`schoolToday`); not in the future |
| `recorded_by` | the request's user, set by the trigger from `app.user_id`; the client cannot send it |
| `created_at` | set by the trigger |

- Forced row security, the `figbloom_app` tenant policy and the owner-only policy, as every school table.
- Grants: `SELECT` and `INSERT` only. A movement is **never rewritten or removed**. A mistake is put right with an
  `adjusted` movement. The trigger also refuses an `UPDATE` from the owner.
- The item is the same school's through the composite key `(item_id, tenant_id)`, as `inventory_issues` does.

**The trigger `inventory_movements_apply`** (BEFORE INSERT OR UPDATE, SECURITY INVOKER). In one step, under a lock on the
item (`SELECT ... FOR UPDATE`, as `inventory_issues_guard` does), it:

1. refuses an item the school does not have, an asset (`tracking = 'asset'`) and a written-off item;
2. refuses stock below 0 (`Only 5 kg of Rice in stock`) and, when stock goes down, below what the register still owes to
   issues (`inventory_out_count`);
3. trims the texts, sets `recorded_by` and `created_at`;
4. moves `inventory_items.quantity`, and a priced delivery sets the item's price (`unit_cost_cents`): the latest price is
   the item's price.

So two people using the last 5 kg at once cannot both succeed: the second waits for the first, then sees 0.

## Endpoints

All under `/v1/tenants/{tenantId}/inventory`. Same permissions as the rest of the register.

| Method and path | Permission | What it does |
|---|---|---|
| `POST /movements` | `resource.inventory.write` | Record one movement. 201 `{ movement, item }` (the item with its new count). Audited `inventory.movement.recorded` (movement id, item id, kind) |
| `GET /movements?item_id&from&to&limit&cursor` | `resource.inventory.read` | Newest day first, then the latest recorded. Keyset-paged on `(occurred_on, created_at, id)`; the cursor is bound to the school and every filter. Each row has `recorded_by_name` |
| `GET /stock-levels?as_of` | `resource.inventory.read` | Every live stock line (see below). Not paged |
| `POST /items` | `resource.inventory.write` | Now takes `unit`, `consumable`, `reorder_level`. A stock line may start at 0 |
| `GET /items`, `GET /items/{itemId}`, retire | as before | Items now carry `unit`, `consumable`, `reorder_level` |

**Errors from `POST /movements`.** 400 for a broken sign rule, a field that belongs to another kind, a day in the future,
an asset item (`Fridge is a single tracked item; only stock lines take deliveries and use`); 404 for an unknown item or
another school's; 409 when the stock is not there (`Only 5 kg of Rice in stock`, or `8 of Exercise books are out with
people or not returned; the stock cannot fall below that`) or the item is written off (`Old flour has been written off`).
The 409 messages are the Supabase wording, with the real numbers read under the lock.

**Stock levels** are `inventory_stock_levels` on Supabase, with the same maths. For each live stock line (not an asset,
not written off): `quantity` (the register's count now), `unit_cost_cents`, `value_cents` (quantity times price), use and
waste over the 28 days to `as_of`, `avg_daily_use` (used / 28, 2 decimals), `days_of_cover` (quantity / average use,
1 decimal; null with no use), `low` (at or below the reorder level), `last_received_on`, and `next_delivery_on` (the last
delivery plus the median gap between delivery days in the 120 days to `as_of`). Ordered by store, then name. `as_of`
defaults to the school's today.

## Who reads and writes

| Who | Record movements | Read movements and stock levels |
|---|---|---|
| School administrator | yes | yes |
| Teacher or staff holding the **Inventory** area | yes | yes |
| Org admin with a delegation of `area.inventory` | yes | yes |
| Any other teacher or staff, a holder of another area, an org admin without a delegation | no (audited 403) | no (audited 403) |
| Parent, student, driver | no | no |
| Another school, a suspended school | no | no |

No new permission: `resource.inventory.read` and `.write` already mean "the register" and come with the Inventory area.

## What differs from Supabase, and why

1. **Who reads.** On Supabase any staff member of the school can read movements and the reports (`is_staff()`). On the API
   they need `resource.inventory.read` (administrators and Inventory-area holders), as the items and issues routes already
   do. The stock pages are office pages, so no screen loses anything; a teacher without the area cannot read stock here.
2. **"What is out on issues"** is `inventory_out_count()`: issues that are out, lost or damaged (migration 063). On the
   API a lost or damaged issue stays against the item's count (the count is never reduced), so the stock may not fall below
   those either. On Supabase, closing an issue as lost takes the copies off the count, and a damaged return is back on the
   shelf, so only `out` counts. The rule is the same (stock never below what the register owes to issues); the accounting
   underneath is the API's own. For a consumable this almost never matters: kitchen food is not issued.
3. **Sick-bay medicine is not counted as use.** Supabase's ledger adds medicine the sick bay gave from a Medical stock line
   (`visit_medications`) as `used` for "Sick bay". The API's sick bay does not take medicine from stock (migration 052
   deferred it), so there is nothing to count: on the API clinic use must be recorded as `used` movements. Stock levels and
   the S1b reports therefore read movements only.
4. **The trigger runs as the caller** (SECURITY INVOKER; Supabase: SECURITY DEFINER). Row security then decides which item it
   can lock and move, and the runtime role already holds the column grants it needs (`UPDATE` of `quantity`,
   `unit_cost_cents`). No owner rights are lent.
5. **The day.** `occurred_on` defaults to the school's today in its own time zone (Supabase: the database's date), and a
   day in the future is refused by the server (on Supabase only the screen refuses it, in `movementProblem`).
6. **Same-school and audit guards** (`20261125000000`): the API uses the composite key instead of a same-school trigger,
   and writes the audit event from the route, as the rest of inventory does. There is no update or delete to audit.
7. **A recorder cannot be deleted** while their movements exist (`recorded_by` has no `ON DELETE`). On Supabase the column
   says `on delete set null`, but the no-update trigger refuses that update, so in practice it is the same. The API deletes
   no users.
8. **Fields refused, not dropped.** The Supabase screen quietly drops a price on a use, or meals served on a delivery; the
   database refuses them. The API refuses them with 400 too (it is the database's rule).
9. **A stock line may be created at 0** (Supabase allows it; the API used to require at least 1). An asset stays at 1, and
   an asset with a unit, consumable or reorder level is refused (on Supabase the screen nulls them).

## Not in S1a (said so on purpose)

- **No item PATCH.** The API has no item edit today (`editItem` is false on the API build). Changing an existing item's
  unit, consumable flag or reorder level is part of that edit form, which stays hidden. The stock pages themselves do not
  edit items. Adding PATCH is a separate change.
- **No item price on create.** `unit_cost_cents`, `purchased_on` and `notes` stay out of the item shapes
  (`itemCostAndNotes` is false on the API build). A priced delivery sets the price, and `GET /stock-levels` returns it.
- **No `Idempotency-Key`** on `POST /movements` (as on Supabase). A double tap records twice; the screen disables its button
  while saving.

## Notes for the web slice (S1c)

- `recordStockMovement` maps to `POST /movements` with `item_id`, `kind`, `quantity`, `occurred_on`, `unit_cost_cents`,
  `supplier`, `reference`, `purpose`, `meals_served`, `note`. Send `unit_cost_cents` and `supplier` only for `received`,
  `meals_served` only for `used`, or the API answers 400.
- `fetchMovements(itemId)` maps to `GET /movements?item_id=...` (page with `listAllPages`, or stop at 500 as Supabase does).
  `recordedByName` is `recorded_by_name`. Numbers come back as numbers (no `String`/`Number` dance).
- `fetchStockLevels` maps to `GET /stock-levels` (field names are Supabase's).
- Stock-take: `stockTakeDelta(onHand, counted)` uses `item.quantity`. On the API that count still includes lost and damaged
  issued copies (difference 2), which only matters for a stock line that is also issued.
