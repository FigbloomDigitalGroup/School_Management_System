import { AI_DRAFT_NOTE, fetchAiStatus, type AiStatus } from "@figbloom/shared";
import { useAsync } from "./useAsync";
import { useTenantSession } from "./sessionContext";

/**
 * Whether this school has AI drafting (and the study helper) switched on, so
 * screens only show AI buttons that will work. Null while loading or if it
 * can't be read: screens treat that as off.
 */
export function useAiStatus(enabled = true): AiStatus | null {
  const { tenant } = useTenantSession();
  const { data } = useAsync(() => (enabled ? fetchAiStatus(tenant.id).catch(() => null) : Promise.resolve(null)), [tenant.id, enabled]);
  return data ?? null;
}

export { AI_DRAFT_NOTE };
