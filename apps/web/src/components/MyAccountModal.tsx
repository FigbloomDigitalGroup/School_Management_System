import { Link } from "react-router-dom";
import { MyAccountFields } from "./MyAccountFields";
import { PasswordForm } from "./PasswordGate";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";
import { useTenantSession } from "../lib/sessionContext";

/**
 * "My account" as a pop-up card over whatever the person was looking at,
 * instead of a page of its own. Used by the driver's trip screen and by the
 * sidebar menu of every ConsoleShell role that has an account (admin, teacher,
 * parent, staff). Must be rendered inside the tenant routes (it reads the session).
 */
export function MyAccountModal({ onClose, nameLocked = false, withPassword = false, moreHref, moreLabel = "More account options", onSignOut, blurb }: {
  onClose: () => void;
  /** Drivers: the school set the name parents know them by. */
  nameLocked?: boolean;
  /** Show the change-password form here. The console shells already have a Change password menu item, so they leave it off. */
  withPassword?: boolean;
  /** A page with the rest of this role's account (teacher: calls, parent: children), linked from the footer. */
  moreHref?: string;
  moreLabel?: string;
  onSignOut?: () => void;
  blurb?: string;
}) {
  const toast = useToast();
  const { profile } = useTenantSession();

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="ACCOUNT"
      title="My profile"
      blurb={blurb}
      width={480}
      actions={
        <>
          {moreHref && (
            <Link to={moreHref} onClick={onClose} className="hit rounded-lg border border-line px-4 py-2 text-small font-semibold text-ink-muted">
              {moreLabel}
            </Link>
          )}
          {onSignOut && <Button onClick={onSignOut}>Sign out</Button>}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="grid gap-5">
        <MyAccountFields nameLocked={nameLocked} bare />
        {withPassword && (
          <section className="border-t border-line-soft pt-4">
            <h3 className="mb-3 text-[14px] font-semibold">Change password</h3>
            <PasswordForm profileId={profile.id} submitLabel="Change password" onDone={() => toast("Password changed")} />
          </section>
        )}
      </div>
    </Modal>
  );
}
