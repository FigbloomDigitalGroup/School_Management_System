import { PageHead } from "../../components/ConsoleShell";
import { ChatWorkspace } from "../../components/chat/ChatWorkspace";

const COPY = {
  parent: {
    blurb: "Chat with your child, their teachers and the school office.",
    empty: "Start a chat with your child's class teacher, a subject teacher, the school office, or your child.",
  },
  student: {
    blurb: "Chat with your parents and guardians.",
    empty: "Start a chat with a parent or guardian.",
  },
  teacher: {
    blurb: "One-to-one chats with the parents of learners you teach and with colleagues. For the whole class, use Messages.",
    empty: "Start a chat with the parent of a learner you teach, or a colleague.",
  },
  staff: {
    blurb: "One-to-one chats with the school office, teachers and other staff.",
    empty: "Start a chat with the school office, a teacher or a colleague.",
  },
} as const;

/** Chats for a parent, a learner, a teacher or other staff; the office's version, with oversight, is admin/Chats. */
export function MyChats({ role }: { role: keyof typeof COPY }) {
  return (
    <div className="flex h-full flex-col">
      <PageHead eyebrow="Chats" title="Chats" blurb={COPY[role].blurb} />
      <ChatWorkspace emptyBody={COPY[role].empty} />
    </div>
  );
}
