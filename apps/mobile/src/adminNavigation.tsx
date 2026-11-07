import { NavigationContainer } from "@react-navigation/native";
import { View } from "react-native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { Home, Menu, User } from "lucide-react-native";
import { phoneConsolesFor } from "@figbloom/shared";
import { adminScreensFor, type AdminScreen } from "./adminScreens";
import { CallProvider } from "./calls/CallProvider";
import type { StaffSession } from "./lib/staffSession";
import { useHrApprover } from "./lib/useHrApprover";
import { accentFor, fontSize } from "./theme";
import { NAV_THEME, tabIcon } from "./navShared";
import { AdminAnnouncements } from "./screens/admin/Announcements";
import { CallLog } from "./screens/admin/CallLog";
import { ClassRegister } from "./screens/admin/ClassRegister";
import { AdminHome } from "./screens/admin/Home";
import { AdminLeave } from "./screens/admin/Leave";
import { LeaveToApprove } from "./screens/admin/LeaveToApprove";
import { AdminMore } from "./screens/admin/More";
import type { OpenRegister } from "./screens/admin/Overview";
import { SchoolChats } from "./screens/admin/SchoolChats";
import { ChatList } from "./screens/chat/ChatList";
import { ChatThread } from "./screens/chat/ChatThread";
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

/** The admin screens listed under More, one stack so each opens over the list with a way back. */
function MoreStack({ session, screens }: { session: StaffSession; screens: readonly AdminScreen[] }) {
  const tint = accentFor(session.accent).deep;
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="MoreMenu">
        {({ navigation }: { navigation: { navigate: (screen: string) => void } }) => <AdminMore session={session} screens={screens} onOpen={(to) => navigation.navigate(to)} />}
      </Stack.Screen>
      <Stack.Screen name="Announcements">{() => <AdminAnnouncements session={session} />}</Stack.Screen>
      {/* The office's own chats, as the teacher has them; a chat opens in ChatThread, with the call buttons. */}
      <Stack.Screen name="Chats">
        {() => <ChatList tint={tint} blurb="With parents and staff at the school." empty="Start a chat with any parent or member of staff at the school." />}
      </Stack.Screen>
      <Stack.Screen name="ChatThread">{() => <ChatThread tint={tint} />}</Stack.Screen>
      {/* Every chat in the school, read only: opens the same thread screen in oversight. */}
      <Stack.Screen name="SchoolChats">
        {({ navigation }: { navigation: { navigate: (screen: string, params?: object) => void } }) => (
          <SchoolChats session={session} onOpen={(chat) => navigation.navigate("ChatThread", chat)} />
        )}
      </Stack.Screen>
      <Stack.Screen name="CallLog">{() => <CallLog session={session} />}</Stack.Screen>
      <Stack.Screen name="Leave">{() => <AdminLeave session={session} />}</Stack.Screen>
      {/* Leave waiting on this person in Figbloom HR; listed only for an approver at a school whose leave runs there. */}
      <Stack.Screen name="LeaveToApprove">{() => <LeaveToApprove session={session} />}</Stack.Screen>
    </Stack.Navigator>
  );
}

/**
 * The school's admin console on the phone, for a school admin and for a teacher or other staff member who
 * holds admin areas. It opens on Home, with More (the admin screens this person's areas open; no tab when there
 * are none yet) and Account beside it. Screens are added a part at a time (fees, people, leave and the rest).
 */
export function AdminNavigation({ session }: { session: StaffSession }) {
  const { t, scheme, accentInk } = useTheme();
  const a = accentFor(session.accent);
  // Asked of HR once, so the More list never waits on it: the "Leave to approve" row appears when the answer is yes.
  const hrApprover = useHrApprover(session.profileId);
  const screens = adminScreensFor(phoneConsolesFor(session.role, session.adminAreas).admin, hrApprover);

  return (
    // Calls ring on the admin side too: the office is rung by parents, and rings them from a chat.
    <CallProvider profileId={session.profileId}>
    <View style={{ flex: 1 }}>
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
        {screens.length > 0 && (
          <Tab.Screen name="More" options={tabIcon(Menu)}>
            {() => <MoreStack session={session} screens={screens} />}
          </Tab.Screen>
        )}
        {/* The teacher's own Account screen: the same name, phone, photo, appearance, lock and sign-out for anyone on staff. */}
        <Tab.Screen name="Account" options={tabIcon(User)}>
          {() => <TeacherAccount session={session} back={false} />}
        </Tab.Screen>
      </Tab.Navigator>
    </NavigationContainer>
    </View>
    </CallProvider>
  );
}
