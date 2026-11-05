import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, signInAs, type SignedIn } from "./support/signInAs";

/**
 * QA 14 (FIG-1247), uploads: what can a signed-in person put into the two buckets that hold photos, logos and records, and what
 * happens when the file is opened straight from its address?
 *
 * What was found is written down as tests. A plain `it` is something that holds and must keep holding (a name that climbs out of the
 * school's folder is refused; an HTML page is not served as a page; private files are not served to the signed-out). An `it.fails`
 * is a bug already filed (its tag carries the FIG id): it passes while the bug exists and fails the day it is fixed; then change
 * it.fails to it.
 *
 * Everything written here is removed in afterAll, and afterAll then checks that nothing is left. Needs `npm run db:seed-org` (the
 * second school is Kijani Ridge). Local stack only; the sign-in helper refuses anything else.
 */

const run = Date.now().toString(36);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]); // the start of a PNG file: small, and nothing reads past it

let admin: SignedIn;
let teacher: SignedIn;
let parent: SignedIn;
let student: SignedIn;
let tenantId = "";
let studentId = "";
let otherTenantId = "";
let other: SupabaseClient;
const made: { bucket: string; path: string }[] = [];

const publicUrl = (path: string) => admin.client.storage.from("public-assets").getPublicUrl(path).data.publicUrl;
async function put(who: SignedIn, bucket: string, path: string, body: Blob | Uint8Array | string, contentType: string, upsert = false) {
  const r = await who.client.storage.from(bucket).upload(path, body, { contentType, upsert });
  if (!r.error) made.push({ bucket, path });
  return r;
}
async function tenantOf(who: SignedIn): Promise<string> {
  return ((await who.client.from("profiles").select("tenant_id").eq("id", who.userId).single()).data?.tenant_id as string) ?? "";
}
/** A request sent exactly as written: the supabase client and fetch both tidy ".." out of a path before it leaves the machine. */
function raw(method: string, path: string, token: string, body: string): Promise<{ status: number; body: string }> {
  const url = new URL(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: url.hostname, port: url.port, method, path,
      headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY!, authorization: `Bearer ${token}`, "content-type": "text/plain", "content-length": Buffer.byteLength(body), "x-upsert": "true" },
    }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: d })); });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
const accessToken = async (who: SignedIn) => (await who.client.auth.getSession()).data.session!.access_token;

beforeAll(async () => {
  admin = await signInAs("school_admin");
  teacher = await signInAs("teacher");
  parent = await signInAs("parent");
  student = await signInAs("student");
  tenantId = await tenantOf(admin);
  studentId = ((await admin.client.from("students").select("id").limit(1)).data?.[0]?.id as string) ?? "";
  expect(tenantId && studentId, "a school and a learner on the seed").toBeTruthy();
  other = anonClient();
  const { data, error } = await other.auth.signInWithPassword({ email: "head@kijaniridge.sc.ke", password: "figbloom-dev" });
  if (error || !data.user) throw new Error(`could not sign in as the second school's admin: ${error?.message}. Did you run npm run db:seed-org?`);
  otherTenantId = ((await other.from("profiles").select("tenant_id").eq("id", data.user.id).single()).data?.tenant_id as string) ?? "";
  expect(otherTenantId).not.toBe(tenantId);
});

afterAll(async () => {
  const byBucket = new Map<string, string[]>();
  for (const m of made) byBucket.set(m.bucket, [...(byBucket.get(m.bucket) ?? []), m.path]);
  for (const [bucket, paths] of byBucket) await admin.client.storage.from(bucket).remove(paths);
  const left: string[] = [];
  for (const m of made) if (!(await admin.client.storage.from(m.bucket).download(m.path)).error) left.push(`${m.bucket}/${m.path}`);
  if (left.length) throw new Error(`could not remove what this file uploaded: ${left.join(", ")}`);
});

