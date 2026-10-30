import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";
import { FileText, Image as ImageIcon, Link2, Music, PlayCircle, type LucideIcon } from "lucide-react-native";
import {
  fetchAttachments, mediaSummary, openableUrl, type AttachmentOwner, type MaterialKind, type MediaItem,
} from "@figbloom/shared";
import { s, t } from "../theme";
import { Tap } from "../ui/Tap";

/**
 * Files and links from a teacher or the school: a worksheet, a lesson
 * video, a YouTube link. The app doesn't play anything itself; a tap opens
 * the file (through a signed link that lasts an hour) or the link in
 * whatever the phone uses for it: the browser, YouTube, a PDF viewer.
 */

const KIND_ICON: Record<MaterialKind, LucideIcon> = {
  document: FileText,
  video: PlayCircle,
  image: ImageIcon,
  audio: Music,
  link: Link2,
};

export function MediaRow({ item, tint }: { item: MediaItem; tint: string }) {
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const Icon = KIND_ICON[item.kind];

  async function open() {
    setOpening(true);
    setFailed(false);
    try {
      await Linking.openURL(await openableUrl(item));
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }

  return (
    <Tap
      accessibilityRole="link"
      accessibilityLabel={`Open ${item.title}`}
      disabled={opening}
      onPress={() => void open()}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingVertical: 6 }}
    >
      <View style={{ width: 32, height: 32, borderRadius: 10, backgroundColor: t.appSurface.page, alignItems: "center", justifyContent: "center" }}>
        <Icon color={tint} size={17} />
      </View>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ fontSize: 13.5, fontWeight: "600", color: t.appSurface.ink }}>{item.title}</Text>
        <Text numberOfLines={1} style={[s.faint, { marginTop: 2, color: failed ? "#B4472B" : t.appSurface.inkFaint }]}>
          {failed ? "Could not open it. Check your connection and try again." : mediaSummary(item)}
        </Text>
      </View>
      {opening ? <ActivityIndicator color={tint} /> : <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Open</Text>}
    </Tap>
  );
}

export function MediaLinks({ items, tint, heading = "ATTACHED" }: { items: MediaItem[]; tint: string; heading?: string }) {
  if (!items.length) return null;
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={[s.eyebrow, { marginBottom: 2 }]}>{heading} · {items.length}</Text>
      {items.map((m) => <MediaRow key={m.id} item={m} tint={tint} />)}
    </View>
  );
}

/** Attachments for a list of announcements or homework in one query, keyed by owner id. Empty until loaded or if offline. */
export function useAttachments(owner: AttachmentOwner, ids: string[]): Map<string, MediaItem[]> {
  const key = ids.join(",");
  const [map, setMap] = useState<Map<string, MediaItem[]>>(new Map());
  useEffect(() => {
    let alive = true;
    fetchAttachments(owner, key ? key.split(",") : [])
      .then((m) => { if (alive) setMap(m); })
      .catch(() => {}); // offline: the notice or homework still shows, just without its files
    return () => { alive = false; };
  }, [owner, key]);
  return map;
}

/** One announcement's or homework's attachments, for a screen showing one at a time. */
export function OwnerAttachments({ owner, id, tint, heading }: { owner: AttachmentOwner; id: string; tint: string; heading?: string }) {
  const items = useAttachments(owner, [id]).get(id) ?? [];
  return <MediaLinks items={items} tint={tint} heading={heading} />;
}
