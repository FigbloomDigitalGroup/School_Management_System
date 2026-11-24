import { useEffect, useRef, useState } from "react";
import { PageHead } from "../../components/ConsoleShell";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { SelectField, TextArea, TextField } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { useTenantSession } from "../../lib/sessionContext";

type ReportType = "daily" | "weekly" | "incident" | "progress" | "observation";
type ReportStatus = "draft" | "submitted" | "reviewed";
type InputMode = "typed" | "handwritten_ocr" | "hybrid";

export interface TeacherReportRecord {
  id: string;
  report_type: ReportType;
  report_date: string;
  title: string;
  input_mode: InputMode;
  raw_ocr_text: string | null;
  body: string;
  ocr_confidence: number | null;
  ocr_provider: string | null;
  status: ReportStatus;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

const REPORT_TYPE_OPTIONS: Array<{ value: ReportType; label: string }> = [
  { value: "daily", label: "Daily class report" },
  { value: "weekly", label: "Weekly summary" },
  { value: "progress", label: "Learner progress" },
  { value: "observation", label: "Classroom observation" },
  { value: "incident", label: "Incident report" },
];

const STATUS_TONE: Record<ReportStatus, Tone> = {
  draft: "muted",
  submitted: "info",
  reviewed: "ok",
};

function apiBaseUrl(): string {
  return (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("figbloom_api_token") ?? localStorage.getItem("api_token");
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read image file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Teacher Reports screen: teachers can either type a report directly OR capture/upload a photo
 * of a handwritten report, have Vision AI interpret the handwriting into editable text, review
 * and edit the captured text freely, and save as a draft or submit for school review.
 */
export function TeacherReports() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [reports, setReports] = useState<TeacherReportRecord[]>([]);
  const [loadingList, setLoadingList] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [mode, setMode] = useState<"type" | "scan">("type");
  const [reportType, setReportType] = useState<ReportType>("daily");
  const [reportDate, setReportDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  // Handwritten image capture & OCR state
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [imageMime, setImageMime] = useState<"image/jpeg" | "image/png" | "image/webp" | null>(null);
  const [rawOcrText, setRawOcrText] = useState<string | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrProvider, setOcrProvider] = useState<string | null>(null);
  const [interpreting, setInterpreting] = useState(false);
  const [saving, setSaving] = useState(false);

  async function loadReports() {
    const base = apiBaseUrl();
    if (!base) return;
    setLoadingList(true);
    try {
      const res = await fetch(`${base}/v1/tenants/${tenant.id}/teacher-reports?limit=30`, {
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { reports?: TeacherReportRecord[] };
      setReports(json.reports ?? []);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    void loadReports();
  }, [tenant.id]);

  function resetForm() {
    setEditingId(null);
    setReportType("daily");
    setReportDate(new Date().toISOString().slice(0, 10));
    setTitle("");
    setBody("");
    setPreviewUrl(null);
    setImageMime(null);
    setRawOcrText(null);
    setOcrConfidence(null);
    setOcrProvider(null);
  }

  function openExisting(r: TeacherReportRecord) {
    setEditingId(r.id);
    setReportType(r.report_type);
    setReportDate(r.report_date);
    setTitle(r.title);
    setBody(r.body);
    setRawOcrText(r.raw_ocr_text);
    setOcrConfidence(r.ocr_confidence);
    setOcrProvider(r.ocr_provider);
    setPreviewUrl(null);
    setMode("type");
  }

  async function handleFileSelected(file: File | undefined) {
    if (!file) return;
    const supported = ["image/jpeg", "image/png", "image/webp"] as const;
    const mime = supported.includes(file.type as (typeof supported)[number])
      ? (file.type as "image/jpeg" | "image/png" | "image/webp")
      : null;
    if (!mime) {
      toast("Please capture or upload a JPEG, PNG, or WebP photo.", "error");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      setPreviewUrl(dataUrl);
      setImageMime(mime);
    } catch {
      toast("Could not read that image.", "error");
    }
  }

  async function interpretHandwriting() {
    if (!previewUrl || !imageMime) {
      toast("Capture or choose a handwritten photo first.", "error");
      return;
    }
    const base = apiBaseUrl();
    if (!base) {
      toast("API URL is not configured.", "error");
      return;
    }
    setInterpreting(true);
    try {
      const res = await fetch(`${base}/v1/tenants/${tenant.id}/teacher-reports/interpret-handwriting`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          image_base64: previewUrl,
          mime_type: imageMime,
          report_type: reportType,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        interpretation?: {
          transcribed_text: string;
          suggested_title: string | null;
          confidence: number | null;
          provider: string;
        };
        error?: { message?: string };
      };
      if (!res.ok || !json.interpretation) {
        toast(json.error?.message ?? "Could not interpret handwriting. You can still type the report below.", "error");
        return;
      }
      const { transcribed_text, suggested_title, confidence, provider } = json.interpretation;
      setRawOcrText(transcribed_text);
      setOcrConfidence(confidence);
      setOcrProvider(provider);
      setBody(transcribed_text);
      if (!title.trim() && suggested_title) setTitle(suggested_title);
      toast("Handwriting interpreted! Review and edit the text below before saving.");
    } catch {
      toast("Network error while interpreting handwriting.", "error");
    } finally {
      setInterpreting(false);
    }
  }

  async function saveReport(submit: boolean) {
    if (!title.trim() || !body.trim()) {
      toast("Please enter both a report title and report text.", "error");
      return;
    }
    const base = apiBaseUrl();
    if (!base) {
      toast("API URL is not configured.", "error");
      return;
    }
    setSaving(true);
    try {
      const url = editingId
        ? `${base}/v1/tenants/${tenant.id}/teacher-reports/${editingId}`
        : `${base}/v1/tenants/${tenant.id}/teacher-reports`;
      const method = editingId ? "PATCH" : "POST";
      const payload = editingId
        ? {
            report_type: reportType,
            report_date: reportDate,
            title: title.trim(),
            body: body.trim(),
            submit,
          }
        : {
            report_type: reportType,
            report_date: reportDate,
            title: title.trim(),
            body: body.trim(),
            input_mode: rawOcrText ? (body.trim() === rawOcrText.trim() ? "handwritten_ocr" : "hybrid") : "typed",
            raw_ocr_text: rawOcrText,
            ocr_confidence: ocrConfidence,
            ocr_provider: ocrProvider,
            source_image_mime: imageMime,
            submit,
          };

      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) {
        toast(json.error?.message ?? "Could not save report.", "error");
        return;
      }
      toast(submit ? "Teacher report submitted." : "Draft saved.");
      resetForm();
      await loadReports();
    } catch {
      toast("Network error while saving report.", "error");
    } finally {
      setSaving(false);
    }
  }

  const wasEditedAfterOcr = Boolean(rawOcrText && body.trim() !== rawOcrText.trim());

  return (
    <>
      <PageHead
        eyebrow="Teacher · Reports"
        title="Teacher reports"
        blurb="Type a report directly or capture a photo of handwritten notes, let AI transcribe it, then review and edit every word before submitting."
        actions={editingId ? <Button onClick={resetForm}>New report</Button> : undefined}
      />

      <div className="grid gap-6 px-7 py-6 lg:grid-cols-[1.2fr_0.8fr]">
        <section className="rounded-xl border border-line bg-white p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold text-ink">
              {editingId ? "Edit report" : "Create report"}
            </h2>
            <div className="inline-flex rounded-lg border border-line bg-sunken p-0.5 text-[12.5px]">
              <button
                type="button"
                onClick={() => setMode("type")}
                className={`rounded-md px-3 py-1 font-medium transition ${mode === "type" ? "bg-white text-ink shadow-sm" : "text-ink-mute"}`}
              >
                Type report
              </button>
              <button
                type="button"
                onClick={() => setMode("scan")}
                className={`rounded-md px-3 py-1 font-medium transition ${mode === "scan" ? "bg-white text-ink shadow-sm" : "text-ink-mute"}`}
              >
                Scan handwritten page
              </button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              id="teacher-report-type"
              label="Report type"
              value={reportType}
              onChange={(e) => setReportType(e.target.value as ReportType)}
              options={REPORT_TYPE_OPTIONS}
            />
            <TextField
              id="teacher-report-date"
              label="Report date"
              type="date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
            />
          </div>

          {mode === "scan" && (
            <div className="mt-4 rounded-lg border border-dashed border-line bg-sunken/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[13px] font-medium text-ink">Capture or upload handwritten report</p>
                  <p className="text-[12px] text-ink-mute">
                    Use your phone camera or upload a clear photo (JPEG, PNG, WebP). You can edit the interpreted text afterwards.
                  </p>
                </div>
                <div className="flex gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => void handleFileSelected(e.target.files?.[0])}
                  />
                  <Button onClick={() => fileInputRef.current?.click()}>
                    {previewUrl ? "Retake / change photo" : "Capture / upload photo"}
                  </Button>
                  <Button
                    variant="accent"
                    disabled={!previewUrl || interpreting}
                    onClick={() => void interpretHandwriting()}
                  >
                    {interpreting ? "Interpreting…" : "Interpret handwriting"}
                  </Button>
                </div>
              </div>

              {previewUrl && (
                <div className="mt-3">
                  <img
                    src={previewUrl}
                    alt="Captured handwritten report preview"
                    className="max-h-64 rounded-lg border border-line object-contain"
                  />
                </div>
              )}
            </div>
          )}

          <div className="mt-4 space-y-3">
            <TextField
              id="teacher-report-title"
              label="Report title"
              placeholder="e.g. Grade 5 Daily Summary"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />

            <div>
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12.5px] font-medium text-ink">
                  Report text {rawOcrText ? "(interpreted from handwriting — editable)" : ""}
                </span>
                {rawOcrText && (
                  <div className="flex items-center gap-2 text-[11.5px]">
                    {ocrConfidence !== null && (
                      <Badge tone="info">OCR {Math.round(ocrConfidence * 100)}%</Badge>
                    )}
                    {wasEditedAfterOcr && <Badge tone="ok">Edited by teacher</Badge>}
                    {wasEditedAfterOcr && (
                      <button
                        type="button"
                        className="text-forest underline"
                        onClick={() => setBody(rawOcrText)}
                      >
                        Restore original OCR
                      </button>
                    )}
                  </div>
                )}
              </div>
              <TextArea
                id="teacher-report-body"
                label=""
                placeholder="Type your report here, or scan a handwritten page above to populate this editor…"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <Button disabled={saving} onClick={() => void saveReport(false)}>
              {saving ? "Saving…" : "Save draft"}
            </Button>
            <Button variant="accent" disabled={saving} onClick={() => void saveReport(true)}>
              {saving ? "Submitting…" : "Submit report"}
            </Button>
          </div>
        </section>

        <aside className="rounded-xl border border-line bg-white p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-ink">Recent reports</h2>
            <Button onClick={() => void loadReports()} disabled={loadingList}>
              Refresh
            </Button>
          </div>

          {loadingList && reports.length === 0 ? (
            <p className="text-[13px] text-ink-mute">Loading reports…</p>
          ) : reports.length === 0 ? (
            <p className="text-[13px] text-ink-mute">No teacher reports saved yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {reports.map((r) => (
                <li
                  key={r.id}
                  className="rounded-lg border border-line p-3 transition hover:border-forest/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-[13.5px] font-medium text-ink">{r.title}</p>
                      <p className="text-[12px] text-ink-mute">
                        {r.report_date} · {r.report_type} ·{" "}
                        {r.input_mode === "typed"
                          ? "Typed"
                          : r.input_mode === "hybrid"
                            ? "Handwritten + edited"
                            : "Handwritten OCR"}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[12.5px] text-ink-mute">{r.body}</p>
                  {r.status !== "reviewed" && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => openExisting(r)}
                        className="text-[12px] font-medium text-forest underline"
                      >
                        Edit report
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </>
  );
}
