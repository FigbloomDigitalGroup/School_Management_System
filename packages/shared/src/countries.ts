/**
 * Everything about a country that the product needs to vary by — currency
 * formatting, phone-number shape, display label — registered by ISO
 * 3166-1 alpha-2 code, the same key `tenants.country` and
 * `gradingSchemeFor()` already use. Kenya is the only entry today, but the
 * shape supports adding another country later as a data entry here, not a
 * rearchitecture — mirrors the pattern in `gradingSchemes.ts`.
 */

export interface CountryProfile {
  label: string;
  /** ISO 4217 currency code, e.g. "KES". */
  currencyCode: string;
  /** The symbol/prefix shown before an amount, e.g. "KSh". */
  currencySymbol: string;
  /** Fraction digits to display — 0 for a shilling-style currency with no
   *  everyday sub-unit in practice. */
  currencyDecimals: number;
  /** Country calling code, no "+", e.g. "254". */
  dialCode: string;
  /** Leading digits on a local-format number that get dropped and replaced
   *  with `dialCode` — e.g. a Kenyan "07xx..." becomes "2547xx...". */
  localPrefixes: string[];
  /** Example shown as a phone field's placeholder. */
  phonePlaceholder: string;
}

const KENYA: CountryProfile = {
  label: "Kenya",
  currencyCode: "KES",
  currencySymbol: "KSh",
  currencyDecimals: 0,
  dialCode: "254",
  localPrefixes: ["0"],
  phonePlaceholder: "07xx xxx xxx",
};

export const COUNTRIES: Record<string, CountryProfile> = { KE: KENYA };

/** Falls back to Kenya for an unregistered country — matches the product's
 *  only real customers today (all Kenyan) rather than throwing, so onboarding
 *  a tenant with a not-yet-modeled country doesn't hard-fail. */
export function countryProfile(country: string): CountryProfile {
  return COUNTRIES[country] ?? KENYA;
}
