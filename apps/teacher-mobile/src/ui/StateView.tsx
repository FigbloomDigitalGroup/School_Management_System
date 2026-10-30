import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Inbox, TriangleAlert, type LucideIcon } from "lucide-react-native";
import { fontSize, s, t } from "../theme";
import { Button } from "./Button";

/**
 * What a screen shows instead of content. Empty and failed are different
 * messages — "nothing here yet" must never read as "it broke", nor the
 * reverse — but they share a shape, so a person learns it once.
 */
function StateBlock({ icon: Icon, title, body, action, alert }: {
  icon: LucideIcon;
  title: string;
  body?: string;
  action?: ReactNode;
  alert?: boolean;
}) {
  return (
    <View
      accessible
      accessibilityRole={alert ? "alert" : undefined}
      accessibilityLiveRegion={alert ? "polite" : undefined}
      style={styles.block}
    >
      <View style={styles.tile}>
        <Icon size={26} color={t.appSurface.inkMuted} />
      </View>
      <Text style={[s.h2, styles.title]}>{title}</Text>
      {!!body && <Text style={[s.small, styles.body]}>{body}</Text>}
      {action}
    </View>
  );
}

/** Nothing to show yet, and that is fine: say what will appear here, and what to do if there is a next step. */
export function EmptyState({ icon = Inbox, title, body, action }: { icon?: LucideIcon; title: string; body?: string; action?: ReactNode }) {
  return <StateBlock icon={icon} title={title} body={body} action={action} />;
}

/** The load failed. Always offers the retry when the screen can do one, so nobody has to leave and come back. */
export function ErrorState({ title = "Couldn't load this", body = "Check your connection, then try again.", onRetry }: { title?: string; body?: string; onRetry?: () => void }) {
  return (
    <StateBlock
      alert
      icon={TriangleAlert}
      title={title}
      body={body}
      action={onRetry ? <Button variant="secondary" label="Try again" onPress={onRetry} style={styles.retry} /> : undefined}
    />
  );
}

const styles = StyleSheet.create({
  block: { alignItems: "center", paddingVertical: 32, paddingHorizontal: 24 },
  tile: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: t.appSurface.lineSoft },
  title: { marginTop: 14, fontSize: fontSize.title, textAlign: "center" },
  body: { marginTop: 6, textAlign: "center", maxWidth: 320 },
  retry: { marginTop: 18, minWidth: 160 },
});
