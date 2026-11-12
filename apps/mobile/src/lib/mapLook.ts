import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_MAP_LOOK, parseMapLook, type MapLook } from "@figbloom/shared";

/**
 * Where the phone keeps the map's look. It is a choice about this phone, like light or dark, not anyone's
 * data, so it is not one of the keys signing out deletes (lib/cacheKeys.ts).
 */
export const MAP_LOOK_KEY = "figbloom.mapLook.v1";

interface LookStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * The map's look (road map or satellite, traffic on or off), held once for every map on the phone: a parent
 * with two children has two maps on one screen, and a map opened full screen is a second one over the first,
 * so a choice made on any of them has to reach them all at once. What was chosen last time is read the first
 * time a map asks, and a choice made before that answer arrives is not overwritten by it.
 */
export function createMapLookStore(storage: LookStorage) {
  let look: MapLook = DEFAULT_MAP_LOOK;
  let asked = false;
  let chosen = false;
  const listeners = new Set<() => void>();
  const tell = () => { listeners.forEach((listener) => listener()); };

  function readSaved() {
    if (asked) return;
    asked = true;
    storage.getItem(MAP_LOOK_KEY)
      .then((raw) => {
        if (chosen) return;
        const saved = parseMapLook(raw);
        if (saved.base === look.base && saved.traffic === look.traffic) return;
        look = saved;
        tell();
      })
      .catch(() => {}); // unreadable storage: the plain map stands
  }

  return {
    get: (): MapLook => look,
    set(next: MapLook): void {
      chosen = true;
      look = next;
      tell();
      storage.setItem(MAP_LOOK_KEY, JSON.stringify(next)).catch(() => {}); // not remembered, still applied
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      readSaved();
      return () => { listeners.delete(listener); };
    },
  };
}

/** This phone's one store. */
export const mapLook = createMapLookStore(AsyncStorage);

/** The map's look and the way to change it, for a component: it re-renders when any map changes the look. */
export function useMapLook(): [MapLook, (next: MapLook) => void] {
  return [useSyncExternalStore(mapLook.subscribe, mapLook.get), mapLook.set];
}
