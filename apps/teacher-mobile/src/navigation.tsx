import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Bell, Mail, Menu, SquareCheck, Table2, type LucideIcon } from "lucide-react-native";
import { accentFor } from "./theme";

import { TeacherAttendance } from "./screens/teacher/Attendance";
import { TeacherGradebook } from "./screens/teacher/Gradebook";
import { TeacherMessages } from "./screens/teacher/Messages";
import { TeacherNotices } from "./screens/teacher/Notices";
import { TeacherMore } from "./screens/teacher/More";
import { TeacherTimetable } from "./screens/teacher/Timetable";
import { TeacherClasses } from "./screens/teacher/Classes";
import { TeacherLeave } from "./screens/teacher/Leave";
import { TeacherAccount } from "./screens/teacher/Account";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

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
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreMenu">{() => <TeacherMore session={session} />}</Stack.Screen>
      <Stack.Screen name="Timetable">{() => <TeacherTimetable session={session} />}</Stack.Screen>
      <Stack.Screen name="Classes">{() => <TeacherClasses session={session} />}</Stack.Screen>
      <Stack.Screen name="Leave">{() => <TeacherLeave session={session} />}</Stack.Screen>
      <Stack.Screen name="Account">{() => <TeacherAccount session={session} />}</Stack.Screen>
    </Stack.Navigator>
  );
}

export function Navigation({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: a.deep,
          tabBarInactiveTintColor: "#9A908E",
          tabBarLabelStyle: { fontSize: 10.5, fontWeight: "600" },
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
  );
}
