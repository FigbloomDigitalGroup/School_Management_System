import { fetchMyInventory } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { IssuedItems } from "../../components/IssuedItems";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/** What the school has issued this teacher: a laptop, lab keys, a class set they're holding. */
export function TeacherItems() {
  const { profile } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchMyInventory(profile.id), [profile.id]);
  return (
    <>
      <PageHead eyebrow="Inventory" title="My items" blurb="Things the school has issued you, and when they're due back. Returns are recorded by the office." />
      <div className="px-7 py-6">
        <IssuedItems rows={data} loading={loading} error={error} whose="you" />
      </div>
    </>
  );
}
