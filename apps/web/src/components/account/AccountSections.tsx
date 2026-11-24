import { accountCapabilities } from "@figbloom/shared";
import { useTenantSession } from "../../lib/sessionContext";
import { MyAccountFields } from "../MyAccountFields";
import { ChangePasswordCard } from "./ChangePasswordCard";
import { NotificationChoices } from "./NotificationChoices";
import { TwoStepCard } from "./TwoStepCard";

/** The line under the page title: on the API the page also holds the password and two-step verification. */
export function accountBlurb(): string {
  return accountCapabilities().security
    ? "Your own details, password and how the school reaches you: nobody else's."
    : "Your own name, phone, and photo — nobody else's.";
}

/**
 * The body of a "My account" page, the same for every role that has one (admin, teacher; staff and parent next). On Supabase it is
 * the person's own details, as before. On the new API the details are read-only (the API cannot change them) and the page also
 * holds the password, two-step verification and how the school reaches the person, each shown only where the backend has it
 * (accountCapabilities).
 */
export function AccountSections({ nameLocked }: { nameLocked?: boolean } = {}) {
  const { profile } = useTenantSession();
  const caps = accountCapabilities();
  return (
    <div className="grid gap-4">
      <MyAccountFields nameLocked={nameLocked} />
      {caps.security && <ChangePasswordCard />}
      {caps.security && <TwoStepCard />}
      {caps.notificationChoices && <NotificationChoices role={profile.role} profileId={profile.id} />}
    </div>
  );
}
