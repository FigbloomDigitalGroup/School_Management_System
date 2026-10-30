import { useEffect, useMemo, useRef, useState } from "react";
import {
  arrangeRiders, breakdownAffected, listTripRiders, markRider, pushRiderUpdates, reportBreakdown, riderMarkRow,
  type ArrangedRider, type RiderStatus, type Trip, type TripRider,
} from "@figbloom/shared";
import { queue } from "../../lib/queue";

type Section = "waiting" | "on_bus" | "done";
import type { LatLng } from "./LiveRouteMap";

const PLACE_NOTE: Record<ArrangedRider["place"], string | null> = {
  on_bus: "On the bus",
  waiting: null,
  dropped: "Dropped off",
  not_here: "Not here",
  absent_from_class: "Absent from class today",
};

/** The one or two things a driver can do with a child, by where they are. "Undo" fixes a mis-tap. */
function actionsFor(r: ArrangedRider): { label: string; status: RiderStatus; primary?: boolean }[] {
  if (r.status === "boarded") return [{ label: "Got off", status: "alighted", primary: true }];
  if (r.status === "alighted") return [{ label: "Undo", status: "boarded" }];
  if (r.status === "absent") return [{ label: "Undo", status: "expected" }];
  // absent from class: no "not here" to tap, but they can still be marked on if they turn up
  if (r.absent_from_class) return [{ label: "On bus", status: "boarded" }];
  return [{ label: "On bus", status: "boarded", primary: true }, { label: "Not here", status: "absent" }];
}

/**
 * The driver's list of every child on, or assigned to, the bus, marked on and
 * off as the trip goes. Each mark tells the family (a trigger writes the
 * update, rider-update pushes it); marks made with no signal wait in the
 * offline queue like location pings. Below the list, "Report a breakdown"
 * tells the office and the families of the children it affects.
 */
export function TripRiders({ trip, tenantId, stops, online, pos }: {
  trip: Trip;
  tenantId: string;
  /** The route's stops in the order this trip reaches them. */
  stops: { id: string; name: string }[];
  online: boolean;
  pos: LatLng | null;
}) {
  const [riders, setRiders] = useState<TripRider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRiders(null);
    listTripRiders(trip.id)
      .then((r) => { if (alive) setRiders(r); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? `Could not load the children: ${err.message}` : "Could not load the children."); });
    return () => { alive = false; };
  }, [trip.id]);

  // Marks held in a dead zone reach the database when the queue drains; push their updates once it has.
  const pendingRef = useRef(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      void queue.pendingFor("trip_riders").then((p) => {
        if (pendingRef.current > 0 && p.length === 0) pushRiderUpdates(trip.id);
        pendingRef.current = p.length;
      });
    }, 4_000);
    return () => window.clearInterval(id);
  }, [trip.id]);

  const stopName = useMemo(() => new Map(stops.map((s) => [s.id, s.name])), [stops]);
  const arranged = useMemo(() => (riders ? arrangeRiders(riders, stops.map((s) => s.id)) : []), [riders, stops]);

  async function mark(r: ArrangedRider, status: RiderStatus) {
    setError(null);
    setBusy(r.student_id);
    const input = { tenantId, tripId: trip.id, studentId: r.student_id, stopId: r.stop_id, status, markedAt: new Date().toISOString() };
    try {
      if (online) await markRider(input);
      else await queue.enqueue("trip_riders", [riderMarkRow(input)]);
      setRiders((prev) => prev?.map((p) => (p.student_id === r.student_id ? { ...p, status } : p)) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? `Could not mark ${r.full_name}: ${err.message}` : `Could not mark ${r.full_name}.`);
    } finally {
      setBusy(null);
    }
  }

  const onBoard = arranged.filter((r) => r.place === "on_bus").length;
  const waiting = arranged.filter((r) => r.place === "waiting").length;

  // A full bus is 30-odd rows: the driver needs the next stop's children, not
  // a scroll past everyone already aboard. Still-to-pick-up first, by stop;
  // on the bus folds away while anyone is waiting (open on the way home, when
  // it's the list being dropped off); the done ones stay folded.
  const [opened, setOpened] = useState<Partial<Record<Section, boolean>>>({});
  const sections: { key: Section; title: string; riders: ArrangedRider[]; open: boolean; byStop: boolean }[] = [
    { key: "waiting", title: "To pick up", riders: arranged.filter((r) => r.place === "waiting"), open: true, byStop: true },
    { key: "on_bus", title: "On the bus", riders: arranged.filter((r) => r.place === "on_bus"), open: waiting === 0, byStop: true },
    { key: "done", title: "Dropped off, not here or absent", riders: arranged.filter((r) => r.faded), open: false, byStop: false },
  ];
  const isOpen = (s: (typeof sections)[number]) => opened[s.key] ?? s.open;

  const row = (r: ArrangedRider, showStop: boolean) => {
    const note = PLACE_NOTE[r.place];
    const stop = r.stop_id ? stopName.get(r.stop_id) : null;
    // under a section heading, "On the bus" and the stop name would repeat it
    const sub = showStop ? [note, stop ?? "No stop set"].filter(Boolean).join(" · ") : "";
    return (
      <li key={r.student_id} className={`flex items-center gap-2 px-3 py-2 ${r.faded ? "bg-page" : ""}`}>
        <div className={`min-w-0 flex-1 ${r.faded ? "opacity-50" : ""}`}>
          <div className={`truncate text-body font-semibold text-ink ${r.struck ? "line-through" : ""}`}>{r.full_name}</div>
          {sub && <div className="truncate text-[11.5px] text-ink-muted">{sub}</div>}
        </div>
        {actionsFor(r).map((a) => (
          <button
            key={a.status}
            onClick={() => void mark(r, a.status)}
            disabled={busy === r.student_id}
            className={`hit shrink-0 rounded-lg px-3 py-2 text-small font-semibold disabled:opacity-60 ${
              a.primary ? "bg-forest text-white" : "border border-line text-ink-muted"
            }`}
          >
            {a.label}
          </button>
        ))}
      </li>
    );
  };

  /** Consecutive riders at the same stop (arrangeRiders already sorts by stop) under one heading. */
  const byStop = (list: ArrangedRider[]) => {
    const groups: { stopId: string | null; riders: ArrangedRider[] }[] = [];
    for (const r of list) {
      const last = groups[groups.length - 1];
      if (last && last.stopId === r.stop_id) last.riders.push(r);
      else groups.push({ stopId: r.stop_id, riders: [r] });
    }
    return groups;
  };

  return (
    <section className="mt-3" aria-label="Children on this bus">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Children</h2>
        {riders && <span className="text-[11.5px] text-ink-muted">{onBoard} on the bus · {waiting} to pick up</span>}
      </div>
      {error && <p className="mt-1 text-small leading-relaxed text-warn-ink">{error}</p>}
      {!riders ? (
        !error && <p className="mt-1 text-small text-ink-muted">Loading the list…</p>
      ) : !arranged.length ? (
        <p className="mt-1 text-small text-ink-muted">Nobody is assigned to this route yet.</p>
      ) : (
        <div className="mt-1.5 grid gap-2">
          {sections.filter((s) => s.riders.length).map((s) => (
            <div key={s.key} className="overflow-hidden rounded-xl border border-line">
              <button
                type="button"
                onClick={() => setOpened((o) => ({ ...o, [s.key]: !isOpen(s) }))}
                aria-expanded={isOpen(s)}
                className="hit flex w-full items-center justify-between gap-2 bg-page px-3 py-2 text-left"
              >
                <span className="text-small font-semibold text-ink">{s.title} · {s.riders.length}</span>
                <span className="text-[11.5px] font-semibold text-ink-muted">{isOpen(s) ? "Hide" : "Show"}</span>
              </button>
              {isOpen(s) && (s.byStop ? byStop(s.riders).map((g) => (
                <div key={g.stopId ?? "none"}>
                  <div className="border-t border-line px-3 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
                    {(g.stopId ? stopName.get(g.stopId) : null) ?? "No stop set"} · {g.riders.length}
                  </div>
                  <ul className="divide-y divide-line border-t border-line-soft">{g.riders.map((r) => row(r, false))}</ul>
                </div>
              )) : (
                <ul className="divide-y divide-line border-t border-line">{s.riders.map((r) => row(r, true))}</ul>
              ))}
            </div>
          ))}
        </div>
      )}

      <ReportBreakdown tripId={trip.id} affected={riders ? breakdownAffected(riders).length : null} online={online} pos={pos} />
    </section>
  );
}

