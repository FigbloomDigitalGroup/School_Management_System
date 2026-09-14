import { useMemo, useState } from "react";
import { needsAttention, supabase, type Tenant } from "@figbloom/shared";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { OnboardSchool } from "./OnboardSchool";
import { TenantDetail } from "./TenantDetail";
import { Icon } from "../../components/Icon";

async function loadTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase().from("tenants").select("*").order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Tenant[];
}

export const STATUS_TONE: Record<Tenant["status"], Tone> = {
  active: "ok", trial: "muted", onboarding: "info",
  overdue: "warn", suspended: "warn", setup_stalled: "warn",
};

export const STATUS_LABEL: Record<Tenant["status"], string> = {
  active: "Active", trial: "Trial", onboarding: "Onboarding",
  overdue: "Overdue", suspended: "Suspended", setup_stalled: "Setup stalled",
};

type Filter = "All" | "Attention" | "Trial";

/**
 * Master-detail: the list stays put while a school is inspected, so a support
 * agent working a queue of nine never loses their place.
 */
export function Tenants() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: tenants, loading } = useAsync(() => loadTenants(), [refreshKey]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("All");
  const [query, setQuery] = useState("");
  const [wizard, setWizard] = useState(false);

  const all = useMemo(() => tenants ?? [], [tenants]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((t) => filter === "All" || (filter === "Attention" ? needsAttention(t) : t.status === "trial"))
      .filter((t) => !q || t.name.toLowerCase().includes(q) || t.slug.includes(q) || t.county.toLowerCase().includes(q));
  }, [all, filter, query]);

  const counts = {
    All: all.length,
    Attention: all.filter(needsAttention).length,
    Trial: all.filter((t) => t.status === "trial").length,
  };

  const selected = all.find((t) => t.id === selectedId) ?? all[0] ?? null;

  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <div className="flex w-[320px] shrink-0 flex-col border-r border-line bg-[#FAFBFA]">
          <div className="border-b border-line px-4 py-4">
            <div className="mb-3 flex items-center justify-between">
              <h1 className="text-[16px] font-semibold">Tenants</h1>
              <Button variant="accent" onClick={() => setWizard(true)}>+ Onboard</Button>
            </div>
            <label className="flex items-center gap-2 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5">
              <Icon name="search" size={12} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${all.length} schools`}
                aria-label="Search schools"
                className="w-full bg-transparent text-small outline-none"
              />
            </label>
            <div className="mt-2.5 flex gap-1.5">
              {(["All", "Attention", "Trial"] as Filter[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className="rounded-full px-2.5 py-1 text-[11.5px]"
                  style={
                    filter === k
                      ? { background: "#17402A", color: "#fff" }
                      : k === "Attention"
                        ? { background: "#FDEBDF", color: "#B8460A" }
                        : { background: "#EEF1EE", color: "#5F6B62" }
                  }
                >
                  {k} {counts[k]}
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {loading ? (
              <TableSkeleton rows={8} />
            ) : (
              <>
                {list.map((t) => {
                  const active = t.id === selected?.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setSelectedId(t.id)}
                      className="flex w-full items-center gap-3 border-b border-line-soft px-4 py-3 text-left"
                      style={{
                        background: active ? "#F1F5F2" : "transparent",
                        borderLeft: `3px solid ${active ? "#F26A1B" : "transparent"}`,
                      }}
                    >
                      {t.logo_url ? (
                        <img src={t.logo_url} alt="" className="h-[30px] w-[30px] shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div
                          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg text-[11px] font-bold"
                          style={{ background: active ? t.accent : "#E3EFE7", color: active ? "#fff" : "#1B4D2E" }}
                        >
                          {t.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body font-medium">{t.name}</div>
                        <div className="truncate font-mono text-[10.5px] text-ink-faint">{t.county} · {t.licensed_seats} seats</div>
                      </div>
                      <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                    </button>
                  );
                })}

                {list.length === 0 && (
                  <EmptyState
                    title="No school matches that"
                    body="Try the school's short name or its address. A brand new school may still be in onboarding."
                  />
                )}
              </>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-auto">
          {selected ? (
            <TenantDetail tenant={selected} />
          ) : (
            !loading && (
              <EmptyState title="No school selected" body="Choose a school from the list on the left." />
            )
          )}
        </div>
      </div>

      <OnboardSchool
        open={wizard}
        onClose={() => setWizard(false)}
        existingSlugs={all.map((t) => t.slug)}
        onCreated={(t) => { setRefreshKey((k) => k + 1); setSelectedId(t.id); }}
      />
    </>
  );
}
