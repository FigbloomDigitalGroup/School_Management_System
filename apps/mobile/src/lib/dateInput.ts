/**
 * Digits typed into a date field, laid out as YYYY-MM-DD while they are typed ("20261109" becomes "2026-11-09"),
 * so the number pad is enough and the dashes need not be found. Anything that is not a digit is dropped.
 */
export function formatDateInput(text: string): string {
  const digits = text.replace(/\D/g, "").slice(0, 8);
  return [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)].filter(Boolean).join("-");
}
