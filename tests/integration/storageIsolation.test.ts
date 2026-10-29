import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, signInAs, type SignedIn } from "./support/signInAs";

/**
 * QA 03 (FIG-1236), storage: can a user of school B reach school A's files by guessing the path?
 *
 * The victim is the first demo school (Alliance). Its school admin uploads one real file into each bucket folder the app uses,
 * then every user of the second school (Kijani Ridge, from `npm run db:seed-org`) and an anonymous caller try to read, list,
 * overwrite, delete and move those files. Each attack is followed by a check, as the owner, that the file is still there and
 * unchanged, so a refusal that merely hides a successful write cannot pass.
 *
 * Not covered: `chat-files` (a file there is tied to a conversation and the seed has none). The photo and logo in the public
 * bucket are readable by anyone who knows the exact path; that is the known limitation in PRODUCTION_TODO (photos stay public
 * by exact path until signed URLs exist) and is asserted below so a change to it is noticed.
 */

const PASSWORD = "figbloom-dev";
const OTHER_SCHOOL = {
  school_admin: "head@kijaniridge.sc.ke",
  teacher: "tc-0001@login.kijani-ridge.figbloom.internal",
  parent: "pt-0001@login.kijani-ridge.figbloom.internal",
  student: "st-0001@login.kijani-ridge.figbloom.internal",
  driver: "bd-0001@login.kijani-ridge.figbloom.internal",
} as const;
type Attacker = keyof typeof OTHER_SCHOOL | "anonymous";
const ATTACKERS: Attacker[] = [...(Object.keys(OTHER_SCHOOL) as (keyof typeof OTHER_SCHOOL)[]), "anonymous"];

interface Victim { bucket: string; path: string; what: string; secret: string }

const run = Date.now().toString(36);
let owner: SignedIn;
let tenantId = "";
const victims: Victim[] = [];
const clients = new Map<Attacker, SupabaseClient>();
const planted: Victim[] = [];

async function attackerClient(who: Attacker): Promise<SupabaseClient> {
  const client = anonClient();
  if (who === "anonymous") return client;
  const { error } = await client.auth.signInWithPassword({ email: OTHER_SCHOOL[who], password: PASSWORD });
  if (error) throw new Error(`could not sign in as ${who} of the second school (${OTHER_SCHOOL[who]}): ${error.message}. Did you run npm run db:seed-org?`);
  return client;
}

async function plant(bucket: string, path: string, what: string): Promise<Victim> {
  const secret = `QA03 secret ${run} ${what}`;
  const { error } = await owner.client.storage.from(bucket).upload(path, new Blob([secret], { type: "text/plain" }), { contentType: "text/plain" });
  if (error) throw new Error(`the owner could not create ${bucket}/${path}: ${error.message}`);
  const v = { bucket, path, what, secret };
  planted.push(v);
  return v;
}

async function ownerStillHas(v: Victim): Promise<boolean> {
  const { data, error } = await owner.client.storage.from(v.bucket).download(v.path);
  return !error && !!data && (await data.text()) === v.secret;
}

beforeAll(async () => {
  owner = await signInAs("school_admin");
  tenantId = ((await owner.client.from("profiles").select("tenant_id").eq("id", owner.userId)).data?.[0]?.tenant_id as string) ?? "";
  const stu = ((await owner.client.from("students").select("id").limit(1)).data?.[0]?.id as string) ?? "";
  const inv = ((await owner.client.from("fee_invoices").select("id").eq("student_id", stu).limit(1)).data?.[0]?.id as string) ?? "";
  const ann = ((await owner.client.from("announcements").select("id").limit(1)).data?.[0]?.id as string) ?? "";
  expect([tenantId, stu, inv, ann].every(Boolean), "the owner needs a school, a learner, an invoice and an announcement").toBe(true);

  victims.push(
    await plant("private-documents", `${tenantId}/students/${stu}/qa03-${run}.txt`, "a learner's private document"),
    await plant("private-documents", `${tenantId}/invoices/${inv}/qa03-${run}.txt`, "a payment proof"),
    await plant("private-documents", `${tenantId}/medical/${stu}/qa03-${run}.txt`, "a medical file"),
    await plant("learning-media", `${tenantId}/announcements/${ann}/qa03-${run}.txt`, "an announcement attachment"),
    await plant("public-assets", `${tenantId}/branding/qa03-${run}.txt`, "a public asset"),
  );
  for (const who of ATTACKERS) clients.set(who, await attackerClient(who));
}, 90_000);

afterAll(async () => {
  for (const v of planted) await owner.client.storage.from(v.bucket).remove([v.path]);
}, 60_000);

describe("control: the owner's own files", () => {
  it("the school admin can read back every file it planted", async () => {
    for (const v of victims) expect(await ownerStillHas(v), `${v.bucket}/${v.path}`).toBe(true);
  });
});

