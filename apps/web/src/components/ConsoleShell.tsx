import { useState, type FormEvent, type ReactNode } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { NAV, supabase, type Role } from "@figbloom/shared";
import { Icon } from "./Icon";
import { useTenant } from "./TenantTheme";
import { Button } from "./ui/Button";
import { TextField } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";

interface Props {
  role: Role;
  user: { name: string; roleLabel: string };
  /** Second column: the master list in a master-detail screen. */
  aside?: ReactNode;
  children: ReactNode;
  badges?: Record<string, string>;
  /** org_admin only — there's no `tenant` to read a name/logo from, so OrgShell passes the organization's own name. */
  workspaceName?: string;
}

/**
 * Desktop shell for the three power-user roles.
 * Expanded with labels by default and collapsible to icons — a support agent
 * hunting one school needs the labels; a bursar who lives here does not.
 */
export function ConsoleShell({ role, user, aside, children, badges = {}, workspaceName }: Props) {
  const [open, setOpen] = useState(true);
  const [changingPw, setChangingPw] = useState(false);
  const { slug, orgSlug } = useParams();
  const tenant = useTenant();
  const nav = useNavigate();
  // "Classes"/"My classes" are the K-12 homeroom concept (classes.form_level,
  // class_teacher_id); "Courses"/"My sections" are the higher-ed equivalent
  // (semesters, course catalogue, section rosters) — each institution type
  // only ever sees its own, rather than an empty screen shaped for the other.
  // Attendance/Timetable/Messages are still keyed off teaching_assignments/
  // class_id, which no higher-ed tenant populates, so they'd only ever show
  // "no classes" for a lecturer — hidden for the same reason, not because the
  // underlying capability doesn't matter (it's simply not built for course
  // sections yet). Gradebook is the exception: FIG-330 gave it a real
  // higher-ed branch (GpaGradebook), so it stays visible for both.
  const higherEd = tenant?.institution_type === "higher_ed";
  // Transport is meaningless for a fully-online tenant (FIG-358) — hidden
  // here, and the underlying routes are gated the same way in App.tsx, since
  // hiding a nav item alone never blocks the route itself.
  const online = tenant?.delivery_mode === "online";
  const K12_ONLY_TEACHER_ROUTES = new Set(["teacher/classes", "teacher/attendance", "teacher/timetable", "teacher/messages"]);
  const items = NAV[role].filter((item) => {
    if (item.to === "admin/classes" || K12_ONLY_TEACHER_ROUTES.has(item.to)) return !higherEd;
    if (item.to === "admin/courses" || item.to === "teacher/sections") return higherEd;
    if (item.to === "admin/fleet" || item.to === "parent/bus") return !online;
    return true;
  });
  // Three link-prefix regimes, not two: /platform/* (super_admin, absolute
  // paths as-is), /org/:orgSlug/* (org_admin), /s/:slug/* (everyone else).
  // org_admin was previously falling into the tenant-scoped bucket by
  // elimination (role !== "super_admin"), building hrefs like /s/undefined/schools
  // since useParams() on an /org/* route has no `slug` — nav was completely broken.
  const tenantScoped = role !== "super_admin" && role !== "org_admin";
  const orgScoped = role === "org_admin";

  async function signOut() {
    await supabase().auth.signOut();
    nav("/signin", { replace: true });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      <nav
        aria-label="Main"
        className="flex shrink-0 flex-col gap-0.5 overflow-hidden px-3 py-4 transition-[width] duration-150"
        style={{ width: open ? 224 : 68, background: tenantScoped ? "var(--accent-deep)" : "#17402A" }}
      >
        <div className="flex min-h-[34px] items-center gap-3 px-0.5 pb-4">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-white p-1">
            <img
              src={tenantScoped && tenant?.logo_url ? tenant.logo_url : "/logo-mark.png"}
              alt={tenantScoped ? tenant?.name ?? "School" : workspaceName ?? "Figbloom"}
              className="h-full w-full object-contain"
            />
          </div>
          {open && (
            <div className="overflow-hidden whitespace-nowrap">
              <div className="text-[14.5px] font-semibold tracking-tight text-white">
                {tenantScoped ? tenant?.name ?? "School" : workspaceName ?? "Figbloom"}
              </div>
              <div className="font-mono text-[8.5px] tracking-[0.1em] text-white/50">
                {tenantScoped ? "SCHOOL WORKSPACE" : orgScoped ? "ORGANIZATION CONSOLE" : "PLATFORM CONSOLE"}
              </div>
            </div>
          )}
        </div>

        {items.map((it) => {
          const to = tenantScoped
            ? `/s/${slug}/${it.to.replace(/^\//, "")}`
            : orgScoped
              ? `/org/${orgSlug}/${it.to.replace(/^\//, "")}`
              : it.to;
          return (
            <NavLink
              key={it.to}
              to={to}
              end
              title={it.label}
              className={({ isActive }) =>
                [
                  "hit flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-[9px] px-2.5",
                  isActive ? "bg-white font-semibold text-forest" : "text-white/75 hover:bg-white/10",
                ].join(" ")
              }
              style={{ height: 38 }}
            >
              <Icon name={it.icon} />
              {open && <span className="flex-1 truncate text-body">{it.label}</span>}
              {open && badges[it.to] && (
                <span className="rounded-full bg-orange px-1.5 font-mono text-[10px] text-white">{badges[it.to]}</span>
              )}
            </NavLink>
          );
        })}

        <div className="mt-auto flex flex-col gap-1.5">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="hit flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-[9px] px-2.5 text-white/60"
            style={{ height: 34 }}
          >
            <Icon name={open ? "back" : "forward"} size={13} />
            {open && <span className="text-small">Collapse menu</span>}
          </button>
          <div className="flex items-center gap-3 overflow-hidden whitespace-nowrap border-t border-white/10 px-0.5 pt-2.5">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[9px] bg-white/15 text-[11px] font-semibold text-white">
              {user.name.split(" ").map((p) => p[0]).join("").slice(0, 2)}
            </div>
            {open && (
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-small text-white">{user.name}</div>
                <div className="font-mono text-[8.5px] text-white/50">{user.roleLabel.toUpperCase()}</div>
              </div>
            )}
          </div>
          <button
            onClick={() => setChangingPw(true)}
            title="Change password"
            className="hit flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-[9px] px-2.5 text-white/60 hover:bg-white/10"
            style={{ height: 34 }}
          >
            <Icon name="gear" size={13} />
            {open && <span className="text-small">Change password</span>}
          </button>
          <button
            onClick={() => { void signOut(); }}
            title="Sign out"
            className="hit flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-[9px] px-2.5 text-white/60 hover:bg-white/10"
            style={{ height: 34 }}
          >
            <Icon name="signout" size={13} />
            {open && <span className="text-small">Sign out</span>}
          </button>
        </div>
      </nav>

      {aside && <div className="flex w-[320px] shrink-0 flex-col overflow-hidden border-r border-line bg-[#FAFBFA]">{aside}</div>}
      <main className="min-w-0 flex-1 overflow-auto">{children}</main>

      {changingPw && <ChangePasswordModal onClose={() => setChangingPw(false)} />}
    </div>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError("");
    if (password.length < 8) { setError("At least 8 characters."); return; }
    if (password !== confirm) { setError("The passwords don't match."); return; }
    setBusy(true);
    try {
      const { error: err } = await supabase().auth.updateUser({ password });
      if (err) throw err;
      toast("Password changed.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change the password.");
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void submit();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Change password"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving…" : "Change password"}
          </Button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="grid gap-3.5">
        <TextField id="new-pw" label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters." />
        <TextField id="new-pw2" label="Confirm password" type="password" value={confirm} error={error} onChange={(e) => setConfirm(e.target.value)} />
      </form>
    </Modal>
  );
}

/** Page header used by every console screen. */
export function PageHead({ eyebrow, title, blurb, actions }: { eyebrow: string; title: string; blurb?: string; actions?: ReactNode }) {
  return (
    <header className="border-b border-line bg-white px-7 pb-5 pt-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">{eyebrow.toUpperCase()}</div>
          <h1 className="mt-1.5 text-h2 font-semibold tracking-tight">{title}</h1>
          {blurb && <p className="mt-1.5 max-w-[620px] text-[13px] leading-relaxed text-ink-muted">{blurb}</p>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
    </header>
  );
}
