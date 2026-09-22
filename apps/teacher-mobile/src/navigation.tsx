import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { Text } from "react-native";
import { accentFor } from "./theme";

import { TeacherAttendance } from "./screens/teacher/Attendance";
import { TeacherGradebook } from "./screens/teacher/Gradebook";
import { TeacherMessages } from "./screens/teacher/Messages";
import { TeacherAccount } from "./screens/teacher/Account";

const Tab = createBottomTabNavigator();

const glyph = (g: string) => ({ tabBarIcon: () => <Text style={{ fontSize: 17 }}>{g}</Text> });

export interface TeacherSession {
  profileId: string;
  tenantId: string;
  fullName: string;
  accent: string;
  country: string;
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
        <Tab.Screen name="Attendance" options={glyph("✓")}>
          {() => <TeacherAttendance session={session} />}
        </Tab.Screen>
        <Tab.Screen name="Gradebook" options={glyph("▦")}>
          {() => <TeacherGradebook session={session} />}
        </Tab.Screen>
        <Tab.Screen name="Messages" options={glyph("◉")}>
          {() => <TeacherMessages session={session} />}
        </Tab.Screen>
        <Tab.Screen name="Account" options={glyph("◎")}>
          {() => <TeacherAccount session={session} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}
