import { useEffect } from "react";
import { NavigationContainer, createNavigationContainerRef } from "@react-navigation/native";
import { View } from "react-native";
import { fetchMyConversations, type PushTarget } from "@figbloom/shared";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Bell, Mail, Menu, SquareCheck, Table2, type LucideIcon } from "lucide-react-native";
import { accentFor, fontSize, t } from "./theme";

import { TeacherAttendance } from "./screens/teacher/Attendance";
import { TeacherGradebook } from "./screens/teacher/Gradebook";
import { TeacherMessages } from "./screens/teacher/Messages";
import { TeacherNotices } from "./screens/teacher/Notices";
import { TeacherMore } from "./screens/teacher/More";
import { TeacherTimetable } from "./screens/teacher/Timetable";
import { TeacherClasses } from "./screens/teacher/Classes";
import { TeacherLeave } from "./screens/teacher/Leave";
import { TeacherHomework } from "./screens/teacher/Homework";
import { TeacherItems } from "./screens/teacher/Items";
import { useQueueSync } from "./lib/useQueueSync";
import { CallProvider } from "./calls/CallProvider";
import { listenForPushTaps } from "./pushTaps";
import { TeacherBuses } from "./screens/teacher/Buses";
import { TeacherAccount } from "./screens/teacher/Account";
import { ChatList } from "./screens/chat/ChatList";
import { ChatThread } from "./screens/chat/ChatThread";
import { TeacherVisitors } from "./screens/teacher/Visitors";
import { TeacherPerformance } from "./screens/teacher/Performance";
import { TeacherReportCards } from "./screens/teacher/ReportCards";
import { TeacherBloom } from "./screens/teacher/Bloom";
import { TeacherLiveClass } from "./screens/teacher/LiveClass";
import { VisitAlerts } from "./components/VisitAlerts";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
/** Lets the visitor alert, which sits above the navigator, open a screen inside it. */
const navRef = createNavigationContainerRef<Record<string, object | undefined>>();

/** What to do once the navigator exists: a tap that opened the app from nothing arrives before it is ready. */
let afterReady: (() => void) | null = null;
const whenReady = (run: () => void) => { if (navRef.isReady()) run(); else afterReady = run; };

/** Opens what a tapped push is about: a chat, or the visitors list. Anything else just opens the app. */
async function openPushTarget(target: PushTarget) {
  if (target.kind === "visit") {
    whenReady(() => navRef.navigate("More", { screen: "Visitors", initial: false }));
    return;
  }
  if (target.kind !== "chat") return;
  // The thread wants the other person's name and role, which the push doesn't carry.
  const found = (await fetchMyConversations().catch(() => [])).find((c) => c.id === target.conversationId);
  whenReady(() => navRef.navigate("More", found
    ? { screen: "ChatThread", initial: false, params: { conversationId: found.id, otherId: found.otherId, name: found.otherName, role: found.otherRole, canReply: found.canReply } }
    : { screen: "Chats", initial: false }));
}

const tabIcon = (Icon: LucideIcon) => ({
  tabBarIcon: ({ color, size }: { color: string; size: number }) => <Icon color={color} size={size} />,
});

export interface TeacherSession {
  profileId: string;
  tenantId: string;
  fullName: string;
  accent: string;
  country: string;
}

/** Timetable/Classes/Leave/Account live under the "More" tab rather than as
 *  their own tabs — 4 daily-use screens (Attendance/Gradebook/Messages/
 *  Notices) plus a catch-all fits a phone-width tab bar; 8 tabs wouldn't. */
function MoreStack({ session }: { session: TeacherSession }) {
  const tint = accentFor(session.accent).deep;
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreMenu">{() => <TeacherMore session={session} />}</Stack.Screen>
      <Stack.Screen name="Timetable">{() => <TeacherTimetable session={session} />}</Stack.Screen>
      <Stack.Screen name="Homework">{() => <TeacherHomework session={session} />}</Stack.Screen>
      <Stack.Screen name="Classes">{() => <TeacherClasses session={session} />}</Stack.Screen>
      <Stack.Screen name="Leave">{() => <TeacherLeave session={session} />}</Stack.Screen>
      <Stack.Screen name="Items">{() => <TeacherItems session={session} />}</Stack.Screen>
      <Stack.Screen name="Buses">{() => <TeacherBuses session={session} />}</Stack.Screen>
      <Stack.Screen name="Account">{() => <TeacherAccount session={session} />}</Stack.Screen>
      {/* One-to-one chats with parents; the whole-class Messages tab stays as it is. */}
      <Stack.Screen name="Chats">
        {() => <ChatList tint={tint} blurb="With parents of learners you teach, and your colleagues." empty="Start a chat with the parent of a learner you teach, or a colleague at the school. For the whole class, use Messages." />}
      </Stack.Screen>
      <Stack.Screen name="ChatThread">{() => <ChatThread tint={tint} />}</Stack.Screen>
      <Stack.Screen name="Visitors">{() => <TeacherVisitors session={session} />}</Stack.Screen>
      <Stack.Screen name="Performance">{() => <TeacherPerformance session={session} />}</Stack.Screen>
      <Stack.Screen name="ReportCards">{() => <TeacherReportCards session={session} />}</Stack.Screen>
      <Stack.Screen name="Bloom">{() => <TeacherBloom session={session} />}</Stack.Screen>
      <Stack.Screen name="LiveClass">{() => <TeacherLiveClass session={session} />}</Stack.Screen>
    </Stack.Navigator>
  );
}

export function Navigation({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  // Registers and marks saved on this phone go out as soon as the app opens, not only when a screen asks.
  useQueueSync(session.profileId);
  // Tapping a push opens what it is about.
  useEffect(() => listenForPushTaps((target) => { void openPushTarget(target); }), []);

  return (
    <CallProvider profileId={session.profileId}>
    <View style={{ flex: 1 }}>
    <NavigationContainer ref={navRef} onReady={() => { const run = afterReady; afterReady = null; run?.(); }}>
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
        }}
      >
        <Tab.Screen name="Attendance" options={tabIcon(SquareCheck)}>
          {() => <TeacherAttendance session={session} />}
        </Tab.Screen>
        <Tab.Screen name="Gradebook" options={tabIcon(Table2)}>
          {() => <TeacherGradebook session={session} />}
        </Tab.Screen>
        <Tab.Screen name="Messages" options={tabIcon(Mail)}>
          {() => <TeacherMessages session={session} />}
        </Tab.Screen>
        <Tab.Screen name="Notices" options={tabIcon(Bell)}>
          {() => <TeacherNotices session={session} />}
        </Tab.Screen>
        <Tab.Screen name="More" options={tabIcon(Menu)}>
          {() => <MoreStack session={session} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
    {/* Over whatever screen is open: someone has come to see this teacher. */}
    <VisitAlerts
      tenantId={session.tenantId}
      profileId={session.profileId}
      onOpen={() => { if (navRef.isReady()) navRef.navigate("More", { screen: "Visitors" }); }}
    />
    </View>
    </CallProvider>
  );
}
