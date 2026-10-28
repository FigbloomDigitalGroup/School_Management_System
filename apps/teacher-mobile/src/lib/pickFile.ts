import { errorCodes, isErrorWithCode, pick, types } from "@react-native-documents/picker";
import { launchCamera, launchImageLibrary } from "react-native-image-picker";
import { mimeForFile, safeFileName, type UploadableFile } from "@figbloom/shared";

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  /** null when the phone didn't say. */
  sizeBytes: number | null;
}

/** Where a file comes from: a photo taken now, a photo from the gallery, or a PDF or other document from the phone's files. */
export type FileSource = "camera" | "gallery" | "document";

/** What the file browser offers for a payment slip or a prescription. */
export const PDF_OR_IMAGE: string[] = [types.pdf, types.images];
/** Anything, for a chat: the chat then checks the type against what its storage takes. */
export const ANY_FILE: string[] = [types.allFiles];

/**
 * Gets one file from the phone, from the system's own camera, photo picker or
 * file browser, so the app asks for no permission and sees only the file the
 * person chooses. (Android's camera is the system camera app, reached by an
 * intent, which needs no CAMERA permission; iOS says why in Info.plist.)
 * null when they back out. `documentTypes` only narrows the file browser.
 */
export async function pickFile(source: FileSource, documentTypes: string[] = PDF_OR_IMAGE): Promise<PickedFile | null> {
  if (source === "document") return pickDocument(documentTypes);
  const result = source === "camera"
    ? await launchCamera({ mediaType: "photo", quality: 0.8, saveToPhotos: false })
    : await launchImageLibrary({ mediaType: "photo", quality: 0.8, selectionLimit: 1 });
  if (result.didCancel) return null;
  if (result.errorCode === "camera_unavailable") throw new Error("This phone has no camera the app can use.");
  if (result.errorCode) throw new Error(result.errorMessage ?? (source === "camera" ? "Could not open the camera." : "Could not open your photos."));
  const asset = result.assets?.[0];
  if (!asset?.uri) return null;
  const name = safeFileName(asset.fileName ?? `photo-${Date.now()}.jpg`);
  return { uri: asset.uri, name, mimeType: asset.type ?? mimeForFile({ name }) ?? "image/jpeg", sizeBytes: asset.fileSize ?? null };
}

async function pickDocument(documentTypes: string[]): Promise<PickedFile | null> {
  const doc = await pick({ type: documentTypes, allowMultiSelection: false })
    .then((picked) => picked[0])
    .catch((err: unknown) => {
      if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) return null;
      throw new Error("Could not open your files.");
    });
  if (!doc) return null;
  if (doc.error) throw new Error("Could not read that file.");
  // Some Android file providers ignore the type filter and let anything through.
  if (!doc.hasRequestedType) throw new Error("That kind of file can not be sent here.");
  const name = safeFileName(doc.name ?? `file-${Date.now()}`);
  // A provider may report a generic type for a PDF; the name tells the storage what it really is.
  return { uri: doc.uri, name, mimeType: mimeForFile({ name, type: doc.type }) ?? doc.type ?? "application/octet-stream", sizeBytes: doc.size };
}

/** Reads the picked file into what the shared upload helpers take. */
export async function readPickedFile(file: PickedFile): Promise<UploadableFile> {
  const blob = await (await fetch(file.uri)).blob();
  return { blob, name: file.name, mimeType: file.mimeType };
}
