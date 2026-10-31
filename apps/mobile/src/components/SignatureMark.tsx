import { Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { CAPACITY_LABEL, SIGNATURE_BOX, signatureDate, strokeBounds, strokesToSvgPath, type StoredSignature } from "@figbloom/shared";
import { useTheme } from "../ui/ThemeContext";

const INK = "#14296B";

/** The mark alone: drawn strokes fitted to the space, or the typed name in a handwriting face. */
export function SignatureInk({ signature, height = 40 }: { signature: Pick<StoredSignature, "style" | "strokes" | "fullName">; height?: number }) {
  const b = signature.style === "drawn" && signature.strokes ? strokeBounds(signature.strokes) : null;
  if (b && signature.strokes) {
    const pad = 6;
    const w = b.width + pad * 2;
    const h = b.height + pad * 2;
    return (
      <Svg
        accessibilityLabel={`Signature of ${signature.fullName}`}
        viewBox={`${-pad} ${-pad} ${w} ${h}`}
        height={height}
        width={Math.min(height * (w / h), height * (SIGNATURE_BOX.width / SIGNATURE_BOX.height))}
      >
        <Path d={strokesToSvgPath(signature.strokes, { crop: true })} fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  return <Text style={{ fontFamily: "cursive", fontStyle: "italic", color: INK, fontSize: height * 0.55, lineHeight: height }}>{signature.fullName}</Text>;
}

/**
 * One signature as a family sees it: the mark over the line, then who, in
 * what capacity, and when. A document changed since signing says so, rather
 * than looking signed.
 */
export function SignatureMark({ signature }: { signature: StoredSignature }) {
  const { t, s } = useTheme();
  return (
    <View style={{ alignSelf: "flex-start", minWidth: 200 }}>
      <View style={{ height: 44, justifyContent: "flex-end", borderBottomWidth: 1, borderBottomColor: "rgba(34,26,27,0.4)", paddingBottom: 2 }}>
        <SignatureInk signature={signature} />
      </View>
      <Text style={{ marginTop: 4, fontSize: 12.5, fontWeight: "600", color: t.appSurface.ink }}>{signature.fullName}</Text>
      <Text style={s.faint}>{CAPACITY_LABEL[signature.capacity]} · signed {signatureDate(signature.signedAt)}</Text>
      {signature.isCurrent === false && (
        <Text style={{ marginTop: 2, fontSize: 11.5, fontWeight: "600", color: t.status.warnInk }}>Changed after signing: needs signing again</Text>
      )}
    </View>
  );
}

/** A receipt's signature under its row: the mark, then who and when. "Not signed" when it isn't. */
export function ReceiptSignature({ signature }: { signature: StoredSignature | undefined }) {
  const { s } = useTheme();
  if (!signature) return <Text style={[s.faint, { marginTop: 6 }]}>Not signed</Text>;
  return (
    <View style={{ marginTop: 6 }}>
      <SignatureInk signature={signature} height={24} />
      <Text style={s.faint}>
        {signature.fullName}, {CAPACITY_LABEL[signature.capacity].toLowerCase()} · {signatureDate(signature.signedAt)}
      </Text>
    </View>
  );
}
