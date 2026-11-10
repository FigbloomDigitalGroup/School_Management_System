import { examPaperFilePath, mimeForFile, supabase, uploadFile } from "@figbloom/shared";
import { readPickedFile, type PickedFile } from "./pickFile";

/**
 * Mobile's own upload path — web's apps/web/src/lib/uploads.ts takes a
 * browser File, which doesn't exist on React Native. Same bucket/path
 * convention (public-assets, "<tenant>/avatars/staff-<id>.<ext>"), just
 * reading the local image-picker URI into a Blob instead and sending it the
 * way a phone has to (uploadFile).
 */

function extOf(uri: string): string {
  const m = /\.([a-zA-Z0-9]+)$/.exec(uri.split("?")[0] ?? "");
  return m ? m[1]!.toLowerCase() : "jpg";
}

export async function uploadAvatar(tenantId: string, teacherId: string, uri: string, mimeType?: string): Promise<string> {
  const name = `staff-${teacherId}.${extOf(uri)}`;
  const path = `${tenantId}/avatars/${name}`;
  const file = await readPickedFile({ uri, name, mimeType: mimeType ?? mimeForFile({ name }) ?? "image/jpeg", sizeBytes: null });
  await uploadFile("public-assets", path, file, { upsert: true });
  return supabase().storage.from("public-assets").getPublicUrl(path).data.publicUrl;
}

/**
 * An exam paper's PDF or picture (or the reference sheet that goes with an online paper), from the phone. Staff write it;
 * families can read it once the paper opens. Same bucket and path as the website's upload.
 */
export async function uploadExamPaperFile(tenantId: string, paperId: string, picked: PickedFile): Promise<{ path: string; name: string }> {
  const path = examPaperFilePath(tenantId, paperId, picked.name);
  await uploadFile("private-documents", path, await readPickedFile(picked));
  return { path, name: picked.name };
}
