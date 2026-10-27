import { useState } from "react";
import {
  fetchAttachments, mediaSummary, mediaUrl, parseEmbed, type AttachmentOwner, type MaterialKind, type MediaItem,
} from "@figbloom/shared";
import { useAsync } from "../lib/useAsync";
import { Skeleton } from "./ui/Skeleton";

/**
 * Showing learning materials and attachments: a video file plays in the
 * page, a YouTube / Vimeo / Google Drive link plays in an embedded player,
 * a picture shows, a recording plays, and anything else opens in a new tab.
 * Files come from the private learning-media bucket through signed links
 * that last an hour, so one is only fetched when someone opens the item.
 */

const KIND_GLYPH: Record<MaterialKind, string> = {
  document: "▤",
  video: "▶",
  image: "▣",
  audio: "♪",
  link: "↗",
};

export function MediaGlyph({ kind }: { kind: MaterialKind }) {
  return (
    <span
      aria-hidden
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px]"
      style={{ background: kind === "video" ? "#FFF1E8" : "#EEF1EE", color: kind === "video" ? "#B8460A" : "#5F6B62" }}
    >
      {KIND_GLYPH[kind]}
    </span>
  );
}

/** Whether an item shows something in the page (a player, a picture) rather than only opening elsewhere. */
export function playsInline(m: MediaItem): boolean {
  if (m.filePath) return m.kind === "video" || m.kind === "audio" || m.kind === "image" || m.mimeType === "application/pdf";
  return !!m.url && !!parseEmbed(m.url);
}

/** The item itself: player, picture or embedded page, with an "Open" / "Download" line under it. */
export function MediaPlayer({ item }: { item: MediaItem }) {
  const embed = item.url ? parseEmbed(item.url) : null;
  const { data: src, loading, error } = useAsync(
    () => (item.filePath ? mediaUrl(item.filePath) : Promise.resolve(item.url ?? "")),
    [item.filePath, item.url],
  );

  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not open this: {error.message}
      </p>
    );
  }
  if (loading || !src) return <Skeleton className="aspect-video w-full rounded-lg" />;

  return (
    <div className="grid gap-2">
      {embed ? (
        <div className="relative w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: embed.isVideo ? "16 / 9" : "4 / 3" }}>
          <iframe
            src={embed.embedUrl}
            title={item.title}
            className="absolute inset-0 h-full w-full border-0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            loading="lazy"
            // A YouTube video stays in the app: without allow-popups and
            // allow-top-navigation, the player's logo, title, "Watch on
            // YouTube" and end-screen videos can't open youtube.com.
            sandbox={embed.provider === "youtube" ? "allow-scripts allow-same-origin allow-presentation" : undefined}
          />
        </div>
      ) : item.filePath && item.kind === "video" ? (
        <video controls preload="metadata" src={src} className="w-full rounded-lg bg-black" style={{ maxHeight: "70vh" }}>
          Your browser can't play this video. Use Download below.
        </video>
      ) : item.filePath && item.kind === "audio" ? (
        <audio controls preload="metadata" src={src} className="w-full" />
      ) : item.filePath && item.kind === "image" ? (
        <img src={src} alt={item.title} className="max-h-[70vh] w-full rounded-lg border border-line-soft object-contain" />
      ) : item.filePath && item.mimeType === "application/pdf" ? (
        <iframe src={src} title={item.title} className="h-[70vh] w-full rounded-lg border border-line-soft" />
      ) : null}
      {embed?.provider !== "youtube" && (
        <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
          <a href={src} target="_blank" rel="noopener noreferrer" className="font-semibold text-forest underline">
            {item.filePath ? "Open in a new tab" : "Open the link"}
          </a>
          {item.filePath && <DownloadLink path={item.filePath} name={item.fileName ?? item.title} />}
        </div>
      )}
    </div>
  );
}

/** A signed link that saves the file under its own name rather than opening it. */
function DownloadLink({ path, name }: { path: string; name: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      className="font-semibold text-forest underline disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        try { window.location.assign(await mediaUrl(path, 600, name)); }
        finally { setBusy(false); }
      }}
    >
      Download
    </button>
  );
}

/**
 * A short list of files and links. Tapping one that can show in the page
 * opens it underneath; anything else opens in a new tab.
 */
export function MediaList({ items, heading = "Attached" }: { items: MediaItem[]; heading?: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!items.length) return null;

  async function open(m: MediaItem) {
    setError("");
    if (playsInline(m)) { setOpenId((id) => (id === m.id ? null : m.id)); return; }
    // Opened before the signed link exists, so a pop-up blocker sees the click.
    const tab = window.open("", "_blank");
    try {
      const url = m.filePath ? await mediaUrl(m.filePath) : m.url ?? "";
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.assign(url);
    } catch (err) {
      tab?.close();
      setError(err instanceof Error ? err.message : "Could not open that.");
    }
  }

  return (
    <div>
      {heading && <div className="mb-1.5 font-mono text-micro tracking-[0.1em] text-ink-faint">{heading.toUpperCase()} · {items.length}</div>}
      <ul className="grid gap-1.5">
        {items.map((m) => (
          <li key={m.id} className="rounded-lg border border-line-soft bg-white">
            <button type="button" onClick={() => void open(m)} className="flex w-full items-center gap-3 px-3 py-2 text-left" aria-expanded={playsInline(m) ? openId === m.id : undefined}>
              <MediaGlyph kind={m.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold">{m.title}</span>
                <span className="block truncate text-[11.5px] text-ink-faint">{mediaSummary(m)}</span>
              </span>
              <span className="shrink-0 text-[12px] font-semibold text-forest">
                {playsInline(m) ? (openId === m.id ? "Close" : m.kind === "video" ? "Play" : "View") : "Open"}
              </span>
            </button>
            {openId === m.id && <div className="border-t border-line-soft p-3"><MediaPlayer item={m} /></div>}
          </li>
        ))}
      </ul>
      {error && <p className="mt-1.5 text-[12px] text-warn-ink">{error}</p>}
    </div>
  );
}

/** One announcement's or homework's attachments, fetched on their own (a detail pane showing one item at a time). */
export function OwnerAttachments({ owner, id, heading }: { owner: AttachmentOwner; id: string; heading?: string }) {
  const { data, loading, error } = useAsync(() => fetchAttachments(owner, [id]), [owner, id]);
  if (loading && !data) return <Skeleton className="h-10 w-full rounded-lg" />;
  if (error) return <p className="text-[12px] text-warn-ink">Could not load the attachments: {error.message}</p>;
  return <MediaList items={data?.get(id) ?? []} heading={heading} />;
}
