import { useRef, useState } from "react";
import {
  draftTitle, fileProblem, formatFileSize, kindForLink, kindForMime, mediaSummary, mimeForFile, validateLink,
  type MediaItem,
} from "@figbloom/shared";
import { batchProgressLabel, type BatchProgress, type WebMediaDraft } from "../lib/resumableUpload";
import { MediaGlyph } from "./Media";
import { Button } from "./ui/Button";

/**
 * "Files and links" on a form: pick files (any number) or paste a link, see
 * what's queued, take things off again. Nothing is uploaded here; the form
 * saves its own row first and then hands the drafts to saveAttachments().
 * While that runs, `progress` shows the bar and a Cancel button.
 */
export function AttachmentPicker({ drafts, onChange, existing = [], onRemoveExisting, progress, onCancel, disabled }: {
  drafts: WebMediaDraft[];
  onChange: (drafts: WebMediaDraft[]) => void;
  /** Already saved (editing homework). */
  existing?: MediaItem[];
  onRemoveExisting?: (m: MediaItem) => void;
  progress?: BatchProgress | null;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");
  const [problem, setProblem] = useState("");

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const files = Array.from(list);
    const bad = files.map((f) => fileProblem(f)).find(Boolean);
    setProblem(bad ?? "");
    onChange([...drafts, ...files.filter((f) => !fileProblem(f)).map((file): WebMediaDraft => ({ type: "file", file, title: "" }))]);
  }

  function addLink() {
    const checked = validateLink(link);
    if (!checked.ok) { setProblem(checked.message); return; }
    setProblem("");
    onChange([...drafts, { type: "link", url: checked.value, title: "" }]);
    setLink("");
  }

  const busy = !!progress || disabled;

  return (
    <fieldset className="grid gap-2.5 rounded-lg border border-line-soft bg-page px-3.5 pb-3.5 pt-1">
      <legend className="px-1 text-small font-semibold">Files and links (optional)</legend>
      <p className="text-[11.5px] leading-snug text-ink-faint">
        Worksheets, notes, pictures, recordings or a video up to 2 GB. Or paste a YouTube, Vimeo or Google Drive link: it plays right in the app.
      </p>

      {(existing.length > 0 || drafts.length > 0) && (
        <ul className="grid gap-1.5">
          {existing.map((m) => (
            <li key={m.id} className="flex items-center gap-2.5 rounded-md border border-line-soft bg-white px-2.5 py-1.5">
              <MediaGlyph kind={m.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold">{m.title}</span>
                <span className="block truncate text-[11px] text-ink-faint">{mediaSummary(m)}</span>
              </span>
              {onRemoveExisting && <Button disabled={busy} onClick={() => onRemoveExisting(m)}>Remove</Button>}
            </li>
          ))}
          {drafts.map((d, i) => {
            const kind = d.type === "file" ? kindForMime(mimeForFile(d.file) ?? "") : kindForLink(d.url);
            return (
              <li key={i} className="flex items-center gap-2.5 rounded-md border border-dashed border-[#D3DAD5] bg-white px-2.5 py-1.5">
                <MediaGlyph kind={kind} />
                <span className="min-w-0 flex-1">
                  <input
                    aria-label="Title"
                    className="w-full truncate border-0 bg-transparent p-0 text-[12.5px] font-semibold outline-none"
                    placeholder={draftTitle({ ...d, title: "" })}
                    value={d.title}
                    disabled={busy}
                    onChange={(e) => onChange(drafts.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                  />
                  <span className="block truncate text-[11px] text-ink-faint">
                    {d.type === "file" ? `${d.file.name} · ${formatFileSize(d.file.size)}` : d.url}
                  </span>
                </span>
                <Button disabled={busy} onClick={() => onChange(drafts.filter((_, j) => j !== i))}>Remove</Button>
              </li>
            );
          })}
        </ul>
      )}

      {progress ? (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-3 text-[12px]">
            <span className="min-w-0 truncate text-ink-muted">{batchProgressLabel(progress)}</span>
            {onCancel && <Button onClick={onCancel}>Cancel upload</Button>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-[#E2E6E2]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
            <div className="h-full rounded-full bg-forest transition-[width]" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <Button disabled={busy} onClick={() => fileInput.current?.click()}>Add files</Button>
          <input
            aria-label="Paste a link"
            placeholder="or paste a link, e.g. https://youtu.be/…"
            value={link}
            disabled={busy}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
            className="min-w-[200px] flex-1 rounded-md border border-[#D3DAD5] bg-white px-3 py-2 text-[13px] outline-none focus:border-forest"
          />
          <Button disabled={busy || !link.trim()} onClick={addLink}>Add link</Button>
        </div>
      )}
      {problem && <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{problem}</p>}
    </fieldset>
  );
}
