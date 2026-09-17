/**
 * Mirrors the dial-code/local-prefix data in packages/shared/src/countries.ts.
 * Edge functions run on Deno and have no relative import path into the
 * workspace's packages/shared, so this is a deliberate, minimal duplicate —
 * keep it in sync with packages/shared/src/countries.ts by hand.
 */

export interface CountryDialCode {
  dialCode: string;
  localPrefixes: string[];
}

const KENYA: CountryDialCode = { dialCode: "254", localPrefixes: ["0"] };

export const COUNTRY_DIAL_CODES: Record<string, CountryDialCode> = { KE: KENYA };

export function dialCodeFor(country: string | null | undefined): CountryDialCode {
  return (country && COUNTRY_DIAL_CODES[country]) || KENYA;
}
