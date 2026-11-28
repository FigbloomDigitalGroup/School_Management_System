-- Forward-only. Migrations 001-129 are not edited. Item edits may change stock configuration (W1.6), but the API never has table-level UPDATE.
GRANT UPDATE (unit, consumable, reorder_level) ON inventory_items TO figbloom_app;
