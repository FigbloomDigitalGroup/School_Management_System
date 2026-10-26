import { fetchOwnLearnerInventory } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { IssuedItems } from "../../components/IssuedItems";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/** The textbooks and equipment the school has lent this learner. */
export function StudentItems() {
  const { profile } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchOwnLearnerInventory(profile.id), [profile.id]);
  return (
    <>
      <PageHead eyebrow="Inventory" title="My items" blurb="Books and equipment the school has lent you, and when to bring them back." />
      <div className="px-7 py-6">
        <IssuedItems rows={data} loading={loading} error={error} whose="you" />
      </div>
    </>
  );
}
