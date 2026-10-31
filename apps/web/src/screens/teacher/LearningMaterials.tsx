import { useEffect, useMemo, useRef, useState } from "react";
import {
  MATERIAL_KIND_LABEL, createMaterial, deleteMaterial, fetchMaterials, fetchMyTeachingPairs, fetchTeacherClasses,
  fetchTeacherSubjectsForClass, fileProblem, formatFileSize, formatShortDate, kindForLink, localIsoDate, kindForMime, materialFilePath, mediaSummary,
  mimeForFile, setMaterialPublished, supabase, updateMaterial, validateLink, validateMaterial,
  type MaterialRow,
} from "@figbloom/shared";
import { UPLOAD_LIMIT_BYTES } from "../../lib/uploadLimit";
import { PageHead } from "../../components/ConsoleShell";
import { MediaGlyph, MediaPlayer } from "../../components/Media";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, EmptyState, Mono } from "../../components/ui/DataTable";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { UploadCancelled, uploadLearningMedia, type UploadHandle } from "../../lib/resumableUpload";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { confirmDialog } from "../../components/ui/Confirm";

type Option = { id: string; name: string };

/** Where the class and subject pickers come from: a teacher's own assignments, or the whole school for the office. */
interface Scope {
  classes: () => Promise<Option[]>;
  subjectsFor: (classId: string) => Promise<Option[]>;
}

/**
 * Notes, worksheets, videos, pictures and links a teacher shares with a
 * class for a subject they teach; the school admin sees and can post for
 * every class. A material is a draft, seen only by staff, until it's
 * published; then the class's learners and their parents find it under
 * Learning materials. Videos can be uploaded (up to VITE_MAX_UPLOAD_MB) or linked from
 * YouTube, Vimeo or Google Drive.
 */
