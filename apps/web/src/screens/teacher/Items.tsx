import { canReadMyItems, fetchMyInventory } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { IssuedItems } from "../../components/IssuedItems";
import { EmptyState } from "../../components/ui/DataTable";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

/** What the school has issued this teacher: a laptop, lab keys, a class set they're holding. */
export function TeacherItems() {
  const { profile, adminAreas } = useTenantSession();
  const mayRead = canReadMyItems(adminAreas, profile.role);
  const { data, loading, error } = useAsync(
    () => (mayRead ? fetchMyInventory(profile.id) : Promise.resolve([])),
    [profile.id, mayRead],
  );
  return (
    <>
      <PageHead eyebrow="Inventory" title="My items" blurb="Things the school has issued you, and when they're due back. Returns are recorded by the office." />
      <div className="px-7 py-6">
        {!mayRead ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState
              title="Your issued items aren't available here yet."
              body="On the new system only holders of the Inventory area can read issued items. Ask the school office if you need a list of items issued to you."
            />
          </div>
        ) : (
          <IssuedItems rows={data} loading={loading} error={error} whose="you" />
        )}
      </div>
    </>
  );
}
