import { useEffect } from "react";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { fetchMyConversations, type PushTarget } from "@figbloom/shared";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { BarChart3, Bell, Bus, Calendar, ClipboardList, Home, Mail, User, Wallet, type LucideIcon } from "lucide-react-native";
import { accentFor, fontSize, t } from "./theme";
import { useChild, useMessages } from "./data";
import { useStudentData } from "./studentData";

import { ParentHome } from "./screens/parent/Home";
import { ParentFees } from "./screens/parent/Fees";
import { ParentPay } from "./screens/parent/Pay";
import { ParentHomework } from "./screens/parent/Homework";
import { ParentMaterials } from "./screens/parent/Materials";
import { ParentResults } from "./screens/parent/Results";
import { ParentInbox } from "./screens/parent/Inbox";
import { ParentBus } from "./screens/parent/Bus";
import { ParentAccount } from "./screens/parent/Account";
import { StudentToday } from "./screens/student/Today";
import { StudentTimetable } from "./screens/student/Timetable";
import { StudentWork } from "./screens/student/Work";
import { StudentMaterials } from "./screens/student/Materials";
import { StudentResults } from "./screens/student/Results";
import { StudentNotices } from "./screens/student/Notices";
import { StudentAccount } from "./screens/student/Account";
import { DriverTrip } from "./screens/driver/Trip";
import { ChatList } from "./screens/chat/ChatList";
import { ChatThread } from "./screens/chat/ChatThread";
import { ParentActivities } from "./screens/parent/Activities";
import { ParentHealth } from "./screens/parent/Health";
import { ParentItems } from "./screens/parent/Items";
import { ParentStudyHelper } from "./screens/parent/StudyHelper";
import { StudentActivities } from "./screens/student/Activities";
import { StudentItems } from "./screens/student/Items";
import { StudentStudyHelper } from "./screens/student/StudyHelper";
import { CallProvider } from "./calls/CallProvider";
import { listenForPushTaps } from "./pushTaps";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
/** Lets a tapped push, which arrives from outside the navigator, open a screen inside it. */
const navRef = createNavigationContainerRef<Record<string, object | undefined>>();

/** What to do once the navigator exists: a tap that opened the app from nothing arrives before it is ready. */
let afterReady: (() => void) | null = null;
const whenReady = (run: () => void) => { if (navRef.isReady()) run(); else afterReady = run; };

/**
 * Opens what a tapped push is about: a chat (a parent or a learner), or the
 * Health screen on the child a sick bay notice names (a parent). Anything else
 * just opens the app, as it always has.
 */
async function openPushTarget(target: PushTarget, isParent: boolean) {
  if (target.kind === "chat") {
    // The thread wants the other person's name and role, which the push doesn't carry.
    const found = (await fetchMyConversations().catch(() => [])).find((c) => c.id === target.conversationId);
    whenReady(() => {
      if (found) navRef.navigate("ChatThread", { conversationId: found.id, otherId: found.otherId, name: found.otherName, role: found.otherRole, canReply: found.canReply });
      else navRef.navigate("Chats");
    });
  } else if (target.kind === "health" && isParent) {
    whenReady(() => navRef.navigate("Health", { studentId: target.studentId }));
  }
}

const tabIcon = (Icon: LucideIcon) => ({
  tabBarIcon: ({ color, size }: { color: string; size: number }) => <Icon color={color} size={size} />,
});

interface NavigationProps {
  role: "parent" | "student" | "driver";
  accent: string;
  /** Who is signed in: calls and live classes ring and join as them. */
  profileId: string;
  /** Only present (and only needed) when role is "driver". */
  driver?: { driverId: string; tenantId: string; fullName: string };
}

/** Which app opens is decided by the signed-in role, not by a picker. */
export function Navigation({ role, accent, profileId, driver }: NavigationProps) {
  // Tapping a push opens what it is about. (Before the driver's early return below: a hook can't come after one.)
  useEffect(() => {
    if (role === "driver") return;
    return listenForPushTaps((target) => { void openPushTarget(target, role === "parent"); });
  }, [role]);

  if (role === "driver" && driver) {
    // A driver's screen is a single full-screen page (start/end trip), not a
    // console — no tabs, nothing else to navigate to.
    return <DriverTrip driverId={driver.driverId} tenantId={driver.tenantId} accent={accent} fullName={driver.fullName} />;
  }

  return (
    <CallProvider profileId={profileId}>
    <NavigationContainer ref={navRef} onReady={() => { const run = afterReady; afterReady = null; run?.(); }}>
      {role === "parent" ? (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {/* component, not an inline children render-prop: the latter is a
              fresh closure every render, which React Navigation doesn't
              reliably re-render on outside context changes — the Inbox
              badge silently stopped updating live until this was split out
              into a real named component below, same as StudentTabs. */}
          <Stack.Screen name="ParentTabs" component={ParentTabs} />
          {/* Payment is a stack screen, not a tab — it must not be swiped away mid-prompt. */}
          <Stack.Screen name="Pay" component={ParentPay} options={{ presentation: "modal" }} />
          {/* Homework is opened from the Home card, not a seventh tab — six is already a full bar. */}
          <Stack.Screen name="Homework" component={ParentHomework} />
          {/* Learning materials, likewise, opens from Home. */}
          <Stack.Screen name="Materials" component={ParentMaterials} />
          {/* Chats open from a Home card, with the thread one level down. */}
          <Stack.Screen name="Chats" component={ParentChats} />
          <Stack.Screen name="ChatThread" component={ParentChatThread} />
          {/* Sports and issued items open from Home cards too. */}
          <Stack.Screen name="Activities" component={ParentActivities} />
          <Stack.Screen name="Items" component={ParentItems} />
          <Stack.Screen name="Health" component={ParentHealth} />
          <Stack.Screen name="StudyHelper" component={ParentStudyHelper} />
        </Stack.Navigator>
      ) : (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          {/* The accent travels as a route param so StudentTabs stays a real
              named component (see the note on ParentTabs above). */}
          <Stack.Screen name="StudentTabs" component={StudentTabsScreen} initialParams={{ accent }} />
          {/* Opened from the Work tab, not a seventh tab. */}
          <Stack.Screen name="Materials" component={StudentMaterials} />
          {/* Chats open from a Today card, with the thread one level down. */}
          <Stack.Screen name="Chats" component={StudentChats} />
          <Stack.Screen name="ChatThread" component={StudentChatThread} />
          <Stack.Screen name="Activities" component={StudentActivities} />
          <Stack.Screen name="Items" component={StudentItems} />
          {/* The study helper opens from a Today card. */}
          <Stack.Screen name="StudyHelper" component={StudentStudyHelper} />
        </Stack.Navigator>
      )}
    </NavigationContainer>
    </CallProvider>
  );
}