describe("a name that tries to leave the school's own folder", () => {
  // The path is "<my school>/x/<dots>/<other school>/branding/<file>". If the dots were resolved after the permission check,
  // the file would land in the other school's folder. Both buckets are tried.
  const dots: [string, string][] = [
    ["plain dots", ".."],
    ["encoded dots (%2e%2e)", "%2e%2e"],
  ];
  for (const bucket of ["public-assets", "private-documents"]) {
    for (const [label, d] of dots) {
      it(`${bucket}: ${label} are refused, and nothing is written into the other school`, async () => {
        const name = `qa14-trav-${run}-${bucket}.txt`;
        const r = await raw("POST", `/storage/v1/object/${bucket}/${tenantId}/x/${d}/${d}/${otherTenantId}/branding/${name}`, await accessToken(admin), "QA14 traversal");
        expect(r.status, r.body).toBeGreaterThanOrEqual(400);
        expect(r.body).toMatch(/row-level security|Unauthorized|Invalid/i);
        expect((await other.storage.from(bucket).download(`${otherTenantId}/branding/${name}`)).error, "the other school's folder holds no such file").not.toBeNull();
        expect((await admin.client.storage.from(bucket).download(`${tenantId}/branding/${name}`)).error, "and it did not land in this school's folder either").not.toBeNull();
      });
    }
    it(`${bucket}: a double-encoded name and a name with backslashes are refused as invalid keys`, async () => {
      const token = await accessToken(admin);
      for (const seg of ["%252e%252e/%252e%252e", "..\\..\\"]) {
        const r = await raw("POST", `/storage/v1/object/${bucket}/${tenantId}/x/${seg}${otherTenantId}/branding/qa14-trav-${run}.txt`, token, "QA14");
        expect(r.status, r.body).toBe(400);
        expect(r.body).toMatch(/InvalidKey|Invalid key/);
      }
    });
  }
});

describe("what the public bucket serves, and how", () => {
  it("an HTML page is served as plain text, so opening its address shows the code and does not run it", async () => {
    const path = `${tenantId}/avatars/qa14-${run}.html`;
    const up = await put(admin, "public-assets", path, "<html><script>alert(document.domain)</script></html>", "text/html");
    expect(up.error).toBeNull();
    const res = await fetch(publicUrl(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toMatch(/^text\/plain/);
  });

  it("a signed-out visitor gets nothing from the private bucket, by its public-style address or its private one", async () => {
    const path = `${tenantId}/students/${studentId}/qa14-${run}.txt`;
    expect((await put(admin, "private-documents", path, "QA14 private", "text/plain")).error).toBeNull();
    const base = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!).replace(/\/$/, "");
    for (const kind of ["public", "authenticated"]) {
      const res = await fetch(`${base}/storage/v1/object/${kind}/private-documents/${path}`, { headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY! } });
      expect(res.status, `${kind} address`).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain("QA14 private");
    }
  });

  // An SVG may carry script. In the app it is only ever shown inside an <img>, where script does not run; but its address is public,
  // and opened directly it is served as image/svg+xml with no Content-Security-Policy, no sandbox and no nosniff. Fixed by refusing
  // SVG in the bucket (allowed_mime_types), or by serving public files with `Content-Security-Policy: sandbox`.
  it.fails("QA14-UPLOAD-TYPES FIG-1460: an SVG with a script in the public bucket cannot run when its address is opened", async () => {
    const path = `${tenantId}/branding/qa14-${run}.svg`;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(document.domain)</script><rect width="10" height="10"/></svg>';
    const up = await put(admin, "public-assets", path, svg, "image/svg+xml");
    if (up.error) return; // refused: safe
    const res = await fetch(publicUrl(path));
    const type = res.headers.get("content-type") ?? "";
    const safe = !/svg|html|xml/i.test(type) || /sandbox/i.test(res.headers.get("content-security-policy") ?? "") || /attachment/i.test(res.headers.get("content-disposition") ?? "");
    expect(safe, `served as ${type}, csp: ${res.headers.get("content-security-policy")}, nosniff: ${res.headers.get("x-content-type-options")}`).toBe(true);
  });

  it.fails("QA14-UPLOAD-TYPES FIG-1460: the public bucket (photos and logos) refuses a program file", async () => {
    const up = await put(admin, "public-assets", `${tenantId}/avatars/qa14-${run}.exe`, "MZ not a real program", "application/x-msdownload");
    expect(up.error, "a .exe uploaded as a school photo").not.toBeNull();
  });

  it.fails("QA14-UPLOAD-SIZE FIG-1460: the public bucket refuses a 'photo' of 6 MB (a photo or a logo needs a fraction of that)", async () => {
    const up = await put(admin, "public-assets", `${tenantId}/avatars/qa14-${run}-big.png`, new Blob([new Uint8Array(6 * 1024 * 1024)]), "image/png");
    expect(up.error, "6 MB accepted as a photo").not.toBeNull();
  });
});

