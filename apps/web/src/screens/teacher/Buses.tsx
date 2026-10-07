import { listBusesOnRoutes } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { FleetLiveMap } from "../../components/fleet/FleetLiveMap";
import { Skeleton } from "../../components/ui/Skeleton";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

/** Every school bus, live and read-only — handy at dismissal to see who's arriving and when. */
export function TeacherBuses() {
  const { tenant } = useTenantSession();
  const { data, loading, error } = useAsync(() => listBusesOnRoutes(tenant.id), [tenant.id]);

  return (
    <>
      <PageHead eyebrow="Transport" title="School buses" blurb="Where every bus is right now, its route, and when it reaches its next stop." />
      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the buses: {error.message}
          </p>
        ) : loading || !data ? (
          <Skeleton className="h-[560px] rounded-xl" />
        ) : (
          <FleetLiveMap tenantId={tenant.id} buses={data} className="h-[calc(100vh-200px)] min-h-[480px] rounded-xl border border-line" />
        )}
      </div>
    </>
  );
}
