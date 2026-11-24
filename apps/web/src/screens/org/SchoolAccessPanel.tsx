import { useState } from "react";
import {
  SCHOOL_ACCESS_CODES, apiFetchMySchoolAccess, apiGrantSchoolAccess, apiRemoveSchoolAccess, describeDelegatedCode, fetchOrgAdminsForOwnOrg,
  userMessage,
} from "@figbloom/shared";
import { Button } from "../../components/ui/Button";
import { confirmDialog } from "../../components/ui/Confirm";
import { SelectField } from "../../components/ui/Field";
import { Skeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";

/**
 * Access inside one school for the organisation's admins, on the new API (S11; FIG-1609 delegations). An org admin holds
 * nothing in a school unless it was given to them, by the school's own admin or by another admin of the organisation.
 * Here they see what they hold, give a co-admin access, or take all of a co-admin's access away. The API asks for the
 * password again before either change (the session guard's prompt). What a co-admin holds now cannot be listed: that is
 * still an owner decision (docs/web-on-api/org-console.md).
 */
export function SchoolAccessPanel({ tenantId, organizationId, schoolName }: { tenantId: string; organizationId: string; schoolName: string }) {
  const toast = useToast();
  const [reloadKey, setReloadKey] = useState(0);
  const mine = useAsync(() => apiFetchMySchoolAccess(tenantId), [tenantId, reloadKey]);
  const admins = useAsync(() => fetchOrgAdminsForOwnOrg(organizationId), [organizationId]);
  const others = (admins.data ?? []).filter((a) => !a.is_you);

  const [giveTo, setGiveTo] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [takeFrom, setTakeFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string) => others.find((a) => a.id === id)?.full_name ?? "this admin";

  async function give() {
    if (!giveTo || codes.length === 0) { toast("Choose an admin and at least one kind of access.", "error"); return; }
    setBusy(true);
    try {
      const granted = await apiGrantSchoolAccess(tenantId, giveTo, codes);
      toast(`${nameOf(giveTo)} now has ${granted.length} kind${granted.length === 1 ? "" : "s"} of access at ${schoolName}.`);
      setCodes([]);
    } catch (err) {
      toast(`Could not give access: ${userMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function take() {
    if (!takeFrom) { toast("Choose an admin.", "error"); return; }
    const ok = await confirmDialog({
      title: `Take away ${nameOf(takeFrom)}'s access?`,
      body: `Everything ${nameOf(takeFrom)} was given at ${schoolName} stops working on their next request. They keep their place in the organization.`,
      confirmLabel: "Take away access",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const n = await apiRemoveSchoolAccess(tenantId, takeFrom);
      toast(n > 0 ? `Took away ${n} kind${n === 1 ? "" : "s"} of access from ${nameOf(takeFrom)}.` : `${nameOf(takeFrom)} had no access here.`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(`Could not take access away: ${userMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Access in this school" className="overflow-hidden rounded-lg border border-line bg-white">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">Access in this school</h2>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          An organization admin holds nothing inside a school until it is given to them.
        </p>
      </header>

      <div className="grid gap-5 px-4 py-4">
        <div>
          <h3 className="text-[12.5px] font-semibold">What you hold here</h3>
          {mine.loading ? <Skeleton className="mt-2 h-4 w-48" /> : mine.error ? (
            <p className="mt-1 text-[12.5px] text-warn-ink">Could not load: {userMessage(mine.error)}</p>
          ) : mine.data && mine.data.length > 0 ? (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {mine.data.map((c) => <li key={c} className="rounded-full bg-sunken px-2.5 py-0.5 text-[12px]">{describeDelegatedCode(c)}</li>)}
            </ul>
          ) : (
            <p className="mt-1 text-[12.5px] text-ink-muted">Nothing yet. The school's admin, or another admin of your organization, can give you access.</p>
          )}
        </div>

        {admins.error ? (
          <p className="text-[12.5px] text-warn-ink">Could not load the organization's admins: {userMessage(admins.error)}</p>
        ) : others.length === 0 ? (
          admins.loading ? <Skeleton className="h-4 w-64" /> : (
            <p className="text-[12.5px] text-ink-muted">You are this organization's only admin, so there is nobody here to give access to. (You cannot give access to yourself.)</p>
          )
        ) : (
          <>
            <div className="border-t border-line-soft pt-4">
              <h3 className="text-[12.5px] font-semibold">Give an admin access</h3>
              <div className="mt-2 max-w-[360px]">
                <SelectField id="access-give-to" label="Admin" value={giveTo} onChange={(e) => setGiveTo(e.target.value)}
                  options={[{ value: "", label: "Choose…" }, ...others.map((a) => ({ value: a.id, label: a.full_name }))]} />
              </div>
              <fieldset className="mt-3">
                <legend className="text-[12px] text-ink-muted">Access</legend>
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  {SCHOOL_ACCESS_CODES.map((c) => (
                    <label key={c} className="flex items-center gap-2 text-[12.5px]">
                      <input type="checkbox" checked={codes.includes(c)} style={{ accentColor: "#17402A" }}
                        onChange={(e) => setCodes((cur) => (e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)))} />
                      {describeDelegatedCode(c)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button className="mt-3" variant="accent" disabled={busy || !giveTo || codes.length === 0} onClick={() => void give()}>
                {busy ? "Saving…" : "Give access"}
              </Button>
            </div>

            <div className="border-t border-line-soft pt-4">
              <h3 className="text-[12.5px] font-semibold">Take away an admin's access</h3>
              <div className="mt-2 flex max-w-[480px] items-end gap-3">
                <div className="flex-1">
                  <SelectField id="access-take-from" label="Admin" value={takeFrom} onChange={(e) => setTakeFrom(e.target.value)}
                    options={[{ value: "", label: "Choose…" }, ...others.map((a) => ({ value: a.id, label: a.full_name }))]} />
                </div>
                <Button disabled={busy || !takeFrom} onClick={() => void take()}>Take away all access</Button>
              </div>
            </div>

            <p className="text-[12px] leading-relaxed text-ink-faint">
              What another admin holds here cannot be listed on the new system yet. Giving or taking away access asks for your password again.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
