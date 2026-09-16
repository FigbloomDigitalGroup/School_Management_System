import { formatMoney, supabase } from "@figbloom/shared";
import type { ClassGroup, FeeInvoice, Term } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { StatRow } from "../../components/ui/StatCard";
import { Skeleton } from "../../components/ui/Skeleton";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";

interface DashboardData {
  term: Term | null;
  classes: Pick<ClassGroup, "id" | "name">[];
  studentsByClass: Map<string, number>;
  activeStudents: number;
  staffCount: number;
  invoices: Pick<FeeInvoice, "total_cents" | "paid_cents">[];
  attendanceDate: string | null;
  presentByClass: Map<string, number>;
  submittedClasses: Set<string>;
}

async function fetchDashboard(): Promise<DashboardData> {
  const sb = supabase();

  const { data: term } = await sb.from("terms").select("*").eq("is_current", true).maybeSingle<Term>();
  const termId = term?.id ?? null;

  const [{ data: classRows }, { data: studentRows }, { data: staffRows }, invoicesRes] = await Promise.all([
    sb.from("classes").select("id,name").order("name").returns<Pick<ClassGroup, "id" | "name">[]>(),
    sb.from("students").select("id,class_id").eq("active", true).returns<{ id: string; class_id: string }[]>(),
    sb.from("profiles").select("id").in("role", ["school_admin", "teacher"]).returns<{ id: string }[]>(),
    termId
      ? sb.from("fee_invoices").select("total_cents,paid_cents").eq("term_id", termId).returns<Pick<FeeInvoice, "total_cents" | "paid_cents">[]>()
      : Promise.resolve({ data: [] as Pick<FeeInvoice, "total_cents" | "paid_cents">[] }),
  ]);

  const studentsByClass = new Map<string, number>();
  for (const s of studentRows ?? []) studentsByClass.set(s.class_id, (studentsByClass.get(s.class_id) ?? 0) + 1);

  let attendanceDate: string | null = null;
  const presentByClass = new Map<string, number>();
  const submittedClasses = new Set<string>();

  if (termId) {
    const { data: latest } = await sb
      .from("attendance").select("taken_on").eq("term_id", termId)
      .order("taken_on", { ascending: false }).limit(1)
      .returns<{ taken_on: string }[]>();
    attendanceDate = latest?.[0]?.taken_on ?? null;

    if (attendanceDate) {
      const { data: rows } = await sb
        .from("attendance").select("class_id,mark")
        .eq("term_id", termId).eq("taken_on", attendanceDate)
        .returns<{ class_id: string; mark: string }[]>();
      for (const r of rows ?? []) {
        submittedClasses.add(r.class_id);
        if (r.mark === "present") presentByClass.set(r.class_id, (presentByClass.get(r.class_id) ?? 0) + 1);
      }
    }
  }

  return {
    term: term ?? null,
    classes: classRows ?? [],
    studentsByClass,
    activeStudents: studentRows?.length ?? 0,
    staffCount: staffRows?.length ?? 0,
    invoices: invoicesRes.data ?? [],
    attendanceDate,
    presentByClass,
    submittedClasses,
  };
}

/**
 * A principal opens this at 07:30. It answers three questions in order:
 * is the school running today, is anything on fire, and what needs a signature.
 */
