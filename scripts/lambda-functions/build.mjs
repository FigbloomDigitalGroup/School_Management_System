// Builds every function in supabase/functions as an AWS Lambda package, unchanged (adapter.ts does what the edge runtime
// did): dist/lambda-functions/<name>/index.js, plus manifest.json (each function and its verify_jwt) for figbloom-platform's
// SchoolsFunctions stack, which deploys them.
//
//   npm ci --prefix scripts/lambda-functions && npm run build --prefix scripts/lambda-functions
//
// The functions' npm: imports (npm:@supabase/supabase-js@2.116.0, ...) are bundled from this folder's node_modules, and the
// build stops if the version installed here isn't the one the import names. The AWS SDK (for reading the settings) is the
// Lambda runtime's own.
import { build } from "esbuild";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import console from "node:console";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const functionsDir = join(root, "supabase/functions");
const out = join(root, "dist/lambda-functions");
const adapter = join(here, "adapter.ts").replaceAll("\\", "/");

// [functions.<name>] verify_jwt = true|false in supabase/config.toml; a function not listed verifies, as on Supabase
export function verifyJwtSettings(toml) {
  const settings = {};
  let current = null;
  for (const line of toml.split(/\r?\n/)) {
    const section = /^\s*\[functions\.([a-z0-9-]+)\]\s*$/.exec(line);
    if (section) { current = section[1]; continue; }
    if (/^\s*\[/.test(line)) { current = null; continue; }
    const v = /^\s*verify_jwt\s*=\s*(true|false)\b/.exec(line);
    if (current && v) settings[current] = v[1] === "true";
  }
  return settings;
}

// npm:@scope/pkg@1.2.3/sub/path -> { name: "@scope/pkg", version: "1.2.3", sub: "/sub/path" }
export function parseNpmSpecifier(spec) {
  const m = /^npm:((?:@[^/@]+\/)?[^/@]+)@([^/]+)(\/.*)?$/.exec(spec);
  if (!m) throw new Error(`${spec}: an npm: import must name an exact version (npm:pkg@1.2.3)`);
  return { name: m[1], version: m[2], sub: m[3] ?? "" };
}

const npmSpecifiers = {
  name: "npm-specifiers",
  setup(b) {
    b.onResolve({ filter: /^npm:/ }, async (args) => {
      const { name, version, sub } = parseNpmSpecifier(args.path);
      const pkg = join(here, "node_modules", name, "package.json");
      if (!existsSync(pkg)) throw new Error(`${name} is not installed in scripts/lambda-functions (add ${name}@${version} to its package.json)`);
      const installed = JSON.parse(readFileSync(pkg, "utf8")).version;
      if (installed !== version) throw new Error(`${args.importer} imports ${name}@${version}, but ${installed} is installed in scripts/lambda-functions`);
      const r = await b.resolve(`${name}${sub}`, { kind: args.kind, resolveDir: here });
      if (r.errors.length) return { errors: r.errors };
      return { path: r.path };
    });
    // jsr: is only for the functions' Deno tests; a function that ships it can't run here
    b.onResolve({ filter: /^jsr:/ }, (args) => ({ errors: [{ text: `${args.path}: jsr imports are test-only; ${args.importer} can't use one` }] }));
  },
};

async function main() {
  const verify = verifyJwtSettings(readFileSync(join(root, "supabase/config.toml"), "utf8"));
  const names = readdirSync(functionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && existsSync(join(functionsDir, d.name, "index.ts")))
    .map((d) => d.name)
    .sort();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = {};
  for (const name of names) {
    const verifyJwt = verify[name] ?? true;
    const fn = join(functionsDir, name, "index.ts").replaceAll("\\", "/");
    const entry = `
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createLambdaHandler } from ${JSON.stringify(adapter)};
const sm = new SecretsManagerClient({});
async function secret(id) {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
  return JSON.parse(r.SecretString ?? "{}");
}
export const handler = createLambdaHandler({
  name: ${JSON.stringify(name)},
  verifyJwt: ${verifyJwt},
  // The function settings first, then the server's keys over them: a setting can't replace the database's address or keys
  loadSettings: async () => {
    const [settings, keys] = await Promise.all([secret(process.env.FUNCTION_SETTINGS_SECRET), secret(process.env.KEYS_SECRET)]);
    const all = {};
    for (const [k, v] of Object.entries(settings)) all[k] = String(v);
    for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET"]) {
      if (!keys[k]) throw new Error("The keys secret has no " + k);
      all[k] = String(keys[k]);
    }
    return all;
  },
  loadFunction: () => import(${JSON.stringify(fn)}),
});
`;
    const result = await build({
      stdin: { contents: entry, resolveDir: here, sourcefile: `${name}-lambda.mjs`, loader: "js" },
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      outfile: join(out, name, "index.js"),
      external: ["@aws-sdk/*"],
      // Each function serves only when it is the program (if (import.meta.main) Deno.serve(...)), so its tests can import
      // it without serving. Here it is the program.
      define: { "import.meta.main": "true" },
      plugins: [npmSpecifiers],
      sourcemap: true,
      minify: true,
      legalComments: "none",
      logLevel: "warning",
      metafile: true,
    });
    const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
    manifest[name] = { verifyJwt };
    console.log(`${name.padEnd(24)} verify_jwt=${String(verifyJwt).padEnd(5)} ${(bytes / 1024).toFixed(0)} KiB`);
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ functions: manifest }, null, 2) + "\n");
  console.log(`${names.length} functions -> ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
