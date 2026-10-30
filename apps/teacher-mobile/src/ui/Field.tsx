import { forwardRef, useState } from "react";
import { StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from "react-native";
import { CircleAlert, Eye, EyeOff } from "lucide-react-native";
import { fieldLine, fontSize, HIT, s, t } from "../theme";
import { Tap } from "./Tap";

export interface FieldProps extends Omit<TextInputProps, "style"> {
  label: string;
  /** Quiet help under the field. An `error` replaces it. */
  hint?: string;
  error?: string;
  /** A password: dots, with a show/hide control inside the field. */
  secret?: boolean;
  /** Edge colour while the field has focus. Ink by default, which reads on any school's accent. */
  focusColor?: string;
  /** The wrapper around label, field and message: for spacing. */
  style?: StyleProp<ViewStyle>;
}

/**
 * A labelled input, one line or (with `multiline`) a few. The label sits above, always, so it never
 * vanishes under what is typed. The edge is 3:1 against the page (the divider
 * colour is not), grows to 2px on focus and turns warn-coloured with an icon on
 * error (never colour alone), and the error is announced to a screen reader the
 * moment it appears. The 2px edge takes 1px from the padding, so nothing moves.
 * Forwards its ref to the TextInput, to focus the next field from "next".
 */
export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, hint, error, secret = false, focusColor = t.appSurface.ink, style, onFocus, onBlur, accessibilityLabel, ...input },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [shown, setShown] = useState(false);
  const wide = focused || !!error;
  const edge = error ? t.status.warnInk : focused ? focusColor : fieldLine;

  return (
    <View style={style}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.box, { borderColor: edge, borderWidth: wide ? 2 : 1 }]}>
        <TextInput
          {...input}
          ref={ref}
          accessibilityLabel={accessibilityLabel ?? label}
          placeholderTextColor={t.appSurface.inkFaint}
          secureTextEntry={secret && !shown}
          onFocus={(e) => { setFocused(true); onFocus?.(e); }}
          onBlur={(e) => { setFocused(false); onBlur?.(e); }}
          style={[styles.input, input.multiline && styles.multiline, { paddingLeft: wide ? 13 : 14 }]}
        />
        {secret && (
          <Tap
            accessibilityLabel={shown ? "Hide password" : "Show password"}
            onPress={() => setShown((v) => !v)}
            pressedScale={1}
            style={styles.toggle}
          >
            {shown ? <EyeOff size={20} color={t.appSurface.inkMuted} /> : <Eye size={20} color={t.appSurface.inkMuted} />}
          </Tap>
        )}
      </View>
      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.message}>
          <CircleAlert size={14} color={t.status.warnInk} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : hint ? (
        <Text style={[s.faint, styles.hint]}>{hint}</Text>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  label: { fontSize: fontSize.small, fontWeight: "600", color: t.appSurface.ink, marginBottom: 6 },
  box: { flexDirection: "row", alignItems: "center", borderRadius: t.radius.lg, backgroundColor: t.appSurface.card },
  input: { flex: 1, minHeight: 48, paddingVertical: 0, paddingRight: 8, fontSize: fontSize.lead, color: t.appSurface.ink, textAlignVertical: "center" },
  /** Three lines tall to start; the text grows it, and large system text only makes it taller. */
  multiline: { minHeight: 96, paddingVertical: 12, textAlignVertical: "top" },
  toggle: { ...HIT, alignItems: "center", justifyContent: "center", borderRadius: t.radius.lg },
  message: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 6 },
  errorText: { flex: 1, fontSize: fontSize.caption, lineHeight: 17, color: t.status.warnInk },
  hint: { marginTop: 6 },
});
