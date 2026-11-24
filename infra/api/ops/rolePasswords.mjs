// Gives the API's runtime roles (figbloom_app, figbloom_worker) their LOGIN password, as the database owner.
//
// Migrations create both roles NOLOGIN (004, 036); turning LOGIN on with a password is an operations step
// (apps/api/docs/DB-ROLES.md). The password is sent as a SCRAM-SHA-256 verifier computed here, so the plain
// password never reaches the server and cannot end up in a server log. PostgreSQL stores a verifier as-is.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import pg from "pg";

const ITERATIONS = 4096; // PostgreSQL's default scram_iterations

/** Generated passwords are ASCII letters and digits; refuse anything SASLprep could change. */
function assertPlainAscii(password, role) {
  if (typeof password !== "string" || password.length < 20 || !/^[\x21-\x7e]+$/.test(password)) {
    throw new Error(`the password for ${role} must be at least 20 printable ASCII characters`);
  }
}

/** The SCRAM-SHA-256 verifier PostgreSQL itself would store for this password (RFC 5802 / 7677). */
export function scramVerifier(password, salt = randomBytes(16), iterations = ITERATIONS) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/**
 * @param {string} ownerUrl  the owner's connection string
 * @param {Array<[string, string]>} roles  [role, password] pairs
 */
export async function setRolePasswords(ownerUrl, roles) {
  for (const [role, password] of roles) assertPlainAscii(password, role);
  const client = new pg.Client({ connectionString: ownerUrl, application_name: "figbloom-release" });
  await client.connect();
  try {
    for (const [role, password] of roles) {
      const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
      if (exists.rowCount !== 1) throw new Error(`role ${role} does not exist (have the migrations run?)`);
      const sql = `ALTER ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${client.escapeLiteral(scramVerifier(password))}`;
      await client.query(sql);
      process.stdout.write(`release: ${role} can log in\n`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
