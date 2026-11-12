/**
 * How a person likes the bus map drawn: the plain road map or satellite photos (with the road names on), and
 * Google's live traffic over either. The web map and the phone's map offer the same two choices and each
 * remembers them on the device, as this object in JSON.
 */
export interface MapLook { base: "map" | "satellite"; traffic: boolean }

export const DEFAULT_MAP_LOOK: MapLook = { base: "map", traffic: false };

/** What was saved last time, or the plain map when nothing was saved or what is there cannot be read. */
export function parseMapLook(raw: string | null | undefined): MapLook {
  if (raw) {
    try {
      const saved = JSON.parse(raw) as { base?: unknown; traffic?: unknown } | null;
      if (saved && (saved.base === "map" || saved.base === "satellite")) return { base: saved.base, traffic: !!saved.traffic };
    } catch {
      // not JSON: as good as nothing saved
    }
  }
  return { ...DEFAULT_MAP_LOOK };
}
