/**
 * The Noto Sans font files for Bloom's PDF export (bloomExportPdf.ts), from
 * @expo-google-fonts/noto-sans and noto-sans-mono (SIL Open Font License).
 * Vite copies just these six files into the build as hashed assets; nothing
 * is fetched until a PDF is made, and then only the faces that PDF uses. Each
 * file is fetched once per page load.
 */
import mono from "@expo-google-fonts/noto-sans-mono/400Regular/NotoSansMono_400Regular.ttf?url";
import monoBold from "@expo-google-fonts/noto-sans-mono/700Bold/NotoSansMono_700Bold.ttf?url";
import regular from "@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf?url";
import italic from "@expo-google-fonts/noto-sans/400Regular_Italic/NotoSans_400Regular_Italic.ttf?url";
import bold from "@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf?url";
import boldItalic from "@expo-google-fonts/noto-sans/700Bold_Italic/NotoSans_700Bold_Italic.ttf?url";
import type { FontFace } from "./bloomExportPdf";

const URLS: Record<FontFace, string> = { regular, bold, italic, boldItalic, mono, monoBold };

const cache = new Map<FontFace, Promise<Uint8Array>>();

/** A face's TrueType bytes, fetched on first use. */
export function loadBloomFont(face: FontFace): Promise<Uint8Array> {
  let bytes = cache.get(face);
  if (!bytes) {
    bytes = fetch(URLS[face]).then(async (res) => {
      if (!res.ok) throw new Error(`The PDF font didn't load (${res.status}).`);
      return new Uint8Array(await res.arrayBuffer());
    });
    // a failed fetch is tried again next time
    bytes.catch(() => cache.delete(face));
    cache.set(face, bytes);
  }
  return bytes;
}