export function LearningMaterials({ admin = false }: { admin?: boolean }) {
  const toast = useToast();
  const { profile, tenant } = useTenantSession();
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<{ material?: MaterialRow } | null>(null);
  const [viewing, setViewing] = useState<MaterialRow | null>(null);
  const reload = () => setReloadKey((k) => k + 1);

  const scope: Scope = useMemo(() => admin
    ? {
        classes: async () => {
          const { data, error } = await supabase().from("classes").select("id, name").eq("tenant_id", tenant.id).order("name");
          if (error) throw new Error(error.message);
          return (data ?? []) as Option[];
        },
        subjectsFor: async () => {
          const { data, error } = await supabase().from("subjects").select("id, name").eq("tenant_id", tenant.id).order("name");
          if (error) throw new Error(error.message);
          return (data ?? []) as Option[];
        },
      }
    : {
        classes: () => fetchTeacherClasses(profile.id),
        subjectsFor: (classId: string) => fetchTeacherSubjectsForClass(profile.id, classId),
      }, [admin, tenant.id, profile.id]);

  const { data: classes } = useAsync(() => scope.classes(), [scope]);
  const { data, loading, error } = useAsync(async () => {
    const [all, pairs] = await Promise.all([fetchMaterials(tenant.id), admin ? Promise.resolve(null) : fetchMyTeachingPairs(profile.id)]);
    return pairs ? all.filter((m) => pairs.has(`${m.classId}:${m.subjectId}`)) : all;
  }, [tenant.id, profile.id, admin, reloadKey]);

  const materials = data ?? [];

  async function togglePublish(m: MaterialRow) {
    if (m.publishedAt && !(await confirmDialog({ title: `Unpublish "${m.title}"?`, body: `${m.className} won't see it any more.`, confirmLabel: "Unpublish" }))) return;
    try {
      await setMaterialPublished(m.id, !m.publishedAt);
      toast(m.publishedAt ? "Unpublished. Only staff can see it now." : `Published. ${m.className} can see it now.`);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not change that.", "error");
    }
  }

  async function remove(m: MaterialRow) {
    if (!(await confirmDialog({ title: `Delete "${m.title}" for ${m.className}?`, body: m.filePath ? "The file is deleted too." : undefined, confirmLabel: "Delete", danger: true }))) return;
    try {
      await deleteMaterial(m);
      toast("Material deleted");
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete it.", "error");
    }
  }

  return (
    <>
      <PageHead
        eyebrow="Learning materials"
        title="Learning materials"
        blurb={admin
          ? "Notes, worksheets, videos and links shared with every class in the school. Learners and parents see what's published."
          : "Share notes, worksheets, videos and links with a class you teach. Learners and their parents see them once you publish."}
        actions={<Button variant="accent" disabled={!classes?.length} onClick={() => setEditing({})}>Add material</Button>}
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the materials: {error.message}
          </p>
        ) : loading && !data ? (
          <TableSkeleton rows={4} />
        ) : classes && classes.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState title="No classes yet" body={admin ? "Add classes first under Classes." : "You aren't assigned to any classes yet. Ask the school admin to add you to a class."} />
          </div>
        ) : materials.length === 0 ? (
          <div className="rounded-lg border border-line bg-white">
            <EmptyState
              title="Nothing shared yet"
              body="Upload notes, a worksheet or a lesson video, or paste a YouTube link. It stays a draft until you publish it."
              action={<Button variant="accent" onClick={() => setEditing({})}>Add material</Button>}
            />
          </div>
        ) : (
          <DataTable
            title="Materials"
            columns={[
              { key: "title", header: "Material", width: "2fr", render: (m: MaterialRow) => (
                <div className="flex items-center gap-2.5">
                  <MediaGlyph kind={m.kind} />
                  <Cell sub={mediaSummary(m)}>{m.title}</Cell>
                </div>
              ) },
              { key: "class", header: "Class · subject", width: "1.2fr", render: (m: MaterialRow) => <Cell sub={m.subjectName}>{m.className}</Cell> },
              { key: "added", header: "Added", width: "0.8fr", render: (m: MaterialRow) => <Mono>{formatShortDate(localIsoDate(new Date(m.createdAt)))}</Mono> },
              { key: "state", header: "Status", width: "0.8fr", render: (m: MaterialRow) => (
                m.publishedAt ? <Badge tone="ok">Published</Badge> : <Badge tone="muted">Draft</Badge>
              ) },
              { key: "actions", header: "", align: "right", width: "2.2fr", render: (m: MaterialRow) => (
                <div className="flex flex-wrap justify-end gap-2">
                  <Button onClick={() => setViewing(m)}>View</Button>
                  <Button onClick={() => setEditing({ material: m })}>Edit</Button>
                  <Button onClick={() => void togglePublish(m)}>{m.publishedAt ? "Unpublish" : "Publish"}</Button>
                  <Button onClick={() => void remove(m)}>Delete</Button>
                </div>
              ) },
            ]}
            rows={materials}
            rowKey={(m) => m.id}
            minWidth="900px"
            empty={{ title: "Nothing shared yet", body: "Add the first one." }}
          />
        )}
      </div>

      {editing && (
        <MaterialEditor
          material={editing.material}
          classes={classes ?? []}
          scope={scope}
          onClose={() => { setEditing(null); reload(); }}
          onSaved={(msg) => { toast(msg); setEditing(null); reload(); }}
        />
      )}
      {viewing && (
        <Modal open onClose={() => setViewing(null)} eyebrow={`${MATERIAL_KIND_LABEL[viewing.kind]} · ${viewing.className} · ${viewing.subjectName}`} title={viewing.title} width={820}>
          <div className="grid gap-3">
            {viewing.description && <p className="whitespace-pre-line text-[13.5px] leading-relaxed">{viewing.description}</p>}
            <MediaPlayer item={viewing} />
          </div>
        </Modal>
      )}
    </>
  );
}

