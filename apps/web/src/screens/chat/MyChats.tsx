import { onApi } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { ChatWorkspace } from "../../components/chat/ChatWorkspace";

const COPY = {
  parent: {
    blurb: "Chat with your child, their teachers and the school office.",
    empty: "Start a chat with your child's class teacher, a subject teacher, the school office, or your child.",
    apiBlurb: "Chat with your child's teachers and the school office.",
    apiEmpty: "Start a chat with your child's class teacher, a subject teacher, or the school office.",
  },
  student: {
    blurb: "Chat with your parents and guardians.",
    empty: "Start a chat with a parent or guardian.",
    // On the API a learner talks with the teachers of their own class and the school office, and with nobody else (owner decision, 25 November 2026).
    apiBlurb: "Chat with your class teachers and the school office.",
    apiEmpty: "Start a chat with your class teacher, a subject teacher, or the school office.",
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
  const copy = COPY[role];
  const blurb = onApi() && "apiBlurb" in copy ? copy.apiBlurb : copy.blurb;
  const empty = onApi() && "apiEmpty" in copy ? copy.apiEmpty : copy.empty;
  return (
    <div className="flex h-full flex-col">
      <PageHead eyebrow="Chats" title="Chats" blurb={blurb} />
      <ChatWorkspace emptyBody={empty} />
    </div>
  );
}
