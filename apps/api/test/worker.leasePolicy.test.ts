import { describe, expect, it } from "vitest";
import { leasePolicyViolation, minimumSafeLeaseSeconds, worstCaseHandlerSeconds } from "../src/worker/leasePolicy.js";

const DEFAULTS = { mpesaHttpTimeoutMs: 10_000, statementTimeoutMs: 15_000, poolAcquireTimeoutMs: 2_000 };

describe("worker lease guard (owner decision 6.9)", () => {
  it("the shipped defaults pass with margin; the previous 120 s lease does NOT (worst case 148 s)", () => {
    expect(worstCaseHandlerSeconds(DEFAULTS)).toBe(148);
    expect(minimumSafeLeaseSeconds(DEFAULTS)).toBe(185);
    expect(leasePolicyViolation({ ...DEFAULTS, leaseSeconds: 300 })).toBeNull();
    expect(leasePolicyViolation({ ...DEFAULTS, leaseSeconds: 185 })).toBeNull();
    expect(leasePolicyViolation({ ...DEFAULTS, leaseSeconds: 184 })).toMatch(/below the safe minimum 185s/);
    expect(leasePolicyViolation({ ...DEFAULTS, leaseSeconds: 120 })).toMatch(/WORKER_LEASE_SECONDS=120/);
    expect(leasePolicyViolation({ ...DEFAULTS, leaseSeconds: 5 })).not.toBeNull();
  });

  it("raising any timeout raises the required lease; tightening timeouts lowers it", () => {
    expect(minimumSafeLeaseSeconds({ ...DEFAULTS, mpesaHttpTimeoutMs: 60_000 })).toBeGreaterThan(minimumSafeLeaseSeconds(DEFAULTS));
    expect(minimumSafeLeaseSeconds({ ...DEFAULTS, statementTimeoutMs: 5_000 })).toBeLessThan(minimumSafeLeaseSeconds(DEFAULTS));
    expect(leasePolicyViolation({ leaseSeconds: 90, mpesaHttpTimeoutMs: 5_000, statementTimeoutMs: 5_000, poolAcquireTimeoutMs: 1_000 })).toBeNull();
  });
});
