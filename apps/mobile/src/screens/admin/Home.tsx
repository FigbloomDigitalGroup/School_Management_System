import { Linking, ScrollView, Text, View } from "react-native";
import { ADMIN_AREA_INFO, SITE_ORIGIN, homeRouteFor, phoneConsolesFor } from "@figbloom/shared";
import { useConsoleSwitch } from "../../lib/consoleSwitch";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor } from "../../theme";
import { Button } from "../../ui/Button";
import { useTheme } from "../../ui/ThemeContext";

/** Where the school's admin console lives on the web: everything the phone does not do yet is there. */
export const webConsoleUrl = (slug: string): string => `${SITE_ORIGIN}${homeRouteFor("school_admin", slug)}`;

/**
 * The admin side's first screen: who is signed in, what this person may do at the school, and the way to the
 * rest on the web. A full admin has all of the admin console; a teacher or other staff member has the areas they
 * were given, and the database checks every one of them again (has_perm), so this only says what to expect.
 */
export function AdminHome({ session }: { session: StaffSession }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { canSwitch, switchTo } = useConsoleSwitch();
  const access = phoneConsolesFor(session.role, session.adminAreas).admin;
  const areas = access === "all" || !access ? [] : access;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>{session.school.name}</Text>
        <Text style={s.headerSub}>{session.title ? `${session.fullName} · ${session.title}` : session.fullName}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={[s.h2, { marginBottom: 8 }]}>Your access</Text>
        {access === "all" ? (
          <View style={s.card}>
            <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "500" }}>Everything in the admin console</Text>
            <Text style={s.faint}>All of the school's admin areas, and its settings, reports and who can do what.</Text>
          </View>
        ) : (
          areas.map((area) => (
            <View key={area} style={[s.card, { marginBottom: 8 }]}>
              <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "500" }}>{ADMIN_AREA_INFO[area].label}</Text>
              <Text style={s.faint}>{ADMIN_AREA_INFO[area].allows}</Text>
            </View>
          ))
        )}

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>On this phone</Text>
        <View style={s.card}>
          <Text style={s.small}>
            The admin screens are being added to this app one at a time. Until then, the web console has all of
            it, signed in with the same login.
          </Text>
          <Button
            variant="secondary"
            label="Open the web console"
            onPress={() => void Linking.openURL(webConsoleUrl(session.school.slug)).catch(() => {})}
            style={{ marginTop: 12 }}
          />
        </View>

        {canSwitch && (
          <Button variant="secondary" label="Back to teacher screens" onPress={() => switchTo("own")} style={{ marginTop: 16 }} />
        )}
      </ScrollView>
    </View>
  );
}
