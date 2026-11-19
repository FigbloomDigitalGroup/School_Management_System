import type { Tx } from "../../db/sql.js";
import { validationError } from "../../http/errors.js";
import {
  decodeCursor,
  pageFingerprint,
  pageFromKeysetRows,
  parseLimit,
  pgTimestamptzMicrosExpr,
  type CursorKeySpec,
  type PageInfo,
} from "../../http/pagination.js";
import { pgCode } from "./pgError.js";

/**
 * OD-4 keyset pagination for Stage 9/10 lists, on the FIG-1621 convention (src/http/pagination.ts):
 * `limit` 1–200 (default 50), opaque cursor v2 `{v, k, f, s}`, response `page: { limit, next_cursor }`,
 * `next_cursor` null on the last page, `?sort` refused (fixed sort per list).
 *
 * - Order is (sort key, id): total and stable.
 * - The fingerprint covers the wrapped query text and ALL its bound parameters (tenant, filters and the
 *   OD-2 teacher class scope). A cursor replayed under another filter, scope or tenant is refused
 *   ("cursor does not match this query"), and the tenant/scope filters are inside the wrapped query, so
 *   even a forged cursor can only move the position within rows the caller may already see.
 * - Keys are PostgreSQL text (timestamps as UTC with microseconds), validated before any SQL cast.
 */
export interface PageInput {
  limit: number;
  rawCursor: unknown;
}

export interface Page<T> {
  items: T[];
  page: PageInfo;
}

export function parsePage(query: unknown): PageInput {
  const q = (query ?? {}) as Record<string, unknown>;
  if (q.sort !== undefined && q.sort !== null && q.sort !== "") {
    throw validationError("sort is not supported on this endpoint", [
      { field: "sort", code: "invalid_value", message: "Invalid value" },
    ]);
  }
  return { limit: parseLimit(q.limit), rawCursor: q.cursor };
}

export type SortType = "text" | "date" | "timestamptz" | "integer";

export interface SortSpec {
  /** Stable name bound into cursors. */
  name: string;
  /** Expression over the wrapped row alias `q`, never null. */
  expr: string;
  type: SortType;
  dir: "asc" | "desc";
}

const KEY_SPEC: Record<SortType, CursorKeySpec> = {
  text: { kind: "text", maxLen: 400 },
  date: { kind: "text", maxLen: 10 },
  integer: { kind: "text", maxLen: 11 },
  timestamptz: { kind: "timestamptz_micros" },
};

const KEY_SHAPE: Partial<Record<SortType, RegExp>> = {
  date: /^\d{4}-\d{2}-\d{2}$/,
  integer: /^-?\d{1,10}$/,
};

/**
 * Run `inner` (a complete SELECT with its own tenant / scope WHERE, no ORDER BY or LIMIT; it must
 * output `id`) one page at a time. Rows come back with an extra `page_key` column, which the mappers
 * never copy into responses.
 */
export async function pageQuery<R extends { id: string }>(
  tx: Tx,
  inner: string,
  params: readonly unknown[],
  sort: SortSpec,
  page: PageInput,
  /** Restrict to one row (by-id lookups and idempotent replays share the list's query and scope). */
  onlyId?: string,
): Promise<{ rows: Array<R & { page_key: string }>; page: PageInfo }> {
  const fingerprint = pageFingerprint(sort.name, { inner, params: params.map((v) => v ?? null) });
  const cursor = onlyId === undefined
    ? decodeCursor(page.rawCursor, { sort: sort.name, fingerprint, keySpecs: [KEY_SPEC[sort.type], { kind: "uuid" }] })
    : null;
  const shape = KEY_SHAPE[sort.type];
  if (cursor && shape && !shape.test(cursor.k[0]!)) throw validationError("cursor is invalid");

  const p: unknown[] = [...params];
  const conds: string[] = [];
  if (onlyId !== undefined) {
    p.push(onlyId);
    conds.push(`q.id = $${p.length}::uuid`);
  }
  if (cursor) {
    p.push(cursor.k[0], cursor.k[1]);
    const op = sort.dir === "asc" ? ">" : "<";
    conds.push(`(${sort.expr}, q.id) ${op} ($${p.length - 1}::${sort.type}, $${p.length}::uuid)`);
  }
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const keyExpr = sort.type === "timestamptz" ? pgTimestamptzMicrosExpr(sort.expr) : `(${sort.expr})::text`;
  const dir = sort.dir === "asc" ? "ASC" : "DESC";
  p.push(page.limit + 1);
  let res;
  try {
    res = await tx.query<R & { page_key: string }>(
      `SELECT q.*, ${keyExpr} AS page_key FROM (${inner}) q${where}
        ORDER BY ${sort.expr} ${dir}, q.id ${dir} LIMIT $${p.length}`,
      p,
    );
  } catch (err) {
    const code = pgCode(err);
    if (code && code.startsWith("22")) throw validationError("cursor is invalid");
    throw err;
  }
  const out = pageFromKeysetRows(res.rows, {
    limit: page.limit,
    sort: sort.name,
    fingerprint,
    keysOf: (row) => [row.page_key, row.id],
  });
  return { rows: out.items, page: out.page };
}

/** A single-row page request, for by-id lookups through a list's query. */
export const ONE_ROW: PageInput = { limit: 1, rawCursor: undefined };
