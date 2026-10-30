import { describe, expect, it } from "vitest";
import { fileExtension, prescriptionPath, uploadProblem, PHONE_UPLOAD_LIMIT_BYTES } from "./uploads";
import { paymentProofFilePath } from "./paymentProofs";

describe("phone uploads", () => {
  it("keeps a file's extension, lower-cased, and falls back to bin", () => {
    expect(fileExtension("Scan 1.JPG")).toBe("jpg");
    expect(fileExtension("photo.tar.gz")).toBe("gz");
    expect(fileExtension("noextension")).toBe("bin");
  });

  it("puts a prescription photo in the child's own medical folder", () => {
    expect(prescriptionPath("t1", "s1", "IMG 0042.jpeg", 1700000000000)).toBe("t1/medical/s1/1700000000000-prescription.jpeg");
    // a name with slashes or odd characters cannot climb out of the folder
    expect(prescriptionPath("t1", "s1", "../../x.png", 5)).toBe("t1/medical/s1/5-prescription.png");
  });

  it("puts a payment proof in the invoice's folder under a safe name", () => {
    expect(paymentProofFilePath("t1", "inv1", "M-Pesa slip.png", 9)).toBe("t1/invoices/inv1/9-M-Pesa slip.png");
    const p = paymentProofFilePath("t1", "inv1", "../../evil/..\\x.png", 9);
    expect(p.startsWith("t1/invoices/inv1/9-")).toBe(true);
    expect(p.slice("t1/invoices/inv1/".length)).not.toMatch(/[\\/]/);
  });

  it("refuses a photo over the limit and lets an unmeasured one through", () => {
    expect(uploadProblem({ name: "a.jpg", sizeBytes: 1024 })).toBeNull();
    expect(uploadProblem({ name: "a.jpg", sizeBytes: null })).toBeNull();
    expect(uploadProblem({ name: "a.jpg", sizeBytes: PHONE_UPLOAD_LIMIT_BYTES + 1 })).toMatch(/most that can be sent is 50 MB/);
  });
});
