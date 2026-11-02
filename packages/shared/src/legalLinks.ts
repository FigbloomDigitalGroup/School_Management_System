/**
 * The two public pages the apps link to from Account, and the store listings
 * (Play Console, App Store Connect) point at too. They are static files in
 * apps/web/public, served from the web app's production origin: if that
 * domain changes, change it here, in index.html, robots.txt and sitemap.xml,
 * and in store-assets.
 */
export const SITE_ORIGIN = "https://schoolmanagement.figbloom.org";
export const PRIVACY_POLICY_URL = `${SITE_ORIGIN}/privacy.html`;
export const DELETE_ACCOUNT_URL = `${SITE_ORIGIN}/delete-account.html`;

/**
 * Figbloom's support address, as published in the privacy policy
 * (apps/web/public/privacy.html). Shown to people whose school is suspended
 * (suspended.ts); change it here if support moves.
 */
export const FIGBLOOM_SUPPORT_EMAIL = "support@figbloom.org";
