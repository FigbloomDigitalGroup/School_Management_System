import { fetchAiStatus, type AiStatus } from "@figbloom/shared";
import { useAsync } from "./useAsync";
import { useTenantSession } from "./sessionContext";

/**
 * Whether this school has AI drafting (and the study helper) switched on, so
 * screens only show AI buttons that will work. Null while loading or if it
 * can't be read: screens treat that as off.
 */
export function useAiStatus(): AiStatus | null {
  const { tenant } = useTenantSession();
  const { data } = useAsync(() => fetchAiStatus(tenant.id).catch(() => null), [tenant.id]);
  return data ?? null;
}

/** A label for what AI drafting is, shown beside every AI button. */
export const AI_DRAFT_NOTE = "Bloom is an AI and can get things wrong. Read and edit before you save or send.";
