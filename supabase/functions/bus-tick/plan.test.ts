import { assertEquals } from "jsr:@std/assert@1";
import { personalise, plan, type Eta, type Stop, type StopState } from "./plan.ts";

// Kijani Ridge's Route 1, from_school order: school, South B shops, Enterprise Road, Imara Daima.
const STOPS: Stop[] = [
  { id: "school", name: "Kijani Ridge Academy", lat: -1.3104, lng: 36.8340, sequence: 1 },
  { id: "southb", name: "South B shops", lat: -1.3098, lng: 36.8420, sequence: 2 },
  { id: "enterprise", name: "Enterprise Road", lat: -1.3191, lng: 36.8652, sequence: 3 },
  { id: "imara", name: "Imara Daima", lat: -1.3290, lng: 36.8790, sequence: 4 },
];
const NOW = new Date("2026-10-07T13:00:00Z");
const riders = new Set(["enterprise"]);

function run(pos: { lat: number; lng: number }, said: string[] = [], extra: Partial<StopState> = {}, eta?: Eta) {
  const state = new Map([["enterprise", { said: new Set(said), baselineEta: null, lateNotifiedMin: 0, ...extra }]]);
  const etas = new Map(eta ? [["enterprise", eta]] : []);
  return plan({ direction: "from_school", stops: STOPS, pos, riderStopIds: riders, state, etas, fresh: true, now: NOW, timeZone: "Africa/Nairobi" });
}
const keys = (p: ReturnType<typeof run>) => p.flatMap((s) => s.updates.map((u) => u.key));

Deno.test("leaving school, far from the stop: trip started with the arrival time", () => {
  const p = run({ lat: -1.3104, lng: 36.8340 }, [], {}, { at: new Date(NOW.getTime() + 12 * 60_000), trafficMin: 0, estimated: false });
  assertEquals(keys(p), ["started"]);
  assertEquals(p[0]!.updates[0]!.title, "Bus has left school");
  assertEquals(p[0]!.updates[0]!.body, "Heading to Enterprise Road · 16:12 (12 min)");
});

Deno.test("within 2 km: the 2 km milestone, once", () => {
  const pos = { lat: -1.3135, lng: 36.8520 }; // ~1.9 km out along the route
  assertEquals(keys(run(pos, ["started"])), ["m2000"]);
  assertEquals(keys(run(pos, ["started", "m2000"])), []);
});

Deno.test("jumping straight inside 500 m only announces 500 m", () => {
  const pos = { lat: -1.3175, lng: 36.8622 };
  assertEquals(keys(run(pos, ["started"])), ["m500"]);
  // and a closer milestone already said silences the further ones
  assertEquals(keys(run({ lat: -1.3135, lng: 36.8520 }, ["started", "m1000"])), []);
});

Deno.test("at the stop: arrived, then nothing more for it", () => {
  const at = { lat: -1.3191, lng: 36.8653 };
  assertEquals(keys(run(at, ["started", "m500"])), ["arrived"]);
  // once past it, the stop drops out of the plan entirely
  assertEquals(run({ lat: -1.3280, lng: 36.8780 }, ["arrived"]), []);
});

Deno.test("running late: a single slipped reading is held, not announced", () => {
  const base = new Date(NOW.getTime() + 10 * 60_000);
  const late = { at: new Date(base.getTime() + 9 * 60_000), trafficMin: 6, estimated: false };
  const p = run({ lat: -1.3104, lng: 36.8340 }, ["started"], { baselineEta: base }, late);
  assertEquals(keys(p), []);
  assertEquals(p[0]!.latePendingMin, 9);
  // ...and if the next check is back near the promise, it's forgotten
  const back = { ...late, at: new Date(base.getTime() + 2 * 60_000) };
  assertEquals(run({ lat: -1.3104, lng: 36.8340 }, ["started"], { baselineEta: base, latePendingMin: 9 }, back)[0]!.latePendingMin, null);
});

Deno.test("running late: confirmed by a second check, with the traffic reason", () => {
  const base = new Date(NOW.getTime() + 10 * 60_000);
  const late = { at: new Date(base.getTime() + 8 * 60_000), trafficMin: 6, estimated: false };
  const p = run({ lat: -1.3104, lng: 36.8340 }, ["started"], { baselineEta: base, latePendingMin: 10 }, late);
  assertEquals(keys(p), ["late8"]);
  assertEquals(p[0]!.updates[0]!.body.startsWith("Heavy traffic · about 8 min behind"), true);
  assertEquals(p[0]!.lateNotifiedMin, 8);
  // 11 min late after announcing 8: not another 5 yet
  const later = { ...late, at: new Date(base.getTime() + 11 * 60_000) };
  assertEquals(keys(run({ lat: -1.3104, lng: 36.8340 }, ["started", "late8"], { baselineEta: base, lateNotifiedMin: 8 }, later)), []);
  // estimates never claim lateness
  assertEquals(keys(run({ lat: -1.3104, lng: 36.8340 }, ["started"], { baselineEta: base }, { ...late, estimated: true })), []);
});

Deno.test("personalise names the family's own children", () => {
  assertEquals(personalise("Bus is 1 km away", ["Amani"]), "Amani's bus is 1 km away");
  assertEquals(personalise("Bus is 1 km away", ["Amani", "Baraka"]), "Amani and Baraka's bus is 1 km away");
});
