/**
 * "Esther Hawi" -> "Esther H.", for the sign-in screen's "Signing in as ..."
 * confirmation. That lookup is public, so it shows enough for the person to
 * recognise their own account and not the full name of whoever holds an ID.
 * A single name gives only its first letter.
 */
export function maskName(fullName: string | null | undefined): string {
  const parts = (fullName ?? "").trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "";
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  if (!last) return `${Array.from(first)[0]}•••`;
  return `${first} ${Array.from(last)[0].toUpperCase()}.`;
}
