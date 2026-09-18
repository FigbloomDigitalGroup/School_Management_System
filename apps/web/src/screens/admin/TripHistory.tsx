import { useState } from "react";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { Modal } from "../../components/ui/Modal";
import { Skeleton } from "../../components/ui/Skeleton";
import { TripReplayMap } from "../../components/TripReplayMap";
import { useAsync } from "../../lib/useAsync";
import { fetchTripPath, listTrips, type TripRow } from "@figbloom/shared";

const STATUS_TONE: Record<TripRow["status"], Tone> = { active: "ok", completed: "muted", cancelled: "warn" };
const DIRECTION_LABEL: Record<TripRow["direction"], string> = { to_school: "To school", from_school: "From school" };

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(startedAt: string, endedAt: string | null): string {
  const end = endedAt ? new Date(endedAt) : new Date();
  const mins = Math.max(0, Math.round((end.getTime() - new Date(startedAt).getTime()) / 60000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/**
 * Every trip a driver has started, most recent first — scrubbable replay of
 * the exact vehicle_locations history already being recorded, not a new
 * computation. Answers "where did this bus actually go on Tuesday."
 */
export function TripHistory({ tenantId }: { tenantId: string }) {
  const { data: trips, loading, error } = useAsync(() => listTrips(tenantId), [tenantId]);
  const [openTrip, setOpenTrip] = useState<TripRow | null>(null);

  return (
    <section>
      <h2 className="mb-3 text-[14px] font-semibold">Trip history</h2>
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load trip history: {error.message}</p>
      ) : loading || !trips ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : (
        <DataTable
          columns={[
            { key: "vehicle", header: "Vehicle", render: (t: TripRow) => <Mono>{t.vehicle?.plate_number ?? "—"}</Mono> },
            { key: "driver", header: "Driver", render: (t: TripRow) => <Cell>{t.driver?.full_name ?? "—"}</Cell> },
            { key: "route", header: "Route", render: (t: TripRow) => <span className="text-[13px]">{t.route?.name ?? "—"}</span> },
            { key: "direction", header: "Direction", render: (t: TripRow) => <span className="text-[13px]">{DIRECTION_LABEL[t.direction]}</span> },
            { key: "started", header: "Started", render: (t: TripRow) => <span className="font-mono text-[12px] text-ink-muted">{fmtWhen(t.started_at)}</span> },
            { key: "duration", header: "Duration", render: (t: TripRow) => <span className="font-mono text-[12px] text-ink-muted">{fmtDuration(t.started_at, t.ended_at)}</span> },
            { key: "status", header: "", align: "right", render: (t: TripRow) => <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge> },
          ]}
          rows={trips}
          rowKey={(t) => t.id}
          onRowClick={(t) => setOpenTrip(t)}
          minWidth="820px"
          empty={{ title: "No trips yet", body: "Trips appear here once a driver starts one from their own page." }}
        />
      )}

      {openTrip && <TripReplayModal trip={openTrip} onClose={() => setOpenTrip(null)} />}
    </section>
  );
}

function TripReplayModal({ trip, onClose }: { trip: TripRow; onClose: () => void }) {
  const { data: path, loading, error } = useAsync(() => fetchTripPath(trip.id), [trip.id]);

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Trip replay"
      title={`${trip.vehicle?.plate_number ?? "Vehicle"} · ${DIRECTION_LABEL[trip.direction]}`}
      blurb={`${fmtWhen(trip.started_at)} · ${trip.driver?.full_name ?? "Driver"}${trip.route?.name ? ` · ${trip.route.name}` : ""}`}
      width={720}
    >
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load the path: {error.message}</p>
      ) : loading || !path ? (
        <Skeleton className="h-80 w-full rounded-lg" />
      ) : (
        <TripReplayMap path={path} />
      )}
    </Modal>
  );
}
