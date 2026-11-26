# Inventory (`admin/inventory`, `teacher/items`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin/inventory` (`AdminInventory`), `admin/inventory/stock/:section` (the Stock & kitchen pages, no menu entry of their own), `teacher/items` (`TeacherItems`), and `staff/items` (registered in `staff-shell.pages.tsx` with `staffMayReadItems`). Capability flags: `inventoryCapabilities()` and `canReadMyItems()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/inventoryApi.ts` (register and issues) and `packages/shared/src/api/stockApi.ts` (stock in and out and the reports), registered in `apps/web/src/api/pages/inventory.pages.tsx`.

## What works on the API build

- **Admin & Inventory-area holders (`admin/inventory`):** view active register items with out/available counts, add stock or tracked-asset items, issue items to learners, user-linked staff, or a whole class, view open and overdue issues, record returns (`returned`, `damaged`, or `lost`), write off items with nothing out, and export CSV.
- **My items (`teacher/items`):** for school administrators and holders of the **Inventory** area (`canReadMyItems`), `fetchMyInventory` loads open issues from `GET /v1/tenants/{tenantId}/inventory/issues` filtered to `holder_user_id === profile.id`.
- **Stock & kitchen (slice S1c).** The same screens as the Supabase build, on the endpoints of `apps/api/docs/INVENTORY-STOCK.md`. The shared functions keep their signatures and Supabase's field names; each has an `onApi()` branch into `stockApi.ts`.
  - **Add a stock line** with a unit, "used up" (consumable) and a reorder level (`POST /inventory/items`). A stock line may start at 0.
  - **Receive, Use, Waste and Stock-take** on an item (`POST /inventory/movements`). A price and supplier go only on a delivery, meals served only on a use, as on Supabase. The item's **history** (`GET /inventory/movements?item_id=`, last 500, with the recorder's name).
  - **The Stock & kitchen tab and its nine pages**: stock value and levels (`/stock-levels`), low stock, flags (`/reports/flags`), spend by month, use per item and its trend, trends and per-head charts (`/reports/usage`, `/reports/headcount`), kitchen cost per meal, clinic, and uniforms. The item names come from `GET /inventory/items`.
  - **A refused movement** shows the server's own sentence: `Only 10 kg of Rice in stock` (409, when another person used the stock after this screen loaded), an item written off (409), a price on a use or a day in the future (400).

## What is hidden and why

| Hidden on the API build | Missing in the API |
|---|---|
| Plain teachers without Inventory area (`teacher/items`) | `GET /v1/tenants/{tenantId}/inventory/issues` requires `resource.inventory.read`, which regular teachers do not hold (finding 13 / `staff-1`) |
| Edit item & restore written-off item (`editItem`, `unretireItem`). This includes changing an existing stock line's unit, "used up" flag and reorder level: they are set when the item is added and cannot be changed afterwards | No `PATCH /inventory/items/{itemId}` or unretire endpoint; `GET /inventory/items` returns active items only |
| Purchase date, unit cost, and notes | Not stored on `InventoryItem`. A priced delivery sets the item's price (shown on the stock value page) |
| Closed-issue History tab & Lost counter | `GET /inventory/issues` returns open (`status = 'out'`) issues only |
| Hand-out note & charging lost/damaged items to fees | `POST /inventory/issues` accepts no note; fee charge lookup waits on closed-issue history |
| The "AI insights" panel on Stock & kitchen (`stockInsights`) | `stock_insights` is not in the Bloom contract (`bloom-school/1` is chat only, 4,000-character prompts, no structured answer: `INVENTORY-STOCK.md`, "stock_insights") |
| "Billed to families" on the Uniforms page, and uniforms that have come back | Charging fees for an item needs the closed-issue history (above), and the API lists open issues only, so the page counts uniforms still out with people. Its text says so |
| "This term" period, for a person who may not read the term's dates | `GET /academic-terms` needs the Academics area (or teaching a class). `fetchCurrentTermDates` answers `null` for a refusal and the period is left out; a link that asks for it falls back to the year |

