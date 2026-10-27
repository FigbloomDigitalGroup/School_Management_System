import { useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, Text, TouchableOpacity, View, type GestureResponderEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import { normaliseStrokes, SIGNATURE_BOX, type Stroke } from "@figbloom/shared";
import { s, t } from "../theme";

type Point = { x: number; y: number };

const INK = "#14296B";

/** The points as an SVG path; a single tap becomes a dot. */
function pathOf(points: Point[]): string {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${first.x.toFixed(1)} ${first.y.toFixed(1)}`;
  if (rest.length === 0) d += ` L${(first.x + 0.1).toFixed(1)} ${first.y.toFixed(1)}`;
  for (const p of rest) d += ` L${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  return d;
}

/**
 * A box to sign in with a finger. Reports the signature as strokes in the
 * shared signature box (signatures.ts), or null once cleared, so the same
 * mark draws the same way on the phone, the web and a PDF. onDrawing lets a
 * scrolling parent stop scrolling while a stroke is in progress.
 */
export function SignaturePad({ onChange, onDrawing, disabled }: {
  onChange: (strokes: Stroke[] | null) => void;
  onDrawing?: (drawing: boolean) => void;
  disabled?: boolean;
}) {
  const strokes = useRef<Point[][]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [, redraw] = useState(0);
  // The responder is made once, so it reads the latest props and size from here.
  const live = useRef({ disabled, size, onChange, onDrawing });
  live.current = { disabled, size, onChange, onDrawing };

  const responder = useMemo(() => {
    // Everything on top of the pad ignores touches, so these are relative to the pad itself.
    const at = (e: GestureResponderEvent): Point => ({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
    const finish = () => {
      const { size: pad, onChange: report, onDrawing: drawing } = live.current;
      drawing?.(false);
      const out = normaliseStrokes(strokes.current, pad.width, pad.height);
      report(out.length ? out : null);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => !live.current.disabled,
      onMoveShouldSetPanResponder: () => !live.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        live.current.onDrawing?.(true);
        strokes.current = [...strokes.current, [at(e)]];
        redraw((n) => n + 1);
      },
      onPanResponderMove: (e) => {
        strokes.current[strokes.current.length - 1]?.push(at(e));
        redraw((n) => n + 1);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, []);

  function clear() {
    strokes.current = [];
    redraw((n) => n + 1);
    onChange(null);
  }

  const empty = strokes.current.length === 0;

  return (
    <View>
      <View style={{ aspectRatio: SIGNATURE_BOX.width / SIGNATURE_BOX.height, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, backgroundColor: "#fff", overflow: "hidden" }}>
        <View
          accessibilityLabel="Signature box: sign with your finger"
          style={{ flex: 1 }}
          onLayout={(e) => setSize({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })}
          {...responder.panHandlers}
        >
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <Svg width="100%" height="100%">
              {strokes.current.map((points, i) => (
                <Path key={i} d={pathOf(points)} fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
              ))}
            </Svg>
          </View>
          <View pointerEvents="none" style={{ position: "absolute", left: 24, right: 24, bottom: "22%", borderBottomWidth: 1, borderStyle: "dashed", borderBottomColor: t.appSurface.line }} />
          {empty && <View pointerEvents="none" style={{ position: "absolute", left: 24, top: 12 }}><Text style={s.faint}>Sign here</Text></View>}
        </View>
      </View>
      <TouchableOpacity accessibilityRole="button" disabled={disabled || empty} onPress={clear} style={{ alignSelf: "flex-end", minHeight: 36, justifyContent: "center", opacity: disabled || empty ? 0.4 : 1 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: t.appSurface.inkMuted }}>Clear</Text>
      </TouchableOpacity>
    </View>
  );
}
