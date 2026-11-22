-- Stage 11 remediation (review F-13): the worker role loses a grant it never uses. Forward-only.
--
-- The settle job reads payments, invoices (and, through the invoice triggers, lines, charges, adjustments and proofs), the
-- provider evidence ledger and jobs. It never reads a fee item: fee items are consulted only when a term is billed, which is an
-- API act. WORKER-ISOLATION-PROPOSAL §3/§4 asks for grants that are exactly what the registered job types need. The grant was
-- shown to be unnecessary by the targeted Stage 11 suites (settlement, recompute triggers, operator reconciliation, interleaved
-- tenants: 232 tests) passing without it; a full-suite run on the final tree is still owed (see docs/acceptance/stage11-worker-remediation). The remaining worker SELECT grants are each required by an invoker trigger or by the settlement itself.
REVOKE SELECT ON finance_fee_items FROM figbloom_worker;
