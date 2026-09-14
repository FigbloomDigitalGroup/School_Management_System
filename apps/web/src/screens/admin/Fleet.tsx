import { useEffect, useMemo, useState } from "react";
import type { Route, Vehicle } from "@figbloom/shared";
import {
  acknowledgeAlert,
  assignDriver,
  createRoute,
  createVehicle,
  listAlerts,
  listAssignments,
  listDrivers,
  listRouteStops,
  listRoutes,
  listVehicles,
  replaceRouteStops,
  subscribeVehicleAlerts,
  type AlertRow,
  type AssignmentRow,
  type DriverOption,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { VehicleMap } from "../../components/VehicleMap";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow } from "../../components/ui/StatCard";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { TripHistory } from "./TripHistory";

interface FleetData {
  vehicles: Vehicle[];
  routes: Route[];
  drivers: DriverOption[];
  assignments: AssignmentRow[];
  alerts: AlertRow[];
}

async function fetchFleet(): Promise<FleetData> {
  const [vehicles, routes, drivers, assignments, alerts] = await Promise.all([
    listVehicles(),
    listRoutes(),
    listDrivers(),
    listAssignments(),
    listAlerts(),
  ]);
  return { vehicles, routes, drivers, assignments, alerts };
}

function fmtLastSeen(iso: string | null): string {
  if (!iso) return "Not reporting yet";
  return `Last seen ${new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

function fmtAlertTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Fleet tracking: admin CRUD (vehicles, routes and stops, who's driving what),
 * phase 3's live map, and phase 5's alerts — speeding or off-route is caught
 * server-side by a trigger on every incoming ping (see
 * supabase/migrations/20260903000007_fleet_alerts.sql), not computed here, so
 * this screen only ever displays and acknowledges what the database already
 * decided. New alerts stream in over Realtime without a refresh.
 */
export function Fleet() {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, loading, error } = useAsync(() => fetchFleet(), [refreshKey]);
  const refresh = () => setRefreshKey((k) => k + 1);

  const [addVehicleOpen, setAddVehicleOpen] = useState(false);
  const [addRouteOpen, setAddRouteOpen] = useState(false);
  const [openRouteId, setOpenRouteId] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);

  useEffect(() => {
    return subscribeVehicleAlerts(tenant.id, (alert) => {
      toast(alert.kind === "speed" ? `Speed alert: ${alert.detail}` : `Off-route alert: ${alert.detail}`);
      refresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant.id]);

  async function ack(alertId: string) {
    setAcking(alertId);
    try {
      await acknowledgeAlert(alertId, profile.id);
      refresh();
    } catch (err) {
      toast("Could not acknowledge the alert: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setAcking(null);
    }
  }

  const assignmentByVehicle = useMemo(() => {
    const m = new Map<string, AssignmentRow>();
    for (const a of data?.assignments ?? []) m.set(a.vehicle_id, a);
    return m;
  }, [data]);


  return (
    <>
      <PageHead
        eyebrow="Fleet"
        title="Buses and drivers"
        blurb="Vehicles, routes and who's driving them, plus every bus currently on the road."
        actions={
          <>
            <Button onClick={() => setAddRouteOpen(true)}>+ Add route</Button>
            <Button variant="accent" onClick={() => setAddVehicleOpen(true)}>+ Add vehicle</Button>
          </>
        }
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the fleet: {error.message}
          </p>
        ) : loading || !data ? (
          <div className="grid gap-6">
            <TableSkeleton rows={3} />
            <TableSkeleton rows={3} />
            <TableSkeleton rows={3} />
          </div>
        ) : (
          <div className="grid gap-8">
            <StatRow
              stats={[
                { label: "Vehicles", value: String(data.vehicles.length), sub: `${data.vehicles.filter((v) => v.active).length} active` },
                { label: "Routes", value: String(data.routes.length) },
                { label: "Drivers", value: String(data.drivers.length) },
                { label: "Assigned", value: String(data.assignments.length), sub: `of ${data.vehicles.length} vehicles` },
                { label: "Open alerts", value: String(data.alerts.length), sub: data.alerts.length > 0 ? "needs a look" : "all clear" },
              ]}
            />

            {data.alerts.length > 0 && (
              <section>
                <h2 className="mb-3 text-[14px] font-semibold">Alerts</h2>
                <div className="grid gap-2">
                  {data.alerts.map((a) => (
                    <div
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-warn-ink">
                          <Mono>{a.vehicle?.plate_number ?? "Vehicle"}</Mono> · {a.kind === "speed" ? "Speeding" : "Off route"}
                        </div>
                        <div className="mt-0.5 text-[12.5px] text-warn-ink/90">{a.detail}</div>
                        <div className="mt-0.5 text-[11px] text-ink-faint">{fmtAlertTime(a.created_at)}</div>
                      </div>
                      <Button onClick={() => void ack(a.id)} disabled={acking === a.id}>
                        {acking === a.id ? "Acknowledging…" : "Acknowledge"}
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="mb-3 text-[14px] font-semibold">Live map</h2>
              <VehicleMap tenantId={tenant.id} vehicles={data.vehicles} />
            </section>

            <section>
              <h2 className="mb-3 text-[14px] font-semibold">Vehicles</h2>
              <DataTable
                columns={[
                  {
                    key: "plate", header: "Vehicle", width: "1.4fr",
                    render: (v: Vehicle) => <Cell sub={v.make_model ?? undefined}><Mono>{v.plate_number}</Mono></Cell>,
                  },
                  { key: "capacity", header: "Capacity", render: (v: Vehicle) => <span className="text-[13px]">{v.capacity ?? "—"}</span> },
                  { key: "status", header: "Status", render: (v: Vehicle) => <Badge tone={v.active ? "ok" : "muted"}>{v.active ? "Active" : "Inactive"}</Badge> },
                  {
                    key: "assigned", header: "Driver & route", width: "1.6fr",
                    render: (v: Vehicle) => {
                      const a = assignmentByVehicle.get(v.id);
                      if (!a) return <span className="text-[12.5px] text-ink-faint">Unassigned</span>;
                      return (
                        <span className="text-[12.5px]">
                          {a.driver?.full_name ?? "Driver"}
                          {a.route?.name ? <span className="text-ink-faint"> · {a.route.name}</span> : null}
                        </span>
                      );
                    },
                  },
                  { key: "seen", header: "Last seen", render: (v: Vehicle) => <span className="text-[12px] text-ink-faint">{fmtLastSeen(v.last_ping_at)}</span> },
                ]}
                rows={data.vehicles}
                rowKey={(v) => v.id}
                minWidth="800px"
                empty={{
                  title: "No vehicles yet",
                  body: "Add the school's first bus to start assigning drivers and routes.",
                  action: <Button variant="primary" onClick={() => setAddVehicleOpen(true)}>+ Add vehicle</Button>,
                }}
              />
            </section>

            <section>
              <h2 className="mb-3 text-[14px] font-semibold">Routes</h2>
              {data.routes.length === 0 ? (
                <div className="rounded-lg border border-line bg-white px-6 py-10 text-center">
                  <p className="text-[13px] text-ink-muted">No routes yet. Add one to start listing its stops.</p>
                </div>
              ) : (
                <ol className="grid gap-2">
                  {data.routes.map((r) => (
                    <RouteCard
                      key={r.id}
                      route={r}
                      tenantId={tenant.id}
                      open={openRouteId === r.id}
                      onToggle={() => setOpenRouteId(openRouteId === r.id ? null : r.id)}
                      toast={toast}
                      onSaved={() => { toast(`Stops saved for ${r.name}`); refresh(); }}
                    />
                  ))}
                </ol>
              )}
            </section>

            <TripHistory />

            <section>
              <h2 className="mb-3 text-[14px] font-semibold">Assign a driver</h2>
              {data.vehicles.length === 0 ? (
                <p className="text-[13px] text-ink-muted">Add a vehicle first.</p>
              ) : data.drivers.length === 0 ? (
                <p className="text-[13px] text-ink-muted">No driver accounts exist yet. A driver needs an account with the "driver" role before they can be assigned.</p>
              ) : (
                <div className="grid gap-2">
                  {data.vehicles.map((v) => (
                    <AssignRow
                      key={v.id}
                      vehicle={v}
                      drivers={data.drivers}
                      routes={data.routes}
                      current={assignmentByVehicle.get(v.id) ?? null}
                      tenantId={tenant.id}
                      toast={toast}
                      onAssigned={() => { toast(`Assigned a driver to ${v.plate_number}`); refresh(); }}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      <AddVehicleModal
        open={addVehicleOpen}
        onClose={() => setAddVehicleOpen(false)}
        tenantId={tenant.id}
        toast={toast}
        onCreated={() => { toast("Vehicle added"); refresh(); }}
      />
      <AddRouteModal
        open={addRouteOpen}
        onClose={() => setAddRouteOpen(false)}
        tenantId={tenant.id}
        toast={toast}
        onCreated={() => { toast("Route added"); refresh(); }}
      />
    </>
  );
}

function RouteCard({ route, tenantId, open, onToggle, onSaved, toast }: {
  route: Route; tenantId: string; open: boolean; onToggle: () => void; onSaved: () => void; toast: (m: string) => void;
}) {
  return (
    <li className="overflow-hidden rounded-xl border" style={{ borderColor: open ? "var(--accent)" : "#E2E6E2" }}>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left">
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold">{route.name}</span>
          {route.description && <span className="mt-0.5 block text-[12.5px] text-ink-muted">{route.description}</span>}
        </span>
        <span aria-hidden className="text-ink-faint">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-t border-line-soft bg-page px-4 py-3.5">
          <StopsEditor routeId={route.id} tenantId={tenantId} toast={toast} onSaved={onSaved} />
        </div>
      )}
    </li>
  );
}

interface StopRow { name: string; lat: string; lng: string }

function StopsEditor({ routeId, tenantId, toast, onSaved }: {
  routeId: string; tenantId: string; toast: (m: string) => void; onSaved: () => void;
}) {
  const { data: stops, loading, error } = useAsync(() => listRouteStops(routeId), [routeId]);
  const [rows, setRows] = useState<StopRow[] | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (stops && rows === null) setRows(stops.map((s) => ({ name: s.name, lat: String(s.lat), lng: String(s.lng) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops]);

  function update(i: number, patch: Partial<StopRow>) {
    setRows((r) => (r ?? []).map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function addRow() {
    setRows((r) => [...(r ?? []), { name: "", lat: "", lng: "" }]);
  }
  function removeRow(i: number) {
    setRows((r) => (r ?? []).filter((_, idx) => idx !== i));
  }

  async function save() {
    const parsed = (rows ?? [])
      .map((r) => ({ name: r.name.trim(), lat: Number(r.lat), lng: Number(r.lng) }))
      .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng));
    setSaving(true);
    try {
      await replaceRouteStops(tenantId, routeId, parsed);
      onSaved();
    } catch (err) {
      toast("Could not save stops: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="text-[12.5px] text-warn-ink">Could not load stops: {error.message}</p>;
  if (loading || rows === null) return <Skeleton className="h-20 w-full" />;

  return (
    <div className="grid gap-2.5">
      {rows.length === 0 && <p className="text-[12.5px] text-ink-muted">No stops yet. Add one below.</p>}
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            value={row.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Stop name"
            aria-label={`Stop ${i + 1} name`}
            className="min-w-[140px] flex-1 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
          />
          <input
            value={row.lat} onChange={(e) => update(i, { lat: e.target.value })} placeholder="Lat" type="number" step="any"
            aria-label={`Stop ${i + 1} latitude`}
            className="w-24 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
          />
          <input
            value={row.lng} onChange={(e) => update(i, { lng: e.target.value })} placeholder="Lng" type="number" step="any"
            aria-label={`Stop ${i + 1} longitude`}
            className="w-24 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
          />
          <button onClick={() => removeRow(i)} aria-label={`Remove stop ${i + 1}`} className="text-[12px] font-semibold text-warn-ink">
            Remove
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2.5">
        <Button onClick={addRow}>+ Add stop</Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save stops"}</Button>
      </div>
    </div>
  );
}

function AssignRow({ vehicle, drivers, routes, current, tenantId, toast, onAssigned }: {
  vehicle: Vehicle; drivers: DriverOption[]; routes: Route[]; current: AssignmentRow | null;
  tenantId: string; toast: (m: string) => void; onAssigned: () => void;
}) {
  const [driverId, setDriverId] = useState(current?.driver_id ?? "");
  const [routeId, setRouteId] = useState(current?.route_id ?? "");
  const [saving, setSaving] = useState(false);

  async function assign() {
    if (!driverId) return;
    setSaving(true);
    try {
      await assignDriver({ tenantId, vehicleId: vehicle.id, driverId, routeId: routeId || null });
      onAssigned();
    } catch (err) {
      toast("Could not assign driver: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line-soft bg-white px-3.5 py-2.5">
      <div className="min-w-[150px]">
        <div className="text-[13px] font-medium"><Mono>{vehicle.plate_number}</Mono></div>
        <div className="mt-0.5 text-[11.5px] text-ink-faint">
          {current ? `Currently ${current.driver?.full_name ?? "assigned"}${current.route?.name ? ` · ${current.route.name}` : ""}` : "Unassigned"}
        </div>
      </div>
      <select
        value={driverId} onChange={(e) => setDriverId(e.target.value)} aria-label={`Driver for ${vehicle.plate_number}`}
        className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
      >
        <option value="">Choose a driver</option>
        {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
      </select>
      <select
        value={routeId} onChange={(e) => setRouteId(e.target.value)} aria-label={`Route for ${vehicle.plate_number}`}
        className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small"
      >
        <option value="">No route yet</option>
        {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <Button variant="primary" onClick={() => void assign()} disabled={saving || !driverId}>
        {saving ? "Assigning…" : current ? "Reassign" : "Assign"}
      </Button>
    </div>
  );
}

function AddVehicleModal({ open, onClose, tenantId, toast, onCreated }: {
  open: boolean; onClose: () => void; tenantId: string; toast: (m: string) => void; onCreated: () => void;
}) {
  const [plate, setPlate] = useState("");
  const [makeModel, setMakeModel] = useState("");
  const [capacity, setCapacity] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setPlate(""); setMakeModel(""); setCapacity(""); }
  }, [open]);

  async function submit() {
    if (!plate.trim()) return;
    setSaving(true);
    try {
      await createVehicle({
        tenantId,
        plateNumber: plate.trim(),
        makeModel: makeModel.trim() || undefined,
        capacity: capacity.trim() ? Number(capacity) : undefined,
      });
      onCreated();
      onClose();
    } catch (err) {
      toast("Could not add vehicle: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Fleet"
      title="Add a vehicle"
      blurb="The plate number is how drivers and parents will recognise it."
      actions={
        <Button variant="primary" onClick={() => void submit()} disabled={saving || !plate.trim()}>
          {saving ? "Adding…" : "Add vehicle"}
        </Button>
      }
    >
      <div className="grid gap-3.5">
        <TextField id="vehiclePlate" label="Plate number" placeholder="e.g. KDA 214B" value={plate} onChange={(e) => setPlate(e.target.value)} />
        <TextField id="vehicleMakeModel" label="Make and model" hint="Optional." placeholder="e.g. Toyota Hiace" value={makeModel} onChange={(e) => setMakeModel(e.target.value)} />
        <TextField id="vehicleCapacity" label="Capacity" hint="Optional." type="number" placeholder="e.g. 33" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </div>
    </Modal>
  );
}

function AddRouteModal({ open, onClose, tenantId, toast, onCreated }: {
  open: boolean; onClose: () => void; tenantId: string; toast: (m: string) => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setName(""); setDescription(""); }
  }, [open]);

  async function submit() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createRoute({ tenantId, name: name.trim(), description: description.trim() || undefined });
      onCreated();
      onClose();
    } catch (err) {
      toast("Could not add route: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow="Fleet"
      title="Add a route"
      blurb="Add stops once the route exists."
      actions={
        <Button variant="primary" onClick={() => void submit()} disabled={saving || !name.trim()}>
          {saving ? "Adding…" : "Add route"}
        </Button>
      }
    >
      <div className="grid gap-3.5">
        <TextField id="routeName" label="Route name" placeholder="e.g. Route B - Thika Road" value={name} onChange={(e) => setName(e.target.value)} />
        <TextArea id="routeDescription" label="Description" hint="Optional." value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </Modal>
  );
}
