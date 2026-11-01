import { useState } from "react";
import { Link } from "react-router-dom";
import { ADMIN_AREA_INFO, ADMIN_AREA_PAGES, supabase, type AdminArea, type ClassGroup } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Skeleton } from "../../components/ui/Skeleton";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { AttendanceDetail } from "./AttendanceDetail";
import { OverdueMedication } from "../../components/medical/common";

// Pages that only exist for one kind of school (ConsoleShell hides the same ones from the nav).
const K12_ONLY = new Set(["admin/classes", "admin/subjects", "admin/exams", "admin/papers", "admin/report-cards", "admin/performance", "admin/materials"]);

/**
 * The admin console's home for a teacher or other staff member holding some
 * admin areas (20261031000000). The full overview (fees collected, every
 * class's attendance, what needs the principal) is for full admins; this
 * lists what their areas let them do and takes them straight there. The
 * attendance area has no page of its own, so its work is here: every
 * class's latest register, each one open to correct.
 */
export function AreasHome() {
  const { profile, tenant, adminAreas } = useTenantSession();
  const higherEd = tenant.institution_type === "higher_ed";
  const online = tenant.delivery_mode === "online";
  const pagesFor = (area: AdminArea) => ADMIN_AREA_PAGES[area].filter((p) =>
    (higherEd ? !K12_ONLY.has(p.to) : p.to !== "admin/courses") && !(online && p.to === "admin/fleet"));

  return (
    <>
      <PageHead
        eyebrow="Admin"
        title={`Hello, ${profile.full_name.split(" ")[0]}`}
        blurb="These are the parts of the school's admin you look after. The school's full admins gave you them and can change them."
      />
      <div className="px-7 py-6">
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {adminAreas.map((area) => (
            <section key={area} className="rounded-lg border border-line bg-white p-4">
              <h2 className="text-body font-semibold">{ADMIN_AREA_INFO[area].label}</h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{ADMIN_AREA_INFO[area].allows}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {pagesFor(area).map((p) => (
                  <Link key={p.to} to={`/s/${tenant.slug}/${p.to}`} className="rounded-md border border-line px-2.5 py-1 text-[12.5px] font-semibold text-forest hover:bg-sunken">
                    {p.label}
                  </Link>
                ))}
                {area === "attendance" && <span className="text-[12px] text-ink-faint">Registers are below.</span>}
              </div>
            </section>
          ))}
        </div>
        {adminAreas.includes("medical") && <div className="mt-5"><OverdueMedication tenantId={tenant.id} slug={tenant.slug} compact /></div>}
        {adminAreas.includes("attendance") && <LatestRegisters tenantId={tenant.id} />}
      </div>
    </>
  );
}

interface Registers {
  date: string | null;
  classes: Pick<ClassGroup, "id" | "name">[];
  learners: Map<string, number>;
  present: Map<string, number>;
  taken: Set<string>;
}

async function fetchLatestRegisters(tenantId: string): Promise<Registers> {
  const sb = supabase();
  const [{ data: classes, error: e1 }, { data: students, error: e2 }, { data: latest, error: e3 }] = await Promise.all([
    sb.from("classes").select("id,name").eq("tenant_id", tenantId).order("name").returns<Pick<ClassGroup, "id" | "name">[]>(),
    sb.from("students").select("class_id").eq("tenant_id", tenantId).eq("active", true).returns<{ class_id: string }[]>(),
    sb.from("attendance").select("taken_on").eq("tenant_id", tenantId).order("taken_on", { ascending: false }).limit(1).returns<{ taken_on: string }[]>(),
  ]);
  for (const e of [e1, e2, e3]) if (e) throw new Error(e.message);

  const learners = new Map<string, number>();
  for (const s of students ?? []) learners.set(s.class_id, (learners.get(s.class_id) ?? 0) + 1);
  const date = latest?.[0]?.taken_on ?? null;
  const present = new Map<string, number>();
  const taken = new Set<string>();
  if (date) {
    const { data: rows, error } = await sb.from("attendance").select("class_id,mark").eq("tenant_id", tenantId).eq("taken_on", date)
      .returns<{ class_id: string; mark: string }[]>();
    if (error) throw new Error(error.message);
    for (const r of rows ?? []) {
      taken.add(r.class_id);
      // a late arrival still attended
      if (r.mark === "present" || r.mark === "late") present.set(r.class_id, (present.get(r.class_id) ?? 0) + 1);
    }
  }
  return { date, classes: classes ?? [], learners, present, taken };
}

/** Every class's most recent register, each one open to see who was missing and correct it. */
function LatestRegisters({ tenantId }: { tenantId: string }) {
  const { data, loading, error } = useAsync(() => fetchLatestRegisters(tenantId), [tenantId]);
  const [open, setOpen] = useState<{ id: string; name: string } | null>(null);

  return (
    <section className="mt-5 overflow-hidden rounded-lg border border-line">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">Attendance by class · {data?.date ?? "latest"}</h2>
      </header>
      {error ? (
        <p className="px-4 py-3.5 text-[12.5px] text-warn-ink">Could not load attendance: {error.message}</p>
      ) : loading || !data ? (
        Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="border-b border-line-soft px-4 py-2.5 last:border-0"><Skeleton className="h-3 w-full" /></div>
        ))
      ) : !data.date ? (
        <p className="px-4 py-3.5 text-[12.5px] text-ink-muted">No class has taken a register yet.</p>
      ) : (
        data.classes.map((c) => (
          <div key={c.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
            <span className="min-w-0 flex-1 truncate text-[13px]">{c.name}</span>
            {data.taken.has(c.id) ? (
              <button
                type="button"
                onClick={() => setOpen(c)}
                className="font-mono text-[12.5px] text-ink-muted underline decoration-dotted underline-offset-2"
                title="See who was late, absent or excused, and correct it"
              >
                {data.present.get(c.id) ?? 0} / {data.learners.get(c.id) ?? 0}
              </button>
            ) : (
              <Badge tone="warn">Not taken</Badge>
            )}
          </div>
        ))
      )}
      {open && data?.date && (
        <AttendanceDetail classId={open.id} className={open.name} date={data.date} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}
