/**
 * A payment recorded on one screen, said on the one under it when it comes back into view: the form that records a
 * payment closes itself, and the fees screen reads the note when it is focused again (and reads the term again, since
 * the balance moved). Held here rather than in navigation params because params only travel forward.
 */
let pending: string | null = null;

/** Leaves a note for the fees screen. */
export function noteRecordedPayment(text: string): void {
  pending = text;
}

/** What the fees screen finds when it is focused: the note, once, or null. */
export function takeRecordedPayment(): string | null {
  const text = pending;
  pending = null;
  return text;
}
