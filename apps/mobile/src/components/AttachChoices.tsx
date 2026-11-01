import { Text, View } from "react-native";
import type { FileSource } from "../lib/pickFile";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

const CHOICES: { source: FileSource; label: string }[] = [
  { source: "camera", label: "📷 Take a photo" },
  { source: "gallery", label: "🖼 Photo" },
  { source: "document", label: "📄 PDF or file" },
];

/**
 * Where a file comes from, as three buttons in a row. Inline rather than a sheet
 * over the screen: the system's own picker opens straight after the tap, and on
 * iOS it can not open over a modal that is still on screen.
 */
export function AttachChoices({ onChoose, disabled = false }: { onChoose: (source: FileSource) => void; disabled?: boolean }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {CHOICES.map((c) => (
        <Tap
          key={c.source}
          accessibilityRole="button"
          disabled={disabled}
          onPress={() => onChoose(c.source)}
          style={{ flexGrow: 1, minHeight: 44, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: t.appSurface.line, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.5 : 1 }}
        >
          <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.appSurface.ink }}>{c.label}</Text>
        </Tap>
      ))}
    </View>
  );
}