/** "The bus has broken down": the office gets an alert, and the families of children on board or still waiting get told. */
function ReportBreakdown({ tripId, affected, online, pos }: { tripId: string; affected: number | null; online: boolean; pos: LatLng | null }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    setSending(true);
    setResult(null);
    try {
      const told = await reportBreakdown({ tripId, note, lat: pos?.lat ?? null, lng: pos?.lng ?? null });
      setResult({ ok: true, text: `The school has been told${told ? `, and the families of ${told === 1 ? "1 child" : `${told} children`}` : ""}.` });
      setOpen(false);
      setNote("");
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Could not report the breakdown." });
    } finally {
      setSending(false);
    }
  }

  if (!open) {
    return (
      <>
        {result && <p className={`mt-2 text-small leading-relaxed ${result.ok ? "text-ok-ink" : "text-warn-ink"}`}>{result.text}</p>}
        <button
          onClick={() => { setResult(null); setOpen(true); }}
          className="hit mt-3 w-full rounded-xl border-[1.5px] border-warn-ink py-3 text-body font-semibold text-warn-ink"
        >
          Report a breakdown
        </button>
      </>
    );
  }

  return (
    <div className="mt-3 rounded-xl border-[1.5px] border-warn-ink p-3">
      <div className="text-body font-semibold text-ink">The bus has broken down</div>
      <p className="mt-1 text-small leading-relaxed text-ink-muted">
        The office is alerted{affected ? `, and the families of the ${affected === 1 ? "1 child" : `${affected} children`} on the bus or still waiting are told` : ""}.
        Families of children already dropped off are not.
      </p>
      <label className="mt-2 block text-[11.5px] font-semibold text-ink-muted" htmlFor="breakdown-note">What happened (optional)</label>
      <textarea
        id="breakdown-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={300}
        rows={2}
        placeholder="Flat tyre near Imara Daima, waiting for help"
        className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-body"
      />
      {!online && <p className="mt-1 text-small leading-relaxed text-warn-ink">No signal. Call the school office instead; this can only be sent with signal.</p>}
      {result && !result.ok && <p className="mt-1 text-small leading-relaxed text-warn-ink">{result.text}</p>}
      <div className="mt-2 flex gap-2">
        <button onClick={() => setOpen(false)} className="hit flex-1 rounded-lg border border-line py-2.5 text-small font-semibold text-ink-muted">Cancel</button>
        <button
          onClick={() => void send()}
          disabled={sending || !online}
          className="hit flex-1 rounded-lg bg-warn-ink py-2.5 text-small font-semibold text-white disabled:opacity-60"
        >
          {sending ? "Sending…" : "Tell the school"}
        </button>
      </div>
    </div>
  );
}
