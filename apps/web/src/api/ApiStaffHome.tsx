import { useState } from "react";
import { Link } from "react-router-dom";
import { NAV, apiBaseUrl, apiClient, apiFetchMyStaffRecord, userMessage } from "@figbloom/shared";
import { PageHead } from "../components/ConsoleShell";
import { Button } from "../components/ui/Button";
import { Skeleton } from "../components/ui/Skeleton";
import { useAsync } from "../lib/useAsync";
import { Fact, type SchoolSession } from "./ApiOverview";

/**
 * The staff home on the new API (`/s/<slug>/staff`): who is signed in, the job title the school office keeps for them (their own
 * staff record, `GET /staff/me`: the session carries no title on the API), the pages this build opens for them, the school,
 * and the connection check. On Supabase the staff home is only a redirect (StaffHome) to the visitor log, the sick bay or Notices,
 * and on the API those are not all open yet, so this page stands in.
 *
 * `pages` are the staff pages in the menu (the same list ApiConsole hides the rest of the menu by).
 */
export function ApiStaffHome({ session, pages }: { session: SchoolSession; pages: readonly string[] }) {
  const { profile, tenant, adminAreas } = session;
  const { data: staff, loading, error } = useAsync(() => apiFetchMyStaffRecord(tenant.id), [tenant.id]);
  const expires = apiClient().session()?.expiresAt;
  const [check, setCheck] = useState("");
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

  const open = NAV.staff.filter((i) => pages.includes(i.to));
  // My items and Visitors are in the menu only for people holding the area (see staff-shell.pages.tsx): that is not "not yet".
  const notYet = NAV.staff.filter((i) => !pages.includes(i.to) && i.to !== "staff/items" && i.to !== "staff/visitors").map((i) => i.label);
  const itemsHidden = !pages.includes("staff/items");
  const visitorsHidden = !pages.includes("staff/visitors");
  const title = staff?.staff_title ?? null;

  return (
    <>
      <PageHead eyebrow="Staff" title={tenant.name} blurb={`Signed in as ${profile.full_name}${title ? `, ${title}` : ""}.`} />
      <div className="max-w-[720px] px-7 py-6" data-testid="api-staff-home">
        <section className="rounded-xl border border-line bg-white px-5 py-3">
          <h2 className="py-2 text-body font-semibold">You</h2>
          <dl className="divide-y divide-line-soft">
            <Fact label="Name">{profile.full_name}</Fact>
            <Fact label="Job title">{loading ? <Skeleton className="h-4 w-32" /> : (title ?? "None on file")}</Fact>
            <Fact label="Email">{profile.email ?? staff?.email ?? "none on file"}</Fact>
            {staff?.phone && <Fact label="Phone">{staff.phone}</Fact>}
            {profile.login_id && <Fact label="Login ID">{profile.login_id}</Fact>}
            <Fact label="Admin areas">{adminAreas.length ? adminAreas.join(", ") : "none"}</Fact>
          </dl>
          {error && <p role="alert" className="py-2 text-[12.5px] text-warn-ink">Could not read your staff record: {userMessage(error)}</p>}
          {!loading && !error && !staff && (
            <p className="py-2 text-[12.5px] text-ink-muted">
              Your sign-in is not linked to a record in the school's staff list, so there is no job title or phone to show. The school
              office can link it.
            </p>
          )}
        </section>

        <section className="mt-4 rounded-xl border border-line bg-white px-5 py-4">
          <h2 className="text-body font-semibold">Your pages</h2>
          <div className="mt-3 flex flex-wrap gap-2.5">
            {open.map((i) => (
              <Link
                key={i.to}
                to={`/s/${tenant.slug}/${i.to}`}
                className="hit rounded-lg border border-line bg-page px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-sunken"
              >
                {i.label}
              </Link>
            ))}
          </div>
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
          {notYet.length > 0 && <>Not in your menu on the new system: {notYet.join(", ")}. </>}
          {itemsHidden && <>My items shows for staff who hold the Inventory area. </>}
          {visitorsHidden && <>Visitors shows for staff who hold the Visitors area.</>}
        </p>
      </div>
    </>
  );
}
