import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { FeesCollection, PendingProof } from "@figbloom/shared";
import { noteRecordedPayment } from "../../lib/recordedPayment";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import { Fees } from "./Fees";

// The bursar's fees away from the desk: the term's figures, the biggest balances, the proofs families sent, and the way to record a payment.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("../../components/Skeleton", () => ({ Skeleton: () => null }));
// The screen reads the note a payment form leaves when it is focused again: the test says when that is.
let mockFocused: (() => void) | null = null;
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useFocusEffect: (callback: () => void) => { mockFocused = callback; },
}));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchFeesCollection: jest.fn(), rejectPaymentProof: jest.fn(), privateDocumentUrl: jest.fn(),
}));

const fetchFeesCollection = shared.fetchFeesCollection as unknown as jest.Mock;
const rejectPaymentProof = shared.rejectPaymentProof as unknown as jest.Mock;
const privateDocumentUrl = shared.privateDocumentUrl as unknown as jest.Mock;

const session: StaffSession = {
  role: "staff", accent: "#7A1F2B", profileId: "bursar-1", tenantId: "school-1", fullName: "Bea Achieng", country: "KE",
  adminAreas: ["fees"], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Bursar",
};

const proof = (over: Partial<PendingProof> = {}): PendingProof => ({
  id: "p1", file_path: "school-1/invoices/inv-1/slip.jpg", file_name: "slip.jpg", note: "Paid on Friday", uploaded_at: "2026-11-05T08:00:00Z",
  sms_text: null, txn_source: null, txn_code: null, txn_amount_cents: null, txn_at: null, txn_payee: null, txn_payee_number: null, txn_account: null,
  studentName: "Ann Wanjiru", cls: "Form 1A", invoice: { id: "inv-1", studentName: "Ann Wanjiru", cls: "Form 1A", balanceCents: 600_000 }, ...over,
});

const collection = (over: Partial<FeesCollection> = {}): FeesCollection => ({
  term: { id: "term-3", tenant_id: "school-1", name: "Term 3, 2026", year: 2026, index: 3, starts_on: "2026-09-01", ends_on: "2026-11-27", is_current: true },
  invoices: [
    { total_cents: 1_000_000, paid_cents: 1_000_000 }, { total_cents: 1_000_000, paid_cents: 400_000 },
    { total_cents: 1_000_000, paid_cents: 0 }, { total_cents: 1_000_000, paid_cents: 1_200_000 },
  ],
  outstanding: [
    { id: "inv-3", name: "Dan Otieno", cls: "Form 2B", billed: 1_000_000, charges: 150_000, paid: 0 },
    { id: "inv-1", name: "Ann Wanjiru", cls: "Form 1A", billed: 1_000_000, charges: 0, paid: 400_000 },
  ],
  overpaid: [{ id: "o1", total_cents: 1_000_000, paid_cents: 1_200_000, overpaid_cents: 200_000, students: { full_name: "Eve Kamau", classes: { name: "Form 3A" } }, terms: { name: "Term 3, 2026" } }],
  pendingProofs: [
    proof({ sms_text: "SFC1234ABC Confirmed. Ksh5,000.00 paid", txn_source: "mpesa", txn_code: "SFC1234ABC", txn_amount_cents: 500_000, txn_payee_number: "522522", txn_at: "2026-11-05T07:00:00Z" }),
  ],
  school: { paybill: "522522", till: null },
  ...over,
});

let openURL: jest.SpyInstance;
const onRecord = jest.fn();
beforeEach(() => {
  mockFocused = null;
  onRecord.mockReset();
  fetchFeesCollection.mockReset().mockResolvedValue(collection());
  rejectPaymentProof.mockReset().mockResolvedValue(undefined);
  privateDocumentUrl.mockReset().mockResolvedValue("https://files.example/signed?token=abc");
  openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
});
afterEach(() => openURL.mockRestore());

async function open() {
  render(<ThemeProvider><Fees session={session} onRecord={onRecord} /></ThemeProvider>);
  await screen.findByText("Largest outstanding balances", {}, { timeout: 5000 });
}

