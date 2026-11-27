# Inventory issue history and fee charges (W1.7)

## Issue history

`GET /inventory/issues` keeps its current default of open issues. `?status=all` returns the full history; `status=out`,
`returned`, `damaged`, or `lost` filters to one status. Status is part of the keyset cursor fingerprint. Issue creation
accepts an optional note (up to 1,000 characters); note text is not copied into audit events.

## Charge a lost or damaged item

The existing `POST /finance/invoices/{invoiceId}/charges` accepts an optional `inventory_issue_id`. If supplied, the
issue must be closed as lost or damaged, belong to a learner, and match the invoice's learner. One issue can be linked
to at most one charge. The link is stored on the immutable finance charge row and appears in invoice detail reads.
Existing charge requests without this field keep their current behavior. Fee authorization, whole-shilling amount
rules, current-term restriction, idempotency and paid-balance checks remain in force.

Migration `130_inventory_issue_charges.sql` adds the same-school foreign key, uniqueness and database guard for the
link. Inventory history reads continue to require `resource.inventory.read`; creating an issue still requires
`resource.inventory.write`; creating the fee charge requires `resource.finance.administer`.
