import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type Json = Record<string, any>;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const doc = parse(readFileSync(resolve(root, "openapi/openapi.yaml"), "utf8")) as Json;

const errors: string[] = [];
const METHODS = new Set(["get", "put", "post", "delete", "patch"]);
const AUTHZ = new Set(["public", "authenticated", "permission"]);

if (!String(doc.openapi ?? "").startsWith("3.")) errors.push("openapi version missing or unsupported");
if (!doc.info?.title || !doc.info?.version) errors.push("info.title / info.version required");
if (!doc.paths || Object.keys(doc.paths).length === 0) errors.push("no paths");

const operationIds = new Set<string>();
for (const [path, item] of Object.entries<Json>(doc.paths ?? {})) {
  for (const [method, op] of Object.entries<Json>(item)) {
    if (!METHODS.has(method)) continue;
    const where = `${method.toUpperCase()} ${path}`;
    if (!op.operationId) errors.push(`${where}: operationId missing`);
    else if (operationIds.has(op.operationId)) errors.push(`${where}: duplicate operationId`);
    else operationIds.add(op.operationId);
    if (!AUTHZ.has(op["x-figbloom-authz"])) errors.push(`${where}: x-figbloom-authz must be public|authenticated|permission`);
    if (op["x-figbloom-authz"] === "permission" && !(op["x-figbloom-permissions"]?.length > 0)) {
      errors.push(`${where}: permission operation lists no x-figbloom-permissions`);
    }
    if (op["x-figbloom-authz"] !== "public" && !op.security) errors.push(`${where}: protected operation has no security`);
    if (!op.responses || Object.keys(op.responses).length === 0) errors.push(`${where}: no responses`);
  }
}

// every $ref must resolve
const text = JSON.stringify(doc);
for (const ref of new Set(text.match(/#\/[A-Za-z0-9_/]+/g) ?? [])) {
  let node: any = doc;
  for (const part of ref.slice(2).split("/")) node = node?.[part];
  if (node === undefined) errors.push(`unresolved $ref ${ref}`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`openapi: ${e}`);
  process.exitCode = 1;
} else {
  console.log(`openapi ok: ${Object.keys(doc.paths).length} paths, ${operationIds.size} operations`);
}
