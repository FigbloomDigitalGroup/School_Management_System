import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const AdminChats = lazy(() => import("../../screens/admin/Chats").then((m) => ({ default: m.AdminChats })));
const MyChats = lazy(() => import("../../screens/chat/MyChats").then((m) => ({ default: m.MyChats })));
const TeacherNotices = lazy(() => import("../../screens/teacher/Notices").then((m) => ({ default: m.TeacherNotices })));
const TeacherMessages = lazy(() => import("../../screens/teacher/Messages").then((m) => ({ default: m.TeacherMessages })));

/** Chats, notices and messages (W4). */
export const pages: AreaPages = {
  admin: [{ path: "admin/chats", element: <Lazy><AdminChats /></Lazy> }],
  teacher: [
    { path: "teacher/chats", element: <Lazy><MyChats role="teacher" /></Lazy> },
    { path: "teacher/notices", element: <Lazy><TeacherNotices /></Lazy> },
    { path: "teacher/messages", element: <Lazy><TeacherMessages /></Lazy> },
  ],
};
