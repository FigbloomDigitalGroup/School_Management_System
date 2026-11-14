import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * F-C6 — tenant-boundary detector.
 *
 * Instead of a fixed list of route files, this inspects every `.query(...)` call
 * outside `src/db/` with the TypeScript type checker. If the SQL text names a
 * tenant-scoped table, the receiver's static type must be the branded tenant
 * handle `Tx` (`__tx: "tenant"`). An identity handle, a generic `SqlClient`/`Db`,
 * a pool or a raw client is a violation.
 *
 * The set of tenant tables is supplied by the caller (derived from the live
 * catalogue: every public table with a `tenant_id` column and row security on),
 * so a table added by a future migration is covered without editing this file.
 *
 * This is a static CI-time guard. It is NOT the security proof: the proof is
 * PostgreSQL's behaviour as `figbloom_app` (RLS, grants, GUC manipulation tests).
 */
export interface BoundaryViolation {
  file: string;
  line: number;
  table: string;
  receiverType: string;
}

const HOLE = String.fromCharCode(0);

function sqlText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => HOLE + s.literal.text).join("");
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = sqlText(node.left);
    const r = sqlText(node.right);
    return l === null && r === null ? null : (l ?? HOLE) + (r ?? HOLE);
  }
  if (ts.isParenthesizedExpression(node)) return sqlText(node.expression);
  if (ts.isObjectLiteralExpression(node)) {
    for (const p of node.properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === "text") return sqlText(p.initializer);
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);
}

function tableRegex(tables: readonly string[]): RegExp {
  const alt = tables.map(escapeRegex).join("|");
  return new RegExp(
    "\\b(?:from|join|into|update|table)\\s+(?:only\\s+)?(?:public\\.)?\"?(" + alt + ")\"?\\b",
    "i",
  );
}

export function findTenantBoundaryViolations(opts: {
  tsconfigPath: string;
  srcRoot: string;
  tenantTables: readonly string[];
  /** Directories (relative to srcRoot) allowed to hold raw database access. */
  allowedDirs?: readonly string[];
  /** Extra files to analyse (negative controls). */
  extraFiles?: readonly string[];
  /**
   * Reviewed exceptions: an identity handle may touch `table` in `file`
   * (`"*"` = any file). Every other receiver must be the tenant handle `Tx`.
   */
  identityAllowed?: ReadonlyArray<{ file: string; table: string; reason: string }>;
}): BoundaryViolation[] {
  const allowed = opts.allowedDirs ?? ["db"];
  const cfg = ts.readConfigFile(opts.tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(opts.tsconfigPath));
  const program = ts.createProgram({
    rootNames: [...parsed.fileNames, ...(opts.extraFiles ?? [])],
    options: parsed.options,
  });
  const checker = program.getTypeChecker();
  const re = tableRegex(opts.tenantTables);
  const src = resolve(opts.srcRoot);
  const extra = new Set((opts.extraFiles ?? []).map((f) => resolve(f)));
  const out: BoundaryViolation[] = [];

  for (const sf of program.getSourceFiles()) {
    const abs = resolve(sf.fileName);
    const inSrc = abs.startsWith(src + "\\") || abs.startsWith(src + "/");
    if (!inSrc && !extra.has(abs)) continue;
    const rel = relative(src, abs).split("\\").join("/");
    if (inSrc && allowed.some((d) => rel === d || rel.startsWith(d + "/"))) continue;

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "query"
      ) {
        const text = sqlText(node.arguments[0]);
        const m = text ? re.exec(text) : null;
        if (m) {
          const recvType = checker.getTypeAtLocation(node.expression.expression);
          const tag = recvType.getProperty("__tx");
          const tagType = tag ? checker.getTypeOfSymbolAtLocation(tag, node) : undefined;
          const members = tagType ? (tagType.isUnion() ? tagType.types : [tagType]) : [];
          const identityOk = (opts.identityAllowed ?? []).some(
            (a) => a.table === m[1]!.toLowerCase() && (a.file === "*" || a.file === rel),
          );
          // Every constituent of the receiver type must be a tenant handle, or an
          // identity handle where a reviewed exception exists. A missing __tx
          // brand (SqlClient, Pool, PoolClient, any) is always a violation.
          const isTenantHandle =
            members.length > 0 &&
            members.every(
              (t) =>
                t.isStringLiteral() &&
                (t.value === "tenant" || (t.value === "identity" && identityOk)),
            );
          if (!isTenantHandle) {
            const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
            out.push({
              file: rel,
              line: line + 1,
              table: m[1]!,
              receiverType: checker.typeToString(recvType),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
