import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Text } from "react-native";
import { accentFor } from "./theme";

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

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const glyph = (g: string) => ({ tabBarIcon: () => <Text style={{ fontSize: 17 }}>{g}</Text> });

/** Which app opens is decided by the signed-in role, not by a picker. */
export function Navigation({ role, accent }: { role: "parent" | "student"; accent: string }) {
  const a = accentFor(accent);

  return (
    <NavigationContainer>
      {role === "parent" ? (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="ParentTabs">
            {() => (
              <Tab.Navigator
                screenOptions={{
                  headerShown: false,
                  tabBarActiveTintColor: a.deep,
                  tabBarInactiveTintColor: "#9A908E",
                  tabBarLabelStyle: { fontSize: 10.5, fontWeight: "600" },
                  tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6 },
                }}
              >
                <Tab.Screen name="Home" component={ParentHome} options={glyph("\u25C8")} />
                <Tab.Screen name="Fees" component={ParentFees} options={glyph("\u25A6")} />
                <Tab.Screen name="Results" component={ParentResults} options={glyph("\u25A4")} />
                <Tab.Screen name="Inbox" component={ParentInbox} options={glyph("\u25C9")} />
                <Tab.Screen name="Account" component={ParentAccount} options={glyph("\u25CE")} />
              </Tab.Navigator>
            )}
          </Stack.Screen>
          {/* Payment is a stack screen, not a tab — it must not be swiped away mid-prompt. */}
          <Stack.Screen name="Pay" component={ParentPay} options={{ presentation: "modal" }} />
        </Stack.Navigator>
      ) : (
        <Tab.Navigator
          screenOptions={{
            headerShown: false,
            tabBarActiveTintColor: a.deep,
            tabBarInactiveTintColor: "#9A908E",
            tabBarLabelStyle: { fontSize: 10.5, fontWeight: "600" },
            tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6 },
          }}
        >
          <Tab.Screen name="Today" component={StudentToday} options={glyph("\u25C8")} />
          <Tab.Screen name="Timetable" component={StudentTimetable} options={glyph("\u25F7")} />
          <Tab.Screen name="Work" component={StudentWork} options={glyph("\u270E")} />
          <Tab.Screen name="Results" component={StudentResults} options={glyph("\u25A4")} />
          <Tab.Screen name="Notices" component={StudentNotices} options={glyph("\u25C9")} />
        </Tab.Navigator>
      )}
    </NavigationContainer>
  );
}
