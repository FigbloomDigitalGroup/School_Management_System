import { Navigate } from "react-router-dom";
import { fetchStaffNotices } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { MyAccountFields } from "../../components/MyAccountFields";
import { useTenantSession } from "../../lib/sessionContext";
import { TeacherNotices } from "../teacher/Notices";
import { DeskVisitors } from "../frontdesk/Desk";

/**
 * The other staff console (role "staff"): the librarian, the matron, the
 * nurse, the cook. Small on purpose -- notices, what the school has issued
 * them, their own account -- plus the visitor log for those holding the
 * visitors admin area (20261031000000; handles_visitors before it). Any other
 * area they hold is in the admin console, behind the "Staff | Admin" switch.
 */

/**
 * staff/: straight to the visitor log for those who keep it, the sick bay
 * (in the admin console) for the nurse or matron, notices for everyone else.
 */
export function StaffHome() {
  const { adminAreas, tenant } = useTenantSession();
  if (adminAreas.includes("visitors")) return <Navigate to="visitors" replace />;
  if (adminAreas.includes("medical")) return <Navigate to={`/s/${tenant.slug}/admin/medical`} replace />;
  return <Navigate to="notices" replace />;
}

/** The visitor log, only for those holding the visitors area; the database refuses everyone else anyway (has_perm). */
export function StaffVisitors() {
  const { adminAreas } = useTenantSession();
  if (!adminAreas.includes("visitors")) return <Navigate to="../notices" relative="path" replace />;
  return <DeskVisitors />;
}

export function StaffNotices() {
  return <TeacherNotices load={fetchStaffNotices} />;
}

export function StaffAccount() {
  return (
    <>
      <PageHead eyebrow="Account" title="My account" blurb="Your own name, phone, and photo — nobody else's. Your title is set by the school office." />
      <div className="px-7 py-6">
        <MyAccountFields />
      </div>
    </>
  );
}
