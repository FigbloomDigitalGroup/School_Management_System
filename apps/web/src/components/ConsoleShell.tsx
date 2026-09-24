import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { NAV, suggestSlug, supabase, type Organization, type Role } from "@figbloom/shared";
import { uiZoom } from "../lib/a11y";
import { createMyOrganization } from "../lib/platformAdmin";
import { AccessibilityModal } from "./AccessibilityModal";
import { Avatar } from "./Avatar";
import { Icon } from "./Icon";
import { useTenant } from "./TenantTheme";
import { Button } from "./ui/Button";
import { SelectField, TextField } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { useToast } from "./ui/Toast";

interface Props {
  role: Role;
  user: { id: string; name: string; roleLabel: string; avatarUrl?: string | null };
  /** Second column: the master list in a master-detail screen. */
  aside?: ReactNode;
  children: ReactNode;
  badges?: Record<string, string>;
  /** org_admin only — there's no `tenant` to read a name/logo from, so OrgShell passes the organization's own name. */
  workspaceName?: string;
  /** org_admin only — every organization this profile administers, including
   *  the current one. Rendered as a switcher when there's more than one;
   *  falls back to the plain static name (previous behavior) otherwise. */
  workspaceOptions?: { slug: string; name: string }[];
  /** Set when an org_admin is acting inside a member school (FIG-391/392) —
   *  a persistent reminder that they are not this school's own admin, with
   *  a way back out. Never set for a school's own school_admin. onExit is a
   *  callback rather than a plain URL so the caller can log the exit before
   *  navigating away. */
  actingBanner?: { orgName: string; schoolName: string; onExit: () => void };
}

/**
 * Desktop shell for the three power-user roles.
 * Expanded with labels by default and collapsible to icons — a support agent
 * hunting one school needs the labels; a bursar who lives here does not.
 */
