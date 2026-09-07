import { useState } from "react";
import { timetable } from "../../lib/mock";
import { PageHead } from "../../components/ConsoleShell";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"] as const;
const NOW = 2;

export function TeacherTimetable() {
  const [day, setDay] = useState<string>("Tue");
  const rows = timetable[day] ?? [];

  return (
    <>
      <PageHead
        eyebrow="Timetable · term 3, 2026"
        title="Your week"
        blurb="Your teaching load, not the whole school's. Free periods are shown because knowing when you are free is half the reason to open this."
      />
      <div className="px-7 py-6">
        <div className="mb-4 flex gap-1.5">
          {DAYS.map((d) => (
            <button key={d} onClick={() => setDay(d)} className="rounded-full px-3.5 py-2 text-small"
              style={day === d ? { background: "var(--accent-deep)", color: "#fff", fontWeight: 600 } : { background: "#EEF1EE", color: "#5F6B62" }}>
              {d}
            </button>
          ))}
        </div>

        <div className="grid max-w-[720px] gap-2">
          {rows.map(([time, subject, room], i) => {
            const isNow = day === "Tue" && i === NOW;
            const free = subject === "Games" || subject === "Library";
            return (
              <div key={time} className="flex items-center gap-3.5 rounded-xl border px-4 py-3"
                style={{ borderColor: isNow ? "var(--accent)" : "#E2E6E2", background: isNow ? "#FFF8F6" : "#fff" }}>
                <span className="w-12 shrink-0 font-mono text-[11.5px] text-ink-muted">{time}</span>
                <span className="h-8 w-[3px] shrink-0 rounded" style={{ background: isNow ? "var(--accent)" : free ? "#E7EBE8" : "#2E7D4F" }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium">{subject}</span>
                  <span className="text-[12px] text-ink-faint">{room} · Form 2 West</span>
                </span>
                {isNow && <span className="rounded-full px-2 py-0.5 text-[10px] font-bold text-white" style={{ background: "var(--accent)" }}>NOW</span>}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
