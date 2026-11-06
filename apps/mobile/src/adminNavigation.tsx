import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Home, User } from "lucide-react-native";
import type { StaffSession } from "./lib/staffSession";
import { accentFor, fontSize } from "./theme";
import { NAV_THEME, tabIcon } from "./navShared";
import { ClassRegister } from "./screens/admin/ClassRegister";
import { AdminHome } from "./screens/admin/Home";
import type { OpenRegister } from "./screens/admin/Overview";
import { TeacherAccount } from "./screens/teacher/Account";
import { useTheme } from "./ui/ThemeContext";

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

/** Home is the front of the console: the screens it leads to (a class's register, and those still to come) open over it. */
function HomeStack({ session }: { session: StaffSession }) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Overview">
        {({ navigation }: { navigation: { navigate: (screen: string, params?: object) => void } }) => <AdminHome session={session} onOpenRegister={(register) => navigation.navigate("ClassRegister", register)} />}
      </Stack.Screen>
      <Stack.Screen name="ClassRegister">
        {({ route }: { route: unknown }) => <ClassRegister session={session} route={route as { params?: OpenRegister }} />}
      </Stack.Screen>
    </Stack.Navigator>
  );
}

/**
 * The school's admin console on the phone, for a school admin and for a teacher or other staff member who
 * holds admin areas. It opens on Home, with Account beside it; the admin screens (fees, people, leave and the
 * rest) are added to Home a part at a time, each shown only to the people whose areas open it.
 */
export function AdminNavigation({ session }: { session: StaffSession }) {
  const { t, scheme, accentInk } = useTheme();
  const a = accentFor(session.accent);

  return (
    <NavigationContainer theme={NAV_THEME[scheme]}>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: accentInk(a.deep),
          tabBarInactiveTintColor: t.appSurface.inkFaint,
          tabBarLabelStyle: { fontSize: fontSize.micro, fontWeight: "600" },
          // The bar is a fixed height, so its labels stay put under large system text;
          // it also steps aside for the keyboard instead of eating a third of a form.
          tabBarAllowFontScaling: false,
          tabBarHideOnKeyboard: true,
          tabBarStyle: { height: 62, paddingBottom: 8, paddingTop: 6 },
        }}
      >
        <Tab.Screen name="Home" options={tabIcon(Home)}>
          {() => <HomeStack session={session} />}
        </Tab.Screen>
        {/* The teacher's own Account screen: the same name, phone, photo, appearance, lock and sign-out for anyone on staff. */}
        <Tab.Screen name="Account" options={tabIcon(User)}>
          {() => <TeacherAccount session={session} back={false} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
  );
}
