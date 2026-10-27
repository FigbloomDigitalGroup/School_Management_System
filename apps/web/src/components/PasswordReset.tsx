import { useState } from "react";
import { fetchChildLogins, fetchOpenPasswordResetRequests, resetUserPassword, type PasswordResetResult, type Role } from "@figbloom/shared";
import { Button } from "./ui/Button";
import { useToast } from "./ui/Toast";
import { TempPasswordCard } from "./TempPasswordCard";
import { useAsync } from "../lib/useAsync";

/**
 * Setting someone a new temporary password when they've forgotten theirs.
 * Login-ID accounts (learners, parents, teachers, drivers) have no mailbox
 * for a reset link, so the school office (or a parent, for their own child)
 * does it from here: reset-user-password sets a random one-time password,
 * shown once, and the person picks their own at their next sign-in.
 */

const ROLE_NOUN: Partial<Record<Role, string>> = {
  student: "Learner", parent: "Parent", teacher: "Teacher", driver: "Driver", staff: "Staff member", school_admin: "Admin",
};

/** Runs a reset and holds its one-time result. */
function useReset(onDone?: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PasswordResetResult | null>(null);

  async function reset(profileId: string, name: string) {
    if (!window.confirm(`Set a new temporary password for ${name}? Their current password stops working straight away.`)) return;
    setBusy(true);
    try {
      setResult(await resetUserPassword(profileId));
      onDone?.();
    } catch (err) {
      toast(`Could not reset ${name}'s password: ${err instanceof Error ? err.message : "something went wrong"}`, "error");
    } finally {
      setBusy(false);
    }
  }
  return { busy, result, reset };
}

/**
 * A "Password" section for a person's manage screen: one button, then the
 * new temporary password inline (not a second modal on top of the first).
 */
export function ResetPasswordSection({ profileId, name, email, schoolName, onDone }: {
  profileId: string;
  name: string;
  /** For an account that signs in with an email rather than a login ID. */
  email?: string | null;
  schoolName?: string;
  onDone?: () => void;
}) {
  const { busy, result, reset } = useReset(onDone);
  return (
    <section className="mt-5 border-t border-line-soft pt-4">
      <h3 className="text-[12.5px] font-semibold text-ink">Password</h3>
      {result ? (
        <div className="mt-2.5">
          <TempPasswordCard
            who={name}
            login={result.login_id ?? email ?? null}
            loginLabel={result.login_id ? "ID" : "Email"}
            password={result.password}
            schoolName={result.login_id ? schoolName : undefined}
          />
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-[420px] text-[12.5px] leading-relaxed text-ink-muted">
            Forgotten their password? Set a new temporary one to hand over. They choose their own when they next sign in.
          </p>
          <Button disabled={busy} onClick={() => void reset(profileId, name)}>{busy ? "Resetting…" : "Reset password"}</Button>
        </div>
      )}
    </section>
  );
}

/**
 * The "Forgot password?" requests waiting at this school, as a banner at the
 * top of Students & staff. Shows nothing when there are none.
 */
export function PasswordResetRequests({ tenantId, schoolName }: { tenantId: string; schoolName?: string }) {
  const [reloadKey, setReloadKey] = useState(0);
  const { data } = useAsync(() => fetchOpenPasswordResetRequests(tenantId), [tenantId, reloadKey]);
  // Results stay on screen after their request closes, until the banner is dismissed.
  const [handed, setHanded] = useState<{ name: string; result: PasswordResetResult }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const toast = useToast();

  async function reset(profileId: string, name: string) {
    if (!window.confirm(`Set a new temporary password for ${name}? Their current password stops working straight away.`)) return;
    setBusyId(profileId);
    try {
      const result = await resetUserPassword(profileId);
      setHanded((h) => [...h, { name, result }]);
      setReloadKey((k) => k + 1);
    } catch (err) {
      toast(`Could not reset ${name}'s password: ${err instanceof Error ? err.message : "something went wrong"}`, "error");
    } finally {
      setBusyId(null);
    }
  }

  const open = data ?? [];
  if (open.length === 0 && handed.length === 0) return null;

  return (
    <section aria-label="Password reset requests" className="border-b border-line bg-[#FFF8EC] px-7 py-3.5">
      {open.length > 0 && (
        <>
          <p className="text-[12.5px] font-semibold text-ink">
            {open.length === 1 ? "1 person has" : `${open.length} people have`} forgotten their password
          </p>
          <p className="mt-0.5 text-[12px] text-ink-muted">They asked from the sign-in screen. Set each a new temporary password and hand it over.</p>
          <ul className="mt-2.5 grid gap-1.5">
            {open.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-white px-3 py-2">
                <span className="text-[13px] font-medium">{r.full_name}</span>
                <span className="text-[11.5px] text-ink-faint">
                  {ROLE_NOUN[r.role] ?? r.role}{r.login_id ? ` · ${r.login_id}` : ""} · asked {new Date(r.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                </span>
                <Button className="ml-auto" disabled={busyId === r.profile_id} onClick={() => void reset(r.profile_id, r.full_name)}>
                  {busyId === r.profile_id ? "Resetting…" : "Reset password"}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {handed.length > 0 && (
        <div className="mt-3 grid gap-2.5">
          {handed.map((h) => (
            <TempPasswordCard key={h.result.password} who={h.name} login={h.result.login_id} loginLabel="ID" password={h.result.password} schoolName={schoolName} />
          ))}
          <button type="button" onClick={() => setHanded([])} className="justify-self-start text-[12px] font-semibold text-forest hover:underline">
            I've handed {handed.length === 1 ? "it" : "them"} over: hide
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * A parent's "Reset <child>'s app password", one row per child who has a
 * login of their own. reset-user-password lets a guardian do this for their
 * own children's learner logins only.
 */
export function ChildPasswordResets({ kids, schoolName }: { kids: { id: string; name: string; first: string }[]; schoolName: string }) {
  const { data: logins } = useAsync(() => fetchChildLogins(kids.map((k) => k.id)), [kids.map((k) => k.id).join(",")]);
  const withLogin = kids.filter((k) => logins?.has(k.id));
  if (withLogin.length === 0) return null;
  return (
    <section className="mt-4 overflow-hidden rounded-lg border border-line bg-white">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-body font-semibold">Your {withLogin.length === 1 ? "child's" : "children's"} app login</h2>
        <p className="mt-0.5 text-[12px] text-ink-muted">If {withLogin.length === 1 ? withLogin[0]!.first : "one of them"} forgets their password, set a new temporary one here.</p>
      </header>
      <div className="px-4 pb-4">
        {withLogin.map((k) => (
          <ChildResetRow key={k.id} profileId={logins!.get(k.id)!} name={k.name} first={k.first} schoolName={schoolName} />
        ))}
      </div>
    </section>
  );
}

function ChildResetRow({ profileId, name, first, schoolName }: { profileId: string; name: string; first: string; schoolName: string }) {
  const { busy, result, reset } = useReset();
  return (
    <div className="border-b border-line-soft py-3 last:border-0">
      {result ? (
        <TempPasswordCard who={first} login={result.login_id} loginLabel="ID" password={result.password} schoolName={schoolName} />
      ) : (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium">{name}</span>
          <Button disabled={busy} onClick={() => void reset(profileId, first)}>{busy ? "Resetting…" : `Reset ${first}'s app password`}</Button>
        </div>
      )}
    </div>
  );
}
