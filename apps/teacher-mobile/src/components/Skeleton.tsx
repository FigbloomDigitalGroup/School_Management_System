import { useEffect, useRef } from "react";
import { Animated, type DimensionValue, type StyleProp, type ViewStyle } from "react-native";
import { motion } from "../theme";
import { useReducedMotion } from "../ui/useReducedMotion";
import { useTheme } from "../ui/ThemeContext";

/**
 * A placeholder shaped like the content that is on its way. Shown only on
 * first load — so a slow network reads as "coming", never as "empty", "0"
 * or a blank field.
 */
export function Skeleton({ width = "100%", height = 12, radius = 6, style }: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTheme();
  const pulse = useRef(new Animated.Value(0.5)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    // Still, at the midpoint of the pulse, rather than flashing for someone who asked for no motion.
    if (reduceMotion) { pulse.setValue(0.75); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: motion.pulse, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.5, duration: motion.pulse, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: t.appSurface.line, opacity: pulse }, style]}
    />
  );
}
