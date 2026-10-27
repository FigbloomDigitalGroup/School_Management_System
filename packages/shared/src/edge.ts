import { supabase } from "./supabase";

/** A failed edge-function call, carrying the HTTP status when there was one (undefined: never reached the function, or timed out). */
export class EdgeError extends Error {
  constructor(message: string, readonly status?: number, readonly cancelled = false) {
    super(message);
    this.name = "EdgeError";
  }
}

export interface InvokeOptions {
  /** Give up after this long (AbortController + setTimeout: the mobile apps' JS engine has no AbortSignal.timeout). */
  timeoutMs: number;
  /** Lets the caller give up early (a Stop button); the call then throws an EdgeError with `cancelled` set. */
  signal?: AbortSignal;
}

/**
 * Calls an edge function and returns its JSON, or throws an EdgeError that
 * says what went wrong in the function's own words: every function answers
 * `{ error: "<a sentence a person can read>" }` on a refusal, and supabase-js
 * hides that behind a generic "non-2xx" message unless the response body is
 * read from `error.context`.
 */
export async function invokeEdge<T>(fn: string, body: Record<string, unknown>, { timeoutMs, signal }: InvokeOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel);
  try {
    const { data, error } = await supabase().functions.invoke<T | { error: string }>(fn, { body, signal: controller.signal });
    if (signal?.aborted) throw new EdgeError("Stopped.", undefined, true);
    if (error) {
      if (controller.signal.aborted) throw new EdgeError("That took too long. Check your connection and try again.");
      const ctx = (error as { context?: Response }).context;
      let message = (error as { message?: string }).message ?? "The request failed.";
      if (ctx && typeof ctx.json === "function") {
        try {
          const parsed = (await ctx.json()) as { error?: string };
          if (parsed?.error) message = parsed.error;
        } catch { /* not JSON (a bare gateway error): keep supabase-js's message */ }
      }
      throw new EdgeError(message, ctx?.status);
    }
    if (data && typeof data === "object" && "error" in data) throw new EdgeError(String((data as { error: unknown }).error));
    return data as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
