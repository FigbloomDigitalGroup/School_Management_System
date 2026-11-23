/**
 * Argon2id benchmark for the deployment hardware (residual closure, workstream 7).
 *
 *   npx tsx scripts/argon2-benchmark.mts [--iterations 40] [--concurrency 1,2,4,8,16] [--out result.json] [--candidates]
 *
 * What it measures, using the ACTUAL configured parameters (ARGON2_PARAMS from src/modules/identity/password.ts) through the
 * ACTUAL hashPassword/verifyPassword code paths:
 *   * hash and verify latency (min / p50 / p95 / p99 / max) sequentially;
 *   * latency and throughput under concurrency (the libuv pool has 4 threads unless UV_THREADPOOL_SIZE is set; the memory held is
 *     about concurrency-limited-by-threads x memory KiB);
 *   * peak resident-set growth while running (sampled every 10 ms; indicative, includes the Node baseline);
 *   * the environment (CPU model/count, memory, OS, Node, threadpool size) so a result can be interpreted later.
 * With --candidates it also times OWASP's equivalent alternative parameter sets for comparison (m=19456,t=2; m=12288,t=3; m=9216,t=4;
 * all p=1). Candidates are measured only; NOTHING is changed and no production configuration is read or written.
 *
 * Safety: passwords are random per run and never printed; hashes are never printed or stored; no database, network or .env access.
 * Local results are INDICATIVE ONLY. Decision guidance: docs/ARGON2-BENCHMARK.md.
 */
import { randomBytes } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import { ARGON2_PARAMS, hashPassword, verifyPassword } from "../src/modules/identity/password.js";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : def;
};
const iterations = Math.max(5, Number(opt("iterations", "40")));
const concurrencies = opt("concurrency", "1,2,4,8,16").split(",").map((x) => Math.max(1, Number(x)));
const out = opt("out", "");
const candidates = args.includes("--candidates");

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const stats = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  return { n: s.length, min: +s[0]!.toFixed(1), p50: +pct(s, 50).toFixed(1), p95: +pct(s, 95).toFixed(1), p99: +pct(s, 99).toFixed(1), max: +s[s.length - 1]!.toFixed(1), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
};
const time = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};
const password = () => randomBytes(18).toString("base64url");

async function withPeakRss<T>(fn: () => Promise<T>): Promise<{ value: T; peakRssMiB: number; baselineRssMiB: number }> {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  try {
    const value = await fn();
    peak = Math.max(peak, process.memoryUsage().rss);
    return { value, peakRssMiB: +(peak / 1048576).toFixed(0), baselineRssMiB: +(baseline / 1048576).toFixed(0) };
  } finally {
    clearInterval(timer);
  }
}

async function main() {
  const argon2Cb = (nodeCrypto as unknown as { argon2?: (...a: never[]) => void }).argon2;
  if (typeof argon2Cb !== "function") throw new Error("crypto.argon2 is unavailable: Node >= 24.7 is required");
  const argon2 = promisify(argon2Cb as never) as unknown as (alg: "argon2id", p: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number }) => Promise<Buffer>;

  const env = {
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    logicalCpus: os.cpus().length,
    totalMemoryGiB: +(os.totalmem() / 1073741824).toFixed(1),
    freeMemoryGiB: +(os.freemem() / 1073741824).toFixed(1),
    uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "4 (default)",
    configured: ARGON2_PARAMS,
    when: new Date().toISOString(),
  };

  // warm-up (JIT, allocator, thread creation) is excluded from the figures
  const warm = password();
  const warmHash = await hashPassword(warm);
  await verifyPassword(warm, warmHash);

  const sampleSecret = password();
  const hashTimes: number[] = [];
  const verifyTimes: number[] = [];
  const failVerifyTimes: number[] = [];
  const seq = await withPeakRss(async () => {
    for (let i = 0; i < iterations; i++) {
      let h = "";
      hashTimes.push(await time(async () => (h = await hashPassword(sampleSecret))));
      verifyTimes.push(await time(() => verifyPassword(sampleSecret, h)));
      failVerifyTimes.push(await time(() => verifyPassword(sampleSecret + "x", h)));
    }
  });

  const conc: Record<string, unknown>[] = [];
  const baseHash = await hashPassword(sampleSecret);
  for (const c of concurrencies) {
    const lat: number[] = [];
    const rounds = Math.max(3, Math.ceil(iterations / c));
    const run = await withPeakRss(async () => {
      const t0 = performance.now();
      for (let r = 0; r < rounds; r++) await Promise.all(Array.from({ length: c }, async () => lat.push(await time(() => verifyPassword(sampleSecret, baseHash)))));
      return performance.now() - t0;
    });
    conc.push({ concurrentVerifications: c, ...stats(lat), throughputPerSecond: +(((rounds * c) / (run.value as number)) * 1000).toFixed(1), peakRssMiB: run.peakRssMiB, peakRssGrowthMiB: run.peakRssMiB - run.baselineRssMiB });
  }

  const cand: Record<string, unknown>[] = [];
  if (candidates) {
    for (const [memory, passes] of [[19456, 2], [12288, 3], [9216, 4]] as const) {
      const lat: number[] = [];
      for (let i = 0; i < Math.min(iterations, 20); i++) {
        lat.push(await time(() => argon2("argon2id", { message: Buffer.from(sampleSecret), nonce: randomBytes(16), parallelism: 1, tagLength: 32, memory, passes })));
      }
      cand.push({ memoryKiB: memory, passes, parallelism: 1, note: "OWASP-equivalent alternative: measured only, NOT applied", ...stats(lat) });
    }
  }

  const result = {
    note: "INDICATIVE ONLY unless run on the deployment hardware under production-like load. No passwords or hashes are recorded.",
    environment: env,
    sequential: { hash: stats(hashTimes), verifyCorrectPassword: stats(verifyTimes), verifyWrongPassword: stats(failVerifyTimes), peakRssMiB: seq.peakRssMiB, baselineRssMiB: seq.baselineRssMiB },
    concurrency: conc,
    candidates: cand,
  };
  const text = JSON.stringify(result, null, 2);
  if (out) writeFileSync(out, text);
  console.log(text);
}

main().catch((e) => {
  console.error("benchmark failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
