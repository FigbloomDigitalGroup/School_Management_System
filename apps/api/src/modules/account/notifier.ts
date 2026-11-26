/**
 * Provider boundary for account messages (invitations and password resets). NO email/SMS provider is wired in this
 * programme: the default notifier reports `not_configured`, and the API then returns the single-use token ONCE to the
 * AUTHORISED administrator who issued it so it can be delivered out of band. Self-service password-reset requests never
 * return a token, so until a provider is configured they cannot be completed (documented external dependency).
 * Tokens must never be logged: a real notifier must send them without writing them to any log.
 */
export type DeliveryResult = "sent" | "not_configured";

export interface AccountMessage {
  /**
   * `org_signup_verify`: the confirmation link of an organisation sign-up (public; the token is never returned to the person who asked).
   * `org_signup_approved`: the first administrator's password-setup link. `org_signup_rejected`: a plain "not approved" notice (no token, no reason).
   */
  kind: "invitation" | "password_reset" | "guardian_invitation" | "org_signup_verify" | "org_signup_approved" | "org_signup_rejected";
  email: string;
  token: string;
  tenantId?: string | null;
}

export interface AccountNotifier {
  send(message: AccountMessage): Promise<DeliveryResult>;
  /**
   * True when this notifier really delivers e-mail. A public flow whose only proof is an e-mailed link (organisation sign-up)
   * is closed (503) while this is not true, rather than storing requests nobody could confirm. Absent means not configured.
   */
  readonly configured?: boolean;
}

const notConfigured: AccountNotifier = { send: async () => "not_configured" };
let current: AccountNotifier = notConfigured;

export function getAccountNotifier(): AccountNotifier {
  return current;
}

/** Composition-root / test hook. Pass null to restore the not-configured default. */
export function setAccountNotifier(n: AccountNotifier | null): void {
  current = n ?? notConfigured;
}
