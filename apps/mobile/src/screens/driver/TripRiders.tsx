import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  arrangeRiders, isRetryable, listTripRiders, markRider, pushRiderUpdates, riderMarkRow,
  type ArrangedRider, type QueuedWrite, type RiderStatus, type Trip, type TripRider,
} from "@figbloom/shared";
import { queue } from "../../storage";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

const PLACE_NOTE: Record<ArrangedRider["place"], string | null> = {
  on_bus: "On the bus",
  waiting: null,
  dropped: "Dropped off",
  not_here: "Not here",
  absent_from_class: "Absent from class today",
};

/** How often to look at marks held on the phone, to push the families' updates once they have gone out. */
const WATCH_MS = 4_000;

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
 * update, rider-update pushes it). A mark made with no signal waits on the
 * phone in the same queue as the location pings and goes out when there is
 * signal; one the server refuses (the child isn't on this route) is said
 * out loud instead of being held. Same screen as the web driver's list.
 */
export function TripRiders({ trip, tenantId, stops, tint }: {
  trip: Trip;
  tenantId: string;
  /** The route's stops in the order this trip reaches them. */
  stops: { id: string; name: string }[];
  tint: string;
}) {
  const { t, s, accentInk } = useTheme();
  const [riders, setRiders] = useState<TripRider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [held, setHeld] = useState(0);
  const [refused, setRefused] = useState<QueuedWrite[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    listTripRiders(trip.id)
      .then((r) => { if (alive) { setRiders(r); setError(null); } })
      .catch((err: unknown) => {
        if (alive) setError(`Could not load the children${err instanceof Error ? `: ${err.message}` : "."} Check your signal and try again.`);
      });
    return () => { alive = false; };
  }, [trip.id, reloadKey]);

  // Marks held on the phone go out with the next flush; once they all have, push the families' updates
  // and read the list again, so what the server decided (and refused) is what is on screen.
  const heldBefore = useRef(0);
  useEffect(() => {
    let alive = true;
    const look = async () => {
      const [waiting, rejected] = await Promise.all([queue.pendingFor("trip_riders"), queue.rejected()]);
      if (!alive) return;
      const mine = rejected.filter((w) => w.table === "trip_riders");
      setHeld(waiting.length);
      setRefused(mine);
      if (heldBefore.current > 0 && waiting.length === 0) {
        pushRiderUpdates(trip.id);
        setReloadKey((k) => k + 1);
      }
      heldBefore.current = waiting.length;
    };
    void look().catch(() => {});
    const timer = setInterval(() => { void look().catch(() => {}); }, WATCH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [trip.id]);

  const stopName = useMemo(() => new Map(stops.map((x) => [x.id, x.name])), [stops]);
  const arranged = useMemo(() => (riders ? arrangeRiders(riders, stops.map((x) => x.id)) : []), [riders, stops]);

  async function mark(r: ArrangedRider, status: RiderStatus) {
    setError(null);
    setBusy(r.student_id);
    const input = { tenantId, tripId: trip.id, studentId: r.student_id, stopId: r.stop_id, status, markedAt: new Date().toISOString() };
    try {
      try {
        await markRider(input);
      } catch (err) {
        // The server said no: holding it would never fix that. No answer at all: hold it and send it later.
        if (!isRetryable(err)) throw err;
        await queue.enqueue("trip_riders", [riderMarkRow(input)]);
        void queue.flush().catch(() => {});
        setHeld((n) => n + 1);
        heldBefore.current += 1;
      }
      setRiders((prev) => prev?.map((p) => (p.student_id === r.student_id ? { ...p, status } : p)) ?? prev);
    } catch (err) {
      setError(err instanceof Error ? `Could not mark ${r.full_name}: ${err.message}` : `Could not mark ${r.full_name}.`);
    } finally {
      setBusy(null);
    }
  }

  async function dismissRefused() {
    await Promise.all(refused.map((w) => queue.discard(w.id)));
    setRefused([]);
    setReloadKey((k) => k + 1);
  }

  const onBoard = arranged.filter((r) => r.place === "on_bus").length;
  const waiting = arranged.filter((r) => r.place === "waiting").length;

  return (
    <View style={{ marginTop: 20 }} accessibilityLabel="Children on this bus">
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <Text style={s.h2}>Children</Text>
        {!!riders && <Text style={s.small}>{onBoard} on the bus · {waiting} to pick up</Text>}
      </View>

      {!!error && (
        <View style={{ marginBottom: 8 }}>
          <Text style={{ fontSize: 12.5, lineHeight: 19, color: t.status.warnInk }}>{error}</Text>
          {!riders && (
            <Tap accessibilityRole="button" onPress={() => setReloadKey((k) => k + 1)} style={{ minHeight: 44, justifyContent: "center" }}>
              <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.brand.orange }}>Try again</Text>
            </Tap>
          )}
        </View>
      )}

      {held > 0 && (
        <Text style={[s.small, { marginBottom: 8, color: t.status.warnInk }]}>
          {held} mark{held === 1 ? "" : "s"} saved on this phone, sending when you have signal.
        </Text>
      )}

      {refused.length > 0 && (
        <View style={[s.card, { marginBottom: 8, gap: 6, borderColor: t.status.warnInk }]} accessibilityRole="alert">
          <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.status.warnInk }}>
            {refused.length === 1 ? "A mark saved on this phone" : `${refused.length} marks saved on this phone`} could not be sent
          </Text>
          <Text style={s.small}>{refused[0]?.rejected?.message}. The list below shows what the school has.</Text>
          <Tap accessibilityRole="button" onPress={() => void dismissRefused()} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.brand.orange }}>Dismiss</Text>
          </Tap>
        </View>
      )}

      {!riders ? (
        !error && <ActivityIndicator color={accentInk(tint)} style={{ marginVertical: 12 }} />
      ) : arranged.length === 0 ? (
        <Text style={s.small}>Nobody is assigned to this route yet.</Text>
      ) : (
        <View style={[s.card, { padding: 0 }]}>
          {arranged.map((r, i) => {
            const note = PLACE_NOTE[r.place];
            const stop = r.stop_id ? stopName.get(r.stop_id) : null;
            return (
              <View
                key={r.student_id}
                style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: t.appSurface.lineSoft, backgroundColor: r.faded ? t.appSurface.page : t.appSurface.card }}
              >
                <View style={{ flex: 1, opacity: r.faded ? 0.5 : 1 }}>
                  <Text numberOfLines={1} style={{ fontSize: 14.5, fontWeight: "600", color: t.appSurface.ink, textDecorationLine: r.struck ? "line-through" : "none" }}>{r.full_name}</Text>
                  <Text numberOfLines={1} style={s.faint}>{[note, stop ?? "No stop set"].filter(Boolean).join(" · ")}</Text>
                </View>
                {actionsFor(r).map((a) => (
                  <Tap
                    key={a.status}
                    accessibilityRole="button"
                    accessibilityLabel={`${a.label}: ${r.full_name}`}
                    disabled={busy === r.student_id}
                    onPress={() => void mark(r, a.status)}
                    style={{
                      minHeight: 44, minWidth: 64, paddingHorizontal: 12, borderRadius: 12, alignItems: "center", justifyContent: "center",
                      opacity: busy === r.student_id ? 0.6 : 1,
                      ...(a.primary ? { backgroundColor: tint } : { borderWidth: 1, borderColor: t.appSurface.line }),
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "600", color: a.primary ? "#fff" : t.appSurface.inkMuted }}>{a.label}</Text>
                  </Tap>
                ))}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
