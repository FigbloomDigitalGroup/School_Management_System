# Phone Apps — The UI Kit and Light/Dark Theme

This covers how the two phone apps (`apps/mobile`: parent, student, driver; `apps/teacher-mobile`: teacher) are drawn: the shared kit, the design tokens, and how light and dark work. Read it before adding a screen.

## TL;DR

- Colours come from **one place**, `packages/shared/src/tokens.ts`, in two sets: `appSurface`/`brand`/`status` (light) and `appSurfaceDark`/`brandDark`/`statusDark` (dark). Every colour a screen uses is a key in those sets. `tokens.test.ts` holds both sets to WCAG AA (4.5:1 for text).
- A component gets its colours from **`useTheme()`**, never from a module constant: `const { t, s, scheme, accentInk, fieldLine } = useTheme();`. `t` is the colour tokens, `s` the shared styles (`s.card`, `s.h2`, ...), `scheme` is `"light"` or `"dark"`.
- Light or dark is chosen once, in `ThemeProvider` (mounted in each app's `App.tsx`): the person's pick from Account > Appearance (Same as phone / Light / Dark, remembered), else the phone's setting. Changing it re-renders live; nothing restarts.
- The kit lives in `src/theme.ts` and `src/ui/` and is **byte-identical in both apps** (there is no shared React Native package). `scripts/phoneUiSync.test.ts` fails and names the file that drifted. Change both or neither.

## The kit

| What | Where | Notes |
| --- | --- | --- |
| Tap target | `ui/Tap.tsx` | Pressable with an Android ripple clipped to rounded corners and a 0.98 press scale; role defaults to `button`. Skips the scale under "remove animations". |
| Button | `ui/Button.tsx` | `primary`, `secondary`, `quiet`; `loading` keeps the label's width. |
| Text field | `ui/Field.tsx` | Label above, 3:1 edge, error with an icon and a live-region announcement. |
| Empty / error state | `ui/StateView.tsx` | `EmptyState`, `ErrorState` (with a retry). |
| Skeleton | `components/Skeleton.tsx` | Pulses; still under reduced motion. |
| Theme | `ui/ThemeContext.tsx`, `ui/scheme.ts` | Provider, `useTheme`, `themedStyles`, the pure light/dark decision. |
| Appearance control | `ui/AppearanceSetting.tsx` | The Account section. Radio group, check mark as well as colour. |
| Scale constants | `theme.ts` | `fontSize`, `radius`, `space`, `HIT` (44dp minimum), `motion`. Same in both schemes. |

## Writing a component that is right in both schemes

- **In a component:** `const { t, s } = useTheme();` and use `t.appSurface.ink`, `t.status.okBg`, `s.card` as before. Never import `t` or `s` from `theme.ts`; they are not exported, so a stray import will not compile.
- **A stylesheet with colours in it:** `const useStyles = themedStyles(({ t }) => ({ box: { backgroundColor: t.appSurface.card } }));` then `const styles = useStyles();` in the component. Each scheme's sheet is built once.
- **A module-level table of colours** (status to pill colours): `const TONE = perScheme((t) => ({ ok: { bg: t.status.okBg, ink: t.status.okInk } }));` and `TONE[scheme][key]` in the component.
- **A school's accent** (`accentFor(hex).deep`) is dark enough to carry a white label, which is why it cannot be read as text on a dark page. Use it as is for a **fill** (header band, primary button, bubble), and `accentInk(accent)` for the accent as **text, an icon, a spinner or an outline**. In light `accentInk` returns the colour unchanged. Anything that conveys data (a progress bar, a stripe) is ink, not a fill.
- **Every `<Text>` and `<TextInput>` sets its own colour.** Android's default text colour is resolved when a view is created, so unstyled text would keep the old scheme after a live switch. A `<Text>` nested inside another `<Text>` inherits, and should not set one. Do not write `color: x ? y : undefined`: `undefined` erases the colour.
- **Status colours** (`ok`, `warn`, `info`, `muted`, `bad`, `caution`, `live`) mean the same in every school and both schemes; add a token before inventing a hex. Hard-coded hex is for things that are the same in both schemes on purpose: white on an accent fill, signature paper, a map marker, the call screens.

## How dark reaches the parts the app does not draw

- `Appearance.setColorScheme` (React Native) sets Android's night mode for the app, so `Alert` dialogs and text-selection handles follow the pick (seen on the emulator: the dialog is dark). The on-screen keyboard does not: it follows the phone's own setting, which an app cannot override. This needs `AppTheme` to be DayNight (`res/values/styles.xml`), which is why that theme changed.
- `res/values/colors.xml` and `res/values-night/colors.xml` define `app_page`, the window background, so there is no light seam under a screen transition or the keyboard.
- React Navigation's own colours (transition page, tab bar card and edge) come from `NAV_THEME` in `navigation.tsx`.
- The parent app's bus map uses `components/mapStyle.ts` (a warm night style) in dark.
- The teacher charts' palette is `components/charts/tokens.ts` (`VIZ`, `BAND_COLORS`), per scheme.
- Following the phone: the app remembers what the phone was set to before it overrode it, so going from Dark back to "Same as phone" is instant instead of waiting for Android to report it.

## Not done on purpose, and why

- **Material You dynamic colour.** Each school's accent is its brand, so the phone's wallpaper colours would replace it. Revisit only if a school asks.
- **A dark splash on the parent app.** Its splash logo is dark green on white and would nearly vanish on dark. It needs a light variant of the logo.
- **Lifting accent fills in dark.** A school's primary buttons stay the school's deep colour with a white label (13:1 or better). On a dark page they are calmer than Material's light-tone buttons. If that is wanted, add an `accentFill` beside `accentInk`.
- **Edge-to-edge and predictive back, haptics, Reanimated.** Unchanged; see the notes in the PR that introduced the kit.

## Checking a change

- `npm run typecheck`, `npm run lint`, `npm run test:unit` (this includes the kit sync test and the contrast tests).
- Look at it in **both** schemes, on an emulator: Account > Appearance, or `adb shell cmd uimode night yes|no` with "Same as phone". Light should be pixel-identical to before for anything you did not mean to change.
