import { useState, type ChangeEvent } from "react";
import { supabase } from "@figbloom/shared";
import { uploadAvatar } from "../lib/uploads";

const AVATAR_TONES = [
  { bg: "#E3EFE7", ink: "#1B4D2E" },
  { bg: "#FDECD8", ink: "#8A4B12" },
  { bg: "#E7E9FB", ink: "#3B3F8C" },
  { bg: "#FBE7EC", ink: "#8C2F49" },
  { bg: "#E7F6FB", ink: "#175C74" },
];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function toneFor(id: string): { bg: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length]!;
}

/** A photo if one's set, else the initials-in-a-colored-box placeholder used across the console. */
export function Avatar({ id, name, url, size = 30 }: { id: string; name: string; url?: string | null; size?: number }) {
  if (url) {
    return <img src={url} alt="" className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />;
  }
  const { bg, ink } = toneFor(id);
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-full font-bold"
      style={{ width: size, height: size, background: bg, color: ink, fontSize: Math.round(size * 0.4) }}
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * Shared by admin's People "Manage" modal (editing someone else) and every
 * role's own Account screen (editing yourself) — same upload, same table
 * write, the only difference is whose id/kind gets passed in.
 */
export function AvatarEditor({ id, name, kind, tenantId, url, onUploaded, toast }: {
  id: string; name: string; kind: "students" | "staff"; tenantId: string; url?: string | null;
  onUploaded: (url: string) => void; toast: (m: string) => void;
}) {
  const [uploading, setUploading] = useState(false);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const newUrl = await uploadAvatar(tenantId, kind, id, file);
      const table = kind === "students" ? "students" : "profiles";
      const { error } = await supabase().from(table).update({ avatar_url: newUrl }).eq("id", id);
      if (error) throw error;
      onUploaded(newUrl);
      toast("Photo updated");
    } catch (err) {
      toast("Could not upload: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  return (
    <div className="flex items-center gap-3.5">
      <Avatar id={id} name={name} url={url} size={56} />
      <label className="text-small font-medium text-leaf">
        <span className="hit inline-block cursor-pointer rounded-md border border-[#D3DAD5] bg-white px-3 py-1.5 hover:bg-page">
          {uploading ? "Uploading…" : "Change photo"}
        </span>
        <input type="file" accept="image/*" className="hidden" onChange={onChange} disabled={uploading} aria-label="Upload photo" />
      </label>
    </div>
  );
}