export function AdminDashboard() {
  const { profile, tenant } = useTenantSession();
  const toast = useToast();
  const { data, loading, error } = useAsync(() => fetchDashboard(), []);

  const firstName = profile.full_name.split(" ")[0];

  const totalBilled = data ? data.invoices.reduce((a, i) => a + i.total_cents, 0) : 0;
  const totalPaid = data ? data.invoices.reduce((a, i) => a + i.paid_cents, 0) : 0;
  const feePct = totalBilled > 0 ? Math.round((totalPaid / totalBilled) * 100) : 0;

  const nothingPaid = data ? data.invoices.filter((i) => i.paid_cents === 0).length : 0;
  const partPaid = data ? data.invoices.filter((i) => i.paid_cents > 0 && i.paid_cents < i.total_cents).length : 0;
  const fullPaid = data ? data.invoices.filter((i) => i.paid_cents >= i.total_cents && i.total_cents > 0).length : 0;
  const bucketTotal = Math.max(data?.invoices.length ?? 0, 1);

  const missingClasses = data ? data.classes.filter((c) => !data.submittedClasses.has(c.id)) : [];
  const owingCount = data ? data.invoices.filter((i) => i.paid_cents < i.total_cents).length : 0;

  const needs: { title: string; body: string }[] = data
    ? [
        ...(missingClasses.length > 0
          ? [{
              title: `${missingClasses.length} class${missingClasses.length === 1 ? "" : "es"} ${missingClasses.length === 1 ? "has" : "have"} not taken attendance`,
              body: `${missingClasses.map((c) => c.name).join(", ") || "No classes"}${data.attendanceDate ? ` for ${data.attendanceDate}` : ""}.`,
            }]
          : []),
        ...(owingCount > 0
          ? [{
              title: `${data.term ? data.term.name + " fee" : "Fee"} balances are outstanding`,
              body: `${owingCount} learner${owingCount === 1 ? "" : "s"} still owe a balance this term.`,
            }]
          : []),
      ]
    : [];

  return (
    <>
      <PageHead
        eyebrow={data?.term ? data.term.name : "Loading term…"}
        title={`Good morning, ${firstName}`}
        blurb={
          data
            ? `${data.submittedClasses.size} of ${data.classes.length} classes have submitted attendance and fee collection stands at ${feePct}%. ${needs.length} thing${needs.length === 1 ? "" : "s"} need${needs.length === 1 ? "s" : ""} you.`
            : "Loading the morning picture…"
        }
        actions={<Button variant="accent" onClick={() => toast("Announcement composer")}>New announcement</Button>}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the dashboard: {error.message}
          </p>
        ) : loading || !data ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-line bg-white px-4 py-3.5">
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className="mt-2 h-6 w-16" />
                <Skeleton className="mt-1.5 h-2.5 w-24" />
              </div>
            ))}
          </div>
        ) : (
          <StatRow
            stats={[
              {
                label: "Attendance today",
                value: data.submittedClasses.size > 0
                  ? `${Math.round(([...data.presentByClass.values()].reduce((a, b) => a + b, 0) / Math.max([...data.submittedClasses].reduce((a, id) => a + (data.studentsByClass.get(id) ?? 0), 0), 1)) * 100)}%`
                  : "—",
                sub: `${data.submittedClasses.size} of ${data.classes.length} classes submitted`,
              },
              { label: "Fees collected", value: `${feePct}%`, sub: `${formatMoney(totalPaid, tenant.country)} of ${formatMoney(totalBilled, tenant.country)}` },
              { label: "Learners", value: data.activeStudents.toLocaleString(), sub: `across ${data.classes.length} classes` },
              { label: "Teaching & admin staff", value: String(data.staffCount), sub: "school admins and teachers" },
            ]}
          />
        )}

        <div className="mt-5 grid gap-4" style={{ gridTemplateColumns: "minmax(0,1.3fr) minmax(0,1fr)" }}>
          <section className="overflow-hidden rounded-lg border border-line">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-body font-semibold">Attendance by class · {data?.attendanceDate ?? "today"}</h2>
            </header>
            <div>
              {error ? (
                <p className="px-4 py-3.5 text-[12.5px] text-warn-ink">Could not load attendance.</p>
              ) : loading || !data ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                    <Skeleton className="h-3 flex-1" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                ))
              ) : (
                data.classes.map((c) => {
                  const total = data.studentsByClass.get(c.id) ?? 0;
                  const present = data.presentByClass.get(c.id) ?? 0;
                  const submitted = data.submittedClasses.has(c.id);
                  return (
                    <div key={c.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
                      <span className="min-w-0 flex-1 truncate text-[13px]">{c.name}</span>
                      {!submitted ? (
                        <>
                          <Badge tone="warn">Not taken</Badge>
                          <Button onClick={() => toast(`Reminded the class teacher for ${c.name}`)}>Remind teacher</Button>
                        </>
                      ) : (
                        <>
                          <span className="font-mono text-[12.5px] text-ink-muted">{present} / {total}</span>
                          <div className="h-1.5 w-20 overflow-hidden rounded bg-sunken">
                            <div className="h-1.5 rounded bg-ok-dot" style={{ width: `${total > 0 ? (present / total) * 100 : 0}%` }} />
                          </div>
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <div className="grid content-start gap-4">
            <section className="rounded-lg border border-orange-line bg-orange-soft p-4">
              <h2 className="text-body font-semibold text-orange-ink">Needs you</h2>
              <ul className="mt-2.5 grid gap-2.5">
                {loading || !data ? (
                  Array.from({ length: 2 }).map((_, i) => (
                    <li key={i} className="rounded-lg bg-white/70 px-3 py-2.5">
                      <Skeleton className="h-3 w-2/3" />
                      <Skeleton className="mt-1.5 h-3 w-full" />
                    </li>
                  ))
                ) : needs.length === 0 ? (
                  <li className="rounded-lg bg-white/70 px-3 py-2.5 text-small text-orange-ink">Nothing needs you right now.</li>
                ) : (
                  needs.map((n) => (
                    <li key={n.title} className="rounded-lg bg-white/70 px-3 py-2.5">
                      <div className="text-small font-semibold text-orange-ink">{n.title}</div>
                      <p className="mt-1 text-[12px] leading-relaxed text-orange-ink">{n.body}</p>
                    </li>
                  ))
                )}
              </ul>
            </section>

            <section className="overflow-hidden rounded-lg border border-line">
              <header className="border-b border-line px-4 py-3"><h2 className="text-body font-semibold">Fee collection · this term</h2></header>
              <div className="px-4 pb-3.5 pt-1.5">
                {loading || !data ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="border-b border-line-soft py-2.5 last:border-0">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="mt-2 h-1.5 w-full" />
                    </div>
                  ))
                ) : (
                  [
                    ["Paid in full", fullPaid, "#2E7D4F"],
                    ["Part paid", partPaid, "#F9A05C"],
                    ["Nothing paid", nothingPaid, "#F26A1B"],
                  ].map(([label, n, colour]) => (
                    <div key={label as string} className="border-b border-line-soft py-2.5 last:border-0">
                      <div className="mb-1.5 flex justify-between text-[13px]">
                        <span>{label}</span><span className="font-mono text-[12px] text-ink-muted">{n}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded bg-sunken">
                        <div className="h-1.5 rounded" style={{ width: `${((n as number) / bucketTotal) * 100}%`, background: colour as string }} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
