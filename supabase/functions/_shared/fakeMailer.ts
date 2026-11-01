/**
 * A stand-in Mailer for tests: records what would have been sent and answers
 * with whatever the test sets. Never touches the network.
 *
 * Not published (the "_shared" prefix keeps the Supabase CLI from deploying
 * it as its own function).
 */

import type { EmailMessage, Mailer, SendResult } from "./email.ts";
import type { Limiter } from "./rateLimit.ts";

export class FakeMailer implements Mailer {
  configured = true;
  appUrl: string | null = "https://app.example.test";
  sent: EmailMessage[] = [];
  /** What send() answers; set it to a failure to test the fallback. */
  answer: SendResult = { status: "sent", id: "email-1" };
  /** Set to make send() throw, as a broken network stack might. */
  throws: Error | null = null;

  send(message: EmailMessage): Promise<SendResult> {
    if (this.throws) return Promise.reject(this.throws);
    this.sent.push(message);
    return Promise.resolve(this.answer);
  }
}

/** A limiter that allows the first `allow` calls and refuses the rest. */
export function countingLimiter(allow = Infinity): Limiter & { calls: number } {
  const limiter = Object.assign(() => {
    limiter.calls += 1;
    return Promise.resolve(limiter.calls <= allow);
  }, { calls: 0 });
  return limiter;
}

/** Runs fn with console.log/error/warn captured, and returns everything they were given, as text. */
export async function captureLogs(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const grab = (...args: unknown[]) => { lines.push(args.map((a) => typeof a === "string" ? a : JSON.stringify(a)).join(" ")); };
  console.log = grab;
  console.error = grab;
  console.warn = grab;
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}
