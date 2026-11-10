import { types } from "@react-native-documents/picker";
import {
  bytesToBase64, chatAttachmentKind, checkChatAttachment, PHONE_UPLOAD_LIMIT_BYTES, type ChatAttachment,
} from "@figbloom/shared";
import type { PickedFile } from "./pickFile";

/** What Bloom can read from a question's files: PDF, Word (.docx) and plain text (CSV is one type on iOS and two on Android). */
export const BLOOM_FILE_TYPES: string[] = [types.pdf, types.docx, types.plainText, ...([] as string[]).concat(types.csv)];

/**
 * A picked file as Bloom takes it with one question: text as text, a PDF or
 * Word file as base64 of its bytes (the website's Drive files arrive the same
 * way). `current` is what the question already carries, for the limits. The
 * checks run before the file is read when the phone says how big it is, so a
 * huge file is refused without being loaded.
 */
export async function readBloomAttachment(file: PickedFile, current: ChatAttachment[]): Promise<ChatAttachment> {
  const kind = chatAttachmentKind(file.mimeType, file.name);
  if (!kind) throw new Error("Bloom can read PDF, Word (.docx) and plain text files.");
  if (file.sizeBytes !== null) {
    const early = checkChatAttachment({ name: file.name, size: file.sizeBytes }, current, PHONE_UPLOAD_LIMIT_BYTES);
    if (early) throw new Error(early);
  }

  const res = await fetch(file.uri);
  if (!res.ok) throw new Error(`Could not read "${file.name}".`);
  if (kind === "text") {
    const text = await res.text();
    const problem = checkChatAttachment({ name: file.name, size: file.sizeBytes ?? text.length, textLength: text.length }, current, PHONE_UPLOAD_LIMIT_BYTES);
    if (problem) throw new Error(problem);
    return { name: file.name, kind, size: file.sizeBytes ?? text.length, text };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const problem = checkChatAttachment({ name: file.name, size: bytes.length }, current, PHONE_UPLOAD_LIMIT_BYTES);
  if (problem) throw new Error(problem);
  return { name: file.name, kind, size: bytes.length, data: bytesToBase64(bytes) };
}
