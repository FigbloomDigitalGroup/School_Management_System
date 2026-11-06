import { useMemo, useState } from "react";
import { callDuration, callOutcome, chatRoleWord, fetchSchoolCallLog, fetchSchoolConversations, filterCallsByName, filterSchoolConversations, schoolChatTitle, supabase, type Call, type SchoolConversation } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { ChatThread } from "../../components/chat/ChatThread";
import { ChatWorkspace } from "../../components/chat/ChatWorkspace";
import { Badge } from "../../components/ui/Badge";
import { DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

type Tab = "mine" | "school" | "calls";

const TAB_LABEL: Record<Tab, string> = { mine: "My chats", school: "All school chats", calls: "Calls" };

/**
 * The office's chats: its own conversations with parents, and, read-only,
 * every chat in the school (school_conversations) and the school's call log.
 * Families and teachers are told on every thread that the office can read it.
 */
export function AdminChats() {
  const { actingForTenant } = useTenantSession();
  // An org admin acting for the school isn't in the school's chats, only overseeing them.
  const [tab, setTab] = useState<Tab>(actingForTenant ? "school" : "mine");

  return (
    <div className="flex h-full flex-col">
      <PageHead
        eyebrow="Chats"
        title="Chats"
        blurb="Your chats with parents and staff, every chat in the school, which you can read but not join, and who called whom."
        actions={
          <div role="tablist" className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
            {(actingForTenant ? (["school", "calls"] as Tab[]) : (["mine", "school", "calls"] as Tab[])).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded px-3 py-1.5 text-[12.5px] ${tab === t ? "bg-forest font-semibold text-white" : "text-ink-muted"}`}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        }
      />
      {tab === "mine" ? <ChatWorkspace emptyBody="Start a chat with any parent or member of staff at the school." />
        : tab === "school" ? <SchoolChats /> : <SchoolCalls />}
    </div>
  );
}

/** The school's call log: who called whom, when, and for how long. Never what was said. */
function SchoolCalls() {
  const { tenant } = useTenantSession();
  const [nameFilter, setNameFilter] = useState("");
  const { data: calls, loading, error } = useAsync(() => fetchSchoolCallLog(tenant.id), [tenant.id]);

  const shown = useMemo(() => filterCallsByName(calls ?? [], nameFilter), [calls, nameFilter]);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-6">
      {error ? (
        <p className="text-[12.5px] text-warn-ink">Could not load the school's calls: {error.message}</p>
      ) : loading || !calls ? (
        <TableSkeleton rows={6} />
      ) : (
        <DataTable
          title={`${shown.length} ${shown.length === 1 ? "call" : "calls"}`}
          filters={
            <input
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              placeholder="Filter by caller or person called"
              aria-label="Filter by name"
              className="w-[260px] rounded-md border border-[#D3DAD5] px-3 py-1.5 text-[12.5px] outline-none focus:border-forest"
            />
          }
          columns={[
            {
              key: "when", header: "When", width: "1fr",
              render: (c: Call) => <Mono>{new Date(c.created_at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</Mono>,
            },
            { key: "from", header: "Caller", width: "1.3fr", render: (c: Call) => <span className="text-[13px]">{c.caller_name}</span> },
            { key: "to", header: "Called", width: "1.3fr", render: (c: Call) => <span className="text-[13px]">{c.callee_name}</span> },
            { key: "kind", header: "Type", width: "0.6fr", render: (c: Call) => <span className="text-[12.5px] text-ink-muted">{c.video ? "Video" : "Voice"}</span> },
            { key: "length", header: "Length", width: "0.6fr", render: (c: Call) => <Mono>{callDuration(c) ?? "—"}</Mono> },
            {
              key: "outcome", header: "", align: "right", width: "0.8fr",
              render: (c: Call) => { const { label, tone } = callOutcome(c); return <Badge tone={tone}>{label}</Badge>; },
            },
          ]}
          rows={shown}
          rowKey={(c) => c.id}
          empty={{ title: "No calls.", body: nameFilter ? "No calls match this name." : "No one at the school has made a call yet." }}
        />
      )}
    </div>
  );
}

function SchoolChats() {
  const { profile, tenant } = useTenantSession();
  const [learnerText, setLearnerText] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: learners } = useAsync(async () => {
    const { data, error } = await supabase()
      .from("students").select("id, full_name, admission_no")
      .eq("tenant_id", tenant.id).eq("active", true).order("full_name").limit(5000);
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; full_name: string; admission_no: string }[];
  }, [tenant.id]);

  // "Amani Wanjiku · 2024/118" from the datalist resolves to that learner; anything else is no filter.
  const learnerId = useMemo(
    () => (learners ?? []).find((l) => `${l.full_name} · ${l.admission_no}` === learnerText)?.id ?? null,
    [learners, learnerText],
  );

  const { data: conversations, loading, error } = useAsync(() => fetchSchoolConversations(tenant.id, learnerId), [tenant.id, learnerId]);

  const shown = useMemo(() => filterSchoolConversations(conversations ?? [], nameFilter), [conversations, nameFilter]);

  const selected = shown.find((c) => c.id === selectedId) ?? shown[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-[340px] shrink-0 flex-col overflow-hidden border-r border-line bg-[#FAFBFA]">
        <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
          <input
            list="chat-learners"
            value={learnerText}
            onChange={(e) => setLearnerText(e.target.value)}
            placeholder="About a learner (their own or their family's chats)"
            aria-label="Filter by learner"
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-1.5 text-[12.5px] outline-none focus:border-forest"
          />
          <datalist id="chat-learners">
            {(learners ?? []).map((l) => <option key={l.id} value={`${l.full_name} · ${l.admission_no}`} />)}
          </datalist>
          <input
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            placeholder="Filter by participant name"
            aria-label="Filter by participant"
            className="w-full rounded-md border border-[#D3DAD5] px-3 py-1.5 text-[12.5px] outline-none focus:border-forest"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="m-4 text-[12.5px] text-warn-ink">Could not load the school's chats: {error.message}</p>
          ) : loading || !conversations ? (
            <TableSkeleton rows={6} />
          ) : shown.length === 0 ? (
            <EmptyState title="No chats." body={learnerId || nameFilter ? "No chats match these filters." : "No one at the school has chatted yet."} />
          ) : (
            shown.map((c) => <SchoolChatRow key={c.id} c={c} active={c.id === selected?.id} onOpen={() => setSelectedId(c.id)} />)
          )}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        {selected && (
          <ChatThread key={selected.id} conversationId={selected.id} myId={profile.id} tenantId={tenant.id} canReply={false} oversight />
        )}
      </div>
    </div>
  );
}

function SchoolChatRow({ c, active, onOpen }: { c: SchoolConversation; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full border-b border-line-soft px-4 py-3 text-left"
      style={{ background: active ? "#F1F5F2" : "transparent", borderLeft: `3px solid ${active ? "var(--accent)" : "transparent"}` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[13px] font-medium">{schoolChatTitle(c)}</span>
        <span className="shrink-0 text-[11px] text-ink-faint">{new Date(c.lastMessageAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      </div>
      <div className="text-[11px] text-ink-faint">
        {chatRoleWord(c.a.role)} · {chatRoleWord(c.b.role)} · {c.messageCount} {c.messageCount === 1 ? "message" : "messages"}
      </div>
      {c.lastBody && <p className="mt-0.5 truncate text-[12px] text-ink-muted">{c.lastBody.split("\n")[0]}</p>}
    </button>
  );
}
