import { useEffect, useMemo, useState } from "react";
import {
  assignStudentToRoute, describeSuggestion, listRoutesWithStops, setLearnerHome, stopNameFor, suggestRouteForHome, supabase,
  type LatLngPoint, type PlanRoute, type RouteSuggestion,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import type { ToastFn } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { HomePinPicker } from "./HomePinPicker";

/**
 * Where a learner lives and which bus they take, for adding a learner and for
 * the Manage learner panel. The home pin is what plans routes: "Auto" joins
 * the nearest stop within a short walk, or adds a new stop to whichever route
 * it costs least to reach (packages/shared/src/routePlanning.ts). Boarders
 * don't get a bus choice.
 */

export type BusChoice =
  | { mode: "auto" }
  | { mode: "none" }
  /** a route chosen by hand; stopId "" = no stop yet, "suggested" = nearest / new stop from the pin */
  | { mode: "route"; routeId: string; stopId: string };

export interface HomeBusValue {
  address: string;
  landmark: string;
  pin: LatLngPoint | null;
  bus: BusChoice;
}

export const EMPTY_HOME_BUS: HomeBusValue = { address: "", landmark: "", pin: null, bus: { mode: "auto" } };

type Routes = (PlanRoute & { stops: { id: string; name: string; lat: number; lng: number; sequence: number }[] })[];

/** What a choice comes to, given the school's routes as they are. null: no bus. */
export function planBus(value: HomeBusValue, routes: Routes, childName: string):
  { routeId: string; stopId?: string | null; suggestion?: RouteSuggestion } | null {
  const stopName = stopNameFor(value.landmark, value.address, `${childName.split(" ")[0] || "New"}'s stop`);
  if (value.bus.mode === "none") return null;
  if (value.bus.mode === "auto") {
    if (!value.pin) return null;
    const s = suggestRouteForHome(value.pin, routes, { stopName });
    return s ? { routeId: s.routeId, suggestion: s } : null;
  }
  const { routeId, stopId } = value.bus;
  if (stopId === "suggested") {
    const route = routes.find((r) => r.id === routeId);
    const s = value.pin && route ? suggestRouteForHome(value.pin, [route], { stopName }) : null;
    return s ? { routeId, suggestion: s } : { routeId, stopId: null };
  }
  return { routeId, stopId: stopId || null };
}

/** Write the bus part of a choice for a learner who already exists. */
export async function saveBus(studentId: string, plan: ReturnType<typeof planBus>): Promise<void> {
  if (!plan) { await assignStudentToRoute({ studentId, routeId: null }); return; }
  const s = plan.suggestion;
  if (s?.kind === "join") await assignStudentToRoute({ studentId, routeId: s.routeId, stopId: s.stopId });
  else if (s?.kind === "new_stop") await assignStudentToRoute({ studentId, routeId: s.routeId, newStop: { name: s.stopName, lat: s.lat, lng: s.lng, position: s.position } });
  else await assignStudentToRoute({ studentId, routeId: plan.routeId, stopId: plan.stopId ?? null });
}

/** The school's routes and stops, for the fields below. */
export function useSchoolRoutes(tenantId: string, reloadKey = 0) {
  return useAsync(() => listRoutesWithStops(tenantId), [tenantId, reloadKey]);
}

export function HomeAndBusFields({ value, onChange, routes, boarding, childName, compact }: {
  value: HomeBusValue;
  onChange: (v: HomeBusValue) => void;
  routes: Routes;
  boarding: boolean;
  childName: string;
  compact?: boolean;
}) {
  const set = (patch: Partial<HomeBusValue>) => onChange({ ...value, ...patch });
  const nearby = useMemo(() => routes.flatMap((r) => r.stops.map((s) => ({ lat: s.lat, lng: s.lng, name: `${r.name}: ${s.name}` }))), [routes]);
  const plan = useMemo(() => planBus(value, routes, childName), [value, routes, childName]);
  const pickedRoute = value.bus.mode === "route" ? routes.find((r) => r.id === (value.bus as { routeId: string }).routeId) : undefined;
  const label = compact ? "mb-1 block text-[11.5px] font-semibold" : "mb-1.5 block text-[12.5px] font-semibold";
  const input = `w-full rounded-md border border-[#D3DAD5] bg-white ${compact ? "px-2.5 py-1.5" : "px-3 py-2"} text-[13px] outline-none`;

  return (
    <div className="grid gap-2.5">
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <label className="block">
          <span className={label}>Home address</span>
          <input value={value.address} onChange={(e) => set({ address: e.target.value })} maxLength={300}
            placeholder="e.g. Plot 12, Kahawa Sukari, off Thika Rd" className={input} />
        </label>
        <label className="block">
          <span className={label}>Landmark</span>
          <input value={value.landmark} onChange={(e) => set({ landmark: e.target.value })} maxLength={200}
            placeholder="e.g. Opposite Naivas" className={input} />
        </label>
      </div>
      <HomePinPicker pin={value.pin} onPin={(pin) => set({ pin })} address={value.address} landmark={value.landmark} nearby={nearby} />

      {boarding ? (
        <p className="text-[12px] text-ink-muted">Boarders don't ride the school bus day to day, so no route is set.</p>
      ) : (
        <div className="grid gap-1.5">
          <span className={label}>School bus</span>
          <div className="flex flex-wrap gap-2">
            <select
              aria-label="School bus"
              value={value.bus.mode === "route" ? value.bus.routeId : value.bus.mode}
              onChange={(e) => {
                const v = e.target.value;
                set({ bus: v === "auto" ? { mode: "auto" } : v === "none" ? { mode: "none" } : { mode: "route", routeId: v, stopId: value.pin ? "suggested" : "" } });
              }}
              className={`${input} max-w-[260px]`}
            >
              <option value="auto">Choose from the home pin</option>
              <option value="none">Doesn't take the bus</option>
              {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            {value.bus.mode === "route" && pickedRoute && (
              <select
                aria-label="Stop"
                value={value.bus.stopId}
                onChange={(e) => set({ bus: { mode: "route", routeId: pickedRoute.id, stopId: e.target.value } })}
                className={`${input} max-w-[260px]`}
              >
                {value.pin && <option value="suggested">Nearest stop, or a new one at home</option>}
                <option value="">No stop yet</option>
                {pickedRoute.stops.map((s) => <option key={s.id} value={s.id}>{s.sequence}. {s.name}</option>)}
              </select>
            )}
          </div>
          <BusPlanNote value={value} plan={plan} routes={routes} />
        </div>
      )}
    </div>
  );
}

function BusPlanNote({ value, plan, routes }: { value: HomeBusValue; plan: ReturnType<typeof planBus>; routes: Routes }) {
  let text: string;
  if (value.bus.mode === "none") text = "Not on a bus route.";
  else if (value.bus.mode === "auto" && !value.pin) text = "Place the home pin and a route and stop will be suggested.";
  else if (value.bus.mode === "auto" && !plan) text = routes.length ? "No route could be suggested." : "The school has no bus routes yet (add them under Fleet).";
  else if (plan?.suggestion) text = describeSuggestion(plan.suggestion);
  else if (plan) {
    const route = routes.find((r) => r.id === plan.routeId);
    const stop = route?.stops.find((s) => s.id === plan.stopId);
    text = stop ? `Rides ${route?.name} from ${stop.name}.` : `Rides ${route?.name ?? "this route"}; no stop picked yet.`;
  } else text = "Not on a bus route.";
  return <p className="text-[12px] text-ink-muted">{text}</p>;
}

// ---------------------------------------------------------------- Manage learner

interface StoredHome {
  home_address: string | null; home_landmark: string | null; home_lat: number | null; home_lng: number | null; boarding: boolean;
}

/** The Manage learner section: load what's saved, edit, save home and bus together. */
export function HomeAndBusEditor({ tenantId, studentId, childName, toast }: {
  tenantId: string; studentId: string; childName: string; toast: ToastFn;
}) {
  const [reload, setReload] = useState(0);
  const { data: routes, error: routesError } = useSchoolRoutes(tenantId, reload);
  const { data: stored, error } = useAsync(async () => {
    const [{ data: s, error: sErr }, { data: t, error: tErr }] = await Promise.all([
      supabase().from("students").select("home_address, home_landmark, home_lat, home_lng, boarding").eq("id", studentId).single<StoredHome>(),
      supabase().from("student_transport").select("route_id, stop_id").eq("student_id", studentId).maybeSingle<{ route_id: string; stop_id: string | null }>(),
    ]);
    if (sErr) throw sErr;
    if (tErr) throw tErr;
    return { home: s, transport: t };
  }, [studentId, reload]);
  const [value, setValue] = useState<HomeBusValue | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!stored) return;
    const h = stored.home;
    setValue({
      address: h.home_address ?? "", landmark: h.home_landmark ?? "",
      pin: h.home_lat != null && h.home_lng != null ? { lat: h.home_lat, lng: h.home_lng } : null,
      bus: stored.transport ? { mode: "route", routeId: stored.transport.route_id, stopId: stored.transport.stop_id ?? "" } : { mode: "none" },
    });
  }, [stored]);

  async function save() {
    if (!value || !routes || !stored) return;
    setSaving(true);
    try {
      await setLearnerHome(studentId, { lat: value.pin?.lat ?? null, lng: value.pin?.lng ?? null, landmark: value.landmark.trim() || null, address: value.address.trim() });
      if (!stored.home.boarding) await saveBus(studentId, planBus(value, routes, childName));
      toast("Home and bus saved.");
      setReload((k) => k + 1);
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-5 border-b border-line-soft pb-5">
      <h3 className="mb-2 text-[13px] font-semibold">Home and bus</h3>
      {error || routesError ? (
        <p className="text-[12.5px] text-warn-ink">Could not load: {(error ?? routesError)!.message}</p>
      ) : !value || !routes || !stored ? (
        <p className="text-small text-ink-faint">Loading…</p>
      ) : (
        <>
          <HomeAndBusFields value={value} onChange={setValue} routes={routes} boarding={stored.home.boarding} childName={childName} compact />
          <Button variant="primary" className="mt-3" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save home and bus"}
          </Button>
        </>
      )}
    </div>
  );
}
