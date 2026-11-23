import { useState, type ReactNode } from "react";
import { adminAccessFor, apiBaseUrl, apiClient, userMessage, type Role } from "@figbloom/shared";
import { PageHead } from "../components/ConsoleShell";
import { Button } from "../components/ui/Button";
import type { Session } from "../lib/useSession";

export type SchoolSession = Session & { profile: NonNullable<Session["profile"]>; tenant: NonNullable<Session["tenant"]> };

const ROLE_NAMES: Record<Role, string> = {
  school_admin: "School administrator", teacher: "Teacher", parent: "Parent", student: "Learner", driver: "Driver",
  staff: "Staff", org_admin: "Organization administrator", super_admin: "Platform administrator",
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
      <dt className="w-40 shrink-0 text-small font-semibold text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-words text-body">{children}</dd>
    </div>
  );
}

/**
 * Who is signed in, which school, and the connection itself: what a person sees first on the new API, and all that a person with
 * no admin console (a parent, a teacher with no admin areas) sees at all so far. In the admin shell it is the Dashboard page.
 */
export function ApiOverview({ session, onSignOut, inShell }: { session: SchoolSession; onSignOut: () => Promise<void>; inShell: boolean }) {
  const { profile, tenant, adminAreas } = session;
  const expires = apiClient().session()?.expiresAt;
  const [check, setCheck] = useState<string>("");
  const [checking, setChecking] = useState(false);

  async function checkConnection() {
    setChecking(true);
    setCheck("");
    const started = performance.now();
    try {
      await apiClient().get("/readyz", { auth: false, tenantId: null });
      setCheck(`The API answered ready in ${Math.round(performance.now() - started)} ms.`);
    } catch (err) {
      setCheck(userMessage(err));
    } finally {
      setChecking(false);
    }
  }

  const body = (
    <>
      <section className="rounded-xl border border-line bg-white px-5 py-3">
        <h2 className="py-2 text-body font-semibold">You</h2>
        <dl className="divide-y divide-line-soft">
          <Fact label="Name">{profile.full_name}</Fact>
          <Fact label="Email">{profile.email ?? "none on file"}</Fact>
          <Fact label="Role">{ROLE_NAMES[profile.role]}</Fact>
          {profile.login_id && <Fact label="Login ID">{profile.login_id}</Fact>}
          {(profile.role === "teacher" || profile.role === "staff") && (
            <Fact label="Admin areas">{adminAreas.length ? adminAreas.join(", ") : "none"}</Fact>
          )}
          {profile.role === "school_admin" && <Fact label="Admin areas">{adminAccessFor(profile.role, adminAreas) === "all" ? "all of them" : "none"}</Fact>}
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white px-5 py-3">
        <h2 className="py-2 text-body font-semibold">School</h2>
        <dl className="divide-y divide-line-soft">
          <Fact label="Address">/s/{tenant.slug}</Fact>
          <Fact label="Status">{tenant.status}</Fact>
          {tenant.timezone && <Fact label="Time zone">{tenant.timezone}</Fact>}
          {tenant.county && <Fact label="County">{tenant.county}</Fact>}
        </dl>
      </section>

      <section className="mt-4 rounded-xl border border-line bg-white px-5 py-3">
        <h2 className="py-2 text-body font-semibold">Connection</h2>
        <dl className="divide-y divide-line-soft">
          <Fact label="API">{apiBaseUrl()}</Fact>
          {expires && <Fact label="Sign-in lasts until">{new Date(expires).toLocaleString()}, or sooner if you are idle</Fact>}
        </dl>
        <div className="flex flex-wrap items-center gap-3 py-3">
          <Button onClick={() => void checkConnection()} disabled={checking}>{checking ? "Checking…" : "Check the connection"}</Button>
          {check && <span role="status" className="text-[12.5px] text-ink-muted">{check}</span>}
        </div>
      </section>

      <p className="mt-6 rounded-xl border border-line bg-page px-5 py-4 text-[13px] leading-relaxed text-ink-muted">
        This build is connected to the new system for sign-in, your school's details, and setting the school up (the term, classes and
        subjects). The other screens are being moved over one area at a time, and are not in this build yet.
      </p>
    </>
  );

  if (inShell) {
    return (
      <>
        <PageHead eyebrow="Connected to the new system" title={tenant.name} blurb={`Signed in as ${profile.full_name}, ${ROLE_NAMES[profile.role]}.`} />
        <div className="max-w-[720px] px-7 py-6" data-testid="api-home">{body}</div>
      </>
    );
  }
  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12" data-testid="api-home">
      <p className="text-small font-semibold uppercase tracking-wide text-forest">Connected to the new system</p>
      <h1 className="mt-1 text-[26px] font-semibold tracking-tight">{tenant.name}</h1>
      <p className="mt-1 mb-6 text-body text-ink-muted">Signed in as {profile.full_name}, {ROLE_NAMES[profile.role]}.</p>
      {body}
      <Button className="mt-6" onClick={() => void onSignOut()}>Sign out</Button>
    </main>
  );
}
