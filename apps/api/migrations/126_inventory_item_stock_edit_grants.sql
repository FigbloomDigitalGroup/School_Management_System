-- Item edits may change stock configuration, but the API never has table-level UPDATE.
GRANT UPDATE (unit, consumable, reorder_level) ON inventory_items TO figbloom_app;
