import { useMemo, useState } from "react";
import { chatRoleWord, fetchSchoolConversations, supabase, type SchoolConversation } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { ChatThread } from "../../components/chat/ChatThread";
import { ChatWorkspace } from "../../components/chat/ChatWorkspace";
import { EmptyState } from "../../components/ui/DataTable";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

type Tab = "mine" | "school";

/**
 * The office's chats: its own conversations with parents, and, read-only,
 * every chat in the school (school_conversations). Families and teachers
 * are told on every thread that the office can read it.
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
        blurb="Your chats with parents, and every chat in the school between families and staff, which you can read but not join."
        actions={
          <div role="tablist" className="flex rounded-md border border-[#D3DAD5] bg-white p-0.5">
            {(actingForTenant ? (["school"] as Tab[]) : (["mine", "school"] as Tab[])).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded px-3 py-1.5 text-[12.5px] ${tab === t ? "bg-forest font-semibold text-white" : "text-ink-muted"}`}
              >
                {t === "mine" ? "My chats" : "All school chats"}
              </button>
            ))}
          </div>
        }
      />
      {tab === "mine" ? <ChatWorkspace emptyBody="Start a chat with any parent at the school." /> : <SchoolChats />}
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

  const shown = useMemo(() => {
    const q = nameFilter.trim().toLowerCase();
    return (conversations ?? []).filter((c) => !q || c.a.name.toLowerCase().includes(q) || c.b.name.toLowerCase().includes(q));
  }, [conversations, nameFilter]);

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
        <span className="truncate text-[13px] font-medium">{c.a.name} and {c.b.name}</span>
        <span className="shrink-0 text-[11px] text-ink-faint">{new Date(c.lastMessageAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
      </div>
      <div className="text-[11px] text-ink-faint">
        {chatRoleWord(c.a.role)} · {chatRoleWord(c.b.role)} · {c.messageCount} {c.messageCount === 1 ? "message" : "messages"}
      </div>
      {c.lastBody && <p className="mt-0.5 truncate text-[12px] text-ink-muted">{c.lastBody.split("\n")[0]}</p>}
    </button>
  );
}
