import type { Tx } from "../../db/sql.js";
import { forbidden, notFound, validationError } from "../../http/errors.js";
import { mayPayFor } from "../finance/payer.js";
import { loadEffectivePermissions, requirePermission, type AuthzContext } from "../rbac/authorize.js";

/**
 * Storage owner types (migration 090, widened by 102; docs/STORAGE-OWNER-TYPES.md).
 *
 * Every stored object belongs to one owner type. The type decides who may upload, finish, read and delete it, which content
 * types and sizes are accepted, and whether `owner_resource_id` must name a real owner. Staff reach an object through the
 * type's staff permission (the same permission the owning domain uses); a few types also have a narrow non-staff path:
 *   - payment_proof: a parent of the learner billed on the invoice the proof names (live family link), or that learner
 *     themselves through their own login (docs/STUDENT-ACCOUNTS.md): the payer rule, `mayPayFor`;
 *   - avatar: any member of the school, for the photo that names their own user id;
 *   - school_logo: any member of the school may read it (the legacy crest was public).
 * Nothing else is reachable without the staff permission. Widening a rule here is a security change.
 */
export const OWNER_RESOURCE_TYPES = [
  "directory_document",
  "export_artifact",
  "medication_authorization",
  "general",
  "payment_proof",
  "homework_attachment",
  "learning_material",
  "exam_paper",
  "avatar",
  "school_logo",
] as const;

export type OwnerResourceType = (typeof OWNER_RESOURCE_TYPES)[number];

export type StorageAction = "read" | "complete" | "delete";

const MIB = 1024 * 1024;

