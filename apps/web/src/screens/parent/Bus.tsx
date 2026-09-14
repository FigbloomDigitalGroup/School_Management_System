import { PageHead } from "../../components/ConsoleShell";
import { VehicleMap } from "../../components/VehicleMap";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState } from "../../components/ui/DataTable";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { myChildBus } from "@figbloom/shared";
import { useParentData } from "../../lib/parentContext";
import { ChildSwitcher } from "./ChildSwitcher";

function fmtLastSeen(iso: string | null): string {
  if (!iso) return "Not reporting yet";
  return `Updated ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Fleet tracking, phase 4: the family view. Same live map as the admin's
 * Fleet screen, narrowed to one child's route — VehicleMap already filters
 * to whatever it's handed, so a one-vehicle array reuses it as-is.
 */
export function ParentBus() {
  const { tenant } = useTenantSession();
  const { child } = useParentData();
  const { data, loading, error } = useAsync(() => (child ? myChildBus(child.id) : Promise.resolve(null)), [child?.id]);

  return (
    <>
      <PageHead
        eyebrow={child ? `${child.cls} · ADM ${child.adm}` : "Bus"}
        title={child ? `${child.first}'s bus` : "Bus"}
        blurb={data?.routeName ? `${data.routeName}${data.driverName ? ` · ${data.driverName} driving` : ""}.` : undefined}
        actions={<ChildSwitcher />}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the bus: {error.message}
          </p>
        ) : loading || !child ? (
          <Skeleton className="h-[360px] rounded-lg" />
        ) : !data ? (
          <EmptyState
            title="Not on a bus route"
            body={`${child.first} isn't linked to a transport route yet. Contact the school office if this seems wrong.`}
          />
        ) : !data.vehicle ? (
          <EmptyState
            title="No bus assigned yet"
            body={`${data.routeName} doesn't have a vehicle assigned to it yet. Check back once the school has set one up.`}
          />
        ) : (
          <div className="grid gap-3.5">
            <VehicleMap tenantId={tenant.id} vehicles={[data.vehicle]} homeStop={data.stop} />
            <div className="flex items-center justify-between rounded-lg border border-line bg-white px-4 py-3">
              <div>
                <div className="text-[13.5px] font-semibold">{data.vehicle.plate_number}</div>
                <div className="text-[12px] text-ink-muted">{data.routeName}{data.driverName ? ` · ${data.driverName}` : ""}</div>
              </div>
              <div className="text-[12px] text-ink-faint">{fmtLastSeen(data.vehicle.last_ping_at)}</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
