import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "react-native";
import { Navigation } from "./src/navigation";
import { accentFor } from "./src/theme";

/**
 * Role and school come from the session, not the URL — mobile has no path to
 * read a tenant slug from, so it is baked in at sign-in.
 */
const SESSION = { role: "parent" as const, accent: "#7A1F2B" };

export default function App() {
  const a = accentFor(SESSION.accent);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={a.deep} />
      <Navigation role={SESSION.role} accent={SESSION.accent} />
    </SafeAreaProvider>
  );
}
