# D-17 — Multi-process rate-limit equivalence

**Status:** ACCEPTED with documented mechanism

The limiter is a PostgreSQL row-locked function (`consume_rate_token`). Multiple
API processes sharing one database serialize on the bucket row lock; concurrent
clients on one DB already prove the same mechanism (Session-1 / Session-2 tests).

A separate multi-process harness is optional hardening, not required to accept
the atomicity claim for P1-A.