const PDF = "application/pdf";
const IMAGES = ["image/jpeg", "image/png", "image/webp"] as const;
const STANDARD = new Set<string>([
  PDF,
  ...IMAGES,
  "text/csv",
  "text/plain",
  "application/json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const IMAGE_ONLY = new Set<string>(IMAGES);
/** The same set `POST /finance/proofs` accepts for a proof file (JPEG, PNG, WebP, PDF up to 10 MB). */
const PROOF = new Set<string>([...IMAGES, PDF]);

export interface OwnerTypeRule {
  /** Staff permission to read metadata and get a download link. */
  read: string;
  /** Staff permission to start, finish and delete an upload. */
  write: string;
  contentTypes: ReadonlySet<string>;
  maxBytes: number;
  /** What `owner_resource_id` must name. null: optional and informational only (never used to authorize). */
  owner: "invoice" | "person" | null;
}

const DOCUMENT = { read: "resource.document.read", write: "resource.document.write" } as const;
const ACADEMICS = { read: "resource.academics.read", write: "resource.academics.write" } as const;

export const OWNER_TYPE_RULES: Readonly<Record<OwnerResourceType, OwnerTypeRule>> = {
  directory_document: { ...DOCUMENT, contentTypes: STANDARD, maxBytes: 25 * MIB, owner: null },
  export_artifact: { ...DOCUMENT, contentTypes: STANDARD, maxBytes: 25 * MIB, owner: null },
  medication_authorization: { ...DOCUMENT, contentTypes: STANDARD, maxBytes: 25 * MIB, owner: null },
  general: { ...DOCUMENT, contentTypes: STANDARD, maxBytes: 25 * MIB, owner: null },
  // Matches POST /finance/proofs: the office (finance administer) submits for a family, finance readers review.
  payment_proof: { read: "resource.finance.read", write: "resource.finance.administer", contentTypes: PROOF, maxBytes: 10 * MIB, owner: "invoice" },
  // Matches /homework-items, /learning-materials and /online-exam-papers (the Academics area or a full administrator).
  homework_attachment: { ...ACADEMICS, contentTypes: STANDARD, maxBytes: 25 * MIB, owner: null },
  learning_material: { ...ACADEMICS, contentTypes: STANDARD, maxBytes: 25 * MIB, owner: null },
  exam_paper: { ...ACADEMICS, contentTypes: STANDARD, maxBytes: 25 * MIB, owner: null },
  // People staff manage everyone's photo; a member manages their own (the self path below).
  avatar: { ...DOCUMENT, contentTypes: IMAGE_ONLY, maxBytes: 5 * MIB, owner: "person" },
  // School profile changes are a full-administrator power (F-02); reading is open to every member (below).
  school_logo: { read: "resource.school_profile.read", write: "resource.school_profile.write", contentTypes: IMAGE_ONLY, maxBytes: 5 * MIB, owner: null },
};

/** Every staff permission that opens some owner type, per action (used to answer a missing object with 404 or 403). */
const STAFF_READ = [...new Set(Object.values(OWNER_TYPE_RULES).map((r) => r.read))];
const STAFF_WRITE = [...new Set(Object.values(OWNER_TYPE_RULES).map((r) => r.write))];

/** The permission each operation documents in OpenAPI; named in the denial audit when no owner type applies. */
const DOCUMENTED = { read: "resource.document.read", write: "resource.document.write" } as const;

/** Content type and size check for one owner type. The content type is normalised (lower case, parameters dropped). */
export function validateContentForOwnerType(
  ownerResourceType: OwnerResourceType,
  contentType: string,
  byteSize: number,
): { contentType: string; byteSize: number } {
  const rule = OWNER_TYPE_RULES[ownerResourceType];
  const normalized = contentType.trim().toLowerCase().split(";")[0]!.trim();
  if (!rule.contentTypes.has(normalized)) {
    throw validationError(`content_type is not allowed for ${ownerResourceType} (allowed: ${[...rule.contentTypes].join(", ")})`);
  }
  if (!Number.isInteger(byteSize) || byteSize < 1 || byteSize > rule.maxBytes) {
    throw validationError(`byte_size must be between 1 and ${rule.maxBytes} bytes for ${ownerResourceType}`);
  }
  return { contentType: normalized, byteSize };
}

/** The caller is known not to hold `permission`: raise the standard 403 with its deferred denial audit. */
async function deny(tx: Tx, authz: AuthzContext, permission: string, ip: string | null): Promise<never> {
  await requirePermission(tx, authz, permission, { ip, deferAudit: true });
  throw forbidden("Missing permission"); // unreachable: requirePermission throws for a permission the caller lacks
}

async function invoiceLearnerId(tx: Tx, tenantId: string, invoiceId: string): Promise<string | null> {
  const res = await tx.query<{ learner_id: string }>(
    `SELECT learner_id FROM finance_invoices WHERE tenant_id = $1 AND id = $2`,
    [tenantId, invoiceId],
  );
  return res.rows[0]?.learner_id ?? null;
}

/** A parent of the learner billed on this invoice (live family link), or that learner's own login, checked now. */
async function isFamilyOfInvoice(tx: Tx, authz: AuthzContext, tenantId: string, invoiceId: string): Promise<boolean> {
  if (!isPayerRole(authz)) return false;
  const learnerId = await invoiceLearnerId(tx, tenantId, invoiceId);
  return learnerId !== null && (await mayPayFor(tx, authz, learnerId));
}

function isPayerRole(authz: AuthzContext): boolean {
  return authz.membership?.role === "parent" || authz.membership?.role === "student";
}

/** An avatar must show a learner of this school or a member of this school. */
async function isPersonOfSchool(tx: Tx, tenantId: string, id: string): Promise<boolean> {
  const res = await tx.query(
    `SELECT 1 FROM learners WHERE tenant_id = $1 AND id = $2
     UNION ALL
     SELECT 1 FROM school_memberships WHERE tenant_id = $1 AND user_id = $2
     LIMIT 1`,
    [tenantId, id],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Gate before the body is read: refuse a caller who could not start an upload of any owner type (no staff write permission
 * and no membership in this school, for example an organisation administrator without a delegation), so validation never
 * answers for them first.
 */
export async function assertMayStartUploads(tx: Tx, authz: AuthzContext, ip: string | null): Promise<void> {
  const perms = await loadEffectivePermissions(tx, authz);
  if (authz.membership || STAFF_WRITE.some((p) => perms.has(p))) return;
  await deny(tx, authz, DOCUMENTED.write, ip);
}

/** Who may start an upload of this owner type, and that the named owner exists in this school. */
export async function authorizeUploadStart(
  tx: Tx,
  authz: AuthzContext,
  input: { tenantId: string; ownerResourceType: OwnerResourceType; ownerResourceId: string | null; ip: string | null },
): Promise<void> {
  const rule = OWNER_TYPE_RULES[input.ownerResourceType];
  const perms = await loadEffectivePermissions(tx, authz);
  const staff = perms.has(rule.write);
  const familyPath = input.ownerResourceType === "payment_proof" && isPayerRole(authz);
  const selfPath = input.ownerResourceType === "avatar" && authz.membership !== null;
  // Refuse a caller with no path to this type before looking at the owner, so a missing owner id never masks the 403.
  if (!staff && !familyPath && !selfPath) await deny(tx, authz, rule.write, input.ip);

  const ownerId = input.ownerResourceId;
  if (rule.owner && !ownerId) throw validationError(`owner_resource_id is required for ${input.ownerResourceType}`);

  if (staff) {
    if (rule.owner === "invoice" && !(await invoiceLearnerId(tx, input.tenantId, ownerId!))) {
      throw validationError("owner_resource_id must name an invoice of this school");
    }
    if (rule.owner === "person" && !(await isPersonOfSchool(tx, input.tenantId, ownerId!))) {
      throw validationError("owner_resource_id must name a learner or a member of this school");
    }
    return;
  }
  // Non-staff: only what is theirs. A missing invoice and another family's invoice get the same 403.
  if (familyPath && (await isFamilyOfInvoice(tx, authz, input.tenantId, ownerId!))) return;
  if (selfPath && ownerId === authz.userId) return;
  await deny(tx, authz, rule.write, input.ip);
}

interface StoredObjectRef {
  owner_resource_type: OwnerResourceType;
  owner_resource_id: string | null;
  uploaded_by: string | null;
}

async function mayActOnObject(
  tx: Tx,
  authz: AuthzContext,
  tenantId: string,
  obj: StoredObjectRef,
  action: StorageAction,
  perms: ReadonlySet<string>,
): Promise<boolean> {
  const rule = OWNER_TYPE_RULES[obj.owner_resource_type];
  if (perms.has(action === "read" ? rule.read : rule.write)) return true;
  const member = authz.membership !== null;
  switch (obj.owner_resource_type) {
    case "payment_proof":
      // A family reads the proofs of its children's invoices and finishes its own upload; it never deletes (legacy: a family
      // cannot remove a file once sent).
      if (!obj.owner_resource_id || action === "delete") return false;
      if (action === "complete" && obj.uploaded_by !== authz.userId) return false;
      return isFamilyOfInvoice(tx, authz, tenantId, obj.owner_resource_id);
    case "avatar":
      if (!member || obj.owner_resource_id !== authz.userId) return false;
      return action !== "complete" || obj.uploaded_by === authz.userId;
    case "school_logo":
      return member && action === "read";
    default:
      return false;
  }
}

/**
 * Load one object of this school and authorize the action on it. A caller who holds no staff permission for the action can
 * only ever reach their own objects, so for them a missing object and another person's object are the same 403 (no oracle
 * for object ids); a staff caller gets 404 for a missing object, as before.
 */
export async function authorizeObjectAction<T extends StoredObjectRef>(
  tx: Tx,
  authz: AuthzContext,
  input: { tenantId: string; action: StorageAction; ip: string | null },
  load: () => Promise<T | null>,
): Promise<T> {
  const perms = await loadEffectivePermissions(tx, authz);
  const obj = await load();
  if (!obj) {
    const staffSet = input.action === "read" ? STAFF_READ : STAFF_WRITE;
    if (staffSet.some((p) => perms.has(p))) throw notFound("Storage object not found");
    return deny(tx, authz, input.action === "read" ? DOCUMENTED.read : DOCUMENTED.write, input.ip);
  }
  if (await mayActOnObject(tx, authz, input.tenantId, obj, input.action, perms)) return obj;
  const rule = OWNER_TYPE_RULES[obj.owner_resource_type];
  return deny(tx, authz, input.action === "read" ? rule.read : rule.write, input.ip);
}
