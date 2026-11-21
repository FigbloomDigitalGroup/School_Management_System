/**
 * Provider boundary for account messages (invitations and password resets). NO email/SMS provider is wired in this
 * programme: the default notifier reports `not_configured`, and the API then returns the single-use token ONCE to the
 * AUTHORISED administrator who issued it so it can be delivered out of band. Self-service password-reset requests never
 * return a token, so until a provider is configured they cannot be completed (documented external dependency).
 * Tokens must never be logged: a real notifier must send them without writing them to any log.
 */
export type DeliveryResult = "sent" | "not_configured";

export interface AccountMessage {
  kind: "invitation" | "password_reset" | "guardian_invitation";
  email: string;
  token: string;
  tenantId?: string | null;
}

export interface AccountNotifier {
  send(message: AccountMessage): Promise<DeliveryResult>;
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
