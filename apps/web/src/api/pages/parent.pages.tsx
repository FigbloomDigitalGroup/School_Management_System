import { lazy } from "react";
import { Lazy } from "./Lazy";
import type { AreaPages } from "./types";

const ParentActivities = lazy(() => import("../../screens/parent/Activities").then((m) => ({ default: m.ParentActivities })));
const ParentBus = lazy(() => import("../../screens/parent/Bus").then((m) => ({ default: m.ParentBus })));
const ParentFees = lazy(() => import("../../screens/parent/Fees").then((m) => ({ default: m.ParentFees })));
const ParentHealth = lazy(() => import("../../screens/parent/Health").then((m) => ({ default: m.ParentHealth })));
const ParentHomework = lazy(() => import("../../screens/parent/Homework").then((m) => ({ default: m.ParentHomework })));
const ParentItems = lazy(() => import("../../screens/parent/Items").then((m) => ({ default: m.ParentItems })));
const ParentMaterials = lazy(() => import("../../screens/parent/Materials").then((m) => ({ default: m.ParentMaterials })));
const ParentResults = lazy(() => import("../../screens/parent/Results").then((m) => ({ default: m.ParentResults })));

/**
 * Parent pages, part 1 (Home, Fees, Results, Homework, Learning materials, Sports & activities, Bus, Health, Issued items). They are
 * served by the parent console (ApiParent.tsx). Home is that console's own page and is not listed here; Inbox, Chats, Account and the
 * Bloom study helper are the second parent slice. Every parent menu entry that is not here is hidden.
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
  ],
};
