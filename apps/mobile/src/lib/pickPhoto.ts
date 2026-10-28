import { launchImageLibrary } from "react-native-image-picker";
import { mimeForFile, safeFileName, type UploadableFile } from "@figbloom/shared";

export interface PickedPhoto {
  uri: string;
  name: string;
  mimeType: string;
  /** null when the phone didn't say. */
  sizeBytes: number | null;
}

/**
 * Opens the phone's own photo picker (the system's, so the app asks for no
 * permission and sees only the photo the person chooses). null when they back
 * out. PDFs and other documents are still sent from the website.
 */
export async function pickPhoto(): Promise<PickedPhoto | null> {
  const result = await launchImageLibrary({ mediaType: "photo", quality: 0.8, selectionLimit: 1 });
  if (result.didCancel) return null;
  if (result.errorCode) throw new Error(result.errorMessage ?? "Could not open your photos.");
  const asset = result.assets?.[0];
  if (!asset?.uri) return null;
  const name = safeFileName(asset.fileName ?? `photo-${Date.now()}.jpg`);
  return { uri: asset.uri, name, mimeType: asset.type ?? mimeForFile({ name }) ?? "image/jpeg", sizeBytes: asset.fileSize ?? null };
}

/** Reads the picked photo into what the shared upload helpers take. */
export async function readPhoto(photo: PickedPhoto): Promise<UploadableFile> {
  const blob = await (await fetch(photo.uri)).blob();
  return { blob, name: photo.name, mimeType: photo.mimeType };
}
