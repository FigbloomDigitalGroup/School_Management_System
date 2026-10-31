import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * QA 14 (FIG-1247): what the code and the configuration say, read as files (no database, no browser, nothing is run).
 *   - the only places that turn text into HTML, and that nothing secret is shipped to a browser or a phone,
 *   - which edge functions a caller may reach without signing in,
 *   - the web host's security headers,
 *   - how the two GitHub workflows install and what they pin.
 * A test marked `it.fails` is a bug already filed (its FIG id is in the title): it passes while the bug exists and fails the day
 * it is fixed; then change it.fails to it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Every source file under a folder, without tests, dependencies and build output. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (["node_modules", "dist", "build", ".expo", "android", "ios", "Pods"].includes(name)) continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(name) && !/\.(test|spec)\.[tj]sx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(rel.replaceAll("\\", "/"));
  }
  return out;
}
/** The code lines of a file: comment-only lines dropped, so a comment that names a danger is not read as using it. */
const codeLines = (rel: string) => read(rel).split(/\r?\n/).map((text, i) => ({ n: i + 1, text })).filter(({ text }) => !/^\s*(\/\/|\/\*|\*)/.test(text));

const CLIENT_SRC = ["apps/web/src", "apps/mobile/src", "apps/teacher-mobile/src", "packages/shared/src"];
const clientFiles = () => CLIENT_SRC.flatMap((d) => sourceFiles(d));

describe("HTML and code sinks", () => {
  const SINKS = /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/;

  it("only one place writes HTML, and what it writes is fixed text", () => {
    const hits = clientFiles().flatMap((f) => codeLines(f).filter(({ text }) => SINKS.test(text)).map(({ n, text }) => `${f}:${n} ${text.trim()}`));
    // Faq.tsx puts the page's own question-and-answer data (a constant) into a JSON-LD script tag, with "<" escaped.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("apps/web/src/screens/landing/Faq.tsx");
    expect(hits[0]).toContain("JSON.stringify(structuredData)");
    expect(hits[0]).toContain(".replace(/</g");
  });

  it("the phone apps load no web page inside the app (no WebView)", () => {
    for (const f of sourceFiles("apps/mobile/src").concat(sourceFiles("apps/teacher-mobile/src"))) {
      expect(read(f), f).not.toMatch(/react-native-webview|WebView/);
    }
  });

  it("no link is built from a javascript: address anywhere", () => {
    const hits = clientFiles().flatMap((f) => codeLines(f).filter(({ text }) => /["'`]javascript:/i.test(text)).map(({ n }) => `${f}:${n}`));
    expect(hits).toEqual([]);
  });
});

describe("secrets in the client code", () => {
  const FORBIDDEN = [
    "SUPABASE_SERVICE_ROLE_KEY", "service_role", "DARAJA_CONSUMER", "DARAJA_PASSKEY", "DARAJA_CALLBACK_SECRET",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LIVEKIT_API_SECRET", "FCM_SERVICE_ACCOUNT", "BEGIN PRIVATE KEY", "BEGIN RSA PRIVATE KEY",
  ];

  it("no server-side secret name or private key appears in the web or phone source", () => {
    const hits = clientFiles().flatMap((f) => FORBIDDEN.filter((s) => read(f).includes(s)).map((s) => `${f}: ${s}`));
    expect(hits).toEqual([]);
  });

  it("the web app reads only VITE_ variables (the only ones the build puts in the bundle)", () => {
    const names = new Set<string>();
    for (const f of sourceFiles("apps/web/src")) for (const m of read(f).matchAll(/import\.meta\.env\.([A-Z0-9_]+)/g)) names.add(m[1]!);
    const notPublic = [...names].filter((n) => !n.startsWith("VITE_") && !["DEV", "PROD", "MODE", "BASE_URL", "SSR"].includes(n));
    expect(notPublic).toEqual([]);
  });

  it("every key written into the source is a public key: a Supabase JWT in the source has the role anon", () => {
    const found: string[] = [];
    for (const f of clientFiles()) {
      for (const m of read(f).matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g)) {
        const role = (JSON.parse(Buffer.from(m[1]!, "base64url").toString()) as { role?: string }).role;
        found.push(`${f}: ${role}`);
      }
    }
    // Today there is none: since FIG-782 the phone apps get the key from their .env at build time. (An older commit of
    // apps/*/src/env.ts still holds the hosted project's anon key; it is public by design.)
    expect(found.filter((x) => !x.endsWith(": anon"))).toEqual([]);
  });

  it("no env file is tracked except the .env.example templates, and the real ones are ignored", () => {
    let tracked: string[];
    try { tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean); } catch { return; } // no git on this machine
    expect(tracked.filter((p) => /(^|\/)\.env(\.|$)/.test(p) && !p.endsWith(".env.example") && !p.endsWith(".xcode.env"))).toEqual([]);
    const ignore = read(".gitignore").split(/\r?\n/);
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".env.*");
  });
});

