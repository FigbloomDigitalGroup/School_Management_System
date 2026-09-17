/**
 * Everything about a country that the product needs to vary by — currency
 * formatting, phone-number shape, display label — registered by ISO
 * 3166-1 alpha-2 code, the same key `tenants.country` and
 * `gradingSchemeFor()` already use.
 *
 * All 194 UN member states are populated (name, ISO 4217 currency code +
 * symbol + decimal places, E.164 calling code), sourced from the
 * mledoze/countries reference dataset with a handful of hand-corrected
 * entries (Cuba's since-discontinued CUC, Zimbabwe's multi-currency economy,
 * Vatican City's ITU code) — see git history for the exact fixes.
 *
 * `localPrefixes` and `phonePlaceholder` are NOT independently verified per
 * country the way currency/dial-code are: every country defaults to the
 * common "drop a leading 0, prepend the dial code" convention and an
 * international-format placeholder. Kenya is the one exception, with a
 * real, in-product-verified local format — same honest-fallback spirit as
 * `gradingSchemeFor()`'s Kenya-only scheme data.
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

export const COUNTRIES: Record<string, CountryProfile> = {
  AF: { label: "Afghanistan", currencyCode: "AFN", currencySymbol: "؋", currencyDecimals: 2, dialCode: "93", localPrefixes: ["0"], phonePlaceholder: "+93 XXXXXXXXX" },
  AL: { label: "Albania", currencyCode: "ALL", currencySymbol: "L", currencyDecimals: 2, dialCode: "355", localPrefixes: ["0"], phonePlaceholder: "+355 XXXXXXXXX" },
  DZ: { label: "Algeria", currencyCode: "DZD", currencySymbol: "د.ج", currencyDecimals: 2, dialCode: "213", localPrefixes: ["0"], phonePlaceholder: "+213 XXXXXXXXX" },
  AD: { label: "Andorra", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "376", localPrefixes: ["0"], phonePlaceholder: "+376 XXXXXXXXX" },
  AO: { label: "Angola", currencyCode: "AOA", currencySymbol: "Kz", currencyDecimals: 2, dialCode: "244", localPrefixes: ["0"], phonePlaceholder: "+244 XXXXXXXXX" },
  AG: { label: "Antigua and Barbuda", currencyCode: "XCD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1268", localPrefixes: ["0"], phonePlaceholder: "+1268 XXXXXXXXX" },
  AR: { label: "Argentina", currencyCode: "ARS", currencySymbol: "$", currencyDecimals: 2, dialCode: "54", localPrefixes: ["0"], phonePlaceholder: "+54 XXXXXXXXX" },
  AM: { label: "Armenia", currencyCode: "AMD", currencySymbol: "֏", currencyDecimals: 2, dialCode: "374", localPrefixes: ["0"], phonePlaceholder: "+374 XXXXXXXXX" },
  AU: { label: "Australia", currencyCode: "AUD", currencySymbol: "$", currencyDecimals: 2, dialCode: "61", localPrefixes: ["0"], phonePlaceholder: "+61 XXXXXXXXX" },
  AT: { label: "Austria", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "43", localPrefixes: ["0"], phonePlaceholder: "+43 XXXXXXXXX" },
  AZ: { label: "Azerbaijan", currencyCode: "AZN", currencySymbol: "₼", currencyDecimals: 2, dialCode: "994", localPrefixes: ["0"], phonePlaceholder: "+994 XXXXXXXXX" },
  BS: { label: "Bahamas", currencyCode: "BSD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1242", localPrefixes: ["0"], phonePlaceholder: "+1242 XXXXXXXXX" },
  BH: { label: "Bahrain", currencyCode: "BHD", currencySymbol: ".د.ب", currencyDecimals: 3, dialCode: "973", localPrefixes: ["0"], phonePlaceholder: "+973 XXXXXXXXX" },
  BD: { label: "Bangladesh", currencyCode: "BDT", currencySymbol: "৳", currencyDecimals: 2, dialCode: "880", localPrefixes: ["0"], phonePlaceholder: "+880 XXXXXXXXX" },
  BB: { label: "Barbados", currencyCode: "BBD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1246", localPrefixes: ["0"], phonePlaceholder: "+1246 XXXXXXXXX" },
  BY: { label: "Belarus", currencyCode: "BYN", currencySymbol: "Br", currencyDecimals: 2, dialCode: "375", localPrefixes: ["0"], phonePlaceholder: "+375 XXXXXXXXX" },
  BE: { label: "Belgium", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "32", localPrefixes: ["0"], phonePlaceholder: "+32 XXXXXXXXX" },
  BZ: { label: "Belize", currencyCode: "BZD", currencySymbol: "$", currencyDecimals: 2, dialCode: "501", localPrefixes: ["0"], phonePlaceholder: "+501 XXXXXXXXX" },
  BJ: { label: "Benin", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "229", localPrefixes: ["0"], phonePlaceholder: "+229 XXXXXXXXX" },
  BT: { label: "Bhutan", currencyCode: "BTN", currencySymbol: "Nu.", currencyDecimals: 2, dialCode: "975", localPrefixes: ["0"], phonePlaceholder: "+975 XXXXXXXXX" },
  BO: { label: "Bolivia", currencyCode: "BOB", currencySymbol: "Bs.", currencyDecimals: 2, dialCode: "591", localPrefixes: ["0"], phonePlaceholder: "+591 XXXXXXXXX" },
  BA: { label: "Bosnia and Herzegovina", currencyCode: "BAM", currencySymbol: "KM", currencyDecimals: 2, dialCode: "387", localPrefixes: ["0"], phonePlaceholder: "+387 XXXXXXXXX" },
  BW: { label: "Botswana", currencyCode: "BWP", currencySymbol: "P", currencyDecimals: 2, dialCode: "267", localPrefixes: ["0"], phonePlaceholder: "+267 XXXXXXXXX" },
  BR: { label: "Brazil", currencyCode: "BRL", currencySymbol: "R$", currencyDecimals: 2, dialCode: "55", localPrefixes: ["0"], phonePlaceholder: "+55 XXXXXXXXX" },
  BN: { label: "Brunei", currencyCode: "BND", currencySymbol: "$", currencyDecimals: 2, dialCode: "673", localPrefixes: ["0"], phonePlaceholder: "+673 XXXXXXXXX" },
  BG: { label: "Bulgaria", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "359", localPrefixes: ["0"], phonePlaceholder: "+359 XXXXXXXXX" },
  BF: { label: "Burkina Faso", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "226", localPrefixes: ["0"], phonePlaceholder: "+226 XXXXXXXXX" },
  BI: { label: "Burundi", currencyCode: "BIF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "257", localPrefixes: ["0"], phonePlaceholder: "+257 XXXXXXXXX" },
  KH: { label: "Cambodia", currencyCode: "KHR", currencySymbol: "៛", currencyDecimals: 2, dialCode: "855", localPrefixes: ["0"], phonePlaceholder: "+855 XXXXXXXXX" },
  CM: { label: "Cameroon", currencyCode: "XAF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "237", localPrefixes: ["0"], phonePlaceholder: "+237 XXXXXXXXX" },
  CA: { label: "Canada", currencyCode: "CAD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1", localPrefixes: ["0"], phonePlaceholder: "+1 XXXXXXXXX" },
  CV: { label: "Cape Verde", currencyCode: "CVE", currencySymbol: "Esc", currencyDecimals: 2, dialCode: "238", localPrefixes: ["0"], phonePlaceholder: "+238 XXXXXXXXX" },
  CF: { label: "Central African Republic", currencyCode: "XAF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "236", localPrefixes: ["0"], phonePlaceholder: "+236 XXXXXXXXX" },
  TD: { label: "Chad", currencyCode: "XAF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "235", localPrefixes: ["0"], phonePlaceholder: "+235 XXXXXXXXX" },
  CL: { label: "Chile", currencyCode: "CLP", currencySymbol: "$", currencyDecimals: 0, dialCode: "56", localPrefixes: ["0"], phonePlaceholder: "+56 XXXXXXXXX" },
  CN: { label: "China", currencyCode: "CNY", currencySymbol: "¥", currencyDecimals: 2, dialCode: "86", localPrefixes: ["0"], phonePlaceholder: "+86 XXXXXXXXX" },
  CO: { label: "Colombia", currencyCode: "COP", currencySymbol: "$", currencyDecimals: 2, dialCode: "57", localPrefixes: ["0"], phonePlaceholder: "+57 XXXXXXXXX" },
  KM: { label: "Comoros", currencyCode: "KMF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "269", localPrefixes: ["0"], phonePlaceholder: "+269 XXXXXXXXX" },
  CG: { label: "Congo", currencyCode: "XAF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "242", localPrefixes: ["0"], phonePlaceholder: "+242 XXXXXXXXX" },
  CR: { label: "Costa Rica", currencyCode: "CRC", currencySymbol: "₡", currencyDecimals: 2, dialCode: "506", localPrefixes: ["0"], phonePlaceholder: "+506 XXXXXXXXX" },
  HR: { label: "Croatia", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "385", localPrefixes: ["0"], phonePlaceholder: "+385 XXXXXXXXX" },
  // The convertible peso (CUC) this dataset originally listed was retired in 2021 — CUP is now Cuba's sole currency.
  CU: { label: "Cuba", currencyCode: "CUP", currencySymbol: "$", currencyDecimals: 2, dialCode: "53", localPrefixes: ["0"], phonePlaceholder: "+53 XXXXXXXXX" },
  CY: { label: "Cyprus", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "357", localPrefixes: ["0"], phonePlaceholder: "+357 XXXXXXXXX" },
  CZ: { label: "Czechia", currencyCode: "CZK", currencySymbol: "Kč", currencyDecimals: 2, dialCode: "420", localPrefixes: ["0"], phonePlaceholder: "+420 XXXXXXXXX" },
  DK: { label: "Denmark", currencyCode: "DKK", currencySymbol: "kr", currencyDecimals: 2, dialCode: "45", localPrefixes: ["0"], phonePlaceholder: "+45 XXXXXXXXX" },
  DJ: { label: "Djibouti", currencyCode: "DJF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "253", localPrefixes: ["0"], phonePlaceholder: "+253 XXXXXXXXX" },
  DM: { label: "Dominica", currencyCode: "XCD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1767", localPrefixes: ["0"], phonePlaceholder: "+1767 XXXXXXXXX" },
  DO: { label: "Dominican Republic", currencyCode: "DOP", currencySymbol: "$", currencyDecimals: 2, dialCode: "1", localPrefixes: ["0"], phonePlaceholder: "+1 XXXXXXXXX" },
  CD: { label: "DR Congo", currencyCode: "CDF", currencySymbol: "FC", currencyDecimals: 2, dialCode: "243", localPrefixes: ["0"], phonePlaceholder: "+243 XXXXXXXXX" },
  EC: { label: "Ecuador", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "593", localPrefixes: ["0"], phonePlaceholder: "+593 XXXXXXXXX" },
  EG: { label: "Egypt", currencyCode: "EGP", currencySymbol: "£", currencyDecimals: 2, dialCode: "20", localPrefixes: ["0"], phonePlaceholder: "+20 XXXXXXXXX" },
  SV: { label: "El Salvador", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "503", localPrefixes: ["0"], phonePlaceholder: "+503 XXXXXXXXX" },
  GQ: { label: "Equatorial Guinea", currencyCode: "XAF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "240", localPrefixes: ["0"], phonePlaceholder: "+240 XXXXXXXXX" },
  ER: { label: "Eritrea", currencyCode: "ERN", currencySymbol: "Nfk", currencyDecimals: 2, dialCode: "291", localPrefixes: ["0"], phonePlaceholder: "+291 XXXXXXXXX" },
  EE: { label: "Estonia", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "372", localPrefixes: ["0"], phonePlaceholder: "+372 XXXXXXXXX" },
  SZ: { label: "Eswatini", currencyCode: "SZL", currencySymbol: "L", currencyDecimals: 2, dialCode: "268", localPrefixes: ["0"], phonePlaceholder: "+268 XXXXXXXXX" },
  ET: { label: "Ethiopia", currencyCode: "ETB", currencySymbol: "Br", currencyDecimals: 2, dialCode: "251", localPrefixes: ["0"], phonePlaceholder: "+251 XXXXXXXXX" },
  FJ: { label: "Fiji", currencyCode: "FJD", currencySymbol: "$", currencyDecimals: 2, dialCode: "679", localPrefixes: ["0"], phonePlaceholder: "+679 XXXXXXXXX" },
  FI: { label: "Finland", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "358", localPrefixes: ["0"], phonePlaceholder: "+358 XXXXXXXXX" },
  FR: { label: "France", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "33", localPrefixes: ["0"], phonePlaceholder: "+33 XXXXXXXXX" },
  GA: { label: "Gabon", currencyCode: "XAF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "241", localPrefixes: ["0"], phonePlaceholder: "+241 XXXXXXXXX" },
  GM: { label: "Gambia", currencyCode: "GMD", currencySymbol: "D", currencyDecimals: 2, dialCode: "220", localPrefixes: ["0"], phonePlaceholder: "+220 XXXXXXXXX" },
  GE: { label: "Georgia", currencyCode: "GEL", currencySymbol: "₾", currencyDecimals: 2, dialCode: "995", localPrefixes: ["0"], phonePlaceholder: "+995 XXXXXXXXX" },
  DE: { label: "Germany", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "49", localPrefixes: ["0"], phonePlaceholder: "+49 XXXXXXXXX" },
  GH: { label: "Ghana", currencyCode: "GHS", currencySymbol: "₵", currencyDecimals: 2, dialCode: "233", localPrefixes: ["0"], phonePlaceholder: "+233 XXXXXXXXX" },
  GR: { label: "Greece", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "30", localPrefixes: ["0"], phonePlaceholder: "+30 XXXXXXXXX" },
  GD: { label: "Grenada", currencyCode: "XCD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1473", localPrefixes: ["0"], phonePlaceholder: "+1473 XXXXXXXXX" },
  GT: { label: "Guatemala", currencyCode: "GTQ", currencySymbol: "Q", currencyDecimals: 2, dialCode: "502", localPrefixes: ["0"], phonePlaceholder: "+502 XXXXXXXXX" },
  GN: { label: "Guinea", currencyCode: "GNF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "224", localPrefixes: ["0"], phonePlaceholder: "+224 XXXXXXXXX" },
  GW: { label: "Guinea-Bissau", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "245", localPrefixes: ["0"], phonePlaceholder: "+245 XXXXXXXXX" },
  GY: { label: "Guyana", currencyCode: "GYD", currencySymbol: "$", currencyDecimals: 2, dialCode: "592", localPrefixes: ["0"], phonePlaceholder: "+592 XXXXXXXXX" },
  HT: { label: "Haiti", currencyCode: "HTG", currencySymbol: "G", currencyDecimals: 2, dialCode: "509", localPrefixes: ["0"], phonePlaceholder: "+509 XXXXXXXXX" },
  HN: { label: "Honduras", currencyCode: "HNL", currencySymbol: "L", currencyDecimals: 2, dialCode: "504", localPrefixes: ["0"], phonePlaceholder: "+504 XXXXXXXXX" },
  HU: { label: "Hungary", currencyCode: "HUF", currencySymbol: "Ft", currencyDecimals: 2, dialCode: "36", localPrefixes: ["0"], phonePlaceholder: "+36 XXXXXXXXX" },
  IS: { label: "Iceland", currencyCode: "ISK", currencySymbol: "kr", currencyDecimals: 2, dialCode: "354", localPrefixes: ["0"], phonePlaceholder: "+354 XXXXXXXXX" },
  IN: { label: "India", currencyCode: "INR", currencySymbol: "₹", currencyDecimals: 2, dialCode: "91", localPrefixes: ["0"], phonePlaceholder: "+91 XXXXXXXXX" },
  ID: { label: "Indonesia", currencyCode: "IDR", currencySymbol: "Rp", currencyDecimals: 2, dialCode: "62", localPrefixes: ["0"], phonePlaceholder: "+62 XXXXXXXXX" },
  IR: { label: "Iran", currencyCode: "IRR", currencySymbol: "﷼", currencyDecimals: 2, dialCode: "98", localPrefixes: ["0"], phonePlaceholder: "+98 XXXXXXXXX" },
  IQ: { label: "Iraq", currencyCode: "IQD", currencySymbol: "ع.د", currencyDecimals: 3, dialCode: "964", localPrefixes: ["0"], phonePlaceholder: "+964 XXXXXXXXX" },
  IE: { label: "Ireland", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "353", localPrefixes: ["0"], phonePlaceholder: "+353 XXXXXXXXX" },
  IL: { label: "Israel", currencyCode: "ILS", currencySymbol: "₪", currencyDecimals: 2, dialCode: "972", localPrefixes: ["0"], phonePlaceholder: "+972 XXXXXXXXX" },
  IT: { label: "Italy", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "39", localPrefixes: ["0"], phonePlaceholder: "+39 XXXXXXXXX" },
  CI: { label: "Ivory Coast", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "225", localPrefixes: ["0"], phonePlaceholder: "+225 XXXXXXXXX" },
  JM: { label: "Jamaica", currencyCode: "JMD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1876", localPrefixes: ["0"], phonePlaceholder: "+1876 XXXXXXXXX" },
  JP: { label: "Japan", currencyCode: "JPY", currencySymbol: "¥", currencyDecimals: 0, dialCode: "81", localPrefixes: ["0"], phonePlaceholder: "+81 XXXXXXXXX" },
  JO: { label: "Jordan", currencyCode: "JOD", currencySymbol: "د.ا", currencyDecimals: 3, dialCode: "962", localPrefixes: ["0"], phonePlaceholder: "+962 XXXXXXXXX" },
  KZ: { label: "Kazakhstan", currencyCode: "KZT", currencySymbol: "₸", currencyDecimals: 2, dialCode: "7", localPrefixes: ["0"], phonePlaceholder: "+7 XXXXXXXXX" },
  KE: KENYA,
  KI: { label: "Kiribati", currencyCode: "AUD", currencySymbol: "$", currencyDecimals: 2, dialCode: "686", localPrefixes: ["0"], phonePlaceholder: "+686 XXXXXXXXX" },
  KW: { label: "Kuwait", currencyCode: "KWD", currencySymbol: "د.ك", currencyDecimals: 3, dialCode: "965", localPrefixes: ["0"], phonePlaceholder: "+965 XXXXXXXXX" },
  KG: { label: "Kyrgyzstan", currencyCode: "KGS", currencySymbol: "с", currencyDecimals: 2, dialCode: "996", localPrefixes: ["0"], phonePlaceholder: "+996 XXXXXXXXX" },
  LA: { label: "Laos", currencyCode: "LAK", currencySymbol: "₭", currencyDecimals: 2, dialCode: "856", localPrefixes: ["0"], phonePlaceholder: "+856 XXXXXXXXX" },
  LV: { label: "Latvia", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "371", localPrefixes: ["0"], phonePlaceholder: "+371 XXXXXXXXX" },
  LB: { label: "Lebanon", currencyCode: "LBP", currencySymbol: "ل.ل", currencyDecimals: 2, dialCode: "961", localPrefixes: ["0"], phonePlaceholder: "+961 XXXXXXXXX" },
  LS: { label: "Lesotho", currencyCode: "LSL", currencySymbol: "L", currencyDecimals: 2, dialCode: "266", localPrefixes: ["0"], phonePlaceholder: "+266 XXXXXXXXX" },
  LR: { label: "Liberia", currencyCode: "LRD", currencySymbol: "$", currencyDecimals: 2, dialCode: "231", localPrefixes: ["0"], phonePlaceholder: "+231 XXXXXXXXX" },
  LY: { label: "Libya", currencyCode: "LYD", currencySymbol: "ل.د", currencyDecimals: 3, dialCode: "218", localPrefixes: ["0"], phonePlaceholder: "+218 XXXXXXXXX" },
  LI: { label: "Liechtenstein", currencyCode: "CHF", currencySymbol: "Fr", currencyDecimals: 2, dialCode: "423", localPrefixes: ["0"], phonePlaceholder: "+423 XXXXXXXXX" },
  LT: { label: "Lithuania", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "370", localPrefixes: ["0"], phonePlaceholder: "+370 XXXXXXXXX" },
  LU: { label: "Luxembourg", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "352", localPrefixes: ["0"], phonePlaceholder: "+352 XXXXXXXXX" },
  MG: { label: "Madagascar", currencyCode: "MGA", currencySymbol: "Ar", currencyDecimals: 0, dialCode: "261", localPrefixes: ["0"], phonePlaceholder: "+261 XXXXXXXXX" },
  MW: { label: "Malawi", currencyCode: "MWK", currencySymbol: "MK", currencyDecimals: 2, dialCode: "265", localPrefixes: ["0"], phonePlaceholder: "+265 XXXXXXXXX" },
  MY: { label: "Malaysia", currencyCode: "MYR", currencySymbol: "RM", currencyDecimals: 2, dialCode: "60", localPrefixes: ["0"], phonePlaceholder: "+60 XXXXXXXXX" },
  MV: { label: "Maldives", currencyCode: "MVR", currencySymbol: ".ރ", currencyDecimals: 2, dialCode: "960", localPrefixes: ["0"], phonePlaceholder: "+960 XXXXXXXXX" },
  ML: { label: "Mali", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "223", localPrefixes: ["0"], phonePlaceholder: "+223 XXXXXXXXX" },
  MT: { label: "Malta", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "356", localPrefixes: ["0"], phonePlaceholder: "+356 XXXXXXXXX" },
  MH: { label: "Marshall Islands", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "692", localPrefixes: ["0"], phonePlaceholder: "+692 XXXXXXXXX" },
  MR: { label: "Mauritania", currencyCode: "MRU", currencySymbol: "UM", currencyDecimals: 2, dialCode: "222", localPrefixes: ["0"], phonePlaceholder: "+222 XXXXXXXXX" },
  MU: { label: "Mauritius", currencyCode: "MUR", currencySymbol: "₨", currencyDecimals: 2, dialCode: "230", localPrefixes: ["0"], phonePlaceholder: "+230 XXXXXXXXX" },
  MX: { label: "Mexico", currencyCode: "MXN", currencySymbol: "$", currencyDecimals: 2, dialCode: "52", localPrefixes: ["0"], phonePlaceholder: "+52 XXXXXXXXX" },
  FM: { label: "Micronesia", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "691", localPrefixes: ["0"], phonePlaceholder: "+691 XXXXXXXXX" },
  MD: { label: "Moldova", currencyCode: "MDL", currencySymbol: "L", currencyDecimals: 2, dialCode: "373", localPrefixes: ["0"], phonePlaceholder: "+373 XXXXXXXXX" },
  MC: { label: "Monaco", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "377", localPrefixes: ["0"], phonePlaceholder: "+377 XXXXXXXXX" },
  MN: { label: "Mongolia", currencyCode: "MNT", currencySymbol: "₮", currencyDecimals: 2, dialCode: "976", localPrefixes: ["0"], phonePlaceholder: "+976 XXXXXXXXX" },
  ME: { label: "Montenegro", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "382", localPrefixes: ["0"], phonePlaceholder: "+382 XXXXXXXXX" },
  MA: { label: "Morocco", currencyCode: "MAD", currencySymbol: "د.م.", currencyDecimals: 2, dialCode: "212", localPrefixes: ["0"], phonePlaceholder: "+212 XXXXXXXXX" },
  MZ: { label: "Mozambique", currencyCode: "MZN", currencySymbol: "MT", currencyDecimals: 2, dialCode: "258", localPrefixes: ["0"], phonePlaceholder: "+258 XXXXXXXXX" },
  MM: { label: "Myanmar", currencyCode: "MMK", currencySymbol: "Ks", currencyDecimals: 2, dialCode: "95", localPrefixes: ["0"], phonePlaceholder: "+95 XXXXXXXXX" },
  NA: { label: "Namibia", currencyCode: "NAD", currencySymbol: "$", currencyDecimals: 2, dialCode: "264", localPrefixes: ["0"], phonePlaceholder: "+264 XXXXXXXXX" },
  NR: { label: "Nauru", currencyCode: "AUD", currencySymbol: "$", currencyDecimals: 2, dialCode: "674", localPrefixes: ["0"], phonePlaceholder: "+674 XXXXXXXXX" },
  NP: { label: "Nepal", currencyCode: "NPR", currencySymbol: "₨", currencyDecimals: 2, dialCode: "977", localPrefixes: ["0"], phonePlaceholder: "+977 XXXXXXXXX" },
  NL: { label: "Netherlands", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "31", localPrefixes: ["0"], phonePlaceholder: "+31 XXXXXXXXX" },
  NZ: { label: "New Zealand", currencyCode: "NZD", currencySymbol: "$", currencyDecimals: 2, dialCode: "64", localPrefixes: ["0"], phonePlaceholder: "+64 XXXXXXXXX" },
  NI: { label: "Nicaragua", currencyCode: "NIO", currencySymbol: "C$", currencyDecimals: 2, dialCode: "505", localPrefixes: ["0"], phonePlaceholder: "+505 XXXXXXXXX" },
  NE: { label: "Niger", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "227", localPrefixes: ["0"], phonePlaceholder: "+227 XXXXXXXXX" },
  NG: { label: "Nigeria", currencyCode: "NGN", currencySymbol: "₦", currencyDecimals: 2, dialCode: "234", localPrefixes: ["0"], phonePlaceholder: "+234 XXXXXXXXX" },
  KP: { label: "North Korea", currencyCode: "KPW", currencySymbol: "₩", currencyDecimals: 2, dialCode: "850", localPrefixes: ["0"], phonePlaceholder: "+850 XXXXXXXXX" },
  MK: { label: "North Macedonia", currencyCode: "MKD", currencySymbol: "den", currencyDecimals: 2, dialCode: "389", localPrefixes: ["0"], phonePlaceholder: "+389 XXXXXXXXX" },
  NO: { label: "Norway", currencyCode: "NOK", currencySymbol: "kr", currencyDecimals: 2, dialCode: "47", localPrefixes: ["0"], phonePlaceholder: "+47 XXXXXXXXX" },
  OM: { label: "Oman", currencyCode: "OMR", currencySymbol: "ر.ع.", currencyDecimals: 3, dialCode: "968", localPrefixes: ["0"], phonePlaceholder: "+968 XXXXXXXXX" },
  PK: { label: "Pakistan", currencyCode: "PKR", currencySymbol: "₨", currencyDecimals: 2, dialCode: "92", localPrefixes: ["0"], phonePlaceholder: "+92 XXXXXXXXX" },
  PW: { label: "Palau", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "680", localPrefixes: ["0"], phonePlaceholder: "+680 XXXXXXXXX" },
  PA: { label: "Panama", currencyCode: "PAB", currencySymbol: "B/.", currencyDecimals: 2, dialCode: "507", localPrefixes: ["0"], phonePlaceholder: "+507 XXXXXXXXX" },
  PG: { label: "Papua New Guinea", currencyCode: "PGK", currencySymbol: "K", currencyDecimals: 2, dialCode: "675", localPrefixes: ["0"], phonePlaceholder: "+675 XXXXXXXXX" },
  PY: { label: "Paraguay", currencyCode: "PYG", currencySymbol: "₲", currencyDecimals: 0, dialCode: "595", localPrefixes: ["0"], phonePlaceholder: "+595 XXXXXXXXX" },
  PE: { label: "Peru", currencyCode: "PEN", currencySymbol: "S/.", currencyDecimals: 2, dialCode: "51", localPrefixes: ["0"], phonePlaceholder: "+51 XXXXXXXXX" },
  PH: { label: "Philippines", currencyCode: "PHP", currencySymbol: "₱", currencyDecimals: 2, dialCode: "63", localPrefixes: ["0"], phonePlaceholder: "+63 XXXXXXXXX" },
  PL: { label: "Poland", currencyCode: "PLN", currencySymbol: "zł", currencyDecimals: 2, dialCode: "48", localPrefixes: ["0"], phonePlaceholder: "+48 XXXXXXXXX" },
  PT: { label: "Portugal", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "351", localPrefixes: ["0"], phonePlaceholder: "+351 XXXXXXXXX" },
  QA: { label: "Qatar", currencyCode: "QAR", currencySymbol: "ر.ق", currencyDecimals: 2, dialCode: "974", localPrefixes: ["0"], phonePlaceholder: "+974 XXXXXXXXX" },
  RO: { label: "Romania", currencyCode: "RON", currencySymbol: "lei", currencyDecimals: 2, dialCode: "40", localPrefixes: ["0"], phonePlaceholder: "+40 XXXXXXXXX" },
  RU: { label: "Russia", currencyCode: "RUB", currencySymbol: "₽", currencyDecimals: 2, dialCode: "7", localPrefixes: ["0"], phonePlaceholder: "+7 XXXXXXXXX" },
  RW: { label: "Rwanda", currencyCode: "RWF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "250", localPrefixes: ["0"], phonePlaceholder: "+250 XXXXXXXXX" },
  KN: { label: "Saint Kitts and Nevis", currencyCode: "XCD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1869", localPrefixes: ["0"], phonePlaceholder: "+1869 XXXXXXXXX" },
  LC: { label: "Saint Lucia", currencyCode: "XCD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1758", localPrefixes: ["0"], phonePlaceholder: "+1758 XXXXXXXXX" },
  VC: { label: "Saint Vincent and the Grenadines", currencyCode: "XCD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1784", localPrefixes: ["0"], phonePlaceholder: "+1784 XXXXXXXXX" },
  WS: { label: "Samoa", currencyCode: "WST", currencySymbol: "T", currencyDecimals: 2, dialCode: "685", localPrefixes: ["0"], phonePlaceholder: "+685 XXXXXXXXX" },
  SM: { label: "San Marino", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "378", localPrefixes: ["0"], phonePlaceholder: "+378 XXXXXXXXX" },
  ST: { label: "São Tomé and Príncipe", currencyCode: "STN", currencySymbol: "Db", currencyDecimals: 2, dialCode: "239", localPrefixes: ["0"], phonePlaceholder: "+239 XXXXXXXXX" },
  SA: { label: "Saudi Arabia", currencyCode: "SAR", currencySymbol: "ر.س", currencyDecimals: 2, dialCode: "966", localPrefixes: ["0"], phonePlaceholder: "+966 XXXXXXXXX" },
  SN: { label: "Senegal", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "221", localPrefixes: ["0"], phonePlaceholder: "+221 XXXXXXXXX" },
  RS: { label: "Serbia", currencyCode: "RSD", currencySymbol: "дин.", currencyDecimals: 2, dialCode: "381", localPrefixes: ["0"], phonePlaceholder: "+381 XXXXXXXXX" },
  SC: { label: "Seychelles", currencyCode: "SCR", currencySymbol: "₨", currencyDecimals: 2, dialCode: "248", localPrefixes: ["0"], phonePlaceholder: "+248 XXXXXXXXX" },
  SL: { label: "Sierra Leone", currencyCode: "SLE", currencySymbol: "Le", currencyDecimals: 2, dialCode: "232", localPrefixes: ["0"], phonePlaceholder: "+232 XXXXXXXXX" },
  SG: { label: "Singapore", currencyCode: "SGD", currencySymbol: "$", currencyDecimals: 2, dialCode: "65", localPrefixes: ["0"], phonePlaceholder: "+65 XXXXXXXXX" },
  SK: { label: "Slovakia", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "421", localPrefixes: ["0"], phonePlaceholder: "+421 XXXXXXXXX" },
  SI: { label: "Slovenia", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "386", localPrefixes: ["0"], phonePlaceholder: "+386 XXXXXXXXX" },
  SB: { label: "Solomon Islands", currencyCode: "SBD", currencySymbol: "$", currencyDecimals: 2, dialCode: "677", localPrefixes: ["0"], phonePlaceholder: "+677 XXXXXXXXX" },
  SO: { label: "Somalia", currencyCode: "SOS", currencySymbol: "Sh", currencyDecimals: 2, dialCode: "252", localPrefixes: ["0"], phonePlaceholder: "+252 XXXXXXXXX" },
  ZA: { label: "South Africa", currencyCode: "ZAR", currencySymbol: "R", currencyDecimals: 2, dialCode: "27", localPrefixes: ["0"], phonePlaceholder: "+27 XXXXXXXXX" },
  KR: { label: "South Korea", currencyCode: "KRW", currencySymbol: "₩", currencyDecimals: 0, dialCode: "82", localPrefixes: ["0"], phonePlaceholder: "+82 XXXXXXXXX" },
  SS: { label: "South Sudan", currencyCode: "SSP", currencySymbol: "£", currencyDecimals: 2, dialCode: "211", localPrefixes: ["0"], phonePlaceholder: "+211 XXXXXXXXX" },
  ES: { label: "Spain", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "34", localPrefixes: ["0"], phonePlaceholder: "+34 XXXXXXXXX" },
  LK: { label: "Sri Lanka", currencyCode: "LKR", currencySymbol: "Rs රු", currencyDecimals: 2, dialCode: "94", localPrefixes: ["0"], phonePlaceholder: "+94 XXXXXXXXX" },
  SD: { label: "Sudan", currencyCode: "SDG", currencySymbol: "PT", currencyDecimals: 2, dialCode: "249", localPrefixes: ["0"], phonePlaceholder: "+249 XXXXXXXXX" },
  SR: { label: "Suriname", currencyCode: "SRD", currencySymbol: "$", currencyDecimals: 2, dialCode: "597", localPrefixes: ["0"], phonePlaceholder: "+597 XXXXXXXXX" },
  SE: { label: "Sweden", currencyCode: "SEK", currencySymbol: "kr", currencyDecimals: 2, dialCode: "46", localPrefixes: ["0"], phonePlaceholder: "+46 XXXXXXXXX" },
  CH: { label: "Switzerland", currencyCode: "CHF", currencySymbol: "Fr.", currencyDecimals: 2, dialCode: "41", localPrefixes: ["0"], phonePlaceholder: "+41 XXXXXXXXX" },
  SY: { label: "Syria", currencyCode: "SYP", currencySymbol: "£", currencyDecimals: 2, dialCode: "963", localPrefixes: ["0"], phonePlaceholder: "+963 XXXXXXXXX" },
  TJ: { label: "Tajikistan", currencyCode: "TJS", currencySymbol: "ЅМ", currencyDecimals: 2, dialCode: "992", localPrefixes: ["0"], phonePlaceholder: "+992 XXXXXXXXX" },
  TZ: { label: "Tanzania", currencyCode: "TZS", currencySymbol: "Sh", currencyDecimals: 2, dialCode: "255", localPrefixes: ["0"], phonePlaceholder: "+255 XXXXXXXXX" },
  TH: { label: "Thailand", currencyCode: "THB", currencySymbol: "฿", currencyDecimals: 2, dialCode: "66", localPrefixes: ["0"], phonePlaceholder: "+66 XXXXXXXXX" },
  TL: { label: "Timor-Leste", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "670", localPrefixes: ["0"], phonePlaceholder: "+670 XXXXXXXXX" },
  TG: { label: "Togo", currencyCode: "XOF", currencySymbol: "Fr", currencyDecimals: 0, dialCode: "228", localPrefixes: ["0"], phonePlaceholder: "+228 XXXXXXXXX" },
  TO: { label: "Tonga", currencyCode: "TOP", currencySymbol: "T$", currencyDecimals: 2, dialCode: "676", localPrefixes: ["0"], phonePlaceholder: "+676 XXXXXXXXX" },
  TT: { label: "Trinidad and Tobago", currencyCode: "TTD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1868", localPrefixes: ["0"], phonePlaceholder: "+1868 XXXXXXXXX" },
  TN: { label: "Tunisia", currencyCode: "TND", currencySymbol: "د.ت", currencyDecimals: 3, dialCode: "216", localPrefixes: ["0"], phonePlaceholder: "+216 XXXXXXXXX" },
  TR: { label: "Türkiye", currencyCode: "TRY", currencySymbol: "₺", currencyDecimals: 2, dialCode: "90", localPrefixes: ["0"], phonePlaceholder: "+90 XXXXXXXXX" },
  TM: { label: "Turkmenistan", currencyCode: "TMT", currencySymbol: "m", currencyDecimals: 2, dialCode: "993", localPrefixes: ["0"], phonePlaceholder: "+993 XXXXXXXXX" },
  TV: { label: "Tuvalu", currencyCode: "AUD", currencySymbol: "$", currencyDecimals: 2, dialCode: "688", localPrefixes: ["0"], phonePlaceholder: "+688 XXXXXXXXX" },
  UG: { label: "Uganda", currencyCode: "UGX", currencySymbol: "Sh", currencyDecimals: 0, dialCode: "256", localPrefixes: ["0"], phonePlaceholder: "+256 XXXXXXXXX" },
  UA: { label: "Ukraine", currencyCode: "UAH", currencySymbol: "₴", currencyDecimals: 2, dialCode: "380", localPrefixes: ["0"], phonePlaceholder: "+380 XXXXXXXXX" },
  AE: { label: "United Arab Emirates", currencyCode: "AED", currencySymbol: "د.إ", currencyDecimals: 2, dialCode: "971", localPrefixes: ["0"], phonePlaceholder: "+971 XXXXXXXXX" },
  GB: { label: "United Kingdom", currencyCode: "GBP", currencySymbol: "£", currencyDecimals: 2, dialCode: "44", localPrefixes: ["0"], phonePlaceholder: "+44 XXXXXXXXX" },
  US: { label: "United States", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "1", localPrefixes: ["0"], phonePlaceholder: "+1 XXXXXXXXX" },
  UY: { label: "Uruguay", currencyCode: "UYU", currencySymbol: "$", currencyDecimals: 2, dialCode: "598", localPrefixes: ["0"], phonePlaceholder: "+598 XXXXXXXXX" },
  UZ: { label: "Uzbekistan", currencyCode: "UZS", currencySymbol: "so'm", currencyDecimals: 2, dialCode: "998", localPrefixes: ["0"], phonePlaceholder: "+998 XXXXXXXXX" },
  VU: { label: "Vanuatu", currencyCode: "VUV", currencySymbol: "Vt", currencyDecimals: 0, dialCode: "678", localPrefixes: ["0"], phonePlaceholder: "+678 XXXXXXXXX" },
  // Vatican City's own ITU-assigned code is +379 (rarely used in practice — most
  // numbers route through Italy's +39 06698), but +379 is the correct standalone code.
  VA: { label: "Vatican City", currencyCode: "EUR", currencySymbol: "€", currencyDecimals: 2, dialCode: "379", localPrefixes: ["0"], phonePlaceholder: "+379 XXXXXXXXX" },
  VE: { label: "Venezuela", currencyCode: "VES", currencySymbol: "Bs.S.", currencyDecimals: 2, dialCode: "58", localPrefixes: ["0"], phonePlaceholder: "+58 XXXXXXXXX" },
  VN: { label: "Vietnam", currencyCode: "VND", currencySymbol: "₫", currencyDecimals: 0, dialCode: "84", localPrefixes: ["0"], phonePlaceholder: "+84 XXXXXXXXX" },
  YE: { label: "Yemen", currencyCode: "YER", currencySymbol: "﷼", currencyDecimals: 2, dialCode: "967", localPrefixes: ["0"], phonePlaceholder: "+967 XXXXXXXXX" },
  ZM: { label: "Zambia", currencyCode: "ZMW", currencySymbol: "ZK", currencyDecimals: 2, dialCode: "260", localPrefixes: ["0"], phonePlaceholder: "+260 XXXXXXXXX" },
  // Zimbabwe operates a real multi-currency economy (BWP/CNY/EUR/GBP/INR/JPY/USD/ZAR/ZWB
  // all circulate) — USD is the most commonly used and stable of these in practice.
  ZW: { label: "Zimbabwe", currencyCode: "USD", currencySymbol: "$", currencyDecimals: 2, dialCode: "263", localPrefixes: ["0"], phonePlaceholder: "+263 XXXXXXXXX" },
};

/** Falls back to Kenya for an unregistered country — matches the product's
 *  first real customers (all Kenyan) rather than throwing, so onboarding a
 *  tenant with a not-yet-modeled country doesn't hard-fail. */
export function countryProfile(country: string): CountryProfile {
  return COUNTRIES[country] ?? KENYA;
}
