import {
  LEARNING_MEDIA_BUCKET, createMaterial, deleteMaterial, fileProblem, kindForMime, materialFilePath, mimeForFile, newMaterialId,
  setMaterialPublished, type MaterialInput,
} from "./materials";
import { uploadFile } from "./storageUpload";
import { PHONE_UPLOAD_LIMIT_BYTES, type UploadableFile } from "./uploads";

/**
 * Shares a file with a class from a phone, in the order the storage policy
 * needs (it only takes a file for a material that already exists): the draft
 * row, then the file, then publishing if asked. The phone has no resumable
 * upload, so the file goes up in one request, up to PHONE_UPLOAD_LIMIT_BYTES;
 * past that the teacher is pointed at the web or a link. If anything fails
 * after the row was made it is taken away again, so there is never a draft
 * pointing at a missing file. Returns the new material's id.
 */
export async function createFileMaterial(tenantId: string, input: MaterialInput, file: UploadableFile, publish: boolean): Promise<string> {
  const problem = fileProblem({ name: file.name, size: file.blob.size, type: file.mimeType }, PHONE_UPLOAD_LIMIT_BYTES);
  const mime = mimeForFile({ name: file.name, type: file.mimeType });
  if (problem || !mime) throw new Error(problem ?? "That type of file can't be shared.");

  const id = newMaterialId();
  const filePath = materialFilePath(tenantId, id, file.name);
  let created = false;
  try {
    await createMaterial(tenantId, input, { id, kind: kindForMime(mime), filePath, fileName: file.name, mimeType: mime, sizeBytes: file.blob.size });
    created = true;
    await uploadFile(LEARNING_MEDIA_BUCKET, filePath, { ...file, mimeType: mime });
    if (publish) await setMaterialPublished(id, true);
    return id;
  } catch (err) {
    if (created) await deleteMaterial({ id, filePath }).catch(() => {});
    throw err;
  }
}
