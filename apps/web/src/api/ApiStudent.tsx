import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { NAV, roleLabel } from "@figbloom/shared";
import { ConsoleShell } from "../components/ConsoleShell";
import { StudentDataProvider } from "../lib/studentContext";
import type { SchoolSession } from "./ApiOverview";
import { API_STUDENT_PAGES, studentPageDefs } from "./pages";
import { Lazy } from "./pages/Lazy";

// The learner's home is this console's own page, as `parent` is the parent's: it is not registered in pages/student*.pages.tsx.
const StudentToday = lazy(() => import("../screens/student/Today").then((m) => ({ default: m.StudentToday })));

/**
 * The console of a learner on the new API: the same menu and shell as the Supabase app's StudentShell (App.tsx), without the parts that
 * read Supabase (the unread chat badge). Its pages are registered in `pages/student*.pages.tsx`, like every other area's, and every
 * student menu entry that is not registered there is hidden and sends the learner home. The learner's own record, class, work, notices
 * and marks load once for every page (StudentDataProvider). Which learner is "me" is decided by the server on every read, from the
 * login: a login whose learner was archived or whose login was revoked gets no record and each page says so.
 */
export function ApiStudentConsole({ session }: { session: SchoolSession }) {
  const home = `/s/${session.tenant.slug}/student`;
  return (
    <StudentDataProvider>
      <ConsoleShell
        role="student"
        user={{ id: session.profile.id, name: session.profile.full_name, avatarUrl: session.profile.avatar_url, roleLabel: roleLabel(session.tenant, "student") }}
        hiddenNav={NAV.student.map((i) => i.to).filter((to) => !API_STUDENT_PAGES.includes(to))}
      >
        <Routes>
          <Route path="student" element={<Lazy><StudentToday /></Lazy>} />
          {studentPageDefs.map((p) => <Route key={p.path} path={p.path} element={p.element} />)}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </ConsoleShell>
    </StudentDataProvider>
  );
}
