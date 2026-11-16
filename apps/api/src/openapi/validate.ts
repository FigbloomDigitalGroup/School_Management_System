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

function resolveRef(node: Json | undefined): Json | undefined {
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    let cur: any = doc;
    for (const part of node.$ref.slice(2).split("/")) cur = cur?.[part];
    return cur;
  }
  return node;
}

function checkSchemaConstraints(schema: Json | undefined, where: string): void {
  const s = resolveRef(schema);
  if (!s || typeof s !== "object") return;
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) {
    errors.push(`${where}: enum must be a non-empty array`);
  }
  if (s.pattern !== undefined && (typeof s.pattern !== "string" || s.pattern.length === 0)) {
    errors.push(`${where}: pattern must be a non-empty string`);
  }
  if (s.maxLength !== undefined && !(typeof s.maxLength === "number" && s.maxLength >= 0)) {
    errors.push(`${where}: maxLength must be a non-negative number`);
  }
  if (s.minLength !== undefined && !(typeof s.minLength === "number" && s.minLength >= 0)) {
    errors.push(`${where}: minLength must be a non-negative number`);
  }
  if (s.maximum !== undefined && typeof s.maximum !== "number") {
    errors.push(`${where}: maximum must be a number`);
  }
  if (s.minimum !== undefined && typeof s.minimum !== "number") {
    errors.push(`${where}: minimum must be a number`);
  }
  if (s.type === "integer" && s.maximum !== undefined && s.minimum !== undefined && s.maximum < s.minimum) {
    errors.push(`${where}: maximum < minimum`);
  }
  if (s.properties && typeof s.properties === "object") {
    for (const [name, prop] of Object.entries<Json>(s.properties)) {
      checkSchemaConstraints(prop, `${where}.properties.${name}`);
    }
  }
  if (s.items) checkSchemaConstraints(s.items, `${where}.items`);
  for (const key of ["allOf", "oneOf", "anyOf"] as const) {
    if (Array.isArray(s[key])) {
      for (let i = 0; i < s[key].length; i++) checkSchemaConstraints(s[key][i], `${where}.${key}[${i}]`);
    }
  }
}

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

    for (const param of op.parameters ?? []) {
      const p = resolveRef(param);
      if (!p) continue;
      const pWhere = `${where} param ${p.name ?? "?"}`;
      checkSchemaConstraints(p.schema, pWhere);
    }
    const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
    if (bodySchema) checkSchemaConstraints(bodySchema, `${where} requestBody`);
    for (const [code, resp] of Object.entries<Json>(op.responses ?? {})) {
      const r = resolveRef(resp);
      const schema = r?.content?.["application/json"]?.schema;
      if (schema) checkSchemaConstraints(schema, `${where} response ${code}`);
    }
  }
}

// Shared parameter constraints used by pagination (FIG-1621).
const pageLimit = resolveRef(doc.components?.parameters?.PageLimit);
if (pageLimit?.schema) {
  checkSchemaConstraints(pageLimit.schema, "components.parameters.PageLimit");
  if (pageLimit.schema.maximum !== 200) errors.push("PageLimit.schema.maximum must be 200");
  if (pageLimit.schema.minimum !== 1) errors.push("PageLimit.schema.minimum must be 1");
}
const pageCursor = resolveRef(doc.components?.parameters?.PageCursor);
if (pageCursor?.schema) {
  checkSchemaConstraints(pageCursor.schema, "components.parameters.PageCursor");
  if (pageCursor.schema.maxLength !== 2048) errors.push("PageCursor.schema.maxLength must be 2048");
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
