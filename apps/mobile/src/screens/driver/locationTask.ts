import { PermissionsAndroid, Platform } from "react-native";
import BackgroundService from "react-native-background-actions";
import Geolocation from "react-native-geolocation-service";
import { PERMISSIONS, RESULTS, request } from "react-native-permissions";

/**
 * Free background GPS, no paid plugin. On Android, a foreground service with
 * a persistent notification — which Android requires for background location
 * access anyway, so it's the honest way to ask a driver's phone to keep
 * reporting position with the screen locked. On iOS, a background-mode
 * location watch (see startIosWatch below) — the two platforms need genuinely
 * different mechanisms, not just different permission prompts.
 */

const PING_MIN_INTERVAL_MS = 10_000;

export interface LocationTick {
  lat: number;
  lng: number;
  speedKmh?: number;
  heading?: number;
  /** When this fix was taken, captured here rather than when it's later sent or queued. */
  recordedAt: string;
}

export interface PermissionResult {
  ok: boolean;
  message?: string;
}

/** Foreground location must be granted before background can even be asked for. */
export async function ensureLocationPermissions(): Promise<PermissionResult> {
  if (Platform.OS === "ios") {
    const whenInUse = await request(PERMISSIONS.IOS.LOCATION_WHEN_IN_USE);
    if (whenInUse !== RESULTS.GRANTED) {
      return { ok: false, message: "Location permission was denied. Allow location access to track this trip." };
    }

    const always = await request(PERMISSIONS.IOS.LOCATION_ALWAYS);
    if (always !== RESULTS.GRANTED) {
      return {
        ok: false,
        message: "Set location access to \"Always\" in phone Settings so tracking keeps working with the screen locked.",
      };
    }

    return { ok: true };
  }

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
  // same constant either way. The OS check isn't redundant: it's what lets
  // TS narrow Platform.Version from string | number to number here.
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
          recordedAt: new Date().toISOString(),
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

// iOS has no foreground-service equivalent: react-native-background-actions'
// task loop is suspended once the app is actually backgrounded. Instead, iOS
// keeps delivering GPS fixes to a live watch while backgrounded, provided
// UIBackgroundModes has "location" and permission is "Always" — so iOS uses
// watchPosition instead of the Android polling loop above.
let iosWatchId: number | null = null;
let iosLastSentAt = 0;

function startIosWatch(onTick: (tick: LocationTick) => void): void {
  iosLastSentAt = 0;
  iosWatchId = Geolocation.watchPosition(
    (position) => {
      const now = Date.now();
      if (now - iosLastSentAt < PING_MIN_INTERVAL_MS) return;
      iosLastSentAt = now;
      const { latitude, longitude, speed, heading } = position.coords;
      onTick({ lat: latitude, lng: longitude, speedKmh: speed != null ? speed * 3.6 : undefined, heading: heading ?? undefined, recordedAt: new Date().toISOString() });
    },
    // A missed fix just means we wait for the next one — not worth surfacing per-tick.
    () => {},
    {
      enableHighAccuracy: true,
      distanceFilter: 0,
      showsBackgroundLocationIndicator: true,
    },
  );
}

/** Starts background tracking. Call only after ensureLocationPermissions() succeeds. */
export async function startLocationTracking(onTick: (tick: LocationTick) => void): Promise<void> {
  if (Platform.OS === "ios") {
    startIosWatch(onTick);
    return;
  }

  await BackgroundService.start(task, {
    taskName: "FigbloomDriverTrip",
    taskTitle: "Trip in progress",
    taskDesc: "Figbloom is sharing this bus's location while the trip is active.",
    taskIcon: { name: "ic_launcher", type: "mipmap" },
    color: "#17402A",
    // Required from Android 14 (API 34) on top of the manifest's own
    // foregroundServiceType="location": the system rejects startForeground()
    // with "type none" if the running call doesn't also declare one, no
    // matter what the manifest says.
    foregroundServiceType: ["location"],
    parameters: { onTick, delay: PING_MIN_INTERVAL_MS } satisfies TaskParams,
  });
}

export async function stopLocationTracking(): Promise<void> {
  if (Platform.OS === "ios") {
    if (iosWatchId != null) {
      Geolocation.clearWatch(iosWatchId);
      iosWatchId = null;
    }
    return;
  }

  if (BackgroundService.isRunning()) await BackgroundService.stop();
}