function ParentChats() {
  const { accent } = useChild();
  return (
    <ChatList
      tint={accentFor(accent).deep}
      blurb="With your child, their teachers and the school office."
      empty="Start a chat with your child's class teacher, a subject teacher, the school office, or your child."
    />
  );
}

function ParentChatThread() {
  const { accent } = useChild();
  return <ChatThread tint={accentFor(accent).deep} />;
}

function StudentChats() {
  const { accent } = useStudentData();
  return <ChatList tint={accentFor(accent).deep} blurb="With your parents and guardians." empty="Start a chat with a parent or guardian." />;
}

function StudentChatThread() {
  const { accent } = useStudentData();
  return <ChatThread tint={accentFor(accent).deep} />;
}

function ParentTabs() {
  const { accent } = useChild();
  const a = accentFor(accent);
  const unread = useMessages().filter((m) => m.unread).length;
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: a.deep,
        tabBarInactiveTintColor: t.appSurface.inkFaint,
        tabBarLabelStyle: { fontSize: fontSize.micro, fontWeight: "600" },
        // The bar is a fixed height, so its labels stay put under large system text;
        // it also steps aside for the keyboard instead of eating a third of a form.
        tabBarAllowFontScaling: false,
        tabBarHideOnKeyboard: true,
        tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6 },
        tabBarBadgeStyle: { backgroundColor: a.deep },
      }}
    >
      <Tab.Screen name="Home" component={ParentHome} options={tabIcon(Home)} />
      <Tab.Screen name="Fees" component={ParentFees} options={tabIcon(Wallet)} />
      <Tab.Screen name="Results" component={ParentResults} options={tabIcon(BarChart3)} />
      <Tab.Screen name="Bus" component={ParentBus} options={tabIcon(Bus)} />
      <Tab.Screen
        name="Inbox"
        component={ParentInbox}
        options={{ ...tabIcon(Mail), tabBarBadge: unread || undefined }}
      />
      <Tab.Screen name="Account" component={ParentAccount} options={tabIcon(User)} />
    </Tab.Navigator>
  );
}

function StudentTabsScreen({ route }: { route: { params?: { accent?: string } } }) {
  return <StudentTabs a={accentFor(route.params?.accent ?? "")} />;
}

/** Its own component (not inlined above) so useStudentData() is only ever
 *  called while mounted under StudentDataProvider \u2014 Navigation itself also
 *  renders for the parent and driver roles, which don't provide it. */
function StudentTabs({ a }: { a: ReturnType<typeof accentFor> }) {
  const unread = useStudentData().data.notices.filter((n) => n.unread).length;
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: a.deep,
        tabBarInactiveTintColor: t.appSurface.inkFaint,
        tabBarLabelStyle: { fontSize: fontSize.micro, fontWeight: "600" },
        // The bar is a fixed height, so its labels stay put under large system text;
        // it also steps aside for the keyboard instead of eating a third of a form.
        tabBarAllowFontScaling: false,
        tabBarHideOnKeyboard: true,
        tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6 },
        tabBarBadgeStyle: { backgroundColor: a.deep },
      }}
    >
      <Tab.Screen name="Today" component={StudentToday} options={tabIcon(Home)} />
      <Tab.Screen name="Timetable" component={StudentTimetable} options={tabIcon(Calendar)} />
      <Tab.Screen name="Work" component={StudentWork} options={tabIcon(ClipboardList)} />
      <Tab.Screen name="Results" component={StudentResults} options={tabIcon(BarChart3)} />
      <Tab.Screen
        name="Notices"
        component={StudentNotices}
        options={{ ...tabIcon(Bell), tabBarBadge: unread || undefined }}
      />
      <Tab.Screen name="Account" component={StudentAccount} options={tabIcon(User)} />
    </Tab.Navigator>
  );
}
