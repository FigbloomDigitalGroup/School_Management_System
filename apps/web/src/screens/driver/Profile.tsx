import { type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@figbloom/shared";
import { MyAccountFields } from "../../components/MyAccountFields";
import { PasswordForm } from "../../components/PasswordGate";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

/** The driver's pages share the trip screen's full-width green header, not ConsoleShell. */
function DriverFrame({ title, back, children }: { title: string; back?: boolean; children: ReactNode }) {
  const { tenant } = useTenantSession();
  return (
    <div className="min-h-[100dvh] bg-page">
      <header className="flex items-center gap-3 bg-forest px-5 py-3.5 text-white">
        {back && (
          <Link to=".." relative="path" className="hit -ml-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/30 text-[18px] text-white" aria-label="Back to trip">←</Link>
        )}
        <div className="min-w-0">
          <div className="truncate text-lead font-semibold tracking-tight">{title}</div>
          <div className="font-mono text-micro tracking-[0.12em] text-white/70">{tenant.name.toUpperCase()} · DRIVER</div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[480px] gap-4 px-4 py-5">{children}</div>
    </div>
  );
}

/**
 * What a driver can change themselves: their photo (parents see it, so the
 * admin is told when it changes), their phone and their password. Name,
 * title, bus and route belong to the school.
 */
export function DriverProfile() {
  const toast = useToast();
  const navigate = useNavigate();
  const { profile } = useTenantSession();

  return (
    <DriverFrame title="My profile" back>
      <p className="text-small leading-relaxed text-ink-muted">
        Parents see your photo and name on their bus page so they know who's collecting their child. Use a clear photo of your face.
      </p>
      <MyAccountFields nameLocked />
      <section className="rounded-lg border border-line bg-white p-4">
        <h2 className="mb-3 text-[14px] font-semibold">Change password</h2>
        <PasswordForm profileId={profile.id} submitLabel="Change password" onDone={() => toast("Password changed")} />
      </section>
      <button
        onClick={() => void supabase().auth.signOut({ scope: "local" }).then(() => navigate("/signin", { replace: true }))}
        className="hit justify-self-start rounded-lg border border-line px-4 py-2 text-small font-semibold text-ink-muted"
      >
        Sign out
      </button>
    </DriverFrame>
  );
}
