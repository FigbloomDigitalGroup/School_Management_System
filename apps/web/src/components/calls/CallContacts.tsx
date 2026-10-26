import { useMemo, useState } from "react";
import { fetchMyContacts, roleLabel, type Contact, type Tenant } from "@figbloom/shared";
import { Avatar } from "../Avatar";
import { Skeleton } from "../ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";
import { CallButton } from "./CallButton";

function describe(c: Contact, tenant: Tenant): string {
  if (c.staff_title) return c.staff_title;
  if (c.role === "school_admin") return "Principal / office";
  if (c.role === "teacher") return roleLabel(tenant, "teacher");
  if (c.role === "parent") return roleLabel(tenant, "parent");
  if (c.role === "student") return roleLabel(tenant, "student");
  if (c.role === "driver") return "Driver";
  return "";
}

/**
 * Everyone the signed-in person may call, from my_contacts(): for a parent,
 * their children, their children's teachers and the office; for staff,
 * colleagues and the parents of learners they teach. A search box once the
 * list is long enough to need one.
 */
export function CallContacts({ title, blurb, roles }: { title: string; blurb?: string; roles?: string[] }) {
  const { tenant } = useTenantSession();
  const { data, loading, error } = useAsync(() => fetchMyContacts(), []);
  const [q, setQ] = useState("");

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((c) => !roles || roles.includes(c.role))
      .filter((c) => !needle || c.full_name.toLowerCase().includes(needle));
  }, [data, q, roles]);
  const total = (data ?? []).filter((c) => !roles || roles.includes(c.role)).length;

  return (
    <section className="mt-5 overflow-hidden rounded-lg border border-line bg-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-body font-semibold">{title}</h2>
          {blurb && <p className="mt-0.5 text-[12.5px] text-ink-muted">{blurb}</p>}
        </div>
        {total > 8 && (
          <input
            value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" aria-label="Search contacts"
            className="w-[200px] max-w-full rounded-md border border-line px-2.5 py-1.5 text-[12.5px]"
          />
        )}
      </header>
      {error ? (
        <p className="px-4 py-3 text-[12.5px] text-warn-ink">Could not load contacts: {error.message}</p>
      ) : loading ? (
        <div className="grid gap-2 p-4"><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
      ) : people.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12.5px] text-ink-faint">{q ? "Nobody by that name." : "Nobody to call yet."}</div>
      ) : (
        <ul className="max-h-[360px] overflow-auto">
          {people.map((c) => (
            <li key={c.id} className="flex items-center gap-3 border-b border-line-soft px-4 py-2.5 last:border-0">
              <Avatar id={c.id} name={c.full_name} url={c.avatar_url} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{c.full_name}</div>
                <div className="truncate text-[12px] text-ink-faint">{describe(c, tenant)}</div>
              </div>
              <CallButton profileId={c.id} name={c.full_name} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
