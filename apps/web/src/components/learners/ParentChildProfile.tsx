import { useEffect, useState } from "react";
import { setLearnerHome, supabase, type LatLngPoint } from "@figbloom/shared";
import { Button } from "../ui/Button";
import type { ToastFn } from "../ui/Toast";
import { BioDataEditor } from "./BioData";
import { HealthEditor } from "./Health";
import { HomePinPicker } from "./HomePinPicker";

/**
 * A parent's own view of their child's record: bio data (identity changes
 * go to the office to approve), health details (which the school's teachers
 * see as an allergy chip on the register) and where they live, which the
 * school uses to plan bus stops. Which class, bus and stop the child has
 * stays with the school office.
 */
export function ParentChildProfile({ tenantId, childId, childFirst, toast }: {
  tenantId: string; childId: string; childFirst: string; toast: ToastFn;
}) {
  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-line bg-white">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">{childFirst}'s details, health and home</h2>
        <p className="mt-0.5 text-[12px] text-ink-muted">Keep these up to date so the school has the right records, knows what to do in an emergency and where to stop the bus.</p>
      </header>
      <div className="px-4 pt-4">
        <BioDataEditor key={`bio-${childId}`} studentId={childId} toast={toast} mode="parent" title="Details" />
        <HealthEditor key={childId} tenantId={tenantId} studentId={childId} toast={toast} title="Health" />
        <HomeEditor key={`home-${childId}`} childId={childId} toast={toast} />
      </div>
    </section>
  );
}

function HomeEditor({ childId, toast }: { childId: string; toast: ToastFn }) {
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [pin, setPin] = useState<LatLngPoint | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void supabase().from("students").select("home_address, home_landmark, home_lat, home_lng").eq("id", childId)
      .maybeSingle<{ home_address: string | null; home_landmark: string | null; home_lat: number | null; home_lng: number | null }>()
      .then(({ data }) => {
        if (!alive) return;
        setAddress(data?.home_address ?? "");
        setLandmark(data?.home_landmark ?? "");
        setPin(data?.home_lat != null && data.home_lng != null ? { lat: data.home_lat, lng: data.home_lng } : null);
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [childId]);

  async function save() {
    setSaving(true);
    try {
      await setLearnerHome(childId, { lat: pin?.lat ?? null, lng: pin?.lng ?? null, landmark: landmark.trim() || null, address: address.trim() });
      toast("Home saved. The school office will use it for the bus.");
    } catch (err) {
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(false);
    }
  }

  const field = "w-full rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-[13px] outline-none";
  return (
    <div className="pb-4">
      <h3 className="mb-2 text-[13px] font-semibold">Home</h3>
      {!loaded ? (
        <p className="text-small text-ink-faint">Loading…</p>
      ) : (
        <div className="grid gap-2.5">
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold">Address</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} className={field} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-semibold">Landmark</span>
              <input value={landmark} onChange={(e) => setLandmark(e.target.value)} maxLength={200} placeholder="e.g. Opposite Naivas" className={field} />
            </label>
          </div>
          <HomePinPicker pin={pin} onPin={setPin} address={[address, landmark].filter(Boolean).join(", ")} />
          <div><Button variant="primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save home"}</Button></div>
        </div>
      )}
    </div>
  );
}
