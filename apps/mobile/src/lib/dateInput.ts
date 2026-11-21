import { toLocalInput } from "@figbloom/shared";

/**
 * Digits typed into a date field, laid out as YYYY-MM-DD while they are typed ("20261109" becomes "2026-11-09"),
 * so the number pad is enough and the dashes need not be found. Anything that is not a digit is dropped.
 */
export function formatDateInput(text: string): string {
  const digits = text.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)].filter(Boolean).join("-");
}

/** Digits typed into a time box, laid out as HH:MM while they are typed ("0830" becomes "08:30"). */
export function formatTimeInput(text: string): string {
  const digits = text.replace(/\D/g, "").slice(0, 4);
  return digits.length <= 2 ? digits : `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/** A saved moment as the two boxes show it, on this phone's clock: date as YYYY-MM-DD, time as HH:MM. Both empty for none. */
export function splitDateTime(iso: string | null): { date: string; time: string } {
  const [date = "", time = ""] = toLocalInput(iso).split("T");
  return { date, time };
}

/**
 * The two boxes as the "YYYY-MM-DDTHH:MM" value `fromLocalInput` reads. "" when both are empty (nothing chosen),
 * null when what is typed is not a real date and time (half typed, a 31st of February, minute 75).
 */
export function joinDateTime(date: string, time: string): string | null {
  if (!date.trim() && !time.trim()) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const value = `${date}T${time}`;
  const at = new Date(value);
  // A date that does not exist rolls over into the next month, so it only counts when it reads back the same.
  return !Number.isNaN(at.getTime()) && toLocalInput(at.toISOString()) === value ? value : null;
}
