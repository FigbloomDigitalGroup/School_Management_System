import { SESSION_LABEL, type AttendanceSession } from "@figbloom/shared";

/** Morning / Afternoon switch for a register. The caller only renders it while the school takes an afternoon register. */
export function SessionSwitch({ value, options, onChange }: {
  value: AttendanceSession;
  options: readonly AttendanceSession[];
  onChange: (s: AttendanceSession) => void;
}) {
  return (
    <div role="group" aria-label="Register" className="inline-flex overflow-hidden rounded-md border border-[#D3DAD5] bg-white">
      {options.map((s) => {
        const on = s === value;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(s)}
            className={`px-3 py-1.5 text-[13px] font-semibold ${on ? "bg-accent-deep text-white" : "text-ink-muted"}`}
          >
            {SESSION_LABEL[s]}
          </button>
        );
      })}
    </div>
  );
}