describe("edge functions that need no sign-in", () => {
  /** verify_jwt = false means anyone on the internet can call the function; each one here has a reason and a check of its own. */
  const PUBLIC = {
    "mpesa-callback": "Safaricom cannot send a JWT (a shared secret in the URL is checked instead)",
    "signup-organization": "the caller has no account yet",
    "search-schools": "the school search before sign-in",
    "resolve-login-id": "login ID to email, before sign-in",
    "request-password-reset": "forgot password, before sign-in",
  };

  const config = read("supabase/config.toml");
  const explicit = new Map<string, boolean>();
  for (const m of config.matchAll(/\[functions\.([a-z0-9-]+)\]\s*\r?\nverify_jwt\s*=\s*(true|false)/g)) explicit.set(m[1]!, m[2] === "true");

  it("exactly these five functions are public, no more", () => {
    const open = [...explicit].filter(([, v]) => !v).map(([k]) => k).sort();
    expect(open).toEqual(Object.keys(PUBLIC).sort());
  });

  it("every other function keeps verify_jwt on (an explicit true, or the default when it is not listed) and still checks the caller itself", () => {
    const dirs = readdirSync(join(ROOT, "supabase/functions")).filter((d) => existsSync(join(ROOT, "supabase/functions", d, "index.ts")));
    expect(dirs.length).toBeGreaterThan(15);
    for (const d of dirs.filter((x) => !(x in PUBLIC))) {
      expect(explicit.get(d) ?? true, `${d} must not be public`).toBe(true);
      const code = read(`supabase/functions/${d}/index.ts`);
      expect(/auth\.getUser|getUser\(/.test(code) || /SERVICE_ROLE|serviceRole/.test(code), `${d} checks who is calling`).toBe(true);
    }
  });

  it("the public functions that reach the database limit how often one caller may ask", () => {
    for (const d of ["resolve-login-id", "request-password-reset", "search-schools", "signup-organization"]) {
      expect(read(`supabase/functions/${d}/index.ts`), `${d} rate limits`).toMatch(/withinLimit|rateLimit|note_login_lookup/);
    }
  });
});

describe("the web host's security headers (apps/web/vercel.json)", () => {
  const vercel = JSON.parse(read("apps/web/vercel.json")) as { headers?: { source: string; headers: { key: string; value: string }[] }[] };
  const everyPage = (vercel.headers ?? []).filter((h) => ["/(.*)", "/:path*", "/(.*)/", "/:path(.*)"].includes(h.source));
  const keys = new Set(everyPage.flatMap((h) => h.headers.map((x) => x.key.toLowerCase())));
  const csp = everyPage.flatMap((h) => h.headers).find((x) => x.key.toLowerCase() === "content-security-policy")?.value ?? "";

  // The page and the sign-in form are served from here, so these decide whether another site can frame the Pay button
  // or whether a script that gets in can load more from anywhere.
  it.fails("QA14-HEADERS FIG-1459: every page is sent with a Content-Security-Policy, HSTS, nosniff, a referrer policy and frame protection", () => {
    expect(keys.has("content-security-policy")).toBe(true);
    expect(keys.has("strict-transport-security")).toBe(true);
    expect(keys.has("x-content-type-options")).toBe(true);
    expect(keys.has("referrer-policy")).toBe(true);
    expect(keys.has("x-frame-options") || /frame-ancestors/.test(csp)).toBe(true);
  });

  it("the header rules that do exist are valid (caching and noindex only, nothing that weakens a page)", () => {
    for (const h of vercel.headers ?? []) for (const x of h.headers) {
      expect(["x-robots-tag", "cache-control"], `${h.source}: ${x.key}`).toContain(x.key.toLowerCase());
    }
  });
});

describe("the GitHub workflows", () => {
  const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/mobile-release-build.yml"];
  const installs = (file: string) => read(file).split(/\r?\n/).filter((l) => /^\s*-?\s*(run:\s*)?npm (ci|install)\b/.test(l) || /\brun:\s*npm (ci|install)\b/.test(l));

  it("every third-party action is pinned to a commit, not a movable tag", () => {
    for (const f of WORKFLOWS) for (const l of read(f).split(/\r?\n/).filter((x) => /^\s*-?\s*uses:/.test(x))) {
      expect(l, `${f}: ${l.trim()}`).toMatch(/uses:\s*[\w./-]+@[0-9a-f]{40}\b/);
    }
  });

  it("each workflow limits what its token can do, and none runs untrusted pull-request code with secrets (no pull_request_target)", () => {
    for (const f of WORKFLOWS) {
      const text = read(f);
      expect(text, f).toMatch(/^permissions:\s*\r?\n\s+contents:\s*read/m);
      expect(text, f).not.toMatch(/pull_request_target/);
    }
  });

  it("both run the security scan before anything is installed", () => {
    for (const f of WORKFLOWS) {
      const text = read(f);
      expect(text.indexOf("scripts/security-scan.sh"), `${f} runs the scan`).toBeGreaterThan(-1);
      expect(text.indexOf("scripts/security-scan.sh"), `${f}: scan before install`).toBeLessThan(text.indexOf("npm ci"));
    }
  });

  it("the CI workflow installs with --ignore-scripts, so no dependency runs code at install time", () => {
    const lines = installs(WORKFLOWS[0]!);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain("--ignore-scripts");
  });

  // The release job installs, then writes the signing keystore and its passwords and builds the app people install. An install script
  // from a hijacked package runs on that machine first.
  it.fails("QA14-RELEASE-INSTALL FIG-1458: the mobile release workflow installs with --ignore-scripts too", () => {
    const lines = installs(WORKFLOWS[1]!);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toContain("--ignore-scripts");
  });
});

describe("the phone apps' dependencies", () => {
  const major = (v: string) => Number(/(\d+)/.exec(v)?.[1]);
  for (const app of ["apps/mobile", "apps/teacher-mobile"]) {
    // native-stack 5 is a React Navigation 5 package; navigation itself is on 7 (npm ls shows 5.0.5 beside native 7.3.18).
    it.fails(`QA14-NAV-PIN FIG-1463: ${app} uses the same major version of @react-navigation/native-stack as of @react-navigation/native`, () => {
      const deps = (JSON.parse(read(`${app}/package.json`)) as { dependencies: Record<string, string> }).dependencies;
      expect(major(deps["@react-navigation/native-stack"]!)).toBe(major(deps["@react-navigation/native"]!));
    });
  }
});

describe("the git history", () => {
  it("no signing key, keystore (other than Android's public debug one), env file or service-account file was ever committed", () => {
    let names: string[];
    try {
      names = execFileSync("git", ["log", "--all", "--name-only", "--pretty=format:", "--", "*.jks", "*.keystore", "*.p12", "*.pfx", "*key.properties", "*.pem", ".env", ".env.local", ".env.production", "apps/*/.env", "service-account*.json", "*serviceAccount*.json", "firebase-adminsdk*"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\n").map((s) => s.trim()).filter(Boolean);
    } catch { return; } // no git, or a shallow clone without history
    const unexpected = [...new Set(names)].filter((n) => !/(^|\/)debug\.keystore$/.test(n));
    expect(unexpected.map((n) => relative("", n))).toEqual([]);
  });
});
