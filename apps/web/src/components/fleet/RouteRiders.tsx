import { useMemo, useState } from "react";
import {
  fmtDistance, listRouteRiders, listRouteStops, pathLengthM, rebuildStopsFromHomes, saveRebuiltStops,
  type PlannedStop, type RouteRider, type RouteStop,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import type { ToastFn } from "../ui/Toast";
import { useAsync } from "../../lib/useAsync";

/**
 * Who rides a route, and "Rebuild stops from riders' homes": cluster the
 * riders' home pins into stops, order them from the school end, preview, then
 * save. Stop 1 (the school end) is kept as it is, and a new stop that lands on
 * an existing one keeps it, so its riders and its name carry over.
 */
export function RouteRiders({ routeId, toast, onSaved }: { routeId: string; toast: ToastFn; onSaved: () => void }) {
  const [reload, setReload] = useState(0);
  const { data, loading, error } = useAsync(
    () => Promise.all([listRouteRiders(routeId), listRouteStops(routeId)]).then(([riders, stops]) => ({ riders, stops })),
    [routeId, reload],
  );
  const [preview, setPreview] = useState<PlannedStop[] | null>(null);
  const [saving, setSaving] = useState(false);

  const stopName = useMemo(() => new Map((data?.stops ?? []).map((s) => [s.id, `${s.sequence}. ${s.name}`])), [data]);

  function rebuild(riders: RouteRider[], stops: RouteStop[]) {
    const homes = riders.filter((r) => r.home).map((r) => ({ studentId: r.studentId, ...r.home! }));
    if (!homes.length) { toast("None of this route's riders has a home pin yet. Pin their homes from People first.", "error"); return; }
    const anchor = stops[0] ? { id: stops[0].id, name: stops[0].name, lat: stops[0].lat, lng: stops[0].lng } : null;
    setPreview(rebuildStopsFromHomes(homes, { anchor, existing: stops }));
  }

  async function save() {
    if (!preview) return;
    setSaving(true);
    try {
      await saveRebuiltStops(routeId, preview);
      toast("Stops rebuilt from riders' homes.");
      setPreview(null);
      setReload((k) => k + 1);
      onSaved();
    } catch (err) {
      toast("Could not save the new stops: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      setSaving(false);
    }
  }

  if (error) return <p className="text-[12.5px] text-warn-ink">Could not load riders: {error.message}</p>;
  if (loading && !data) return <Skeleton className="h-16 w-full" />;
  if (!data) return null;
  const { riders, stops } = data;
  const nameOf = new Map(riders.map((r) => [r.studentId, r.fullName]));
  const unpinned = riders.filter((r) => !r.home);

  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-semibold">Riders ({riders.length})</h4>
        {riders.length > 0 && !preview && (
          <Button onClick={() => rebuild(riders, stops)}>Rebuild stops from riders' homes</Button>
        )}
      </div>

      {riders.length === 0 ? (
        <p className="text-[12.5px] text-ink-muted">No one rides this route yet. Put learners on it from People (Manage learner, Home and bus).</p>
      ) : (
        <ul className="grid gap-1 sm:grid-cols-2">
          {riders.map((r) => (
            <li key={r.studentId} className="flex items-center justify-between gap-2 rounded-md bg-white px-2.5 py-1.5 text-[12.5px]">
              <span className="min-w-0 truncate font-medium">{r.fullName}</span>
              <span className="shrink-0 text-[11.5px] text-ink-faint">
                {r.stopId ? stopName.get(r.stopId) ?? "Stop" : "No stop"}{r.home ? "" : " · no home pin"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {preview && (
        <div className="rounded-lg border border-[var(--accent)] bg-white p-3">
          <div className="text-[13px] font-semibold">New stops, not saved yet</div>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            {preview.length} stop{preview.length === 1 ? "" : "s"}, about {fmtDistance(pathLengthM(preview))} end to end
            {stops.length > 1 ? ` (now ${stops.length} stops, about ${fmtDistance(pathLengthM(stops))})` : ""}.
            {stops[0] ? ` Stop 1 stays ${stops[0].name}.` : " This route has no stops yet, so the order starts from one end; make the school stop 1 afterwards."}
            {unpinned.length > 0 ? ` ${unpinned.length} rider${unpinned.length === 1 ? " has" : "s have"} no home pin and keep${unpinned.length === 1 ? "s" : ""} their stop only if it's still on the list.` : ""}
          </p>
          <ol className="mt-2 grid gap-1">
            {preview.map((p, i) => (
              <li key={i} className="flex gap-2 text-[12.5px]">
                <span className="w-5 shrink-0 text-right font-mono text-ink-faint">{i + 1}.</span>
                <span className="min-w-0">
                  <span className="font-semibold">{p.name}</span>
                  {p.id && i > 0 && <span className="text-ink-faint"> (existing stop)</span>}
                  {p.studentIds.length > 0 && <span className="text-ink-muted"> · {p.studentIds.map((id) => nameOf.get(id) ?? "Learner").join(", ")}</span>}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save these stops"}</Button>
            <Button onClick={() => setPreview(null)} disabled={saving}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
