# Activities API: edits and archive (W1.4)

The API keeps the existing `activities`, `activity_patrons`, and `activity_members` tables. W1.4 adds no new permission and does not alter the columns or meaning already in use.

- `active` continues to mean that an activity is open. `PATCH` may update its details or close/reopen it.
- `DELETE /activities/{id}` archives it by setting a new `archived_at` timestamp. It never removes the activity or cascades its events, patrons, or members. There is no unarchive route.
- Normal activity lists and family activity reads omit archived rows. A direct members or patrons read of an archived activity returns 404; changes require an open, unarchived activity.
- Patron list entries use the teacher's signed-in user id and name, matching the existing create route. Patron delete and member delete remove only their association rows.
- Member role updates may change only `role`; ids, tenant, and join date remain immutable. Role may be null to clear it.
- All reads and writes require the existing `resource.activity.read` or `resource.activity.write` permission and use the caller's tenant transaction. Writes emit security audit events with record ids only.

The new archive marker and narrowly scoped column grants are additive migration 126. Migration 056 and all production Supabase behavior remain unchanged.
