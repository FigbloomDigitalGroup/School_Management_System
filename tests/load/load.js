/* global __ENV, __VU, open, console */
// k6 load test for the load school made by tests/load/*. LOCAL STACK ONLY: run it with tests/load/run.sh.
//
// It replays the requests the apps really send (captured by calling the app's own loaders and logging every
// fetch): the parent home screen (about 13 calls), the teacher register (about 9 calls), record_payment, and a
// password sign-in. Every request is tagged with a name, so the summary gives p50 and p95 per call.
//
//   SCEN = parents          closed loop: ramp to PARENTS virtual parents who keep re-opening the app
//          parents_once     every parent opens the app once (SPREAD=60 spreads them over a minute)
//          registers        TEACHERS teachers submit one register each, spread over about 5 minutes
//          registers_burst  the same, all at the same instant
//          payments         100 payments recorded by PAY_VUS (20) clerks
//          signin           PARENTS password sign-ins at once (XFF=1 gives each its own address)
//   SMOKE=1 shrinks every scenario to a few users, to check the script itself.
import http from "k6/http";
import exec from "k6/execution";
import { sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";

const BASE = __ENV.BASE;
const ANON = __ENV.ANON;
const SCEN = __ENV.SCEN;
if (!BASE || BASE.indexOf("supabase_kong") === -1) throw new Error("BASE must be the local Kong container (run it with run.sh)");

const PARENTS = Number(__ENV.PARENTS || 500);
const TEACHERS = Number(__ENV.TEACHERS || 60);
const CLASS_TEACHERS = Number(__ENV.CLASS_TEACHERS || 36);
const tokens = JSON.parse(open("/data/tokens.json"));
const accounts = JSON.parse(open("/data/accounts.json"));
const payables = JSON.parse(open("/data/payables.json"));

const flowMs = new Trend("flow_total_ms", true);
const notOk = new Rate("req_not_2xx");
const s500 = new Counter("status_500_incl_timeouts");
const s429 = new Counter("status_429");
const sOther = new Counter("status_other_non_2xx");
const flowsDone = new Counter("flows_completed");
const flowsBroken = new Counter("flows_with_a_failed_request");
const byStatus = {};
for (const c of [0, 400, 401, 403, 404, 409, 429, 500, 502, 503, 504]) byStatus[c] = new Counter("http_status_" + c);

const pad = (n, w) => String(n).padStart(w, "0");
function note(res) {
  const ok = res.status >= 200 && res.status < 300;
  notOk.add(!ok);
  if (byStatus[res.status]) byStatus[res.status].add(1);
  if (res.status === 0 && __VU <= 3) console.log("status 0: error_code=" + res.error_code + " " + String(res.error).slice(0, 100));
  if (!ok) { if (res.status === 500) s500.add(1); else if (res.status === 429) s429.add(1); else sOther.add(1); }
  return ok;
}
function hdr(tok, extra) {
  const h = { apikey: ANON, "Content-Type": "application/json" };
  if (tok) h.Authorization = "Bearer " + tok;
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}
function call(name, method, path, tok, body, extra) {
  return http.request(method, BASE + path, body ? JSON.stringify(body) : null, { headers: hdr(tok, extra), tags: { name: name }, timeout: "60s" });
}
function batch(reqs, tok) {
  return http.batch(reqs.map((r) => ({
    method: r[1], url: BASE + r[2], body: r[3] ? JSON.stringify(r[3]) : null,
    params: { headers: hdr(tok), tags: { name: r[0] }, timeout: "60s" },
  })));
}
const arr = (x) => (Array.isArray(x) ? x : []);
const json = (res) => { try { return res.json(); } catch { return null; } };

// ---------------------------------------------------------------- options
const NAMES = {
  parents: ["p01_guardians", "p02_terms", "p03_invoices", "p04_attendance", "p05_marks_published", "p06_class_means", "p07_marks_one_exam",
            "p08_fee_items", "p09_payments", "p10_announcements", "p11_reads", "p12_fee_charges"],
  registers: ["t01_profile", "t02_classes_teacher", "t03_assignments", "t04_classes_in", "t05_term", "t06_roster", "t07_marks_today", "t08_SUBMIT_register"],
  payments: ["a01_record_payment"],
  signin: ["s01_password_sign_in"],
};
NAMES.registers_burst = NAMES.registers;
NAMES.parents_once = NAMES.parents;
const smoke = __ENV.SMOKE === "1";
const scen = {
  parents: { executor: "ramping-vus", startVUs: 0, exec: "parents", gracefulRampDown: "30s", gracefulStop: "60s",
             stages: [{ duration: "30s", target: Math.round(PARENTS / 5) }, { duration: "30s", target: Math.round(PARENTS * 0.6) }, { duration: "30s", target: PARENTS }, { duration: "60s", target: PARENTS }, { duration: "15s", target: 0 }] },
  parents_once: { executor: "per-vu-iterations", vus: Number(__ENV.PARENT_VUS || PARENTS), iterations: 1, maxDuration: "5m", exec: "parentsOnce" },
  registers: { executor: "per-vu-iterations", vus: TEACHERS, iterations: 1, maxDuration: "12m", exec: "registers" },
  registers_burst: { executor: "per-vu-iterations", vus: TEACHERS, iterations: 1, maxDuration: "12m", exec: "registers" },
  payments: { executor: "shared-iterations", vus: Number(__ENV.PAY_VUS || 20), iterations: Math.min(100, payables.length), maxDuration: "12m", exec: "payments" },
  signin: { executor: "per-vu-iterations", vus: Number(__ENV.SIGNIN_VUS || PARENTS), iterations: 1, maxDuration: "10m", exec: "signin" },
};
if (smoke) {
  scen.parents = { executor: "constant-vus", vus: 3, duration: "10s", exec: "parents" };
  scen.parents_once.vus = 3;
  scen.registers = { executor: "per-vu-iterations", vus: 3, iterations: 1, maxDuration: "2m", exec: "registers" };
  scen.registers_burst = scen.registers;
  scen.payments = { executor: "shared-iterations", vus: 2, iterations: 3, maxDuration: "2m", exec: "payments" };
  scen.signin.vus = 5;
}
// Budgets: every request under 2 s at p95, a whole screen load under 3 s. Today they are crossed (see the README).
const thresholds = { req_not_2xx: ["rate<0.01"], flow_total_ms: ["p(95)<3000"] };
for (const n of NAMES[SCEN] || []) thresholds["http_req_duration{name:" + n + "}"] = ["p(95)<2000"];
export const options = { scenarios: { [SCEN]: scen[SCEN] }, thresholds: thresholds, summaryTrendStats: ["min", "med", "p(90)", "p(95)", "max"] };

// ---------------------------------------------------------------- parents open the app (a session already exists)
export function parents() {
  const me = tokens["PT-L" + pad(((__VU - 1) % PARENTS) + 1, 4)];
  const t0 = Date.now();
  let broken = false;
  const mark = (r) => { if (!note(r)) broken = true; return r; };

  const g = mark(call("p01_guardians", "GET", "/rest/v1/guardians?select=students(id,full_name,admission_no,class_id,boarding,classes(name,form_level,level))&profile_id=eq." + me.id, me.token));
  if (g.status !== 200) { flowMs.add(Date.now() - t0); flowsBroken.add(1); return; } // the app throws here and shows an error
  const kids = arr(json(g)).map((x) => x.students).filter((s) => s);
  const ids = kids.map((k) => k.id).join(",");

  const b2 = batch([
    ["p02_terms", "GET", "/rest/v1/terms?select=id,name&is_current=eq.true"],
    ["p03_invoices", "GET", "/rest/v1/fee_invoices?select=id,student_id,total_cents,paid_cents,due_on,terms!inner(is_current)&student_id=in.(" + ids + ")&terms.is_current=eq.true"],
    ["p04_attendance", "GET", "/rest/v1/attendance?select=student_id,mark,taken_on&student_id=in.(" + ids + ")"],
    ["p05_marks_published", "GET", "/rest/v1/marks?select=student_id,exam_id,score,exams(name,published_at)&student_id=in.(" + ids + ")&order=exam_id.asc,student_id.asc,subject_id.asc&offset=0&limit=1000"],
  ], me.token);
  b2.forEach(mark);
  const termId = (arr(json(b2[0]))[0] || {}).id;
  const invoiceIds = arr(json(b2[1])).map((i) => i.id).join(",");
  const newest = {};
  for (const m of arr(json(b2[3]))) {
    const pub = (m.exams && m.exams.published_at) || "";
    if (!newest[m.student_id] || pub > newest[m.student_id].pub) newest[m.student_id] = { exam: m.exam_id, pub: pub };
  }

  const reqs = [];
  for (const k of kids) {
    const n = newest[k.id];
    if (!n) continue;
    reqs.push(["p06_class_means", "POST", "/rest/v1/rpc/class_means_for_exam", { p_exam_id: n.exam, p_class_id: k.class_id }]);
    reqs.push(["p07_marks_one_exam", "GET", "/rest/v1/marks?select=score,subject_id,subjects(name)&exam_id=eq." + n.exam + "&student_id=eq." + k.id]);
  }
  reqs.push(["p08_fee_items", "GET", "/rest/v1/fee_items?select=id,name,amount_cents,applies_to,form_level,level&term_id=eq." + termId]);
  // Starts from the children's invoices and has the database fetch each one's payments (packages/shared/src/paidPayments.ts, FIG-1497); the older
  // shape, payments with the invoice embedded, made PostgREST permission-check every payment of every school first.
  reqs.push(["p09_payments", "GET", "/rest/v1/fee_invoices?select=student_id,payments!inner(id,amount_cents,method,mpesa_receipt,reference,msisdn,completed_at,created_at)&student_id=in.(" + ids + ")&payments.status=eq.success"]);
  reqs.push(["p10_announcements", "GET", "/rest/v1/announcements?select=id,subject,body,audience,published_at,created_at,profiles!announcements_author_id_fkey(full_name,role)&order=created_at.desc"]);
  reqs.push(["p11_reads", "GET", "/rest/v1/announcement_reads?select=announcement_id&profile_id=eq." + me.id]);
  batch(reqs, me.token).forEach(mark);

  mark(call("p12_fee_charges", "GET", "/rest/v1/fee_charges?select=id,invoice_id,student_id,amount_cents,reason,issue_id,created_at,voided_at,void_reason&invoice_id=in.(" + invoiceIds + ")&order=created_at.asc", me.token));

  flowMs.add(Date.now() - t0);
  if (broken) flowsBroken.add(1); else flowsDone.add(1);
  sleep(2);
}

export function parentsOnce() {
  const spread = Number(__ENV.SPREAD || 0);
  if (spread > 0) sleep(Math.random() * spread);
  parents();
}

// ---------------------------------------------------------------- teachers submit a register
export function registers() {
  const i = __VU;
  if (SCEN === "registers" && !smoke) sleep((i - 1) * (300 / TEACHERS)); // spread over about 5 minutes
  const me = tokens["TC-L" + pad(i, 3)];
  const t0 = Date.now();
  let broken = false;
  const mark = (r) => { if (!note(r)) broken = true; return r; };

  mark(call("t01_profile", "GET", "/rest/v1/profiles?select=tenant_id&id=eq." + me.id, me.token));
  const b = batch([
    ["t02_classes_teacher", "GET", "/rest/v1/classes?select=*&class_teacher_id=eq." + me.id],
    ["t03_assignments", "GET", "/rest/v1/teaching_assignments?select=class_id&teacher_id=eq." + me.id],
  ], me.token);
  b.forEach(mark);
  const own = arr(json(b[0])).map((c) => c.id);
  const taught = arr(json(b[1])).map((c) => c.class_id);
  const allIds = Array.from(new Set(own.concat(taught)));
  mark(call("t04_classes_in", "GET", "/rest/v1/classes?select=*&id=in.(" + allIds.join(",") + ")", me.token));
  const term = arr(json(mark(call("t05_term", "GET", "/rest/v1/terms?select=*&is_current=eq.true", me.token))))[0];
  const classId = own.length ? own[0] : taught[0];
  // Class teachers take the morning register (one date); the others take a lesson register for a class they teach,
  // each on its own date, so that no two teachers write the same rows.
  const date = i <= CLASS_TEACHERS ? "2026-11-02" : "2026-12-" + pad(1 + (i - CLASS_TEACHERS - 1), 2);

  const roster = arr(json(mark(call("t06_roster", "GET", "/rest/v1/students?select=*&class_id=eq." + classId + "&active=eq.true&order=full_name.asc", me.token))));
  mark(call("t07_marks_today", "GET", "/rest/v1/attendance?select=student_id,mark&class_id=eq." + classId + "&taken_on=eq." + date, me.token));

  const rows = roster.map((s, n) => ({
    tenant_id: s.tenant_id, student_id: s.id, class_id: classId, term_id: term.id, taken_by: me.id, taken_on: date,
    mark: n % 17 === 0 ? "absent" : n % 11 === 0 ? "late" : "present", note: null,
  }));
  const sub = mark(call("t08_SUBMIT_register", "POST",
    '/rest/v1/attendance?on_conflict=student_id,taken_on&columns="tenant_id","student_id","class_id","term_id","taken_by","taken_on","mark","note"',
    me.token, rows, { Prefer: "resolution=merge-duplicates,return=minimal" }));
  if (sub.status >= 300) console.log("register " + i + " status " + sub.status + " " + String(sub.body).slice(0, 120));

  flowMs.add(Date.now() - t0);
  if (broken) flowsBroken.add(1); else flowsDone.add(1);
}

// ---------------------------------------------------------------- payments recorded by the bursar's office
export function payments() {
  const me = tokens["ADM-L001"];
  const inv = payables[exec.scenario.iterationInTest];
  const t0 = Date.now();
  const res = call("a01_record_payment", "POST", "/rest/v1/rpc/record_payment", me.token,
    { p_invoice_id: inv, p_amount_cents: smoke ? 100 : 100000, p_method: "cash", p_reference: null, p_proof_id: null });
  const ok = note(res);
  if (!ok) console.log("payment status " + res.status + " " + String(res.body).slice(0, 140));
  flowMs.add(Date.now() - t0);
  if (ok) flowsDone.add(1); else flowsBroken.add(1);
}

// ---------------------------------------------------------------- password sign-ins, each from its own address
export function signin() {
  const parentAccounts = accounts.filter((x) => x.role === "parent");
  const a = parentAccounts[(__VU - 1) % parentAccounts.length];
  const xff = "10." + (Math.floor(__VU / 250) % 250) + "." + (__VU % 250) + "." + (((__VU * 7) % 250) + 1);
  const t0 = Date.now();
  const res = http.post(BASE + "/auth/v1/token?grant_type=password", JSON.stringify({ email: a.email, password: "figbloom-dev" }),
    { headers: hdr(null, __ENV.XFF === "1" ? { "X-Forwarded-For": xff } : {}), tags: { name: "s01_password_sign_in" }, timeout: "60s" });
  const ok = note(res);
  flowMs.add(Date.now() - t0);
  if (ok) flowsDone.add(1); else flowsBroken.add(1);
}
