import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, roleLabel } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { ParentDataProvider } from "../lib/parentContext";
import { ParentActivities } from "../screens/parent/Activities";
import { ParentBus } from "../screens/parent/Bus";
import { ParentFees } from "../screens/parent/Fees";
import { ParentHealth } from "../screens/parent/Health";
import { ParentHome } from "../screens/parent/Home";
import { ParentHomework } from "../screens/parent/Homework";
import { ParentItems } from "../screens/parent/Items";
import { ParentMaterials } from "../screens/parent/Materials";
import { ParentResults } from "../screens/parent/Results";
import type { SchoolSession } from "./ApiOverview";

/**
 * The parent pages that run on the new API, by their address under /s/<slug>/. A page is added here, and a route below, once its
 * shared module has an API side. Every other entry of the parent menu is hidden, and its address sends the parent home.
 *
 * Not yet here: parent/inbox, parent/chats, parent/settings and parent/study-helper (the second parent slice).
 */
export const API_PARENT_PAGES = [
  "parent", "parent/fees", "parent/results", "parent/homework", "parent/materials", "parent/activities", "parent/bus", "parent/health", "parent/items",
] as const;

/**
 * The console of a parent on the new API: the same menu and shell as the Supabase app's ParentShell (App.tsx), without the parts that
 * read Supabase (the unread badges, the bus-update listener). The parent's children load once for every page (ParentDataProvider) and
 * the chosen child lives in the address (?child=). Which learners are a parent's own is decided by the server on every read; a parent
 * whose link was removed gets no children and each page says so.
 */
export function ApiParentConsole({ session }: { session: SchoolSession }) {
  const home = `/s/${session.tenant.slug}/parent`;
  return (
    <ParentDataProvider>
      <ConsoleShell
        role="parent"
        user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: roleLabel(session.tenant, "parent") }}
        hiddenNav={NAV.parent.map((i) => i.to).filter((to) => !(API_PARENT_PAGES as readonly string[]).includes(to))}
      >
        <Routes>
          <Route path="parent" element={<ParentHome />} />
          <Route path="parent/fees" element={<ParentFees />} />
          <Route path="parent/results" element={<ParentResults />} />
          <Route path="parent/homework" element={<ParentHomework />} />
          <Route path="parent/materials" element={<ParentMaterials />} />
          <Route path="parent/activities" element={<ParentActivities />} />
          <Route path="parent/bus" element={<ParentBus />} />
          <Route path="parent/health" element={<ParentHealth />} />
          <Route path="parent/items" element={<ParentItems />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </ConsoleShell>
    </ParentDataProvider>
  );
}
