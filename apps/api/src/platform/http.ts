/**
 * Small helpers for the calls the API makes to the Figbloom platform and to Figbloom HR (docs/MY-HR.md). Shared by the
 * platform token client and the HR caller, so each of them stays short. Three rules live here:
 *
 *   - a timeout on every call that also covers reading the answer (a server that sends its headers and then stalls
 *     cannot hold a request open);
 *   - an answer is read up to a size limit and no further;
 *   - nothing that comes back is logged or put in an error message: callers get a reason, never the body.
 */

/** A deadline for one call: aborts after `timeoutMs`, or sooner when `signal` (the caller going away) aborts. */
export interface Deadline {
  signal: AbortSignal;
  /** True when it was the timeout that fired. */
  timedOut(): boolean;
  /** Always call this when the call is over (timer and listener). */
  cleanup(): void;
}

export function deadline(timeoutMs: number, signal?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

export type BodyText = { text: string; tooLarge: false } | { text: null; tooLarge: true };

/**
 * The answer's body as text, when it is at most `maxBytes`. A bigger body is not read to the end: the stream is cancelled
 * and `tooLarge` is set. A read that fails (the deadline fired, the connection dropped) throws.
 */
export async function readBodyText(res: Response, maxBytes: number): Promise<BodyText> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return { text: null, tooLarge: true };
  }
  const reader = res.body?.getReader();
  if (!reader) return { text: "", tooLarge: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { text: null, tooLarge: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), tooLarge: false };
}

/** The text as JSON; undefined when it is empty or not JSON. */
export function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