export function ConsoleShell({ role, user, aside, children, badges = {}, workspaceName, workspaceOptions, actingBanner }: Props) {
  // Start collapsed when the labelled sidebar would eat too much of a narrow
  // (or heavily zoomed) window; the person can still expand it.
  const [open, setOpen] = useState(() => window.innerWidth / uiZoom() >= 900);
  const [changingPw, setChangingPw] = useState(false);
  const [a11yOpen, setA11yOpen] = useState(false);
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
  const K12_ONLY_TEACHER_ROUTES = new Set(["teacher/classes", "teacher/attendance", "teacher/timetable", "teacher/messages", "teacher/notices"]);
  const items = NAV[role].filter((item) => {
    if (item.to === "admin/classes" || item.to === "admin/subjects" || K12_ONLY_TEACHER_ROUTES.has(item.to)) return !higherEd;
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
  // Only the three roles with a real self-service "My account" screen (FIG-
  // 403) get a clickable avatar — org_admin/super_admin/student have none to
  // send them to yet.
  const ACCOUNT_ROUTE: Partial<Record<Role, string>> = { school_admin: "admin/account", teacher: "teacher/account", parent: "parent/settings" };
  const accountTo = ACCOUNT_ROUTE[role];
  const accountHref = accountTo
    ? (tenantScoped ? `/s/${slug}/${accountTo}` : orgScoped ? `/org/${orgSlug}/${accountTo}` : accountTo)
    : null;

  async function signOut() {
    await supabase().auth.signOut();
    nav("/signin", { replace: true });
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Header and account footer stay put; only the page list between them
          scrolls. Previously the whole column was overflow-hidden, so on a
          short or zoomed-in window the footer (Sign out included) was simply
          clipped off the bottom with no way to reach it. The nav itself also
          scrolls as a last resort for windows too short even for that. */}
      <nav
        aria-label="Main"
        className="flex shrink-0 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-3 py-4 transition-[width] duration-150"
        style={{ width: open ? 224 : 68, background: tenantScoped ? "var(--accent-deep)" : "#17402A" }}
      >
        <div className="flex min-h-[34px] shrink-0 items-center gap-3 px-0.5 pb-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-white p-1">
            <img
              src={tenantScoped && tenant?.logo_url ? tenant.logo_url : "/logo-mark.png"}
              alt={tenantScoped ? tenant?.name ?? "School" : workspaceName ?? "Figbloom"}
              className="h-full w-full object-contain"
            />
          </div>
          {open && orgScoped && workspaceOptions ? (
            <WorkspaceSwitcher current={workspaceName ?? "Figbloom"} options={workspaceOptions} />
          ) : (
            open && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14.5px] font-semibold tracking-tight text-white">
                  {tenantScoped ? tenant?.name ?? "School" : workspaceName ?? "Figbloom"}
                </div>
                <div className="truncate font-mono text-[8.5px] tracking-[0.1em] text-white/50">
                  {tenantScoped ? "SCHOOL WORKSPACE" : orgScoped ? "ORGANIZATION CONSOLE" : "PLATFORM CONSOLE"}
                </div>
              </div>
            )
          )}
          {open && (
            <button
              onClick={() => setOpen(false)}
              aria-expanded={open}
              title="Collapse menu"
              className="hit ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/60 hover:bg-white/10"
            >
              <Icon name="back" size={13} />
            </button>
          )}
        </div>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            aria-expanded={open}
            title="Expand menu"
            className="hit mx-auto mb-2 grid h-7 w-7 shrink-0 place-items-center rounded-md text-white/60 hover:bg-white/10"
          >
            <Icon name="forward" size={13} />
          </button>
        )}

        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
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
                  open ? "" : "justify-center",
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
        </div>

        <div className="flex shrink-0 flex-col gap-1.5 pt-2">
          {accountHref ? (
            <NavLink
              to={accountHref}
              title="My account"
              className="hit flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-[9px] border-t border-white/10 px-0.5 pt-2.5 hover:bg-white/10"
            >
              <Avatar id={user.id} name={user.name} url={user.avatarUrl} size={32} />
              {open && (
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-small text-white">{user.name}</div>
                  <div className="font-mono text-[8.5px] text-white/50">{user.roleLabel.toUpperCase()}</div>
                </div>
              )}
            </NavLink>
          ) : (
            <div className="flex items-center gap-3 overflow-hidden whitespace-nowrap border-t border-white/10 px-0.5 pt-2.5">
              <Avatar id={user.id} name={user.name} url={user.avatarUrl} size={32} />
              {open && (
                <div className="min-w-0 flex-1 leading-tight">
                  <div className="truncate text-small text-white">{user.name}</div>
                  <div className="font-mono text-[8.5px] text-white/50">{user.roleLabel.toUpperCase()}</div>
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setA11yOpen(true)}
            title="Accessibility"
            className="hit flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-[9px] px-2.5 text-white/60 hover:bg-white/10"
            style={{ height: 34 }}
          >
            <Icon name="text" size={13} />
            {open && <span className="text-small">Accessibility</span>}
          </button>
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
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {actingBanner && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-orange-line bg-orange-soft px-5 py-2 text-[12.5px] text-orange-ink">
            <span>
              Acting for <span className="font-semibold">{actingBanner.orgName}</span> inside{" "}
              <span className="font-semibold">{actingBanner.schoolName}</span> — you are not this school's own admin.
            </span>
            <button
              type="button"
              onClick={actingBanner.onExit}
              className="hit shrink-0 font-semibold underline decoration-orange-ink/40 underline-offset-2"
            >
              Exit to organization
            </button>
          </div>
        )}
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>

      {changingPw && <ChangePasswordModal onClose={() => setChangingPw(false)} />}
      {a11yOpen && <AccessibilityModal onClose={() => setA11yOpen(false)} />}
    </div>
  );
}

/** Every org_admin gets this instead of the plain static workspace name —
 *  jump between orgs without signing out, and spin up an additional one. */
