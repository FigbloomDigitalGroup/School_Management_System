import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { assertRuntimeRole } from "../src/db/roleAssert.js";
import { assertIsolatedTestDatabase, resetDatabase, runtimeUrlFromOwner } from "./support.js";
import { randomBytes } from "node:crypto";

const { Pool } = pg;
const ownerUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "";

describe("runtime role assertion", () => {
  const pool = new Pool({ connectionString: ownerUrl, max: 4, application_name: "figbloom-role-test" });

  beforeAll(async () => {
    assertIsolatedTestDatabase(ownerUrl);
    await resetDatabase(pool);
  }, 120_000);

  afterAll(async () => {
    await pool.query(`ALTER ROLE figbloom_app WITH NOLOGIN PASSWORD NULL`).catch(() => undefined);
    await pool.query(`DROP TABLE IF EXISTS figbloom_owned_probe`).catch(() => undefined);
    await pool.query(`REVOKE figbloom_tblowner FROM CURRENT_USER`).catch(() => undefined);
    for (const role of ["figbloom_br", "figbloom_reader", "figbloom_leaf", "figbloom_mid", "figbloom_tblowner"]) {
      await pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    }
    await pool.end();
  });

  it("rejects the superuser connection", async () => {
    const client = await pool.connect();
    try {
      await expect(assertRuntimeRole(client, { expectedRole: "figbloom_app" })).rejects.toThrow(
        /expected figbloom_app/,
      );
    } finally {
      client.release();
    }
  });

  it("accepts figbloom_app after migration 009 and rejects privileged variants", async () => {
    const password = randomBytes(18).toString("base64url");
    await pool.query(`ALTER ROLE figbloom_app WITH LOGIN PASSWORD '${password.replace(/'/g, "''")}'`);
    const runtime = new Pool({
      connectionString: runtimeUrlFromOwner(ownerUrl, password),
      max: 1,
      application_name: "figbloom-role-ok",
    });
    try {
      const client = await runtime.connect();
      try {
        await expect(assertRuntimeRole(client, { expectedRole: "figbloom_app" })).resolves.toBeUndefined();
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }

    const secret = randomBytes(18).toString("base64url");
    const literal = `'${secret.replace(/'/g, "''")}'`;

    async function expectLoginRejected(role: string, pattern: RegExp): Promise<void> {
      const url = new URL(ownerUrl);
      url.username = role;
      url.password = secret;
      const login = new Pool({ connectionString: url.toString(), max: 1, application_name: "figbloom-role-bad" });
      try {
        const bad = await login.connect();
        try {
          await expect(assertRuntimeRole(bad, { expectedRole: role })).rejects.toThrow(pattern);
        } finally {
          bad.release();
        }
      } finally {
        await login.end();
      }
    }

    await pool.query(`REVOKE figbloom_br FROM CURRENT_USER`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS figbloom_br`);
    await pool.query(`CREATE ROLE figbloom_br NOLOGIN BYPASSRLS`);
    await pool.query(`ALTER ROLE figbloom_br WITH LOGIN PASSWORD ${literal}`);
    await expectLoginRejected("figbloom_br", /rolbypassrls/);
    await pool.query(`ALTER ROLE figbloom_br WITH NOLOGIN PASSWORD NULL`);

    await pool.query(`REVOKE figbloom_reader FROM CURRENT_USER`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS figbloom_reader`);
    await pool.query(`CREATE ROLE figbloom_reader NOLOGIN NOINHERIT`);
    await pool.query(`GRANT pg_read_all_data TO figbloom_reader`);
    await pool.query(`ALTER ROLE figbloom_reader WITH LOGIN PASSWORD ${literal}`);
    await expectLoginRejected("figbloom_reader", /member of/);
    await pool.query(`ALTER ROLE figbloom_reader WITH NOLOGIN PASSWORD NULL`);

    await pool.query(`REVOKE figbloom_leaf FROM CURRENT_USER`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS figbloom_leaf`);
    await pool.query(`DROP ROLE IF EXISTS figbloom_mid`);
    await pool.query(`CREATE ROLE figbloom_mid NOLOGIN`);
    await pool.query(`CREATE ROLE figbloom_leaf NOLOGIN NOINHERIT`);
    await pool.query(`GRANT pg_read_all_data TO figbloom_mid`);
    await pool.query(`GRANT figbloom_mid TO figbloom_leaf`);
    await pool.query(`ALTER ROLE figbloom_leaf WITH LOGIN PASSWORD ${literal}`);
    await expectLoginRejected("figbloom_leaf", /member of/);
    await pool.query(`ALTER ROLE figbloom_leaf WITH NOLOGIN PASSWORD NULL`);

    await pool.query(`DROP TABLE IF EXISTS figbloom_owned_probe`);
    await pool.query(`REVOKE figbloom_tblowner FROM CURRENT_USER`).catch(() => undefined);
    await pool.query(`DROP ROLE IF EXISTS figbloom_tblowner`);
    await pool.query(`CREATE ROLE figbloom_tblowner NOLOGIN NOINHERIT`);
    await pool.query(`GRANT figbloom_tblowner TO CURRENT_USER`);
    await pool.query(`GRANT CREATE ON SCHEMA public TO figbloom_tblowner`);
    await pool.query(`CREATE TABLE figbloom_owned_probe (id int)`);
    await pool.query(`ALTER TABLE figbloom_owned_probe OWNER TO figbloom_tblowner`);
    await pool.query(`ALTER ROLE figbloom_tblowner WITH LOGIN PASSWORD ${literal}`);
    await expectLoginRejected("figbloom_tblowner", /owns/);
    await pool.query(`ALTER ROLE figbloom_tblowner WITH NOLOGIN PASSWORD NULL`);
  });
});
