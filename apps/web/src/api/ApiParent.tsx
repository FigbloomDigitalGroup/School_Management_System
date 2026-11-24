import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, roleLabel } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { ParentDataProvider } from "../lib/parentContext";
import type { SchoolSession } from "./ApiOverview";
import { API_PARENT_PAGES, parentPageDefs } from "./pages";
import { Lazy } from "./pages/Lazy";

// The parent's home is this console's own page, as `admin` and `teacher` are for theirs: it is not registered in pages/parent.pages.tsx.
const ParentHome = lazy(() => import("../screens/parent/Home").then((m) => ({ default: m.ParentHome })));

/**
 * The console of a parent on the new API: the same menu and shell as the Supabase app's ParentShell (App.tsx), without the parts that
 * read Supabase (the unread badges, the bus-update listener). Its pages are registered in `pages/parent.pages.tsx`, like every other
 * area's, and every parent menu entry that is not registered there is hidden and sends the parent home. The parent's children load
 * once for every page (ParentDataProvider) and the chosen child lives in the address (?child=). Which learners are a parent's own is
 * decided by the server on every read; a parent whose link was removed gets no children and each page says so.
 */
export function ApiParentConsole({ session }: { session: SchoolSession }) {
  const home = `/s/${session.tenant.slug}/parent`;
  return (
    <ParentDataProvider>
      <ConsoleShell
        role="parent"
        user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: roleLabel(session.tenant, "parent") }}
        hiddenNav={NAV.parent.map((i) => i.to).filter((to) => !API_PARENT_PAGES.includes(to))}
      >
        <Routes>
          <Route path="parent" element={<Lazy><ParentHome /></Lazy>} />
          {parentPageDefs.map((p) => <Route key={p.path} path={p.path} element={p.element} />)}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </ConsoleShell>
    </ParentDataProvider>
  );
}
