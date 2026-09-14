import { PermissionsAndroid, Platform } from "react-native";
import BackgroundService from "react-native-background-actions";
import Geolocation from "react-native-geolocation-service";
import { PERMISSIONS, RESULTS, request } from "react-native-permissions";

/**
 * Free background GPS: a foreground service with a persistent notification,
 * not a paid plugin. Android requires that notification for background
 * location access anyway — it is not a workaround, it is the honest way to
 * ask a driver's phone to keep reporting position with the screen locked.
 */

const PING_MIN_INTERVAL_MS = 10_000;

export interface LocationTick {
  lat: number;
  lng: number;
  speedKmh?: number;
  heading?: number;
}

export interface PermissionResult {
  ok: boolean;
  message?: string;
}

/** Foreground location must be granted before background can even be asked for. */
export async function ensureLocationPermissions(): Promise<PermissionResult> {
  const fine = await request(PERMISSIONS.ANDROID.ACCESS_FINE_LOCATION);
  if (fine !== RESULTS.GRANTED) {
    return { ok: false, message: "Location permission was denied. Allow location access to track this trip." };
  }

  const background = await request(PERMISSIONS.ANDROID.ACCESS_BACKGROUND_LOCATION);
  if (background !== RESULTS.GRANTED) {
    return {
      ok: false,
      message: "Set location access to \"Allow all the time\" in phone Settings so tracking keeps working with the screen locked.",
    };
  }

  // Not in react-native-permissions' Android map, and not yet in this RN
  // version's PermissionsAndroid.PERMISSIONS typings — the raw string is the
  // same constant either way.
  if (Platform.OS === "android" && Platform.Version >= 33) {
    const notif = await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS");
    if (notif !== PermissionsAndroid.RESULTS.GRANTED) {
      return { ok: false, message: "Notification permission is needed to show the tracking indicator while a trip is active." };
    }
  }

  return { ok: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPositionOnce(): Promise<LocationTick | null> {
  return new Promise((resolve) => {
    Geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, speed, heading } = position.coords;
        resolve({
          lat: latitude,
          lng: longitude,
          speedKmh: speed != null ? speed * 3.6 : undefined,
          heading: heading ?? undefined,
        });
      },
      // A missed fix just means we try again next tick — not worth surfacing per-tick.
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
    );
  });
}

interface TaskParams {
  onTick: (tick: LocationTick) => void;
  delay: number;
}

const task = async (params?: TaskParams) => {
  const onTick = params?.onTick;
  const delay = params?.delay ?? PING_MIN_INTERVAL_MS;
  while (BackgroundService.isRunning()) {
    const tick = await getPositionOnce();
    if (tick && onTick) onTick(tick);
    await sleep(delay);
  }
};

/** Starts the foreground service. Call only after ensureLocationPermissions() succeeds. */
export async function startLocationTracking(onTick: (tick: LocationTick) => void): Promise<void> {
  await BackgroundService.start(task, {
    taskName: "FigbloomDriverTrip",
    taskTitle: "Trip in progress",
    taskDesc: "Figbloom is sharing this bus's location while the trip is active.",
    taskIcon: { name: "ic_launcher", type: "mipmap" },
    color: "#17402A",
    parameters: { onTick, delay: PING_MIN_INTERVAL_MS } satisfies TaskParams,
  });
}

export async function stopLocationTracking(): Promise<void> {
  if (BackgroundService.isRunning()) await BackgroundService.stop();
}
