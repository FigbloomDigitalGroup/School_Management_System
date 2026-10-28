import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { BarChart3, Bell, Bus, Calendar, ClipboardList, Home, Mail, User, Wallet, type LucideIcon } from "lucide-react-native";
import { accentFor } from "./theme";
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

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const tabIcon = (Icon: LucideIcon) => ({
  tabBarIcon: ({ color, size }: { color: string; size: number }) => <Icon color={color} size={size} />,
});

interface NavigationProps {
  role: "parent" | "student" | "driver";
  accent: string;
  /** Only present (and only needed) when role is "driver". */
  driver?: { driverId: string; tenantId: string; fullName: string };
}

/** Which app opens is decided by the signed-in role, not by a picker. */
export function Navigation({ role, accent, driver }: NavigationProps) {
  if (role === "driver" && driver) {
    // A driver's screen is a single full-screen page (start/end trip), not a
    // console — no tabs, nothing else to navigate to.
    return <DriverTrip driverId={driver.driverId} tenantId={driver.tenantId} accent={accent} fullName={driver.fullName} />;
  }

  return (
    <NavigationContainer>
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
        tabBarInactiveTintColor: "#9A908E",
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: "600" },
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
        tabBarInactiveTintColor: "#9A908E",
        tabBarLabelStyle: { fontSize: 10.5, fontWeight: "600" },
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
