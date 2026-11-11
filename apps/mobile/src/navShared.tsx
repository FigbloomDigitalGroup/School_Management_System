import { DarkTheme, DefaultTheme } from "@react-navigation/native";
import type { LucideIcon } from "lucide-react-native";
import { themes } from "./theme";

/**
 * React Navigation's own colours: the page behind a transition, the tab bar's card and its edge. Light is the
 * library's default with the app's page colour; dark is the app's dark surfaces, so a screen sliding in never
 * flashes a light page. Shared by the family/driver navigator and the teacher's.
 */
export const NAV_THEME = {
  light: { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: themes.light.t.appSurface.page } },
  dark: {
    ...DarkTheme,
    colors: {
      ...DarkTheme.colors,
      primary: themes.dark.t.appSurface.ink,
      background: themes.dark.t.appSurface.page,
      card: themes.dark.t.appSurface.card,
      text: themes.dark.t.appSurface.ink,
      border: themes.dark.t.appSurface.line,
    },
  },
};

export const tabIcon = (Icon: LucideIcon) => ({
  tabBarIcon: ({ color, size }: { color: string; size: number }) => <Icon color={color} size={size} />,
});
