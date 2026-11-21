import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/**
 * OA-1 runtime conformance: validate real responses against the OpenAPI document. Supports the JSON
 * Schema subset the spec uses: $ref, type (incl. type arrays for null), properties, required,
 * additionalProperties:false, items, enum, const, anyOf, format uuid/date/date-time, minimum/maximum.
 */
type Json = any;

export function loadSpec(): Json {
  return YAML.parse(readFileSync(join(process.cwd(), "openapi", "openapi.yaml"), "utf8"));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function validate(spec: Json, schema: Json, value: unknown, at = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (schema.$ref) {
    const target = String(schema.$ref).slice(2).split("/").reduce((cur: Json, k: string) => cur?.[k], spec);
    if (!target) return [`${at}: unresolved ${schema.$ref}`];
    return validate(spec, target, value, at);
  }
  if (Array.isArray(schema.anyOf)) {
    const ok = schema.anyOf.some((s: Json) => validate(spec, s, value, at).length === 0);
    return ok ? [] : [`${at}: matches none of anyOf`];
  }
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const fits = types.includes(t) || (t === "integer" && types.includes("number"));
    if (!fits) return [`${at}: expected ${types.join("|")}, got ${t}`];
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string" && schema.format) {
    const re = schema.format === "uuid" ? UUID : schema.format === "date" ? DATE : schema.format === "date-time" ? DATE_TIME : null;
    if (re && !re.test(value)) errors.push(`${at}: not a ${schema.format}: ${value}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) if (!(r in (value as Json))) errors.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value as Json)) {
      if (props[k]) errors.push(...validate(spec, props[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}: undocumented property ${k}`);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validate(spec, schema.items, v, `${at}[${i}]`)));
  }
  return errors;
}

/** The documented response schema for an operation and status, or a reason it is missing. */
export function responseSchema(spec: Json, method: string, path: string, status: number): Json | string {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  if (!op) return `undocumented operation ${method} ${path}`;
  const res = op.responses?.[String(status)];
  if (!res) return `undocumented status ${status} for ${method} ${path}`;
  const schema = res.content?.["application/json"]?.schema;
  return schema ?? `no schema for ${status} ${method} ${path}`;
}
