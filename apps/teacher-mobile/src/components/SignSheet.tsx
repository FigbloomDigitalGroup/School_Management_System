import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { signatureProblem, type SignatureMark, type SignatureStyle, type Stroke } from "@figbloom/shared";
import { s, t } from "../theme";
import { SignatureInk } from "./SignatureMark";
import { SignaturePad } from "./SignaturePad";
import { Tap } from "../ui/Tap";
import { Check, CircleAlert } from "lucide-react-native";

/**
 * Sign something: draw or type the signature, give your full name, and agree
 * that this is your signature. The date saved is the server's; the one shown
 * here is today's, for the signer to see. Callers do the signing (onSign),
 * since what's signed differs: one file, a term's invoices.
 */
export function SignSheet({ title, what, capacityLabel, defaultName, tint, onSign, onClose }: {
  title: string;
  /** "the permission slip", read in the agreement: "... the same as signing the permission slip by hand." */
  what: string;
  capacityLabel: string;
  defaultName: string;
  tint: string;
  onSign: (mark: SignatureMark) => Promise<void>;
  onClose: () => void;
}) {
  const [style, setStyle] = useState<SignatureStyle>("drawn");
  const [fullName, setFullName] = useState(defaultName);
  const [strokes, setStrokes] = useState<Stroke[] | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mark: SignatureMark = { fullName, style, strokes: style === "drawn" ? strokes : null };
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  async function sign() {
    const problem = signatureProblem(mark) ?? (agreed ? null : "Tick the box to agree.");
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError(null);
    try {
      await onSign(mark);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign.");
      setSaving(false);
    }
  }

  return (
    <Modal visible animationType="slide" onRequestClose={saving ? undefined : onClose}>
      <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[s.header, { backgroundColor: tint }]}>
          <Text style={s.headerEyebrow}>ELECTRONIC SIGNATURE</Text>
          <Text style={s.headerTitle}>{title}</Text>
        </View>
        <ScrollView scrollEnabled={!drawing} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14 }}>
          <View style={{ flexDirection: "row", gap: 4, padding: 4, borderRadius: 12, backgroundColor: t.appSurface.shell }} accessibilityRole="tablist">
            {(["drawn", "typed"] as const).map((o) => (
              <Tap
                key={o}
                accessibilityRole="tab"
                accessibilityState={{ selected: style === o }}
                disabled={saving}
                onPress={() => setStyle(o)}
                style={{ flex: 1, minHeight: 40, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: style === o ? "#fff" : "transparent" }}
              >
                <Text style={{ fontSize: 13.5, fontWeight: "600", color: style === o ? t.appSurface.ink : t.appSurface.inkMuted }}>{o === "drawn" ? "Draw" : "Type"}</Text>
              </Tap>
            ))}
          </View>

          <View>
            <Text style={labelStyle}>Your full name</Text>
            <TextInput value={fullName} onChangeText={setFullName} maxLength={120} autoComplete="name" editable={!saving} style={inputStyle} />
          </View>

          {style === "drawn" ? (
            <SignaturePad onChange={setStrokes} onDrawing={setDrawing} disabled={saving} />
          ) : (
            <View style={{ height: 96, borderRadius: 12, borderWidth: 1, borderColor: t.appSurface.line, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" }}>
              {fullName.trim()
                ? <SignatureInk signature={{ style: "typed", strokes: null, fullName: fullName.trim() }} height={56} />
                : <Text style={s.faint}>Your name appears here</Text>}
            </View>
          )}

          <View style={{ flexDirection: "row", gap: 24 }}>
            <View><Text style={s.faint}>Signing as</Text><Text style={{ fontSize: 13.5, fontWeight: "600", marginTop: 2 }}>{capacityLabel}</Text></View>
            <View><Text style={s.faint}>Date</Text><Text style={{ fontSize: 13.5, fontWeight: "600", marginTop: 2 }}>{today}</Text></View>
          </View>

          <Tap
            accessibilityRole="checkbox"
            accessibilityState={{ checked: agreed }}
            disabled={saving}
            onPress={() => { setAgreed((a) => !a); setError(null); }}
            style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", minHeight: 44 }}
          >
            <View style={{ width: 22, height: 22, marginTop: 1, borderRadius: 6, borderWidth: 1.5, borderColor: agreed ? tint : t.appSurface.inkFaint, backgroundColor: agreed ? tint : "#fff", alignItems: "center", justifyContent: "center" }}>
              {agreed && <Check size={15} color="#fff" strokeWidth={3} />}
            </View>
            <Text style={[s.small, { flex: 1, color: t.appSurface.ink }]}>I agree that this electronic signature is mine and means the same as signing {what} by hand.</Text>
          </Tap>

          {!!error && (
            <View accessibilityLiveRegion="polite" style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
              <CircleAlert size={14} color={t.status.warnInk} style={{ marginTop: 2 }} />
              <Text style={{ flex: 1, fontSize: 12.5, color: t.status.warnInk }}>{error}</Text>
            </View>
          )}

          <Text style={s.faint}>A signature can't be changed once made. If something is wrong, ask the school office to void it.</Text>

          <Tap accessibilityRole="button" disabled={saving} onPress={() => void sign()} style={[s.primary, { backgroundColor: tint, opacity: saving ? 0.7 : 1 }]}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Sign</Text>}
          </Tap>
          <Tap accessibilityRole="button" disabled={saving} onPress={onClose} style={{ minHeight: 44, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ fontSize: 14.5, fontWeight: "600", color: t.appSurface.inkMuted }}>Cancel</Text>
          </Tap>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const labelStyle = { fontSize: 12, fontWeight: "600" as const, color: t.appSurface.ink, marginBottom: 4 };
const inputStyle = { borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14, color: t.appSurface.ink, backgroundColor: "#fff" };
