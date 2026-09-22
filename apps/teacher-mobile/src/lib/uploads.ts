import { supabase } from "@figbloom/shared";

/**
 * Mobile's own upload path — web's apps/web/src/lib/uploads.ts takes a
 * browser File, which doesn't exist on React Native. Same bucket/path
 * convention (public-assets, "<tenant>/avatars/staff-<id>.<ext>"), just
 * fetching the local image-picker URI into a Blob instead.
 */

function extOf(uri: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(uri.split("?")[0] ?? "");
  return m ? m[1]!.toLowerCase() : "jpg";
}

export async function uploadAvatar(tenantId: string, teacherId: string, uri: string, mimeType?: string): Promise<string> {
  const path = `${tenantId}/avatars/staff-${teacherId}.${extOf(uri)}`;
  const blob = await (await fetch(uri)).blob();
  const { error } = await supabase().storage.from("public-assets").upload(path, blob, {
    upsert: true,
    contentType: mimeType,
  });
  if (error) throw error;
  return supabase().storage.from("public-assets").getPublicUrl(path).data.publicUrl;
}
