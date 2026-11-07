import { Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { ADMIN_AREA_INFO, SITE_ORIGIN, fetchCoverageThisWeek, fetchLatestRegisters, fetchSchoolOverview, homeRouteFor, phoneConsolesFor } from "@figbloom/shared";
import { Skeleton } from "../../components/Skeleton";
import { useConsoleSwitch } from "../../lib/consoleSwitch";
import type { StaffSession } from "../../lib/staffSession";
import { useLoad } from "../../lib/useLoad";
import { accentFor } from "../../theme";
import { Button } from "../../ui/Button";
import { ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";
import { CoverageSection } from "./CoverageSection";
import { LatestRegistersSection, OverviewSections, type OpenRegisterHandler } from "./Overview";

/** Where the school's admin console lives on the web: everything the phone does not do yet is there. */
export const webConsoleUrl = (slug: string): string => `${SITE_ORIGIN}${homeRouteFor("school_admin", slug)}`;

/** Placeholders shaped like the sections on their way, so a slow network reads as "coming" and not "empty". */
function LoadingSections() {
  const { s } = useTheme();
  return (
    <View accessibilityLabel="Loading" style={{ gap: 10 }}>
      <Skeleton width="40%" height={11} />
      <Skeleton width="90%" height={13} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 }}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={[s.card, { flexBasis: "47%", flexGrow: 1, padding: 14, gap: 8 }]}>
            <Skeleton width="50%" height={11} />
            <Skeleton width="40%" height={22} />
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * The admin side's first screen. A full admin opens on the overview a principal reads first (attendance by class,
 * fees, what needs them); a teacher or other staff member sees the areas they were given, and the registers when one
 * of them is attendance. The database checks every area again (has_perm), so this only says what to expect. Below it,
 * the way to the rest on the web.
 */
export function AdminHome({ session, onOpenRegister }: { session: StaffSession; onOpenRegister: OpenRegisterHandler }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { canSwitch, switchTo } = useConsoleSwitch();
  const access = phoneConsolesFor(session.role, session.adminAreas).admin;
  const full = access === "all";
  const areas = access === "all" || !access ? [] : access;

  // A full admin reads the whole school's overview. Someone who holds the attendance area reads the registers.
  const overview = useLoad(full ? () => fetchSchoolOverview(session.tenantId) : null, session.tenantId);
  const registers = useLoad(!full && areas.includes("attendance") ? () => fetchLatestRegisters(session.tenantId) : null, session.tenantId);
  // Periods this week whose teacher is on approved leave (a full admin's, as on the web Dashboard). It never holds the overview back.
  const coverage = useLoad(full ? () => fetchCoverageThisWeek(session.tenantId) : null, session.tenantId);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>{session.school.name}</Text>
        <Text style={s.headerSub}>{session.title ? `${session.fullName} · ${session.title}` : session.fullName}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16 }}
        refreshControl={
          <RefreshControl
            refreshing={overview.refreshing || registers.refreshing || coverage.refreshing}
            onRefresh={() => void Promise.all([overview.refresh(), registers.refresh(), coverage.refresh()])}
          />
        }
      >
        {full ? (
          overview.error ? (
            <ErrorState title="Couldn't load the overview" body={overview.error} onRetry={overview.retry} />
          ) : overview.data ? (
            <OverviewSections
              session={session}
              data={overview.data}
              onOpen={onOpenRegister}
              afterNeeds={
                coverage.data ? (
                  <CoverageSection session={session} items={coverage.data} onChanged={() => void coverage.refresh()} />
                ) : coverage.error ? (
                  <View style={[s.card, { marginTop: 14 }]}>
                    <Text style={s.small}>Couldn't check who needs cover this week: {coverage.error}</Text>
                    <Button variant="secondary" label="Try again" onPress={coverage.retry} style={{ marginTop: 10 }} />
                  </View>
                ) : null
              }
            />
          ) : (
            <LoadingSections />
          )
        ) : (
          <>
            <Text style={[s.h2, { marginBottom: 8 }]}>Your access</Text>
            {areas.map((area) => (
              <View key={area} style={[s.card, { marginBottom: 8 }]}>
                <Text style={{ color: t.appSurface.ink, fontSize: 13.5, fontWeight: "500" }}>{ADMIN_AREA_INFO[area].label}</Text>
                <Text style={s.faint}>{ADMIN_AREA_INFO[area].allows}</Text>
              </View>
            ))}
            {areas.includes("attendance") && (
              registers.error ? (
                <ErrorState title="Couldn't load the registers" body={registers.error} onRetry={registers.retry} />
              ) : registers.data ? (
                <LatestRegistersSection data={registers.data} onOpen={onOpenRegister} />
              ) : (
                <View style={{ marginTop: 14 }}><LoadingSections /></View>
              )
            )}
          </>
        )}

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>On this phone</Text>
        <View style={s.card}>
          <Text style={s.small}>
            More admin screens are being added to this app one at a time. Until then, the web console has all of
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