function MaterialEditor({ material, classes, scope, onClose, onSaved }: {
  material?: MaterialRow;
  classes: Option[];
  scope: Scope;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { tenant } = useTenantSession();
  const [source, setSource] = useState<"file" | "link">("file");
  const [classId, setClassId] = useState(material?.classId ?? classes[0]?.id ?? "");
  const [subjectId, setSubjectId] = useState(material?.subjectId ?? "");
  const [title, setTitle] = useState(material?.title ?? "");
  const [description, setDescription] = useState(material?.description ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [fraction, setFraction] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const upload = useRef<UploadHandle | null>(null);

  const { data: subjectList } = useAsync(
    async () => ({ classId, list: classId ? await scope.subjectsFor(classId) : [] }),
    [classId, scope],
  );
  const subjects = useMemo(() => (subjectList?.classId === classId ? subjectList.list : null), [subjectList, classId]);
  useEffect(() => {
    if (!subjects) return;
    if (!subjects.some((s) => s.id === subjectId)) setSubjectId(subjects[0]?.id ?? "");
  }, [subjects, subjectId]);

  function pickFile(f: File | null) {
    setFile(f);
    setError(f ? fileProblem(f, UPLOAD_LIMIT_BYTES) ?? "" : "");
    // A file named "Photosynthesis notes.pdf" is usually titled just that.
    if (f && !title.trim()) setTitle(f.name.replace(/\.[a-z0-9]+$/i, ""));
  }

  async function save(publish: boolean) {
    const checked = validateMaterial({ classId, subjectId, title, description });
    if (!checked.ok) { setError(checked.message); return; }
    setError("");

    if (material) {
      setSaving(true);
      try {
        await updateMaterial(material.id, checked.value);
        if (publish && !material.publishedAt) await setMaterialPublished(material.id, true);
        onSaved(publish ? "Published. Learners in the class can see it now." : "Material saved");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save.");
        setSaving(false);
      }
      return;
    }

    if (source === "link") {
      const url = validateLink(link);
      if (!url.ok) { setError(url.message); return; }
      setSaving(true);
      try {
        const id = await createMaterial(tenant.id, checked.value, { kind: kindForLink(url.value), url: url.value });
        if (publish) await setMaterialPublished(id, true);
        onSaved(publish ? "Published. Learners in the class can see it now." : "Saved as a draft");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save.");
        setSaving(false);
      }
      return;
    }

    if (!file) { setError("Choose the file to upload."); return; }
    const problem = fileProblem(file, UPLOAD_LIMIT_BYTES);
    const mime = mimeForFile(file);
    if (problem || !mime) { setError(problem ?? "That type of file can't be uploaded."); return; }

    // The row goes in first as a draft (the storage policy only takes a file
    // for a material that exists), then the file, then it's published.
    setSaving(true);
    const id = crypto.randomUUID();
    const filePath = materialFilePath(tenant.id, id, file.name);
    let created = false;
    try {
      await createMaterial(tenant.id, checked.value, { id, kind: kindForMime(mime), filePath, fileName: file.name, mimeType: mime, sizeBytes: file.size });
      created = true;
      setFraction(0);
      upload.current = uploadLearningMedia(filePath, file, mime, setFraction);
      await upload.current.done;
      if (publish) await setMaterialPublished(id, true);
      onSaved(publish ? "Uploaded and published. Learners in the class can see it now." : "Uploaded. It's a draft until you publish it.");
    } catch (err) {
      // Nothing half-done is left behind: no draft pointing at a missing file.
      if (created) await deleteMaterial({ id, filePath }).catch(() => {});
      setError(err instanceof UploadCancelled ? "Upload cancelled. Nothing was saved." : err instanceof Error ? err.message : "Could not upload.");
      setSaving(false);
    } finally {
      upload.current = null;
      setFraction(null);
    }
  }

  async function close() {
    if (upload.current && !(await confirmDialog({ title: "Stop uploading and close?", body: "The file is still uploading.", confirmLabel: "Stop and close" }))) return;
    upload.current?.cancel();
    onClose();
  }

  const noSubjects = subjects !== null && subjects.length === 0;
  const published = !!material?.publishedAt;

  return (
    <Modal
      open
      onClose={close}
      eyebrow="Learning materials"
      title={material ? "Edit material" : "Add material"}
      width={640}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button disabled={saving || noSubjects} onClick={() => void save(false)}>{saving ? "Saving…" : published ? "Save changes" : "Save draft"}</Button>
          {!published && <Button variant="accent" disabled={saving || noSubjects} onClick={() => void save(true)}>Save and publish</Button>}
        </>
      }
    >
      <div className="grid gap-3.5">
        <div className="grid gap-3.5" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <SelectField id="lm-class" label="Class" value={classId} disabled={saving} onChange={(e) => setClassId(e.target.value)}
            options={classes.map((c) => ({ value: c.id, label: c.name }))} />
          <SelectField id="lm-subject" label="Subject" value={subjectId} disabled={saving} onChange={(e) => setSubjectId(e.target.value)}
            options={(subjects ?? []).map((s) => ({ value: s.id, label: s.name }))}
            hint={noSubjects ? "You aren't assigned a subject in this class. Ask the school admin." : undefined} />
        </div>

        {material ? (
          <div className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-page px-3.5 py-2.5">
            <MediaGlyph kind={material.kind} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{material.fileName ?? material.url}</div>
              <div className="text-[11.5px] text-ink-faint">{mediaSummary(material)}. To use a different file or link, add a new material and delete this one.</div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              {(["file", "link"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={saving}
                  onClick={() => { setSource(s); setError(""); }}
                  className="flex-1 rounded-lg border px-3.5 py-2.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
                  style={source === s ? { borderColor: "#17402A", background: "#F1F6F2" } : { borderColor: "#D3DAD5" }}
                >
                  <div className="text-[13px] font-semibold">{s === "file" ? "Upload a file" : "Paste a link"}</div>
                  <div className="mt-0.5 text-[11.5px] text-ink-faint">
                    {s === "file" ? `Notes, a worksheet, slides, a picture, a recording, or a video up to ${formatFileSize(UPLOAD_LIMIT_BYTES)}.` : "A YouTube, Vimeo or Google Drive video plays right in the app. Any other site opens in a new tab."}
                  </div>
                </button>
              ))}
            </div>
            {source === "file" ? (
              <div className="rounded-lg border border-line-soft bg-page px-3.5 py-3">
                <input type="file" disabled={saving} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} className="text-[12.5px]" />
                {file && !fileProblem(file, UPLOAD_LIMIT_BYTES) && (
                  <div className="mt-1.5 text-[11.5px] text-ink-faint">{MATERIAL_KIND_LABEL[kindForMime(mimeForFile(file) ?? "")]} · {formatFileSize(file.size)}</div>
                )}
                {fraction !== null && (
                  <div className="mt-3 grid gap-1.5">
                    <div className="flex items-center justify-between gap-3 text-[12px]">
                      <span className="text-ink-muted">Uploading {file?.name} · {Math.round(fraction * 100)}%</span>
                      <Button onClick={() => upload.current?.cancel()}>Cancel upload</Button>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-[#E2E6E2]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
                      <div className="h-full rounded-full bg-forest transition-[width]" style={{ width: `${Math.round(fraction * 100)}%` }} />
                    </div>
                    <p className="text-[11.5px] text-ink-faint">Keep this window open until it finishes. A dropped connection picks up where it left off.</p>
                  </div>
                )}
              </div>
            ) : (
              <TextField id="lm-link" label="Link" placeholder="e.g. https://www.youtube.com/watch?v=…" value={link} disabled={saving} onChange={(e) => setLink(e.target.value)} />
            )}
          </>
        )}

        <TextField id="lm-title" label="Title" placeholder="e.g. Photosynthesis: notes and diagrams" value={title} disabled={saving} onChange={(e) => setTitle(e.target.value)} />
        <TextArea id="lm-description" label="Description (optional)" placeholder="e.g. Read pages 1 to 4 before Thursday's practical." value={description} disabled={saving} onChange={(e) => setDescription(e.target.value)} />

        {error && (
          <p className="flex items-start gap-1.5 text-[12px] leading-snug text-warn-ink"><span aria-hidden>✕</span>{error}</p>
        )}
      </div>
    </Modal>
  );
}
