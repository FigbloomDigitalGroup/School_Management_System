import { afterEach, describe, expect, it, vi } from "vitest";
import { initBackend } from "../backend";
import { NotOnApiError, canManageMaterials, materialsCapabilities } from "../capabilities";
import {
  createLearningMaterial, createMaterial, deleteMaterial, fetchMaterials, setMaterialPublished, updateMaterial,
} from "../materials";
import { BASE, createFakeApi, type FakeApi, type FakeReply, type FakeRoute } from "../testing/fakeApi";
import { resetApiClient, setApiActiveTenant, setApiTokenStore } from "./client";
import { createMemoryTokenStore } from "./tokenStore";

const T = "11111111-1111-4111-8111-111111111111";
const YEAR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const S1 = "s1s1s1s1-s1s1-4s1s-8s1s-s1s1s1s1s1s1";
const U1 = "30000001-1111-4111-8111-111111111111";

const stamp = { created_at: "2026-05-01T08:00:00Z", updated_at: "2026-05-01T08:00:00Z" };
const year = (o: Record<string, unknown> = {}) => ({
  id: YEAR, tenantId: T, label: "2026", starts_on: "2026-01-01", ends_on: "2026-12-31", is_current: true, ...stamp, ...o,
});
const clsRow = (o: Record<string, unknown> = {}) => ({
  id: C1, tenantId: T, academic_year_id: YEAR, name: "Form 2 East", form_level: 2, stream: "East",
  education_level: "secondary", class_teacher_staff_id: null, active: true, ...stamp, ...o,
});
const subRow = (o: Record<string, unknown> = {}) => ({
  id: S1, tenantId: T, code: "BIO", name: "Biology", active: true, ...stamp, ...o,
});
const page = (next: string | null = null) => ({ limit: 200, next_cursor: next });
const list = (key: string, items: unknown[], next: string | null = null): FakeReply => ({ body: { [key]: items, page: page(next) } });
const refused = (code: string, status: number, message = "no") => ({ status, body: { error: { code, message } } });

const P = `/v1/tenants/${T}`;
let api: FakeApi;

function boot(routes: Record<string, FakeRoute>) {
  api = createFakeApi(routes);
  vi.stubGlobal("fetch", api.fetch);
  initBackend({ kind: "api", apiUrl: BASE });
  resetApiClient();
  setApiTokenStore(createMemoryTokenStore({ token: "tok", expiresAt: "2099-01-01T00:00:00Z", userId: U1 }));
  setApiActiveTenant(T);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetApiClient();
  initBackend({ kind: "supabase" });
});

describe("fetchMaterials and createLearningMaterial on API", () => {
  it("lists materials across pages and resolves class and subject names", async () => {
    boot({
      [`GET ${P}/learning-materials`]: (req) => (
        req.query.get("cursor")
          ? list("materials", [
              { id: "m2", tenantId: T, title: "School revision pack", description: null, class_id: null, subject_id: null, storage_status: "metadata_only", created_at: "2026-05-01T08:00:00Z" },
            ])
          : list("materials", [
              { id: "m1", tenantId: T, title: "Photosynthesis", description: "Read ch 1", class_id: C1, subject_id: S1, storage_status: "metadata_only", created_at: "2026-05-02T08:00:00Z" },
            ], "c-1")
      ),
      [`GET ${P}/academic-years`]: list("academic_years", [year()]),
      [`GET ${P}/classes`]: list("classes", [clsRow()]),
      [`GET ${P}/subjects`]: list("subjects", [subRow()]),
    });

    const rows = await fetchMaterials(T);
    expect(rows.map((r) => ({
      id: r.id, title: r.title, description: r.description, className: r.className, subjectName: r.subjectName, publishedAt: r.publishedAt,
    }))).toEqual([
      { id: "m1", title: "Photosynthesis", description: "Read ch 1", className: "Form 2 East", subjectName: "Biology", publishedAt: "2026-05-02T08:00:00Z" },
      { id: "m2", title: "School revision pack", description: "", className: "All classes", subjectName: "—", publishedAt: "2026-05-01T08:00:00Z" },
    ]);
  });

  it("tolerates 403 on classes/subjects and validates + posts strict material body", async () => {
    const server = boot({
      [`GET ${P}/learning-materials`]: list("materials", [
        { id: "m1", tenantId: T, title: "Notes", description: null, class_id: C1, subject_id: S1, storage_status: "metadata_only", created_at: "2026-05-02T08:00:00Z" },
      ]),
      [`GET ${P}/academic-years`]: refused("forbidden", 403),
      [`GET ${P}/classes`]: refused("forbidden", 403),
      [`GET ${P}/subjects`]: refused("forbidden", 403),
      [`POST ${P}/learning-materials`]: {
        status: 201,
        body: { material: { id: "new-m1", tenantId: T, title: "Cell Biology", description: null, class_id: C1, subject_id: S1, storage_status: "metadata_only", created_at: "2026-05-02T08:00:00Z" } },
      },
    });

    const rows = await fetchMaterials(T);
    expect(rows[0]!.className).toBe("All classes");
    expect(rows[0]!.subjectName).toBe("—");

    const id = await createLearningMaterial(T, { classId: C1, subjectId: S1, title: "  Cell   Biology  ", description: "   " });
    expect(id).toBe("new-m1");
    expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({
      title: "Cell Biology",
      description: null,
      class_id: C1,
      subject_id: S1,
    });
  });
});

describe("materialsCapabilities and NotOnApiError guards", () => {
  it("reports Supabase vs API capabilities and guards Supabase-only mutations", async () => {
    expect(materialsCapabilities()).toEqual({
      filesAndLinks: true, draftWorkflow: true, editMaterial: true, deleteMaterial: true,
    });

    initBackend({ kind: "api", apiUrl: BASE });
    expect(materialsCapabilities()).toEqual({
      filesAndLinks: false, draftWorkflow: false, editMaterial: false, deleteMaterial: false,
    });

    await expect(createMaterial(T, { classId: C1, subjectId: S1, title: "T", description: "" }, { kind: "link", url: "https://example.com" }))
      .rejects.toThrow(NotOnApiError);
    await expect(updateMaterial("m1", { classId: C1, subjectId: S1, title: "T", description: "" }))
      .rejects.toThrow(NotOnApiError);
    await expect(setMaterialPublished("m1", true)).rejects.toThrow(NotOnApiError);
    await expect(deleteMaterial({ id: "m1", filePath: null })).rejects.toThrow(NotOnApiError);
  });

  it("checks canManageMaterials on Supabase vs API", () => {
    expect(canManageMaterials([], "teacher")).toBe(true);

    initBackend({ kind: "api", apiUrl: BASE });
    expect(canManageMaterials([], "teacher")).toBe(false);
    expect(canManageMaterials(["academics"], "teacher")).toBe(true);
    expect(canManageMaterials([], "school_admin")).toBe(true);
  });
});
