import { loadConfig, loadDotEnvForLocal } from "./config.js";
import { createPool, runtimePoolOptions } from "./db/pool.js";
import { acquireClient } from "./db/tenantTransaction.js";
import { assertRuntimeRole } from "./db/roleAssert.js";
import { startServer } from "./server.js";
import { describeError, logError, logInfo, logWarn } from "./log.js";
import { setAccountNotifier } from "./modules/account/notifier.js";
import { resendNotifierFromEnv } from "./modules/account/resendNotifier.js";
import { myHrSetup } from "./modules/hr/myHr.js";

async function main(): Promise<void> {
  loadDotEnvForLocal();
  const config = loadConfig();
  // Account e-mail (invitations, password resets). Off unless RESEND_API_KEY is a real key; then issuers no
  // longer receive tokens, so the links must open a working page (ACCOUNT_LINK_BASE_URL).
  const notifier = resendNotifierFromEnv(process.env, config.appEnv);
  if (notifier) setAccountNotifier(notifier);
  logInfo("account_email", { outcome: notifier ? "resend" : "not_configured" });
  // My HR (docs/MY-HR.md): off unless MY_HR_ENABLED=true and every setting is there. Setting names only, never values.
  const myHr = myHrSetup(config);
  if (myHr.state === "incomplete") logWarn("my_hr", { outcome: "incomplete", reason: `missing ${myHr.missing.join(", ")}` });
  else logInfo("my_hr", { outcome: myHr.state });
  const pool = createPool(runtimePoolOptions(config));
  try {
    const client = await acquireClient(pool, config.poolAcquireTimeoutMs);
    try {
      await assertRuntimeRole(client, { expectedRole: config.runtimeRole });
    } finally {
      client.release();
    }
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }

  const server = await startServer(config, pool);
  logInfo("listening", { outcome: "ready" });

  const stop = (reason: string) => {
    void server.shutdown(reason).then((code) => process.exit(code));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  // An unhandled failure leaves the process in an unknown state: stop serving and exit non-zero.
  const fatal = (kind: string, err: unknown) => {
    logError(kind, describeError(err));
    void server.shutdown(kind).then(() => process.exit(1));
  };
  process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));
  process.on("uncaughtException", (err) => fatal("uncaughtException", err));
}

main().catch((err) => {
  // Our own configuration and role-assertion errors name the violated property, never a value.
  // Anything else (a driver error) is reported by class and SQLSTATE only.
  const safe = err instanceof Error && /^(Invalid (API|migrate) config|Unsafe runtime role)/.test(err.message);
  logError("startup_failed", { ...(safe ? { reason: (err as Error).message } : {}), ...describeError(err) });
  process.exitCode = 1;
});
