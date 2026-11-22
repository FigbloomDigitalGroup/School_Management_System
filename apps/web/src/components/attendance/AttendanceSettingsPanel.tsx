import { useEffect, useState } from "react";
import {
  DEFAULT_ATTENDANCE_SETTINGS, PERCENTAGE_MODE_LABEL, fetchAttendanceSettings, saveAttendanceSettings,
  type AttendanceSettings, type PercentageMode,
} from "@figbloom/shared";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";

/**
 * Attendance settings (FIG-1514): whether the school takes an afternoon register, and how percentages count.
 * Show it to people with the attendance area (and full admins); the database refuses anyone else and says so.
 * `onSaved` lets the screen around it reload what the settings change (the afternoon badges, the figures in the school's mode),
 * so the screen never shows the old setting next to the new one.
 */
export function AttendanceSettingsPanel({ tenantId, onSaved }: { tenantId: string; onSaved?: (settings: AttendanceSettings) => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState<AttendanceSettings | null>(null);
  const [draft, setDraft] = useState<AttendanceSettings>(DEFAULT_ATTENDANCE_SETTINGS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetchAttendanceSettings(tenantId).then((s) => { if (alive) { setSaved(s); setDraft(s); } });
    return () => { alive = false; };
  }, [tenantId]);

  const dirty = !!saved && (saved.afternoon_enabled !== draft.afternoon_enabled || saved.percentage_mode !== draft.percentage_mode);

  async function save() {
    setSaving(true);
    try {
      // What the database holds now (saveAttendanceSettings reads it back and throws unless it matches), not what was asked for.
      const stored = await saveAttendanceSettings(tenantId, draft);
      setSaved(stored);
      setDraft(stored);
      onSaved?.(stored);
      toast("Attendance settings saved.");
    } catch (err) {
      toast(`Could not save the settings: ${err instanceof Error ? err.message : "something went wrong"}`, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-5 overflow-hidden rounded-lg border border-line bg-white" aria-label="Attendance settings">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">Attendance settings</h2>
      </header>
      {!saved ? (
        <div className="px-4 py-3.5"><Skeleton className="h-3 w-2/3" /></div>
      ) : (
        <div className="grid gap-4 px-4 py-3.5">
          <div>
            <label className="flex items-center gap-2 text-[13px] font-medium">
              <input
                type="checkbox"
                checked={draft.afternoon_enabled}
                onChange={(e) => setDraft({ ...draft, afternoon_enabled: e.target.checked })}
              />
              Take an afternoon register
            </label>
            <p className="mt-1 text-[12px] text-ink-muted">
              Afternoon registers need the updated teacher app. A register from an older app always counts as the morning register.
            </p>
          </div>

          <fieldset>
            <legend className="text-[13px] font-medium">How percentages count</legend>
            <div className="mt-1.5 grid gap-1.5">
              {(["session", "day"] as PercentageMode[]).map((m) => (
                <label key={m} className="flex items-start gap-2 text-[12.5px]">
                  <input
                    type="radio"
                    name="attendance-percentage-mode"
                    className="mt-0.5"
                    checked={draft.percentage_mode === m}
                    onChange={() => setDraft({ ...draft, percentage_mode: m })}
                  />
                  <span>{PERCENTAGE_MODE_LABEL[m]}</span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[12px] text-ink-muted">Changing this recalculates past percentages.</p>
          </fieldset>

          <div>
            <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
