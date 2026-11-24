import { isRetryableStatus, WriteError, type QueuedWrite } from "../queue";
import { apiClient } from "./client";
import { isApiError } from "./errors";

/**
 * Sends one write the offline queue held for the new API (the API side of queueSend.ts).
 *
 * Which writes may wait in the queue was decided from apps/api/src/modules/transport/operations.ts, not guessed. No transport
 * POST reads the `Idempotency-Key` header (finding 33), so the key is sent for the day the server does, and what makes a retry
 * safe today is the server's own checks:
 *  - `trip-event` (a child boarded, got off or not here): one such event per child per trip is kept by a unique index, and a
 *    second answers 200 `replayed`. Safe.
 *  - `driver-location`: a fix with the same time and place as the newest is a no-op (200 `replayed`), an older one is refused
 *    (409), and one older than 10 minutes is refused (400). Never doubled, but a backlog from a long dead zone is lost.
 *  - A breakdown (`incident`) and a delay are NOT deduplicated: a retry makes a second incident, so they are never queued.
 *  - Ending a trip is never queued: a second finish answers 409, and an ending the driver cannot see the answer of is not one to hold.
 */

export type QueuedApiOp = "trip-event" | "driver-location";

export const QUEUED_API_OPS: readonly QueuedApiOp[] = ["trip-event", "driver-location"];

export async function sendQueuedApiWrite(w: QueuedWrite): Promise<void> {
  const call = w.api;
  if (!call) {
    throw new WriteError("This was held by an older version of the app and cannot be sent to the new system.", false);
  }
  const { tenantId, tripId } = call.params;
  if (!tenantId || !tripId) throw new WriteError("This held write does not say which school and trip it was for.", false);
  try {
    if (call.op === "trip-event") {
      await apiClient().post("/v1/tenants/{tenantId}/trips/{tripId}/events", {
        path: { tenantId, tripId }, body: call.body as never, idempotencyKey: call.idempotencyKey, tenantId,
      });
    } else if (call.op === "driver-location") {
      await apiClient().post("/v1/tenants/{tenantId}/trips/{tripId}/driver-location", {
        path: { tenantId, tripId }, body: call.body as never, idempotencyKey: call.idempotencyKey, tenantId,
      });
    } else {
      throw new WriteError(`Unknown held write "${call.op}".`, false);
    }
  } catch (err) {
    if (err instanceof WriteError) throw err;
    if (isApiError(err)) throw new WriteError(err.message, isRetryableStatus(err.status), err.status);
    throw err;
  }
}
