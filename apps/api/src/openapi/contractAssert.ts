/**
 * Lightweight live OpenAPI contract helpers (R3-06 / D-12).
 * Validates required properties and nested required keys against the YAML
 * component schemas without pulling a heavyweight validator.
 */

export type SchemaNode = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  $ref?: string;
};

export function resolveRef(
  doc: { components?: { schemas?: Record<string, SchemaNode> } },
  node: SchemaNode | undefined,
): SchemaNode | undefined {
  if (!node) return undefined;
  if (!node.$ref) return node;
  const name = node.$ref.replace("#/components/schemas/", "");
  return doc.components?.schemas?.[name];
}

export function assertMatchesSchema(
  value: unknown,
  schema: SchemaNode | undefined,
  doc: { components?: { schemas?: Record<string, SchemaNode> } },
  path = "$",
): string[] {
  const errors: string[] = [];
  const resolved = resolveRef(doc, schema);
  if (!resolved) {
    errors.push(`${path}: schema missing`);
    return errors;
  }

  if (value === null || value === undefined) {
    const types = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
    if (types.includes("null") || types.includes(undefined)) return errors;
    errors.push(`${path}: expected value, got ${String(value)}`);
    return errors;
  }

  if (resolved.type === "object" || resolved.properties || resolved.required) {
    if (typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    for (const key of resolved.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required property missing`);
    }
    for (const [key, propSchema] of Object.entries(resolved.properties ?? {})) {
      if (key in obj) {
        errors.push(...assertMatchesSchema(obj[key], propSchema, doc, `${path}.${key}`));
      }
    }
  }

  if (resolved.type === "array" && resolved.items) {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return errors;
    }
    value.forEach((item, i) => {
      errors.push(...assertMatchesSchema(item, resolved.items, doc, `${path}[${i}]`));
    });
  }

  return errors;
}

export function assertErrorShape(body: unknown): string[] {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return [`$: expected error object`];
  const err = (body as { error?: { code?: unknown; message?: unknown } }).error;
  if (!err || typeof err !== "object") errors.push(`$.error: required`);
  else {
    if (typeof err.code !== "string") errors.push(`$.error.code: string required`);
    if (typeof err.message !== "string") errors.push(`$.error.message: string required`);
  }
  return errors;
}
