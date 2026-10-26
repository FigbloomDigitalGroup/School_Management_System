/**
 * What each AI task may be asked, what it's told, and the shape it must
 * answer in. Kept apart from index.ts so it can be tested without a network:
 * the prompts are product behaviour, not plumbing.
 *
 * Every task except the study helper and Bloom chat answers in JSON fixed by
 * a schema (structured outputs), so the app never parses free text. Staff always see
 * a draft and edit it; nothing a task returns is saved or sent by itself.
 */

export type Task = "report_comment" | "questions" | "homework" | "message" | "translate" | "tutor" | "chat";
export type Role = "school_admin" | "teacher" | "student";

export const TASKS: Task[] = ["report_comment", "questions", "homework", "message", "translate", "tutor", "chat"];

/** Who may run each task. Org admins and Figbloom staff work through a school's own accounts. */
export const ALLOWED: Record<Task, Role[]> = {
  report_comment: ["school_admin", "teacher"],
  questions: ["school_admin", "teacher"],
  homework: ["school_admin", "teacher"],
  message: ["school_admin", "teacher"],
  translate: ["school_admin", "teacher"],
  tutor: ["student"],
  chat: ["school_admin", "teacher"],
};

/** How hard the model thinks: drafting short text doesn't need much; a question paper with a marking key does. */
export const EFFORT: Record<Task, "low" | "medium"> = {
  report_comment: "low",
  questions: "medium",
  homework: "low",
  message: "low",
  translate: "low",
  tutor: "low",
  // an open-ended assistant gets maths, planning and code too
  chat: "medium",
};

export class BadInput extends Error {}

// deno-lint-ignore no-explicit-any
type Json = any;

const str = (v: unknown, field: string, max: number, { optional = false } = {}): string => {
  if (v === undefined || v === null || v === "") {
    if (optional) return "";
    throw new BadInput(`Missing ${field}.`);
  }
  if (typeof v !== "string") throw new BadInput(`${field} must be text.`);
  const t = v.trim();
  if (t.length > max) throw new BadInput(`${field} is too long (over ${max} characters).`);
  return t;
};
const int = (v: unknown, field: string, min: number, max: number): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw new BadInput(`${field} must be a whole number from ${min} to ${max}.`);
  return n;
};
const oneOf = <T extends string>(v: unknown, field: string, options: readonly T[]): T => {
  if (typeof v !== "string" || !options.includes(v as T)) throw new BadInput(`${field} must be one of: ${options.join(", ")}.`);
  return v as T;
};
const list = (v: unknown, field: string, max: number): unknown[] => {
  if (!Array.isArray(v)) throw new BadInput(`${field} must be a list.`);
  if (v.length > max) throw new BadInput(`${field} can have at most ${max} items.`);
  return v;
};

const obj = (properties: Record<string, Json>, required = Object.keys(properties)) =>
  ({ type: "object", properties, required, additionalProperties: false });

const HOUSE_STYLE = `Write in plain, warm English as used in Kenyan schools (British spelling). Short sentences. No jargon, no emoji, no markdown. Never invent facts, dates, amounts or names that you were not given.`;

// ------------------------------------------------------------------ report card comments

/** Most learners in one request; the app sends a class in batches. */
export const MAX_LEARNERS = 15;

export interface PreparedTask {
  system: string;
  user: string;
  schema: Json | null;
}

