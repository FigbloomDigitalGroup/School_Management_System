import { useState } from "react";
import {
  ADMIN_AREAS, ADMIN_AREA_INFO, ADMIN_PRESETS, DIRECTOR_NOTE, describeAreas, effectiveAreas, presetsWithin, setStaffAreas,
  setStaffRoles, sortAreas, togglePreset, type AdminArea, type SchoolRole,
} from "@figbloom/shared";
import { Button } from "./ui/Button";
import type { ToastFn } from "./ui/Toast";

/**
 * Admin areas (20261031000000), as the office sees them: a tick per area with
 * what it allows in plain words. Areas that come from a role the person holds
 * show as ticked and locked, with the role named, so it's clear why.
 */
export function AreaCheckboxes({ value, onChange, fromRoles = new Map(), idPrefix }: {
  value: readonly AdminArea[];
  onChange: (areas: AdminArea[]) => void;
  /** area -> the names of the held roles that give it */
  fromRoles?: Map<AdminArea, string[]>;
  idPrefix: string;
}) {
  return (
    <ul className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
      {ADMIN_AREAS.map((area) => {
        const via = fromRoles.get(area);
        const checked = value.includes(area) || !!via;
        return (
          <li key={area}>
            <label htmlFor={`${idPrefix}-${area}`} className={`flex items-start gap-2 rounded-md border px-2.5 py-2 ${checked ? "border-forest/40 bg-forest/5" : "border-line"}`}>
              <input
                id={`${idPrefix}-${area}`}
                type="checkbox"
                className="mt-0.5"
                style={{ accentColor: "#17402A" }}
                checked={checked}
                disabled={!!via}
                onChange={(e) => onChange(sortAreas(e.target.checked ? [...value, area] : value.filter((a) => a !== area)))}
              />
              <span className="text-[13px] leading-snug">
                <span className="font-semibold">{ADMIN_AREA_INFO[area].label}</span>
                {via && <span className="ml-1 text-[11px] text-ink-faint">from {via.join(", ")}</span>}
                <span className="block text-[11.5px] text-ink-muted">{ADMIN_AREA_INFO[area].allows}</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** The built-in presets as quick picks: on adds their areas, off takes away what no other held preset needs. */
export function PresetChips({ value, onChange }: { value: readonly AdminArea[]; onChange: (areas: AdminArea[]) => void }) {
  const on = presetsWithin(value);
  return (
    <div className="flex flex-wrap gap-1.5">
      {ADMIN_PRESETS.map((p) => {
        const active = on.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            aria-pressed={active}
            title={describeAreas(p.areas)}
            onClick={() => onChange(togglePreset(value, p.id))}
            className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold ${active ? "border-forest bg-forest text-white" : "border-line text-ink hover:bg-sunken"}`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Admin access" on a teacher's or other staff member's card: the school's
 * own roles, the presets as quick picks, and a tick per area. Only full
 * admins see this (and the database lets only them save it).
 */
export function AdminAccessEditor({ profileId, name, roles, direct, heldRoleIds, onSaved, toast }: {
  profileId: string;
  name: string;
  roles: readonly SchoolRole[];
  direct: readonly AdminArea[];
  heldRoleIds: readonly string[];
  onSaved: () => void;
  toast: ToastFn;
}) {
  const [areas, setAreas] = useState<AdminArea[]>(sortAreas(direct));
  const [roleIds, setRoleIds] = useState<string[]>([...heldRoleIds]);
  const [saving, setSaving] = useState(false);
  const first = name.split(" ")[0];

  const fromRoles = new Map<AdminArea, string[]>();
  for (const r of roles.filter((x) => roleIds.includes(x.id))) {
    for (const a of r.areas) fromRoles.set(a, [...(fromRoles.get(a) ?? []), r.name]);
  }
  const total = effectiveAreas(areas, roles, roleIds);
  const changed = sortAreas(direct).join() !== areas.join() || [...heldRoleIds].sort().join() !== [...roleIds].sort().join();

  async function save() {
    setSaving(true);
    try {
      await setStaffRoles(profileId, roleIds);
      // an area a role already gives isn't kept twice
      await setStaffAreas(profileId, areas.filter((a) => !fromRoles.has(a)));
      toast(total.length ? `${first} now has: ${describeAreas(total)}.` : `${first} no longer has admin access.`);
      onSaved();
    } catch (err) {
      toast(err instanceof Error ? `Could not save admin access: ${err.message}` : "Could not save admin access.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mb-5 border-b border-line-soft pb-5">
      <h3 className="text-[13px] font-semibold">Admin access</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
        Give {first} the parts of the admin console their job needs. They keep their own login and console, and switch to Admin
        for these. School settings, the overview and this access stay with full admins.
      </p>

      {roles.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11.5px] font-semibold">Your school's roles</div>
          <div className="flex flex-wrap gap-1.5">
            {roles.map((r) => {
              const held = roleIds.includes(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={held}
                  title={describeAreas(r.areas)}
                  onClick={() => setRoleIds(held ? roleIds.filter((id) => id !== r.id) : [...roleIds, r.id])}
                  className={`rounded-full border px-2.5 py-1 text-[12px] font-semibold ${held ? "border-forest bg-forest text-white" : "border-line text-ink hover:bg-sunken"}`}
                >
                  {r.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-3">
        <div className="mb-1.5 text-[11.5px] font-semibold">Quick picks</div>
        <PresetChips value={areas} onChange={setAreas} />
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-faint">{DIRECTOR_NOTE}</p>
      </div>

      <div className="mt-3">
        <div className="mb-1.5 text-[11.5px] font-semibold">Areas</div>
        <AreaCheckboxes idPrefix={`access-${profileId}`} value={areas} onChange={setAreas} fromRoles={fromRoles} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={() => void save()} disabled={saving || !changed}>
          {saving ? "Saving…" : "Save admin access"}
        </Button>
        <span className="text-[12px] text-ink-muted">{describeAreas(total)}</span>
      </div>
    </section>
  );
}