describe("how the term is going", () => {
  it("leads with what was billed, collected, still owed and fully paid, for the school's term", async () => {
    await open();
    expect(fetchFeesCollection).toHaveBeenCalledWith("school-1");
    expect(screen.getByText("Term 3, 2026")).toBeTruthy();
    expect(screen.getByText("KSh 40,000")).toBeTruthy();
    expect(screen.getByText("4 learners")).toBeTruthy();
    expect(screen.getByText("KSh 26,000")).toBeTruthy();
    expect(screen.getByText("65% of billed")).toBeTruthy();
    expect(screen.getByText("KSh 16,000")).toBeTruthy();
    expect(screen.getByText("2 learners owe a balance")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("2 invoices cleared")).toBeTruthy();
  });

  it("lists the biggest balances with what was billed (and the charges in it), what was paid, and where each stands", async () => {
    await open();
    expect(screen.getByText("Dan Otieno")).toBeTruthy();
    expect(screen.getByText("KSh 10,000")).toBeTruthy();
    expect(screen.getByText("Billed KSh 10,000 (incl. KSh 1,500 charges) · Paid KSh 0 · Nothing paid")).toBeTruthy();
    expect(screen.getByText("KSh 6,000")).toBeTruthy();
    expect(screen.getByText("Billed KSh 10,000 · Paid KSh 4,000 · Part paid")).toBeTruthy();
  });

  it("lists what was paid above what was owed, with why it happens", async () => {
    await open();
    expect(screen.getByText("Paid more than was owed")).toBeTruthy();
    expect(screen.getByText("Eve Kamau")).toBeTruthy();
    expect(screen.getByText("Form 3A · Term 3, 2026")).toBeTruthy();
    expect(screen.getByText("KSh 2,000")).toBeTruthy();
    expect(screen.getByText(/Two payments crossed/)).toBeTruthy();
  });

  it("leaves the overpayments out when there are none", async () => {
    fetchFeesCollection.mockResolvedValue(collection({ overpaid: [] }));
    await open();
    expect(screen.queryByText("Paid more than was owed")).toBeNull();
  });

  it("says no term is open between terms, and that nothing is billed yet for a term with no invoices", async () => {
    fetchFeesCollection.mockResolvedValue(collection({ term: null, invoices: [], outstanding: [], pendingProofs: [], overpaid: [] }));
    render(<ThemeProvider><Fees session={session} onRecord={onRecord} /></ThemeProvider>);
    expect(await screen.findByText("No term is open", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("Record a payment")).toBeNull();
  });

  it("says nothing has been billed yet, and that every balance is cleared and nothing waits for review, when that is so", async () => {
    fetchFeesCollection.mockResolvedValue(collection({ invoices: [], outstanding: [], pendingProofs: [], overpaid: [] }));
    await open();
    expect(screen.getByText(/No invoices yet for Term 3, 2026/)).toBeTruthy();
    expect(screen.getByText("Every balance is cleared")).toBeTruthy();
    expect(screen.getByText("Nothing to review")).toBeTruthy();
  });

  it("says why it could not load, and asks again on request", async () => {
    fetchFeesCollection.mockRejectedValueOnce(new Error("Network request failed"));
    render(<ThemeProvider><Fees session={session} onRecord={onRecord} /></ThemeProvider>);
    expect(await screen.findByText("Network request failed", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Largest outstanding balances")).toBeTruthy();
  });
});

describe("recording a payment", () => {
  it("opens the form for any learner from 'Record a payment', in this term", async () => {
    await open();
    fireEvent.press(screen.getByText("Record a payment"));
    expect(onRecord).toHaveBeenCalledWith({ termId: "term-3" });
  });

  it("opens the form for that learner's invoice, at what is still owed, from their balance", async () => {
    await open();
    fireEvent.press(screen.getAllByText("Record payment")[1]!);
    expect(onRecord).toHaveBeenCalledWith({ termId: "term-3", invoice: { id: "inv-1", studentName: "Ann Wanjiru", cls: "Form 1A", balanceCents: 600_000 } });
  });

  it("says a payment was recorded, and reads the term again, when the form closes and the screen is back in view", async () => {
    await open();
    expect(fetchFeesCollection).toHaveBeenCalledTimes(1);
    noteRecordedPayment("KSh 6,000 recorded for Ann Wanjiru");
    await act(async () => { mockFocused!(); });
    expect(await screen.findByText("KSh 6,000 recorded for Ann Wanjiru")).toBeTruthy();
    expect(fetchFeesCollection).toHaveBeenCalledTimes(2);
  });

  it("says nothing, and reads nothing again, when it is focused with no payment recorded", async () => {
    await open();
    await act(async () => { mockFocused!(); });
    expect(fetchFeesCollection).toHaveBeenCalledTimes(1);
  });
});

describe("the proof families sent", () => {
  it("shows whose it is, the code and amount of the message, the message, the note, and what to look at twice", async () => {
    await open();
    expect(screen.getByLabelText("Payment proof from Ann Wanjiru")).toBeTruthy();
    expect(screen.getByText("SFC1234ABC · KSh 5,000")).toBeTruthy();
    expect(screen.getByText("SFC1234ABC Confirmed. Ksh5,000.00 paid")).toBeTruthy();
    expect(screen.getByText("Note: Paid on Friday")).toBeTruthy();
    // KSh 5,000 is not the KSh 6,000 still owed
    expect(screen.getByText("Amount differs from balance")).toBeTruthy();
    expect(screen.getByText("5 Nov")).toBeTruthy();
  });

  it("opens the file the family sent from a signed link", async () => {
    await open();
    fireEvent.press(screen.getByText("View slip.jpg"));
    await act(async () => {});
    expect(privateDocumentUrl).toHaveBeenCalledWith("school-1/invoices/inv-1/slip.jpg");
    expect(openURL).toHaveBeenCalledWith("https://files.example/signed?token=abc");
  });

  it("says why when the file could not be opened", async () => {
    privateDocumentUrl.mockRejectedValue(new Error("Object not found"));
    await open();
    fireEvent.press(screen.getByText("View slip.jpg"));
    expect(await screen.findByText("Object not found")).toBeTruthy();
    expect(openURL).not.toHaveBeenCalled();
  });

  it("confirms by opening the payment form with that invoice and what the proof showed", async () => {
    await open();
    fireEvent.press(screen.getByText("Confirm"));
    expect(onRecord).toHaveBeenCalledWith({
      termId: "term-3",
      invoice: { id: "inv-1", studentName: "Ann Wanjiru", cls: "Form 1A", balanceCents: 600_000 },
      proof: expect.objectContaining({ id: "p1", code: "SFC1234ABC", amountCents: 500_000, method: "mpesa", fileName: "slip.jpg" }),
    });
  });

  it("will not confirm a proof whose invoice cannot be found", async () => {
    fetchFeesCollection.mockResolvedValue(collection({ pendingProofs: [proof({ invoice: null })] }));
    await open();
    fireEvent.press(screen.getByText("Confirm"));
    expect(onRecord).not.toHaveBeenCalled();
  });

  it("asks for a reason before rejecting, which the family will read, and offers the usual ones", async () => {
    await open();
    fireEvent.press(screen.getByText("Reject"));
    expect(screen.getByText(/Ann Wanjiru's family will see this reason/)).toBeTruthy();
    expect(screen.getByText("The amount on the statement is different.")).toBeTruthy();
    fireEvent.press(screen.getByText("Reject proof"));
    expect(rejectPaymentProof).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText("Reason for rejecting Ann Wanjiru's proof"), "no");
    fireEvent.press(screen.getByText("Reject proof"));
    expect(rejectPaymentProof).not.toHaveBeenCalled();
  });

  it("rejects with the reason picked, as the person signed in, says so, and the proof leaves the list", async () => {
    await open();
    fireEvent.press(screen.getByText("Reject"));
    fireEvent.press(screen.getByText("The amount on the statement is different."));
    await act(async () => { fireEvent.press(screen.getByText("Reject proof")); });
    expect(rejectPaymentProof).toHaveBeenCalledWith({ proofId: "p1", reviewerId: "bursar-1", reason: "The amount on the statement is different." });
    expect(await screen.findByText("Payment proof rejected. Ann Wanjiru's family will see the reason.")).toBeTruthy();
    expect(screen.queryByLabelText("Payment proof from Ann Wanjiru")).toBeNull();
    expect(fetchFeesCollection).toHaveBeenCalledTimes(2);
  });

  it("rejects with a reason typed in the person's own words", async () => {
    await open();
    fireEvent.press(screen.getByText("Reject"));
    fireEvent.changeText(screen.getByLabelText("Reason for rejecting Ann Wanjiru's proof"), "Blurred, please send it again");
    await act(async () => { fireEvent.press(screen.getByText("Reject proof")); });
    expect(rejectPaymentProof).toHaveBeenCalledWith(expect.objectContaining({ reason: "Blurred, please send it again" }));
  });

  it("leaves the proof where it is and says why when the database will not take the rejection", async () => {
    rejectPaymentProof.mockRejectedValue(new Error("That payment proof is no longer waiting for review."));
    await open();
    fireEvent.press(screen.getByText("Reject"));
    fireEvent.press(screen.getByText("This payment is for a different learner."));
    await act(async () => { fireEvent.press(screen.getByText("Reject proof")); });
    expect(await screen.findByText("Could not update: That payment proof is no longer waiting for review.")).toBeTruthy();
    expect(screen.getByLabelText("Payment proof from Ann Wanjiru")).toBeTruthy();
  });

  it("goes back from the reason without rejecting", async () => {
    await open();
    fireEvent.press(screen.getByText("Reject"));
    fireEvent.press(screen.getByText("Cancel"));
    expect(screen.queryByText("Reject proof")).toBeNull();
    expect(rejectPaymentProof).not.toHaveBeenCalled();
  });
});
