import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { BarChart3, Bell, Calendar, ClipboardList, Home, Mail, User, Wallet, type LucideIcon } from "lucide-react-native";
import { accentFor } from "./theme";
import { useChild, useMessages } from "./data";
import { useStudentData } from "./studentData";

import { ParentHome } from "./screens/parent/Home";
import { ParentFees } from "./screens/parent/Fees";
import { ParentPay } from "./screens/parent/Pay";
import { ParentResults } from "./screens/parent/Results";
import { ParentInbox } from "./screens/parent/Inbox";
import { ParentAccount } from "./screens/parent/Account";
import { StudentToday } from "./screens/student/Today";
import { StudentTimetable } from "./screens/student/Timetable";
import { StudentWork } from "./screens/student/Work";
import { StudentResults } from "./screens/student/Results";
import { StudentNotices } from "./screens/student/Notices";
import { StudentAccount } from "./screens/student/Account";
import { DriverTrip } from "./screens/driver/Trip";

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
  const a = accentFor(accent);

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
        </Stack.Navigator>
      ) : (
        <StudentTabs a={a} />
      )}
    </NavigationContainer>
  );
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
      <Tab.Screen
        name="Inbox"
        component={ParentInbox}
        options={{ ...tabIcon(Mail), tabBarBadge: unread || undefined }}
      />
      <Tab.Screen name="Account" component={ParentAccount} options={tabIcon(User)} />
    </Tab.Navigator>
  );
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
