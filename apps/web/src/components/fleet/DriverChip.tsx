import { useState } from "react";
import type { BusOnRoute } from "@figbloom/shared";
import { Avatar } from "../Avatar";
import { Modal } from "../ui/Modal";

/**
 * Who's driving: photo (or initials), name and title, tappable for a small
 * profile so a parent can recognise the driver at the gate. Shows only what
 * driver_profiles() returns: never a phone number, email or login.
 */
export function DriverChip({ bus, size = 34 }: { bus: BusOnRoute; size?: number }) {
  const [open, setOpen] = useState(false);
  const d = bus.driver;
  if (!d) return <div className="text-[12px] text-ink-faint">Driver not assigned yet</div>;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="-mx-1.5 flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-page"
        title="See the driver's profile"
      >
        <Avatar id={d.id} name={d.name} url={d.avatarUrl} size={size} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-semibold">{d.name}</span>
          <span className="block truncate text-[11.5px] text-ink-muted">{d.title ?? "Driver"}</span>
        </span>
      </button>

      <Modal open={open} onClose={() => setOpen(false)} eyebrow="Driver" title={d.name} width={380}>
        <div className="flex flex-col items-center text-center">
          <Avatar id={d.id} name={d.name} url={d.avatarUrl} size={112} />
          <div className="mt-3 text-[16px] font-semibold">{d.name}</div>
          <div className="text-[12.5px] text-ink-muted">{d.title ?? "Driver"}</div>
          {!d.avatarUrl && (
            <p className="mt-2 text-[11.5px] text-ink-faint">No photo yet. The school can add one under Students &amp; staff.</p>
          )}
        </div>
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl bg-page px-4 py-3 text-[12.5px]">
          <dt className="text-ink-faint">Bus</dt>
          <dd className="font-mono font-semibold">{bus.vehicle.plate_number}</dd>
          {bus.vehicle.make_model && (
            <>
              <dt className="text-ink-faint">Vehicle</dt>
              <dd>{bus.vehicle.make_model}</dd>
            </>
          )}
          <dt className="text-ink-faint">Route</dt>
          <dd>{bus.route?.name ?? "No route assigned"}</dd>
        </dl>
      </Modal>
    </>
  );
}
