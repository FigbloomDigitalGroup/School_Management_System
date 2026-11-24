import { Navigate, Route, Routes } from "react-router-dom";
import { useQueueSync } from "../lib/queue";
import { DriverProfile } from "../screens/driver/Profile";
import { DriverTrip } from "../screens/driver/Trip";
import type { SchoolSession } from "./ApiOverview";

/** The driver's pages on the new API, by their address under /s/<slug>/. */
export const API_DRIVER_PAGES = ["driver", "driver/profile"] as const;

/**
 * What a driver sees on the new API (FIG-1890 onwards): the trip screen and the profile, full width with the green header and no
 * console shell, as on the Supabase build (App.tsx). The trip screen holds a position or a child's mark on the phone while there is
 * no signal and sends it later (the offline queue, api/queueApi.ts), so this keeps the queue tied to the signed-in driver and drained.
 *
 * What a driver may do on the API is the `driver` role's one permission, `resource.transport.drive`: their own assignment, starting
 * and ending their own trip, their position and the marks of the children on it. They cannot read the fleet, so the screen follows
 * the phone's own position rather than the bus on the live feed (fleetCapabilities().driverLiveFeed).
 */
export function ApiDriverConsole({ session }: { session: SchoolSession }) {
  useQueueSync(session.profile.id);
  return (
    <Routes>
      <Route path="driver" element={<DriverTrip />} />
      <Route path="driver/profile" element={<DriverProfile />} />
      <Route path="*" element={<Navigate to={`/s/${session.tenant.slug}/driver`} replace />} />
    </Routes>
  );
}