function reportComment(p: Json): PreparedTask {
  const who = oneOf(p.who, "who", ["teacher", "principal", "both"] as const);
  const learners = list(p.learners, "learners", MAX_LEARNERS).map((l: Json, i) => ({
    ref: str(l?.ref, `learners[${i}].ref`, 64),
    firstName: str(l?.firstName, `learners[${i}].firstName`, 60),
    className: str(l?.className, `learners[${i}].className`, 60, { optional: true }),
    curriculum: oneOf(l?.curriculum ?? "844", `learners[${i}].curriculum`, ["844", "cbc"] as const),
    mean: l?.mean ?? null,
    grade: l?.grade ?? null,
    subjects: list(l?.subjects ?? [], "subjects", 20),
    areas: list(l?.areas ?? [], "areas", 20),
    competencies: list(l?.competencies ?? [], "competencies", 20),
    attendancePct: l?.attendancePct ?? null,
    existing: str(l?.existing, "existing", 600, { optional: true }),
  }));
  if (!learners.length) throw new BadInput("No learners to write comments for.");
  const style = str(p.style, "style", 300, { optional: true });

  const system = `You draft end-of-term report card comments for a school in Kenya. A teacher will read and edit every comment before it is printed.

For each learner:
- Class teacher's comment: two or three sentences. Name one real strength from the results (a subject, learning area or competency) and one thing to work on, with a concrete next step. Encouraging and honest. Refer to the learner by first name, in the third person.
- Principal's comment: one short sentence, consistent with the class teacher's.
- Use only the results given. Do not mention position, rank, other learners, fees, health or family.
- For CBC learners speak in rubric terms (exceeding, meeting, approaching or below expectations), not letter grades or percentages.
- If attendance is under 85%, the teacher's comment may gently mention attendance.
- If "existing" text is given, improve that wording rather than starting again.
${HOUSE_STYLE}`;

  const user = `Write ${who === "both" ? "both comments" : who === "teacher" ? "the class teacher's comment (leave principal empty)" : "the principal's comment (leave teacher empty)"} for each learner below.${style ? `\nThe school's preferred style: ${style}` : ""}

Learners (JSON):
${JSON.stringify(learners)}`;

  return {
    system,
    user,
    schema: obj({
      comments: { type: "array", items: obj({ ref: { type: "string" }, teacher: { type: "string" }, principal: { type: "string" } }) },
    }),
  };
}

// ------------------------------------------------------------------ question generator

function questions(p: Json): PreparedTask {
  const subject = str(p.subject, "subject", 80);
  const topic = str(p.topic, "topic", 300);
  const classLabel = str(p.classLabel, "classLabel", 60);
  const curriculum = oneOf(p.curriculum ?? "844", "curriculum", ["844", "cbc"] as const);
  const choice = int(p.choice ?? 0, "choice", 0, 30);
  const short = int(p.short ?? 0, "short", 0, 20);
  const long = int(p.long ?? 0, "long", 0, 10);
  if (choice + short + long < 1) throw new BadInput("Ask for at least one question.");
  if (choice + short + long > 40) throw new BadInput("Ask for at most 40 questions at a time.");
  const difficulty = oneOf(p.difficulty ?? "mixed", "difficulty", ["easy", "mixed", "hard"] as const);
  const kind = oneOf(p.kind ?? "exam", "kind", ["exam", "assessment"] as const);
  const notes = str(p.notes, "notes", 600, { optional: true });

  const system = `You write ${kind === "exam" ? "exam" : "class assessment"} questions for a school in Kenya, following the ${curriculum === "cbc" ? "KICD Competency Based Curriculum (CBC)" : "8-4-4 / KCSE syllabus"} for the level given. A teacher reviews every question before learners see it.

Rules:
- Every question tests the topic given, at the level given, and has one clear answer.
- Multiple choice ("choice"): exactly four options, one correct, three plausible distractors. No "all of the above" or "none of the above". correct_option is the 0-based index of the right option; model_answer is a one-line explanation of why it is right.
- Short answer ("short"): answerable in one to three sentences or a short working; 2 to 4 points; model_answer is the marking guide.
- Long answer ("long"): a structured question; 5 to 10 points; model_answer lists the points a marker should look for, with marks.
- For choice questions points is 1. For written questions options is an empty list and correct_option is -1.
- Use Kenyan contexts, names and shillings where a context helps. Keep language at the learners' reading level.
- Write Kiswahili questions entirely in Kiswahili when the subject is Kiswahili.
${HOUSE_STYLE}`;

  const user = `Subject: ${subject}
Class: ${classLabel}
Topic: ${topic}
Difficulty: ${difficulty}
Write ${choice} multiple choice, ${short} short answer and ${long} long answer questions, in that order.${notes ? `\nTeacher's notes: ${notes}` : ""}`;

  return {
    system,
    user,
    schema: obj({
      questions: {
        type: "array",
        items: obj({
          kind: { type: "string", enum: ["choice", "short", "long"] },
          prompt: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correct_option: { type: "integer" },
          model_answer: { type: "string" },
          points: { type: "integer" },
        }),
      },
    }),
  };
}

// ------------------------------------------------------------------ homework with a parent guide

function homework(p: Json): PreparedTask {
  const subject = str(p.subject, "subject", 80);
  const topic = str(p.topic, "topic", 300);
  const classLabel = str(p.classLabel, "classLabel", 60);
  const curriculum = oneOf(p.curriculum ?? "844", "curriculum", ["844", "cbc"] as const);
  const young = p.youngLearner === true;
  const notes = str(p.notes, "notes", 600, { optional: true });

  const system = `You draft a piece of homework for a school in Kenya (${curriculum === "cbc" ? "CBC" : "8-4-4"}), with a short guide for parents. A teacher edits it before it is set.

- title: short, e.g. "Fractions: adding unlike denominators" (at most 80 characters).
- body: the learner's instructions, numbered steps, doable at home without special equipment unless the teacher said otherwise. ${young ? "These are young learners (PP1 to Grade 3): very simple words, one short activity, a parent sits with them." : "Pitched for the class level."}
- guide.about: one or two sentences for a parent on what the homework practises.
- guide.needs: things the child needs (e.g. "Exercise book", "Ruler"), at most five, can be empty.
- guide.help: how a parent can help without knowing the subject.
- guide.avoid: what a parent should not do (e.g. doing it for them).
- guide.minutes: realistic time in minutes (${young ? "10 to 20" : "20 to 60"}).
${HOUSE_STYLE}`;

  const user = `Subject: ${subject}
Class: ${classLabel}
Topic: ${topic}${notes ? `\nTeacher's notes: ${notes}` : ""}`;

  return {
    system,
    user,
    schema: obj({
      title: { type: "string" },
      body: { type: "string" },
      guide: obj({
        about: { type: "string" },
        needs: { type: "array", items: { type: "string" } },
        help: { type: "string" },
        avoid: { type: "string" },
        minutes: { type: "integer" },
      }),
    }),
  };
}

// ------------------------------------------------------------------ announcements and messages

function message(p: Json): PreparedTask {
  const notes = str(p.notes, "notes", 3000);
  const audience = str(p.audience, "audience", 120, { optional: true }) || "parents";
  const tone = oneOf(p.tone ?? "warm", "tone", ["warm", "formal", "brief"] as const);
  const language = oneOf(p.language ?? "en", "language", ["en", "sw", "both"] as const);
  const schoolName = str(p.schoolName, "schoolName", 120, { optional: true });

  const system = `You turn a school staff member's rough notes into an announcement for ${audience}${schoolName ? ` at ${schoolName}` : ""} in Kenya. Staff read and edit it before it is sent.

- subject: at most 80 characters; this is all a parent sees in the notification, so put the key date or action in it.
- body: ${tone === "brief" ? "as short as possible, three or four short lines" : tone === "formal" ? "polite and formal, short paragraphs" : "warm and clear, short paragraphs"}; one instruction per paragraph; dates, times, amounts and places exactly as in the notes. Most parents read this on a phone.
- ${language === "sw" ? "Write subject and body in Kiswahili." : language === "both" ? "Write the subject in English, then the body in English followed by the same message in Kiswahili, separated by a blank line." : "Write in English."}
- Do not add a sign-off name or anything the notes do not support.
${HOUSE_STYLE}`;

  return { system, user: `Notes:\n${notes}`, schema: obj({ subject: { type: "string" }, body: { type: "string" } }) };
}

function translate(p: Json): PreparedTask {
  const subject = str(p.subject, "subject", 200, { optional: true });
  const body = str(p.body, "body", 6000);
  const to = oneOf(p.to, "to", ["sw", "en"] as const);
  const system = `You translate school announcements in Kenya ${to === "sw" ? "from English into natural, everyday Kenyan Kiswahili that parents use" : "from Kiswahili into plain English"}. Keep names, dates, times, amounts and places exactly as they are. Keep the paragraphs. Translate; do not add or remove anything.`;
  return {
    system,
    user: JSON.stringify({ subject, body }),
    schema: obj({ subject: { type: "string" }, body: { type: "string" } }),
  };
}

// ------------------------------------------------------------------ study helper

export const TUTOR_MAX_TURNS = 16;

export function tutorSystem(classLabel: string, curriculum: "844" | "cbc"): string {
  return `You are Bloom, the study helper in a Kenyan school's app (Figbloom), talking with a learner in ${classLabel || "school"} (${curriculum === "cbc" ? "CBC" : "8-4-4"}). You are a patient tutor, not an answer machine.

How you help:
- Explain ideas simply, with Kenyan everyday examples, at this learner's level. Keep replies short: a few sentences, or a few numbered steps.
- Help the learner think: ask one guiding question, give a hint, check their working, show a worked example of a *similar* problem. Do not write out full answers to homework, essays or compositions for them to copy; if asked to, explain that you will help them do it themselves, and start with the first step.
- If you are not sure of a fact, say so and suggest asking their teacher.
- Plain text only, no markdown tables.

Keeping them safe:
- You are talking to a child. Keep everything age-appropriate. Do not discuss sexual content, violence in detail, drugs, gambling, or anything unsafe; gently steer back to schoolwork.
- Never ask for or repeat personal details (full name, phone, address, school name, photos), and tell them not to share them.
- If the learner says they are being hurt, are unsafe, are thinking of hurting themselves, or are very upset: respond kindly, tell them it is not their fault and they deserve help, and encourage them to talk now to a trusted adult such as a parent, teacher or the school counsellor, or to call Childline Kenya on 116 (free, any time). Do not try to counsel them yourself.
- You are Bloom, an AI, not a person. Say so if asked.`;
}

function tutorMessages(p: Json): { role: "user" | "assistant"; content: string }[] {
  const msgs = list(p.messages, "messages", 200).slice(-TUTOR_MAX_TURNS).map((m: Json, i) => ({
    role: oneOf(m?.role, `messages[${i}].role`, ["user", "assistant"] as const),
    content: str(m?.content, `messages[${i}].content`, 2000),
  }));
  // The conversation must start and end with the learner.
  while (msgs.length && msgs[0]!.role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1]!.role !== "user") throw new BadInput("Ask a question first.");
  return msgs;
}

// ------------------------------------------------------------------ Bloom chat

/** Turns of history sent with each question; older ones stay in the saved chat but aren't re-sent. */
export const CHAT_MAX_TURNS = 40;
export const CHAT_MAX_CHARS = 12000;
/** Everything sent at once, so a long chat can't spend the school's month in a few questions. */
export const CHAT_MAX_TOTAL_CHARS = 60000;

export function chatSystem(schoolName: string, role: "school_admin" | "teacher", today: string): string {
  return `You are Bloom, the AI assistant in Figbloom, a school management app used in Kenya. You are talking with ${role === "teacher" ? "a teacher" : "a member of the school office"}${schoolName ? ` at ${schoolName}` : ""}. Today is ${today}.

Help with anything they ask, as a capable general assistant would: writing and editing (letters, circulars, reports, speeches, minutes), explaining ideas, planning lessons and schemes of work, setting and marking questions, maths and science with working shown, translation (especially English and Kiswahili), summarising, brainstorming, spreadsheets and formulas, and code.

- Know the Kenyan school context: CBC/CBE (KICD) and 8-4-4/KCSE, terms, KNEC, TSC, boarding and day schools, fees in shillings. Use British spelling.
- Be direct. Lead with the answer, then the detail. Keep it as short as the question allows.
- Format with Markdown where it helps: headings, lists, tables, **bold**, and fenced code blocks with a language. Use $…$ only if asked for LaTeX.
- If you are not sure of a fact, a date or a regulation, say so plainly instead of guessing. Never invent names, figures or policies about their school; you have no access to its records.
- Learners' personal details don't belong here; if someone pastes them, work with what you need and suggest leaving the rest out.
- You are an AI. Anything you write is a draft for the person to check.`;
}

export function chatMessages(p: Json): { role: "user" | "assistant"; content: string }[] {
  const msgs = list(p.messages, "messages", 500).slice(-CHAT_MAX_TURNS).map((m: Json, i) => {
    const role = oneOf(m?.role, `messages[${i}].role`, ["user", "assistant"] as const);
    // Bloom's own earlier answers can be longer than a question may be; only their start is re-sent.
    const content = role === "assistant" && typeof m?.content === "string"
      ? str(m.content.slice(0, CHAT_MAX_CHARS), `messages[${i}].content`, CHAT_MAX_CHARS)
      : str(m?.content, `messages[${i}].content`, CHAT_MAX_CHARS);
    return { role, content };
  });
  // Oldest turns go first when the whole is too long; the question itself always stays.
  let total = msgs.reduce((n, m) => n + m.content.length, 0);
  while (msgs.length > 1 && total > CHAT_MAX_TOTAL_CHARS) total -= msgs.shift()!.content.length;
  while (msgs.length && msgs[0]!.role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1]!.role !== "user") throw new BadInput("Ask a question first.");
  return msgs;
}

export function prepare(task: Exclude<Task, "tutor" | "chat">, payload: Json): PreparedTask {
  if (!payload || typeof payload !== "object") throw new BadInput("Missing request details.");
  switch (task) {
    case "report_comment": return reportComment(payload);
    case "questions": return questions(payload);
    case "homework": return homework(payload);
    case "message": return message(payload);
    case "translate": return translate(payload);
  }
}

export { tutorMessages };
