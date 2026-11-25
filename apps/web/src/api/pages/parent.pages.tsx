import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const ParentActivities = lazy(() => import("../../screens/parent/Activities").then((m) => ({ default: m.ParentActivities })));
const ParentBus = lazy(() => import("../../screens/parent/Bus").then((m) => ({ default: m.ParentBus })));
const MyChats = lazy(() => import("../../screens/chat/MyChats").then((m) => ({ default: m.MyChats })));
const ParentFees = lazy(() => import("../../screens/parent/Fees").then((m) => ({ default: m.ParentFees })));
const ParentHealth = lazy(() => import("../../screens/parent/Health").then((m) => ({ default: m.ParentHealth })));
const ParentHomework = lazy(() => import("../../screens/parent/Homework").then((m) => ({ default: m.ParentHomework })));
const ParentInbox = lazy(() => import("../../screens/parent/Inbox").then((m) => ({ default: m.ParentInbox })));
const ParentItems = lazy(() => import("../../screens/parent/Items").then((m) => ({ default: m.ParentItems })));
const ParentMaterials = lazy(() => import("../../screens/parent/Materials").then((m) => ({ default: m.ParentMaterials })));
const ParentResults = lazy(() => import("../../screens/parent/Results").then((m) => ({ default: m.ParentResults })));
const ParentSettings = lazy(() => import("../../screens/parent/Settings").then((m) => ({ default: m.ParentSettings })));
const ParentStudyHelper = lazy(() => import("../../screens/parent/StudyHelper").then((m) => ({ default: m.ParentStudyHelper })));

/**
 * Every parent page on the new API (Home, Fees, Results, Homework, Learning materials, Sports & activities, Bus, Health,
 * Issued items, Inbox, Chats, Account, Bloom study helper), served by `ApiParent.tsx` (which also holds the Home route).
 */
export const pages: AreaPages = {
  parent: [
    { path: "parent/fees", element: <Lazy><ParentFees /></Lazy> },
    { path: "parent/results", element: <Lazy><ParentResults /></Lazy> },
    { path: "parent/homework", element: <Lazy><ParentHomework /></Lazy> },
    { path: "parent/materials", element: <Lazy><ParentMaterials /></Lazy> },
    { path: "parent/activities", element: <Lazy><ParentActivities /></Lazy> },
    { path: "parent/bus", element: <Lazy><ParentBus /></Lazy> },
    { path: "parent/health", element: <Lazy><ParentHealth /></Lazy> },
    { path: "parent/items", element: <Lazy><ParentItems /></Lazy> },
    { path: "parent/inbox", element: <Lazy><ParentInbox /></Lazy> },
    { path: "parent/chats", element: <Lazy><MyChats role="parent" /></Lazy> },
    { path: "parent/settings", element: <Lazy><ParentSettings /></Lazy> },
    { path: "parent/study-helper", element: <Lazy><ParentStudyHelper /></Lazy> },
  ],
};
