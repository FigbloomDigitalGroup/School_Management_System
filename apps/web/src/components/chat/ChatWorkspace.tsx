import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chatRoleWord, conversationPreview, fetchChatContacts, fetchMyConversations, startConversation, subscribeChatMessages,
  type ChatContact, type ConversationSummary,
} from "@figbloom/shared";
import { Avatar } from "../Avatar";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/DataTable";
import { Modal } from "../ui/Modal";
import { TableSkeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";
import { ChatThread } from "./ChatThread";

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/**
 * The caller's own chats, master-detail like the parent Inbox: the list stays
 * on the left while a thread is open on the right. "New chat" lists only the
 * people the database says this caller may talk to (my_chat_contacts), so
 * nobody is offered a chat that would then be refused.
 */
export function ChatWorkspace({ emptyBody }: { emptyBody: string }) {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const reload = useCallback(() => {
    fetchMyConversations()
      .then((cs) => { setList(cs); setError(null); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load your chats."));
  }, []);

  useEffect(() => {
    reload();
    // A message in any of the caller's chats moves it up the list and bumps its count.
    return subscribeChatMessages({ tenantId: tenant.id }, reload);
  }, [reload, tenant.id]);

  async function openWith(contact: ChatContact) {
    try {
      const id = await startConversation(contact.profileId);
      setPicking(false);
      setSelectedId(id);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start that chat.", "error");
    }
  }

  const conversations = list ?? [];
  const selected = conversations.find((c) => c.id === selectedId) ?? (selectedId ? null : conversations[0] ?? null);
  // A chat just started has no row yet until reload lands; it can be replied to by definition.
  const openId = selected?.id ?? selectedId;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex w-[320px] shrink-0 flex-col overflow-hidden border-r border-line bg-[#FAFBFA]">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="text-[13px] font-semibold">Chats</span>
          <Button variant="primary" type="button" onClick={() => setPicking(true)}>New chat</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <p className="m-4 text-[12.5px] text-warn-ink">Could not load your chats: {error}</p>
          ) : !list ? (
            <TableSkeleton rows={6} />
          ) : conversations.length === 0 ? (
            <EmptyState title="No chats yet." body={emptyBody} />
          ) : (
            conversations.map((c) => {
              const active = c.id === openId;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedId(c.id)}
                  className="flex w-full items-start gap-3 border-b border-line-soft px-4 py-3 text-left"
                  style={{ background: active ? "#F1F5F2" : "transparent", borderLeft: `3px solid ${active ? "var(--accent)" : "transparent"}` }}
                >
                  <Avatar id={c.otherId} name={c.otherName} url={c.otherAvatarUrl} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[13px]" style={{ fontWeight: c.unread ? 700 : 500 }}>{c.otherName}</span>
                      <span className="shrink-0 text-[11px] text-ink-faint">{when(c.lastMessageAt)}</span>
                    </div>
                    <div className="text-[11px] text-ink-faint">{chatRoleWord(c.otherRole)}</div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <p className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{conversationPreview(c, profile.id)}</p>
                      {c.unread > 0 && <span className="shrink-0 rounded-full bg-orange px-1.5 font-mono text-[10px] text-white">{c.unread}</span>}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      <div className="min-w-0 flex-1">
        {openId ? (
          <ChatThread
            key={openId}
            conversationId={openId}
            myId={profile.id}
            tenantId={tenant.id}
            canReply={selected?.canReply ?? true}
            onRead={reload}
            onSent={reload}
          />
        ) : list ? (
          <div className="px-7 py-6">
            <EmptyState
              title="Start a conversation."
              body={emptyBody}
              action={<Button variant="primary" type="button" onClick={() => setPicking(true)}>New chat</Button>}
            />
          </div>
        ) : null}
      </div>

      <ContactPicker open={picking} onClose={() => setPicking(false)} onPick={(c) => void openWith(c)} />
    </div>
  );
}

function ContactPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (c: ChatContact) => void }) {
  const [contacts, setContacts] = useState<ChatContact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    fetchChatContacts().then(setContacts).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load contacts."));
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (contacts ?? []).filter((c) => !q || c.name.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q));
  }, [contacts, query]);

  return (
    <Modal open={open} onClose={onClose} eyebrow="Chats" title="Start a chat" blurb="Only people you're connected to through a learner are listed." width={520}>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, class or subject"
        aria-label="Search contacts"
        className="mb-3 w-full rounded-md border border-[#D3DAD5] px-3 py-2 text-[13px] outline-none focus:border-forest"
      />
      <div className="max-h-[360px] overflow-auto">
        {error ? (
          <p className="text-[12.5px] text-warn-ink">{error}</p>
        ) : !contacts ? (
          <TableSkeleton rows={4} />
        ) : shown.length === 0 ? (
          <p className="py-6 text-center text-[12.5px] text-ink-muted">{contacts.length ? "No one matches that search." : "There's no one you can chat with yet."}</p>
        ) : (
          shown.map((c) => (
            <button
              key={c.profileId}
              type="button"
              onClick={() => onPick(c)}
              className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-page"
            >
              <Avatar id={c.profileId} name={c.name} url={c.avatarUrl} size={30} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{c.name}</div>
                <div className="truncate text-[11.5px] text-ink-faint">{c.detail}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