describe("who may write the public bucket", () => {
  it("a parent and a student can write their own photo, and nothing else in the bucket or the private one", async () => {
    for (const who of [parent, student]) {
      const own = `${tenantId}/avatars/staff-${who.userId}.png`;
      expect((await put(who, "public-assets", own, PNG, "image/png", true)).error, `${who.role}'s own photo`).toBeNull();
      expect((await put(who, "public-assets", `${tenantId}/avatars/staff-${admin.userId}.png`, PNG, "image/png", true)).error, `${who.role} writing the admin's photo`).not.toBeNull();
      expect((await put(who, "public-assets", `${tenantId}/branding/qa14-${run}-${who.role}.png`, PNG, "image/png", true)).error, `${who.role} writing the school's branding`).not.toBeNull();
      expect((await put(who, "private-documents", `${tenantId}/students/${studentId}/qa14-${run}-${who.role}.txt`, "x", "text/plain")).error, `${who.role} writing a learner's records`).not.toBeNull();
    }
  });

  // public_assets_write used to let anyone with is_staff() (school admins AND teachers) write or delete any object in the school's public
  // folders, so a teacher could replace the school's logo or another person's photo. Since 20261105450000 the logo is the school admin's,
  // and a learner's photo is the admin's, the people office's, or that learner's class teacher's.
  it("QA14-TEACHER-OVERWRITE FIG-1461 (fixed): a teacher cannot replace or delete the school's logo or the photo of a learner in another class", async () => {
    const classes = (await admin.client.from("classes").select("id, class_teacher_id").eq("tenant_id", tenantId)).data ?? [];
    const notMine = classes.filter((c) => c.class_teacher_id !== teacher.userId).map((c) => c.id as string);
    const otherLearner = ((await admin.client.from("students").select("id").in("class_id", notMine).limit(1)).data?.[0]?.id as string) ?? "";
    expect(otherLearner, "a learner in a class that is not the teacher's").toBeTruthy();
    const logo = `${tenantId}/branding/qa14-${run}-logo.png`;
    const photo = `${tenantId}/avatars/students-${otherLearner}-qa14-${run}.png`;
    for (const p of [logo, photo]) expect((await put(admin, "public-assets", p, PNG, "image/png")).error).toBeNull();
    const evil = Uint8Array.from([...PNG, 1, 2, 3, 4]);
    const results: string[] = [];
    for (const p of [logo, photo]) {
      const over = await teacher.client.storage.from("public-assets").upload(p, evil, { contentType: "image/png", upsert: true });
      const now = await admin.client.storage.from("public-assets").download(p);
      const size = now.data ? (await now.data.arrayBuffer()).byteLength : -1;
      if (!over.error && size === evil.byteLength) results.push(`overwrote ${p.split("/")[1]}`);
      const del = await teacher.client.storage.from("public-assets").remove([p]);
      if (!del.error && (del.data?.length ?? 0) > 0) results.push(`deleted ${p.split("/")[1]}`);
    }
    expect(results, "what the teacher managed to do to files that are not hers").toEqual([]);
  });

  it("a class teacher may set the photo of a learner in their own class; the school admin may set the logo", async () => {
    const mine = (await admin.client.from("classes").select("id").eq("tenant_id", tenantId).eq("class_teacher_id", teacher.userId)).data ?? [];
    expect(mine.length, "the seeded teacher is the class teacher of a class").toBeGreaterThan(0);
    const own = ((await admin.client.from("students").select("id").eq("class_id", mine[0]!.id).limit(1)).data?.[0]?.id as string) ?? "";
    expect(own, "a learner in that class").toBeTruthy();
    expect((await put(teacher, "public-assets", `${tenantId}/avatars/students-${own}-qa14-${run}-own.png`, PNG, "image/png", true)).error).toBeNull();
    expect((await put(admin, "public-assets", `${tenantId}/branding/qa14-${run}-admin-logo.png`, PNG, "image/png", true)).error).toBeNull();
  });
});
