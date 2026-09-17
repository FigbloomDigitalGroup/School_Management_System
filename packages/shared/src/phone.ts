import { countryProfile } from "./countries";

/**
 * Best-effort local → international reformat: strips non-digits, replaces a
 * registered local prefix with the country's dial code, and falls back to
 * prepending the dial code outright. Never rejects input — used where the
 * real validator is downstream (Supabase Auth's OTP send/verify), not here.
 */
export function normalisePhoneForCountry(raw: string, country: string): string {
  const { dialCode, localPrefixes } = countryProfile(country);
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith(dialCode)) return `+${digits}`;
  const prefix = localPrefixes.find((p) => digits.startsWith(p));
  if (prefix) return `+${dialCode}${digits.slice(prefix.length)}`;
  return `+${dialCode}${digits}`;
}