Things the screens now say differently on the API build (each is a flag in `inventoryCapabilities()`; on Supabase every one of them is as it was): the Clinic page and the Use form for a Medical item say that sick-bay medicine is **not** taken off stock by itself and must be recorded as use (`sickBayUsesStock`, finding `inventory-6`); a report period is cut to its last 366 days (`reportMaxDays`, finding `inventory-8`); "This term" is offered only when the term's dates were read (`termDatesNeedAcademics`, finding `inventory-4`).

## API notes

- **inventory-1:** As also noted in [the staff shell doc](staff-shell.md) (`staff-1`) and finding 13, `GET /inventory/issues` requires `resource.inventory.read` instead of offering a caller-scoped `GET /me/inventory-issues` endpoint, so teachers and non-Inventory staff cannot see items issued to them yet unless granted the Inventory area.
- **inventory-2: A written-off item has no name in the reports.** `GET /inventory/items` lists live items only, and `/reports/usage` rows carry an `item_id` and no name (the flags and stock levels do carry one). A written-off item that had use in the period shows as "Item" in the use tables and is counted under "Other". The API already has `includeRetired` in `listInventoryItems`; exposing it (`?include_retired=true`) or adding `item_name` to the usage rows fixes it.
- **inventory-3: No item PATCH.** A wrong unit, "used up" flag or reorder level cannot be put right: the only way is to write the item off and add it again, which loses its history. The Edit button stays hidden (`editItem`).
- **inventory-4: "This term" needs the Academics area.** A school administrator, and a teacher who teaches a class, read the terms. A member of staff with only the Inventory area (a storekeeper) gets 403 on `GET /academic-terms`, so the web leaves "This term" out. Adding the current term's dates to `GET /inventory/stock-levels` (or letting `resource.inventory.read` read the current term) would give them the period. The demo teacher could read terms through the teaching role, so the browser check simulated the 403.
- **inventory-5: The Uniforms page counts only what is out.** The list of issues has open issues only, so a returned or lost uniform is not counted, and what was billed cannot be shown. The page says so.
- **inventory-6: Sick-bay medicine is not use.** The API's sick bay does not take medicine from a Medical stock line (`INVENTORY-STOCK.md`, "What differs", 3), so the clinic usage, stock levels and flags read only what was recorded by hand. Supabase counts what the sick bay gave as use.
- **inventory-7: No AI briefing.** See the table above. The panel returns when a structured capability exists in the Bloom contract and a route such as `POST /inventory/insights` reads the flags with the caller's rights.
- **inventory-8: Report periods are limited.** The ledger, usage, spend and cost-per-meal reports answer for at most 400 days, the flags for 366 (headcount 400). The screens' periods are a week, a month, a term or a calendar year, so none is refused, except a term whose dates were never moved on (or one set to run for years): the web cuts every report period to its last 366 days (`capRange`) and the date range above the cards shows what is covered.
- **inventory-9: The Receive form does not pre-fill the last price.** `InventoryItem` has no `unit_cost_cents`; only `GET /stock-levels` has it. The web leaves the price blank (Supabase fills in the item's price).
- **inventory-10: No `Idempotency-Key` on `POST /movements`** (as on Supabase). A double tap records twice. The screen disables its button while saving, and a mistake is corrected with a Stock-take.
- **inventory-11: The ledger has no screen.** `GET /inventory/reports/ledger` is in the API and no screen asks for it (Supabase's `inventory_ledger` has no caller in the web app either), so nothing was ported for it.
- **inventory-12: "Learners present" is the roll.** The per-head chart's text says "learners present", and the headcount function (Supabase's and the API's) counts learners **on the roll**, not who came. The API's note says the same. Unchanged here: the wording is on both builds.
