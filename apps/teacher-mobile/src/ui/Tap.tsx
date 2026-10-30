import { useRef } from "react";
import { Animated, Easing, Platform, Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { motion, PRESS_SCALE } from "../theme";
import { rippleFor } from "./color";
import { useReducedMotion } from "./useReducedMotion";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface TapProps extends Omit<PressableProps, "style"> {
  style?: StyleProp<ViewStyle>;
  /** Ripple colour. By default it follows the control's own background: a dark wash on light, a light one on dark. */
  ripple?: string;
  /** How far the control shrinks while held. 1 turns the shrink off. */
  pressedScale?: number;
}

/**
 * The one thing in the apps that is tapped. A drop-in for TouchableOpacity that
 * feels like Android: a ripple inside the control's bounds, and a slight
 * shrink (on the native thread) while the finger is down. Its role defaults to
 * "button"; pass another for a tab, a switch or a link. With animations turned
 * off in the phone's settings the shrink is skipped and the ripple stays.
 */
export function Tap({ style, ripple, pressedScale = PRESS_SCALE, accessibilityRole = "button", onPressIn, onPressOut, ...rest }: TapProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReducedMotion();

  const animateTo = (toValue: number) => {
    if (reduceMotion || pressedScale === 1) return;
    Animated.timing(scale, { toValue, duration: motion.press, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  };

  const flat = StyleSheet.flatten(style);
  // Android draws a ripple as a rectangle, so on a rounded control its corners would poke out past the
  // border. Clipping the control to its own shape fixes that. Android only: iOS has no ripple, and
  // clipping there would also cut off the shadow.
  const clip = Platform.OS === "android" && flat?.overflow === undefined && isRounded(flat) ? styles.clip : null;

  return (
    <AnimatedPressable
      {...rest}
      accessibilityRole={accessibilityRole}
      android_ripple={{ color: ripple ?? rippleFor(flat?.backgroundColor), foreground: true }}
      onPressIn={(e) => { animateTo(pressedScale); onPressIn?.(e); }}
      onPressOut={(e) => { animateTo(1); onPressOut?.(e); }}
      style={[style, clip, { transform: [{ scale }] }]}
    />
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden" },
});

function isRounded(style: ViewStyle | undefined): boolean {
  return !!style && !!(style.borderRadius || style.borderTopLeftRadius || style.borderTopRightRadius || style.borderBottomLeftRadius || style.borderBottomRightRadius);
}
