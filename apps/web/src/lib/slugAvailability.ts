import { useEffect, useState } from "react";
import { slugAlternatives, supabase, validateSlug } from "@figbloom/shared";

export type SlugKind = "school" | "organization";

/**
 * Which of these addresses are already in use. Goes through the
 * tenant_slugs_taken / organization_slugs_taken functions because most people
 * filling in these forms can't read the tables themselves.
 */
export async function fetchTakenSlugs(kind: SlugKind, slugs: string[]): Promise<Set<string>> {
  const fn = kind === "school" ? "tenant_slugs_taken" : "organization_slugs_taken";
  const { data, error } = await supabase().rpc(fn, { p_slugs: slugs });
  if (error) throw error;
  return new Set((data ?? []) as string[]);
}

export interface SlugAvailability {
  /** "unknown": the check itself failed -- don't block, the insert still enforces uniqueness. */
  status: "idle" | "checking" | "free" | "taken" | "unknown";
  /** Free alternatives, only when taken. */
  alternatives: string[];
}

/** Live "is this address free" for a form field, checked a moment after typing stops. */
export function useSlugAvailability(kind: SlugKind, slug: string, place?: string | null): SlugAvailability {
  const [result, setResult] = useState<SlugAvailability & { for: string }>({ for: "", status: "idle", alternatives: [] });
  const valid = !!slug && validateSlug(slug).ok;

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    const timer = setTimeout(async () => {
      const candidates = slugAlternatives(slug, place);
      try {
        const taken = await fetchTakenSlugs(kind, [slug, ...candidates]);
        if (!alive) return;
        setResult(taken.has(slug)
          ? { for: slug, status: "taken", alternatives: candidates.filter((c) => !taken.has(c)).slice(0, 3) }
          : { for: slug, status: "free", alternatives: [] });
      } catch {
        if (alive) setResult({ for: slug, status: "unknown", alternatives: [] });
      }
    }, 350);
    return () => { alive = false; clearTimeout(timer); };
  }, [kind, slug, place, valid]);

  if (!valid) return { status: "idle", alternatives: [] };
  // a result for an earlier keystroke says nothing about this one
  if (result.for !== slug) return { status: "checking", alternatives: [] };
  return { status: result.status, alternatives: result.alternatives };
}

/**
 * A tenants insert error as a sentence the person can act on. Postgres errors
 * arrive as plain objects (not Error), which is why forms used to fall back
 * to a bare "Could not add the school."
 */
export function schoolInsertError(err: unknown, slug: string): Error {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === "23505" && e.message?.includes("slug")) {
    return new Error(`figbloom.co.ke/s/${slug} was taken by another school a moment ago. Pick a different web address.`);
  }
  if (e?.code === "23514" && e.message?.includes("slug")) {
    return new Error("That web address isn't valid: use 3-40 lowercase letters, numbers and hyphens.");
  }
  if (err instanceof Error) return err;
  return new Error(e?.message || "The school could not be saved. Check your connection and try again.");
}

/** invite-admin's "That email is already in use." says what, not what to do. */
export function adminInviteError(err: unknown, email: string): string {
  const message = err instanceof Error ? err.message : String((err as { message?: string } | null)?.message ?? "");
  if (/already in use|already been registered/i.test(message)) {
    return `${email} already has a Figbloom login, so it can't also be this school's administrator. Use the administrator's own email address.`;
  }
  return message || "The administrator's account could not be created.";
}
