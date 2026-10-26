import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildReportCards } from "./reportCards";
import { renderReportCardsPdf } from "./reportCardPdf";
import {
  inkLength, normaliseStrokes, parseStrokes, sha256Hex, signatureFor, signatureProblem, signatureTally, strokeBounds,
  strokesToSvgPath, MAX_SIGNATURE_POINTS, SIGNATURE_BOX, type StoredSignature,
} from "./signatures";

describe("normaliseStrokes", () => {
  it("scales a pad of any size into the signature box, in whole numbers", () => {
    const out = normaliseStrokes([[{ x: 0, y: 0 }, { x: 150, y: 50 }, { x: 300, y: 100 }]], 300, 100);
    expect(out).toEqual([[0, 0, 300, 100, 600, 200]]);
  });

  it("keeps points inside the box and drops ones that barely moved", () => {
    const out = normaliseStrokes([[{ x: -20, y: 5 }, { x: -19.9, y: 5.2 }, { x: 999, y: 999 }]], SIGNATURE_BOX.width, SIGNATURE_BOX.height);
    expect(out).toEqual([[0, 5, 600, 200]]);
  });

  it("keeps a tap as a dot, skips empty strokes and junk points", () => {
    expect(normaliseStrokes([[{ x: 10, y: 10 }], [], [{ x: NaN, y: 1 }]], 600, 200)).toEqual([[10, 10]]);
    expect(normaliseStrokes([[{ x: 1, y: 1 }]], 0, 200)).toEqual([]);
  });

  it("stops at the point limit", () => {
    const long = Array.from({ length: MAX_SIGNATURE_POINTS + 500 }, (_, i) => ({ x: (i * 3) % 600, y: (i * 7) % 200 }));
    const out = normaliseStrokes([long], 600, 200);
    expect(out.flat().length / 2).toBeLessThanOrEqual(MAX_SIGNATURE_POINTS);
  });
});

describe("signatureProblem", () => {
  const drawn = [[0, 0, 100, 0]];
  it("wants a full name", () => {
    expect(signatureProblem({ fullName: " A ", style: "typed", strokes: null })).toMatch(/full name/);
    expect(signatureProblem({ fullName: "Amani Otieno", style: "typed", strokes: null })).toBeNull();
  });
  it("wants real ink on a drawn signature, not a dot", () => {
    expect(signatureProblem({ fullName: "Amani Otieno", style: "drawn", strokes: [[5, 5]] })).toMatch(/Draw/);
    expect(signatureProblem({ fullName: "Amani Otieno", style: "drawn", strokes: null })).toMatch(/Draw/);
    expect(signatureProblem({ fullName: "Amani Otieno", style: "drawn", strokes: drawn })).toBeNull();
  });
  it("measures ink by distance travelled", () => {
    expect(inkLength([[0, 0, 3, 4, 3, 10]])).toBe(11);
  });
});

describe("strokesToSvgPath", () => {
  it("draws each stroke as a move then lines", () => {
    expect(strokesToSvgPath([[10, 20, 30, 40], [50, 60]])).toBe("M10 20 L30 40 M50 60 L51 60");
  });
  it("crops to the ink when asked", () => {
    expect(strokeBounds([[10, 20, 30, 40]])).toEqual({ minX: 10, minY: 20, width: 20, height: 20 });
    expect(strokesToSvgPath([[10, 20, 30, 40]], { crop: true })).toBe("M0 0 L20 20");
    expect(strokeBounds([])).toBeNull();
  });
});

describe("parseStrokes", () => {
  it("accepts strokes and refuses anything else", () => {
    expect(parseStrokes([[1, 2, 3, 4]])).toEqual([[1, 2, 3, 4]]);
    expect(parseStrokes([[1, 2, 3]])).toBeNull();
    expect(parseStrokes([["1", 2]])).toBeNull();
    expect(parseStrokes(null)).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("matches the standard digest for text and bytes", async () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await sha256Hex("abc")).toBe(abc);
    expect(await sha256Hex(new Uint8Array([97, 98, 99]))).toBe(abc);
  });
});

describe("signatureTally and signatureFor", () => {
  it("counts who has signed each document", () => {
    const row = (docId: string, signedAt: string | null) => ({ docId, signerId: "p", signerName: "P", capacity: "recipient" as const, requestedAt: "2026-10-01", signedAt });
    const t = signatureTally([row("a", "2026-10-02"), row("a", null), row("b", null)]);
    expect(t.get("a")).toEqual({ signed: 1, asked: 2 });
    expect(t.get("b")).toEqual({ signed: 0, asked: 1 });
  });

  it("finds the signature to stamp, leaving out one on a changed document", () => {
    const sig = (capacity: StoredSignature["capacity"], isCurrent: boolean | null): StoredSignature => ({
      id: capacity, docId: "card", signerId: "x", capacity, fullName: "X", style: "typed", strokes: null, signedAt: "2026-10-01T09:00:00Z", isCurrent,
    });
    const sigs = [sig("principal", false), sig("class_teacher", true)];
    expect(signatureFor(sigs, "card", "principal")?.id).toBe("principal");
    expect(signatureFor(sigs, "card", "principal", { currentOnly: true })).toBeUndefined();
    expect(signatureFor(sigs, "card", "class_teacher", { currentOnly: true })?.id).toBe("class_teacher");
  });
});

describe("signed report card PDF", () => {
  it("stamps drawn and typed signatures without breaking the card", async () => {
    const [card] = buildReportCards({
      school: { name: "Kijani Ridge School", county: "Nairobi", country: "KE", logoUrl: null, accent: "#1B4D2E" },
      term: { name: "Term 2 2026", year: 2026, startsOn: "2026-05-04", endsOn: "2026-08-07" },
      className: "Form 2 West", classTeacher: "Mary Wanjiku", scheme: "kcse",
      exams: [{ id: "end", name: "End of term", outOf: 100 }],
      learners: [{ id: "s0", name: "Amani Otieno", admissionNo: "1001" }],
      marks: [{ studentId: "s0", examId: "end", subjectId: "m", subjectName: "Mathematics", subjectCode: "MAT", score: 71 }],
      attendance: new Map(), fees: new Map(),
      options: { showPosition: true, showAttendance: false, showFees: false, nextTermBegins: null },
      today: "2026-08-08",
    });
    const bytes = await renderReportCardsPdf([{
      data: card!, teacherComment: "Steady work.", principalComment: "Keep it up.",
      signatures: {
        teacher: { fullName: "Mary Wanjiku", style: "drawn", strokes: [[10, 100, 80, 40, 150, 120, 220, 60]], signedAt: "2026-08-08T07:00:00Z" },
        principal: { fullName: "Joseph Kamau Ñjoroge", style: "typed", strokes: null, signedAt: "2026-08-09T07:00:00Z" },
      },
    }]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  });
});
