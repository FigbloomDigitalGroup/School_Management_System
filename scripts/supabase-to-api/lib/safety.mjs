// Guards shared by the extract and load scripts. They handle real people, children among them.
import { isAbsolute, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The snapshot, the ledger and the invitation tokens must never end up in git. */
export function assertOutsideRepo(dir, what) {
  const abs = resolve(dir);
  const rel = relative(repoRoot, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside) {
    throw new Error(`${what} ${abs} is inside the repository. It holds real people; use a folder outside it.`);
  }
  return abs;
}

export function isLoopbackUrl(url) {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