describe("control: the same requests work for the owner (so the refusals below are not just broken requests)", () => {
  it("the owner can list, overwrite, copy, move and sign a link for its own file", async () => {
    for (const v of victims) {
      const folder = v.path.split("/").slice(0, -1).join("/");
      const listed = await owner.client.storage.from(v.bucket).list(folder);
      expect((listed.data ?? []).map((o) => o.name), `${v.what}: list`).toContain(v.path.split("/").pop()!);
      const over = await owner.client.storage.from(v.bucket).upload(v.path, new Blob([v.secret], { type: "text/plain" }), { upsert: true, contentType: "text/plain" });
      expect(over.error, `${v.what}: overwrite`).toBeNull();
      const copy = await owner.client.storage.from(v.bucket).copy(v.path, `${v.path}.copy`);
      expect(copy.error, `${v.what}: copy`).toBeNull();
      planted.push({ bucket: v.bucket, path: `${v.path}.copy`, what: "owner copy", secret: "" });
      const moved = await owner.client.storage.from(v.bucket).move(`${v.path}.copy`, `${v.path}.moved`);
      expect(moved.error, `${v.what}: move`).toBeNull();
      planted.push({ bucket: v.bucket, path: `${v.path}.moved`, what: "owner move", secret: "" });
      if (v.bucket !== "public-assets") {
        const signed = await owner.client.storage.from(v.bucket).createSignedUrl(v.path, 60);
        expect(signed.error, `${v.what}: signed link`).toBeNull();
        expect((await fetch(signed.data!.signedUrl)).status, `${v.what}: signed link works`).toBe(200);
      }
    }
  });
});

describe.each(ATTACKERS)("storage: %s of another school", (who) => {
  const client = () => clients.get(who)!;
  const guarded = () => victims.filter((v) => v.bucket !== "public-assets");

  it("cannot download, or get a signed link to, another school's private files", async () => {
    for (const v of guarded()) {
      const got = await client().storage.from(v.bucket).download(v.path);
      expect(got.data, `${v.what} downloaded`).toBeNull();
      expect(got.error, `${v.what}`).not.toBeNull();
      const signed = await client().storage.from(v.bucket).createSignedUrl(v.path, 60);
      if (signed.data?.signedUrl) {
        const res = await fetch(signed.data.signedUrl);
        expect(res.status, `${v.what}: a signed link was handed out and it works`).not.toBe(200);
      }
    }
  });

  it("cannot list another school's folders", async () => {
    for (const v of victims) {
      const folder = v.path.split("/").slice(0, -1).join("/");
      const name = v.path.split("/").pop()!;
      const { data } = await client().storage.from(v.bucket).list(folder);
      expect((data ?? []).map((o) => o.name), `${v.what}: the folder listing shows the file`).not.toContain(name);
    }
  });

  it("cannot upload into another school's folders", async () => {
    for (const v of victims) {
      const folder = v.path.split("/").slice(0, -1).join("/");
      const target = `${folder}/attack-${who}-${run}.txt`;
      const { error } = await client().storage.from(v.bucket).upload(target, new Blob(["attacker file"]), { contentType: "text/plain" });
      if (!error) planted.push({ bucket: v.bucket, path: target, what: "attacker upload", secret: "" });
      expect(error, `${v.what}: an upload into the other school's folder was accepted`).not.toBeNull();
    }
  });

  it("cannot overwrite, delete or move another school's files (and the files are still intact)", async () => {
    for (const v of victims) {
      const overwrite = await client().storage.from(v.bucket).upload(v.path, new Blob(["hacked"]), { upsert: true, contentType: "text/plain" });
      expect(overwrite.error, `${v.what}: overwrite accepted`).not.toBeNull();
      await client().storage.from(v.bucket).remove([v.path]);
      const move = await client().storage.from(v.bucket).move(v.path, `${v.path}.moved`);
      expect(move.error, `${v.what}: move accepted`).not.toBeNull();
      const copy = await client().storage.from(v.bucket).copy(v.path, `${v.path}.copy`);
      if (!copy.error) planted.push({ bucket: v.bucket, path: `${v.path}.copy`, what: "attacker copy", secret: "" });
      expect(copy.error, `${v.what}: copy accepted`).not.toBeNull();
      expect(await ownerStillHas(v), `${v.what}: the file changed or disappeared`).toBe(true);
    }
  });
});

describe("known limitation: public-assets is readable by exact path", () => {
  it("anyone with the exact path can read a public asset (PRODUCTION_TODO: photos stay public until signed URLs exist)", async () => {
    const v = victims.find((x) => x.bucket === "public-assets")!;
    const url = anonClient().storage.from(v.bucket).getPublicUrl(v.path).data.publicUrl;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(v.secret);
  });

  it("a guessed path in another school's public folder that does not exist is a 4xx, not a listing", async () => {
    const url = anonClient().storage.from("public-assets").getPublicUrl(`${tenantId}/branding/`).data.publicUrl;
    const res = await fetch(url);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
