import { KES } from "@figbloom/shared";
import { Badge, Cell, Mono, RecordsPage, type RecordsSpec } from "./RecordsPage";
import { Button } from "../../components/ui/Button";
import { useToast } from "../../components/ui/Toast";

/**
 * The seven cross-tenant console pages. Each is data plus copy — the layout
 * comes from RecordsPage, so they stay consistent as more are added.
 */

const t = (s: string, sub?: string) => <Cell sub={sub}>{s}</Cell>;
const m = (s: string) => <Mono>{s}</Mono>;

export function Health() {
  const spec: RecordsSpec = {
    eyebrow: "Platform · last 24 hours",
    title: "System health",
    blurb: "Everything that has to be up for a teacher to take attendance at 08:00. Schools sit on unreliable links, so degraded is normal and worth watching before it becomes down.",
    stats: [
      { label: "Uptime 30d", value: "99.97%", sub: "SLA is 99.9%" },
      { label: "API p95", value: "212 ms", sub: "Nairobi edge" },
      { label: "Queue depth", value: "1,204", sub: "attendance sync jobs", alarming: true },
      { label: "Open incidents", value: "2", sub: "1 degraded, 1 investigating", alarming: true },
    ],
    actions: [
      { label: "Status page", onClick: () => {} },
      { label: "Declare incident", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "region", header: "Region", width: "1.4fr" },
      { key: "schools", header: "Schools", align: "right" },
      { key: "p95", header: "p95", align: "right" },
      { key: "err", header: "Error rate", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
    ],
    chips: [{ label: "All" }, { label: "Degraded", match: ["degraded"] }],
    rows: [
      ["Nairobi metro", "94", "188 ms", "0.02%", "Healthy"],
      ["Central", "51", "204 ms", "0.03%", "Healthy"],
      ["Rift Valley", "48", "412 ms", "0.31%", "Degraded"],
      ["Nyanza", "27", "236 ms", "0.04%", "Healthy"],
      ["Western", "18", "298 ms", "0.09%", "Healthy"],
      ["Coast", "10", "521 ms", "0.44%", "Degraded"],
    ].map((r) => ({
      id: r[0]!,
      tags: [r[4] === "Degraded" ? "degraded" : "healthy"],
      cells: [
        t(r[0]!), m(r[1]!), m(r[2]!),
        <span className="font-mono text-[12.5px]" style={{ color: r[4] === "Degraded" ? "#B8460A" : undefined }}>{r[3]}</span>,
        <Badge tone={r[4] === "Degraded" ? "warn" : "ok"}>{r[4]}</Badge>,
      ],
    })),
    extra: <ServiceCards />,
  };
  return <RecordsPage spec={spec} />;
}

function ServiceCards() {
  const services = [
    { name: "API", value: "212 ms", note: "p95 latency", ok: true },
    { name: "Attendance sync", value: "backed up", note: "queue draining", ok: false },
    { name: "M-Pesa callbacks", value: "99.4%", note: "success rate", ok: true },
    { name: "SMS gateway", value: "97.1%", note: "delivery rate", ok: true },
    { name: "Report card render", value: "1.8 s", note: "median job", ok: true },
    { name: "File storage", value: "68%", note: "of provisioned", ok: true },
  ];
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
      {services.map((s) => (
        <div key={s.name} className="min-w-0 rounded-lg border border-line px-4 py-3.5">
          <div className="mb-2 flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.ok ? "#2E7D4F" : "#F26A1B" }} />
            <span className="truncate text-[13px] font-semibold">{s.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[11.5px] text-ink-faint">{s.note}</span>
            <span className="font-mono text-[11.5px]" style={{ color: s.ok ? "#2E7D4F" : "#B8460A" }}>{s.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Usage() {
  const spec: RecordsSpec = {
    eyebrow: "Platform · current term",
    title: "Usage & capacity",
    blurb: "Seats in use against what each school licensed. Well over is an upsell conversation; well under is a churn signal.",
    stats: [
      { label: "Licensed seats", value: "238,900", sub: "across 231 active schools" },
      { label: "Seats in use", value: "186,402", sub: "78% utilisation" },
      { label: "Over licence", value: "7", sub: "schools exceeding their plan", alarming: true },
      { label: "Storage", value: "4.2 TB", sub: "68% of provisioned" },
    ],
    actions: [{ label: "Export CSV", onClick: () => {} }],
    columns: [
      { key: "school", header: "School", width: "1.6fr" },
      { key: "lic", header: "Licensed", align: "right" },
      { key: "use", header: "In use", align: "right" },
      { key: "util", header: "Utilisation", align: "right" },
      { key: "signal", header: "Signal", width: "0.9fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Over licence", match: ["over", "never"] },
      { label: "Under 50%", match: ["under", "never"] },
    ],
    minWidth: "780px",
    rows: [
      ["Mang'u High School", "mangu", "1,900", "1,988", "105%", "Over licence", "over"],
      ["Alliance High School", "alliance", "2,000", "1,842", "92%", "Healthy", "ok"],
      ["Kenya High School", "kenya-high", "1,700", "1,516", "89%", "Healthy", "ok"],
      ["Lenana School", "lenana", "1,500", "1,320", "88%", "Healthy", "ok"],
      ["Moi Girls Eldoret", "moi-girls-eldoret", "1,300", "1,204", "93%", "Healthy", "ok"],
      ["Kisumu Boys High", "kisumu-boys", "1,100", "412", "37%", "Under 50%", "under"],
      ["Nakuru Girls High", "nakuru-girls", "1,200", "372", "31%", "Under 50%", "under"],
      ["Bungoma Secondary", "bungoma-sec", "900", "0", "0%", "Never used", "never"],
    ].map((r) => ({
      id: r[1]!,
      tags: [r[6]!],
      cells: [
        t(r[0]!, "/s/" + r[1]), m(r[2]!), m(r[3]!),
        <span className="font-mono text-[12.5px] font-medium" style={{ color: r[6] === "ok" ? undefined : "#B8460A" }}>{r[4]}</span>,
        <Badge tone={r[6] === "ok" ? "ok" : r[6] === "under" ? "muted" : "warn"}>{r[5]}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}

export function Incidents() {
  const spec: RecordsSpec = {
    eyebrow: "Support · open and recent",
    title: "Incidents",
    blurb: "Severity is judged by what the school could not do, not by which service broke.",
    stats: [
      { label: "Open", value: "2", sub: "both under investigation", alarming: true },
      { label: "Mean time to fix", value: "42 min", sub: "last 90 days" },
      { label: "Schools affected", value: "58", sub: "in the open incidents" },
      { label: "Sev-1 this term", value: "1", sub: "resolved 14 Aug" },
    ],
    actions: [
      { label: "Postmortems", onClick: () => {} },
      { label: "Declare incident", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "sev", header: "Sev", width: "0.6fr" },
      { key: "what", header: "Incident", width: "2fr" },
      { key: "aff", header: "Affected", align: "right" },
      { key: "when", header: "Opened", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Open", match: ["Investigating", "Fix in review"] },
      { label: "Resolved", match: ["Resolved"] },
    ],
    minWidth: "840px",
    rows: [
      ["SEV-2", "Attendance sync backlog on the Rift Valley edge", "Teachers see yesterday's roster until the queue drains", "48 schools", "Today 06:40", "Investigating"],
      ["SEV-3", "Report card PDFs render without the school crest", "Only schools that uploaded an SVG logo", "10 schools", "Yesterday 15:12", "Fix in review"],
      ["SEV-1", "M-Pesa callbacks dropped for 22 minutes", "Parent payments succeeded but showed as unpaid", "231 schools", "14 Aug 11:03", "Resolved"],
      ["SEV-3", "SMS invites delayed up to 40 minutes", "Gateway throttled during exam registration", "63 schools", "09 Aug 08:20", "Resolved"],
      ["SEV-2", "Grade entry timed out on large classes", "Classes over 60 learners could not submit", "17 schools", "02 Aug 13:47", "Resolved"],
    ].map((r, i) => ({
      id: "inc" + i,
      tags: [r[5]!],
      cells: [
        <Badge tone={r[0] === "SEV-1" ? "warn" : r[0] === "SEV-2" ? "warn" : "muted"}>{r[0]}</Badge>,
        t(r[1]!, r[2]!), m(r[3]!),
        <span className="font-mono text-[12.5px] text-ink-muted">{r[4]}</span>,
        <Badge tone={r[5] === "Resolved" ? "ok" : r[5] === "Fix in review" ? "info" : "warn"}>{r[5]}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}

export function Subscriptions() {
  const spec: RecordsSpec = {
    eyebrow: "Commercial · term 3, 2026",
    title: "Subscriptions",
    blurb: "Kenyan schools budget by term, so renewals cluster at the start of each one. Anything not renewed by week two rarely renews at all.",
    stats: [
      { label: "MRR", value: KES(412_000_00), sub: "+3.1% vs August" },
      { label: "Renewing this term", value: "84", sub: "62 confirmed" },
      { label: "In trial", value: "12", sub: "3 ending within 10 days" },
      { label: "At risk", value: "5", sub: "low adoption or unpaid", alarming: true },
    ],
    actions: [
      { label: "Plan settings", onClick: () => {} },
      { label: "Onboard a school", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "school", header: "School", width: "1.6fr" },
      { key: "plan", header: "Plan", width: "1.1fr" },
      { key: "amt", header: "Per term", align: "right" },
      { key: "renews", header: "Renews", align: "right", width: "1.1fr" },
      { key: "status", header: "Status", width: "0.9fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Trial", match: ["Trial"] },
      { label: "At risk", match: ["At risk"] },
    ],
    minWidth: "800px",
    rows: [
      ["Alliance High School", "Institution", KES(214_000_00), "01 Jan 2027", "Confirmed"],
      ["Mang'u High School", "Institution", KES(202_000_00), "01 Jan 2027", "Confirmed"],
      ["Kenya High School", "Institution", KES(186_000_00), "01 Jan 2027", "Confirmed"],
      ["Lenana School", "Institution", KES(168_000_00), "01 Jan 2027", "Confirmed"],
      ["Moi Girls Eldoret", "Standard", KES(96_400_00), "01 Jan 2027", "At risk"],
      ["Kisumu Boys High", "Standard", KES(182_000_00), "01 Jan 2027", "At risk"],
      ["Nakuru Girls High", "Standard", "—", "Trial ends 10 Sep", "Trial"],
      ["Kabarak High School", "Standard", "—", "Trial ends 30 Sep", "Trial"],
    ].map((r) => ({
      id: r[0]!,
      tags: [r[4]!],
      cells: [
        t(r[0]!), <span className="text-[13px]">{r[1]}</span>, m(r[2]!),
        <span className="font-mono text-[12.5px] text-ink-muted">{r[3]}</span>,
        <Badge tone={r[4] === "Confirmed" ? "ok" : r[4] === "Trial" ? "muted" : "warn"}>{r[4]}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}

export function Invoices() {
  const toast = useToast();
  const spec: RecordsSpec = {
    eyebrow: "Commercial · outstanding first",
    title: "Invoices",
    blurb: "Bursars pay from an account that is often only funded once fees come in, so late is common and suspension is a last resort. Reminders go to the bursar and the principal together.",
    stats: [
      { label: "Outstanding", value: KES(612_400_00), sub: "across 7 invoices", alarming: true },
      { label: "Overdue 30d+", value: "2", sub: "suspension scheduled", alarming: true },
      { label: "Collected this term", value: KES(11_800_000_00), sub: "94% of billed" },
      { label: "Avg days to pay", value: "18", sub: "net 14 terms" },
    ],
    actions: [
      { label: "Export for accounts", onClick: () => {} },
      { label: "Chase all overdue", primary: true, onClick: () => {} },
    ],
    columns: [
      { key: "inv", header: "Invoice", width: "1.1fr" },
      { key: "school", header: "School", width: "1.5fr" },
      { key: "amt", header: "Amount", align: "right" },
      { key: "due", header: "Due", align: "right" },
      { key: "status", header: "Status", width: "0.9fr" },
      { key: "act", header: "", align: "right" },
    ],
    chips: [
      { label: "All" },
      { label: "Overdue", match: ["overdue"] },
      { label: "Paid", match: ["paid"] },
    ],
    minWidth: "880px",
    rows: [
      ["INV-2026-0812", "Kisumu Boys High", KES(182_000_00), "01 Aug 2026", "Overdue 31d", "overdue"],
      ["INV-2026-0831", "Moi Girls Eldoret", KES(96_400_00), "18 Aug 2026", "Overdue 14d", "overdue"],
      ["INV-2026-0844", "St. Mary's Yala", KES(118_000_00), "05 Sep 2026", "Due soon", "due"],
      ["INV-2026-0790", "Alliance High School", KES(214_000_00), "01 Aug 2026", "Paid", "paid"],
      ["INV-2026-0791", "Mang'u High School", KES(202_000_00), "01 Aug 2026", "Paid", "paid"],
      ["INV-2026-0792", "Kenya High School", KES(186_000_00), "01 Aug 2026", "Paid", "paid"],
    ].map((r) => ({
      id: r[0]!,
      tags: [r[5]!],
      cells: [
        m(r[0]!), t(r[1]!), m(r[2]!),
        <span className="font-mono text-[12.5px] text-ink-muted">{r[3]}</span>,
        <Badge tone={r[5] === "paid" ? "ok" : r[5] === "due" ? "muted" : "warn"}>{r[4]}</Badge>,
        r[5] === "paid" ? null : (
          <Button onClick={() => toast(`Reminder sent to the bursar and principal at ${r[1]}`)}>Send reminder</Button>
        ),
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}

export function Impersonation() {
  const spec: RecordsSpec = {
    eyebrow: "Support · immutable record",
    title: "Impersonation log",
    blurb: "Every session where Figbloom staff acted inside a school. Schools can read their own entries — that is what makes impersonation acceptable to a principal at all.",
    stats: [
      { label: "Sessions this month", value: "34", sub: "by 6 staff members" },
      { label: "Median length", value: "9 min", sub: "30 min hard cap" },
      { label: "Write actions", value: "11", sub: "all reason-tagged" },
      { label: "Schools notified", value: "34", sub: "100% of sessions" },
    ],
    actions: [{ label: "Export for audit", onClick: () => {} }],
    columns: [
      { key: "staff", header: "Staff", width: "1fr" },
      { key: "school", header: "School", width: "1.4fr" },
      { key: "reason", header: "Reason", width: "1.6fr" },
      { key: "len", header: "Length", align: "right", width: "0.8fr" },
      { key: "scope", header: "Scope", width: "0.9fr" },
    ],
    chips: [{ label: "All" }, { label: "Write actions", match: ["Write"] }],
    minWidth: "880px",
    rows: [
      ["Joyce Kimani", "Today 07:42", "Alliance High School", "Grade export returning an empty PDF", "8 min", "Read only"],
      ["David Otieno", "Today 06:15", "Bungoma Secondary", "Finish a stalled student import", "26 min", "Write"],
      ["Joyce Kimani", "Yesterday 16:30", "St. Mary's Yala", "Bursar cannot see the Term 3 invoice", "5 min", "Read only"],
      ["Amina Yusuf", "Yesterday 11:05", "Nakuru Girls High", "Walk the principal through term setup", "31 min", "Write"],
      ["David Otieno", "30 Aug 09:20", "Kisumu Boys High", "Confirm an M-Pesa reconciliation", "12 min", "Read only"],
    ].map((r, i) => ({
      id: "imp" + i,
      tags: [r[5]!],
      cells: [
        t(r[0]!, r[1]!), <span className="text-[13px]">{r[2]}</span>,
        <span className="text-[13px] text-ink-muted">{r[3]}</span>, m(r[4]!),
        <Badge tone={r[5] === "Write" ? "warn" : "muted"}>{r[5]}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}

export function Audit() {
  const spec: RecordsSpec = {
    eyebrow: "Platform · all tenants",
    title: "Audit trail",
    blurb: "Every change that alters money, marks or access. Retained for seven years and exportable per school on request.",
    stats: [
      { label: "Events today", value: "18,402", sub: "across 231 schools" },
      { label: "Privileged changes", value: "22", sub: "role or permission edits" },
      { label: "Failed logins", value: "146", sub: "0.8% of attempts" },
      { label: "Retention", value: "7 yrs", sub: "immutable, append only" },
    ],
    actions: [
      { label: "Filter by school", onClick: () => {} },
      { label: "Export range", onClick: () => {} },
    ],
    columns: [
      { key: "when", header: "Time", width: "1.1fr" },
      { key: "actor", header: "Actor", width: "1.3fr" },
      { key: "event", header: "Event", width: "2fr" },
      { key: "cat", header: "Category", width: "1fr" },
    ],
    chips: [
      { label: "All" },
      { label: "Privileged", match: ["Access", "Academic"] },
      { label: "Financial", match: ["Financial"] },
    ],
    minWidth: "880px",
    rows: [
      ["Today 08:14", "system", "Tenant /s/kabarak provisioned", "Provisioning"],
      ["Today 08:14", "Joyce Kimani", "Admin invite sent to principal@kabarak.sc.ke", "Access"],
      ["Today 07:51", "P. Mwangi · Alliance", "Grading scale changed from 12-point to 8-point", "Academic"],
      ["Today 07:20", "A. Wanjiru · Kenya High", "Term 3 fee structure published to 1,516 parents", "Financial"],
      ["Yesterday 17:02", "system", "Kisumu Boys High suspension scheduled for 06 Sep", "Financial"],
      ["Yesterday 16:44", "D. Otieno · Figbloom", "Impersonation session ended, 2 records written", "Access"],
      ["Yesterday 14:10", "S. Achieng · Lenana", "42 teacher accounts created by CSV import", "Access"],
      ["Yesterday 09:35", "M. Kariuki · Mang'u", "Form 4 exam results locked and published", "Academic"],
    ].map((r, i) => ({
      id: "aud" + i,
      tags: [r[3]!],
      cells: [
        <span className="font-mono text-[12.5px] text-ink-muted">{r[0]}</span>,
        t(r[1]!), <span className="text-[13px]">{r[2]}</span>,
        <Badge tone={r[3] === "Financial" ? "warn" : "info"}>{r[3]}</Badge>,
      ],
    })),
  };
  return <RecordsPage spec={spec} />;
}
