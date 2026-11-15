import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const API_ROOT = process.cwd();
// Inside the package so the compiled entrypoints resolve the migrations directory exactly as production does.
const OUT = resolve(API_ROOT, "dist-smoke");

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolvePort(port));
    });
    s.on("error", reject);
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** FIG-1616: production runs compiled JavaScript, not tsx. */
describe("compiled build (dist)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await createTestApp();
    rmSync(OUT, { recursive: true, force: true });
    const tsc = join(API_ROOT, "..", "..", "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json", "--outDir", OUT], {
      cwd: API_ROOT,
      stdio: "pipe",
    });
  }, 180_000);

  afterAll(async () => {
    rmSync(OUT, { recursive: true, force: true });
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("emits the API and migrate entrypoints and no tests", () => {
    expect(existsSync(join(OUT, "index.js"))).toBe(true);
    expect(existsSync(join(OUT, "db", "migrate.js"))).toBe(true);
    const files = walk(OUT).map((f) => f.slice(OUT.length + 1).split("\\").join("/"));
    expect(files.some((f) => f.startsWith("test/") || f.includes(".test."))).toBe(false);
  });

  it("production scripts do not depend on tsx; tsx stays a dev-only tool", () => {
    const pkg = JSON.parse(readFileSync(join(API_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const name of ["start", "migrate", "migrate:verify"]) {
      expect(pkg.scripts[name], name).toMatch(/^node dist\//);
      expect(pkg.scripts[name], name).not.toMatch(/tsx/);
    }
    expect(pkg.scripts.build).toMatch(/tsc -p tsconfig\.build\.json/);
    expect(pkg.dependencies.tsx).toBeUndefined();
    expect(pkg.devDependencies.tsx).toBeDefined();
    // The compiled program never imports tsx (or typescript).
    const imports = walk(OUT)
      .filter((f) => f.endsWith(".js"))
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/from\s+["']([^"'./][^"']*)["']/g)].map((m) => m[1]!));
    expect(imports.filter((i) => /^(tsx|typescript)(\/|$)/.test(i))).toEqual([]);
  });

  it("compiled migrate --verify resolves the migrations directory from dist and verifies the applied set", () => {
    const out = execFileSync(process.execPath, [join(OUT, "db", "migrate.js"), "--verify"], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL:
          process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:58322/figbloom_api",
        DATABASE_URL: "",
      },
      encoding: "utf8",
    });
    expect(out).toMatch(/verified \d+ migration\(s\)/);
  });

  it("compiled API starts under node, answers /livez and /readyz as figbloom_app, and has no tsx in its process", async () => {
    const port = await freePort();
    const child: ChildProcess = spawn(process.execPath, [join(OUT, "index.js")], {
      cwd: API_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: ctx.runtimeUrl,
        API_HOST: "127.0.0.1",
        API_PORT: String(port),
        AUTH_RATE_CAPACITY: "1000",
        AUTH_RATE_REFILL: "1000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    try {
      let up = false;
      for (let i = 0; i < 60 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/livez`)).status === 200;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      expect(up, output).toBe(true);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(200);
      // A real request through the compiled app on the real runtime role.
      const login = await fetch(`http://127.0.0.1:${port}/v1/auth/login/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin-a@example.com", password: "correct-horse-battery" }),
      });
      expect(login.status).toBe(200);
      expect(output).not.toMatch(/tsx/i);
      expect(output).not.toMatch(/correct-horse|password|scrypt/i);
    } finally {
      child.kill();
      await new Promise((r) => child.once("exit", () => r(undefined)));
    }
  }, 60_000);
});
