# Inventory (`admin/inventory`, `teacher/items`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin/inventory` (`AdminInventory`), `teacher/items` (`TeacherItems`), and `staff/items` (registered in `staff-shell.pages.tsx` with `staffMayReadItems`). Capability flags: `inventoryCapabilities()` and `canReadMyItems()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/inventoryApi.ts`, registered in `apps/web/src/api/pages/inventory.pages.tsx`.

## What works on the API build

- **Admin & Inventory-area holders (`admin/inventory`):** view active register items with out/available counts, add stock or tracked-asset items, issue items to learners, user-linked staff, or a whole class, view open and overdue issues, record returns (`returned`, `damaged`, or `lost`), write off items with nothing out, and export CSV.
- **My items (`teacher/items`):** for school administrators and holders of the **Inventory** area (`canReadMyItems`), `fetchMyInventory` loads open issues from `GET /v1/tenants/{tenantId}/inventory/issues` filtered to `holder_user_id === profile.id`.

## What is hidden and why

| Hidden on the API build | Missing in the API |
|---|---|
| Plain teachers without Inventory area (`teacher/items`) | `GET /v1/tenants/{tenantId}/inventory/issues` requires `resource.inventory.read`, which regular teachers do not hold (finding 13 / `staff-1`) |
| Edit item & restore written-off item | No `PATCH /inventory/items/{itemId}` or unretire endpoint; `GET /inventory/items` returns active items only |
| Purchase date, unit cost, and notes | Not stored on `InventoryItem` |
| Closed-issue History tab & Lost counter | `GET /inventory/issues` returns open (`status = 'out'`) issues only |
| Hand-out note & charging lost/damaged items to fees | `POST /inventory/issues` accepts no note; fee charge lookup waits on closed-issue history |

## API note (`inventory-1`)

- **inventory-1:** As also noted in [the staff shell doc](staff-shell.md) (`staff-1`) and finding 13, `GET /inventory/issues` requires `resource.inventory.read` instead of offering a caller-scoped `GET /me/inventory-issues` endpoint, so teachers and non-Inventory staff cannot see items issued to them yet unless granted the Inventory area.