function WorkspaceSwitcher({ current, options }: { current: string; options: { slug: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey, { capture: true });
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey, { capture: true }); };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-md text-left hover:bg-white/10"
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-semibold tracking-tight text-white">{current}</div>
          <div className="font-mono text-[8.5px] tracking-[0.1em] text-white/50">ORGANIZATION CONSOLE</div>
        </div>
        <span aria-hidden className="shrink-0 pr-1 text-[10px] text-white/50">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1.5 w-64 overflow-hidden rounded-lg border border-line bg-white py-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.slug}
              type="button"
              onClick={() => { setOpen(false); nav(`/org/${o.slug}/dashboard`); }}
              className={`block w-full truncate px-3 py-2 text-left text-[13px] hover:bg-page ${o.name === current ? "font-semibold text-forest" : "text-ink"}`}
            >
              {o.name}
            </button>
          ))}
          <div className="mt-1 border-t border-line-soft pt-1">
            {options.length > 1 && (
              <button
                type="button"
                onClick={() => { setOpen(false); nav("/org-picker"); }}
                className="block w-full px-3 py-2 text-left text-[12.5px] font-medium text-ink-muted hover:bg-page"
              >
                All organizations
              </button>
            )}
            <button
              type="button"
              onClick={() => { setOpen(false); setCreating(true); }}
              className="block w-full px-3 py-2 text-left text-[12.5px] font-medium text-forest hover:bg-page"
            >
              + Create new organization
            </button>
          </div>
        </div>
      )}

      {creating && <CreateOrganizationModal onClose={() => setCreating(false)} />}
    </div>
  );
}

const ORG_KIND_OPTIONS: { value: Organization["kind"]; label: string }[] = [
  { value: "group_owner", label: "I own/manage a group of schools" },
  { value: "government", label: "National government body" },
  { value: "county", label: "County government" },
  { value: "constituency", label: "Constituency" },
];

const ORG_SLUG_RE = /^[a-z0-9-]{3,40}$/;

/** The in-app "+ Create new organization" flow (FIG-394) — same shape as the
 *  public Signup.tsx form, minus the account fields: this org_admin already
 *  has a login, so create-organization just links it to a new org rather
 *  than making a second account. Lands 'pending', same one-click staff
 *  approval every self-registered org goes through — navigating there shows
 *  App.tsx's existing PendingOrgHold screen, no new "success" state needed. */
function CreateOrganizationModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [kind, setKind] = useState<Organization["kind"]>("group_owner");
  const [county, setCounty] = useState("");
  const [saving, setSaving] = useState(false);

  const slugValue = slugTouched ? slug : (name ? suggestSlug(name) : "");
  const slugOk = ORG_SLUG_RE.test(slugValue);

  async function submit() {
    if (!name.trim()) { toast("Give the organization a name."); return; }
    if (!slugOk) { toast("Pick a valid address — 3-40 lowercase letters, numbers and hyphens."); return; }
    setSaving(true);
    try {
      const result = await createMyOrganization({
        name: name.trim(),
        slug: slugValue,
        kind,
        county: county.trim() || undefined,
      });
      onClose();
      nav(`/org/${result.slug}/dashboard`);
    } catch (err) {
      toast(err instanceof Error ? `Could not create the organization: ${err.message}` : "Could not create the organization.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="New workspace"
      title="Create an organization"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" onClick={() => void submit()} disabled={saving}>
            {saving ? "Creating…" : "Create organization"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3.5">
        <p className="text-[12.5px] leading-relaxed text-ink-muted">
          A separate workspace with its own schools — useful for a distinct group, region, or program you run
          alongside this one. It starts pending review, same as any new organization.
        </p>
        <TextField id="new-org-name" label="Organization name" placeholder="e.g. Riverside Schools Trust" value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          id="new-org-slug" label="Address" mono placeholder={slugValue || "riverside-schools-trust"}
          value={slugTouched ? slug : slugValue}
          hint={slugOk ? `figbloom.co.ke/org/${slugValue}` : undefined}
          error={slugTouched && slug && !slugOk ? "3-40 characters, lowercase letters, numbers and hyphens only." : undefined}
          onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }}
        />
        <SelectField id="new-org-kind" label="What best describes it?" value={kind} onChange={(e) => setKind(e.target.value as Organization["kind"])} options={ORG_KIND_OPTIONS} />
        <TextField id="new-org-county" label="County (optional)" placeholder="e.g. Kiambu" value={county} onChange={(e) => setCounty(e.target.value)} />
      </div>
    </Modal>
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
