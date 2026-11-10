import { PermissionsAndroid, Platform } from "react-native";
import { errorCodes, isErrorWithCode, keepLocalCopy, pick, types } from "@react-native-documents/picker";
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
/** What Bloom can read to import an exam paper (IMPORT_ACCEPT in shared): a PDF, a Word (.docx) file, or photos of the pages. */
export const PAPER_IMPORT_FILES: string[] = [types.pdf, types.docx, types.images];
/** What Figbloom HR takes with a leave application (LEAVE_DOCUMENT_TYPES in shared): a PDF, a photo, a Word document. */
export const LEAVE_DOCUMENT_FILES: string[] = [types.pdf, types.images, types.doc, types.docx];

export interface PickOptions {
  /** Shrinks a photo so neither side is longer than this many pixels: a phone's camera photo can be several MB, a leave document may not. */
  maxPixels?: number;
}

/**
 * Gets one file from the phone, from the system's own camera, photo picker or
 * file browser, so the app asks for no permission and sees only the file the
 * person chooses. (Android's camera is the system camera app, reached by an
 * intent, which needs no CAMERA permission of its own. But the calls library
 * declares one, and once an app declares it the system refuses the intent
 * until it is granted, so it is asked for first. iOS says why in Info.plist.)
 * null when they back out. `documentTypes` only narrows the file browser.
 */
export async function pickFile(source: FileSource, documentTypes: string[] = PDF_OR_IMAGE, { maxPixels }: PickOptions = {}): Promise<PickedFile | null> {
  if (source === "document") return pickDocument(documentTypes);
  if (source === "camera" && Platform.OS === "android") {
    const granted = await PermissionsAndroid.request("android.permission.CAMERA");
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error("Allow the camera in your phone's settings to take a photo here.");
  }
  const result = source === "camera"
    ? await launchCamera({ mediaType: "photo", quality: 0.8, saveToPhotos: false, maxWidth: maxPixels, maxHeight: maxPixels })
    : await launchImageLibrary({ mediaType: "photo", quality: 0.8, selectionLimit: 1, maxWidth: maxPixels, maxHeight: maxPixels });
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
  return { uri: await localCopy(doc.uri, name), name, mimeType: mimeForFile({ name, type: doc.type }) ?? doc.type ?? "application/octet-stream", sizeBytes: doc.size };
}

/**
 * The app's own copy of a picked document. The file browser hands back a content:// address that belongs
 * to it; a copy in the app's cache is a plain file that reads the same whichever app it came from. If the
 * copy can't be made (a virtual file, no space) the original address is still tried.
 */
async function localCopy(uri: string, fileName: string): Promise<string> {
  try {
    const [copy] = await keepLocalCopy({ files: [{ uri, fileName }], destination: "cachesDirectory" });
    return copy && copy.status === "success" ? copy.localUri : uri;
  } catch {
    return uri;
  }
}

/**
 * Reads a file on the phone into a Blob. XMLHttpRequest rather than fetch(): fetch answers a local address with
 * status 0, which its own polyfill then throws on from inside a timer, so the promise it returned never settles
 * and a screen waiting on it waits for ever. This one always either resolves or rejects.
 */
function readLocalBlob(uri: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const unreadable = () => reject(new Error("Could not read that file. Choose it again."));
    const xhr = new XMLHttpRequest();
    xhr.onload = () => (xhr.response ? resolve(xhr.response as Blob) : unreadable());
    xhr.onerror = unreadable;
    xhr.ontimeout = unreadable;
    xhr.responseType = "blob";
    xhr.open("GET", uri, true);
    xhr.send(null);
  });
}

/** Reads the picked file into what the shared upload helpers take. */
export async function readPickedFile(file: PickedFile): Promise<UploadableFile> {
  return { blob: await readLocalBlob(file.uri), name: file.name, mimeType: file.mimeType };
}

/**
 * The picked file as base64 (no "data:...;base64," prefix), for a call that carries the file in its JSON body
 * (a leave document going to HR), with its size from the bytes actually read: the phone's own idea of the size
 * can be missing.
 */
export async function readPickedBase64(file: PickedFile): Promise<{ base64: string; size: number }> {
  const blob = await readLocalBlob(file.uri);
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("Could not read that file. Choose it again."));
    reader.readAsDataURL(blob);
  });
  return { base64, size: blob.size };
}
