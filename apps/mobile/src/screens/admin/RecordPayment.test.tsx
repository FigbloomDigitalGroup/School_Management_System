import { Alert } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import type { PayableInvoice, ProofToConfirm } from "@figbloom/shared";
import type { StaffSession } from "../../lib/staffSession";
import { ThemeProvider } from "../../ui/ThemeContext";
import type { RecordPaymentParams } from "./Fees";
import { RecordPayment } from "./RecordPayment";

// Money received outside the M-Pesa prompt: cash, a bank slip, a cheque, M-Pesa to the paybill; or the payment a family's proof shows.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn() }) }));
jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), recordPayment: jest.fn(), searchPayableInvoices: jest.fn() }));

const recordPayment = shared.recordPayment as unknown as jest.Mock;
const searchPayableInvoices = shared.searchPayableInvoices as unknown as jest.Mock;

const session: StaffSession = {
  role: "staff", accent: "#7A1F2B", profileId: "bursar-1", tenantId: "school-1", fullName: "Bea Achieng", country: "KE",
  adminAreas: ["fees"], school: { name: "Kijani Ridge", slug: "kijani" }, title: "Bursar",
};
const ANN: PayableInvoice = { id: "inv-1", studentName: "Ann Wanjiru · 1042", cls: "Form 1A", balanceCents: 600_000 };
const DAN: PayableInvoice = { id: "inv-3", studentName: "Dan Otieno · 1077", cls: "Form 2B", balanceCents: 1_000_000 };
const SMS_PROOF: ProofToConfirm = {
  id: "p1", fileName: "slip.jpg", note: "Paid on Friday", smsText: "SFC1234ABC Confirmed. Ksh5,000.00 paid", code: "SFC1234ABC", amountCents: 500_000, method: "mpesa",
};

let alert: jest.SpyInstance;
const onRecorded = jest.fn();
beforeEach(() => {
  onRecorded.mockReset();
  recordPayment.mockReset().mockResolvedValue(undefined);
  searchPayableInvoices.mockReset().mockResolvedValue([ANN, DAN]);
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

async function open(params: Partial<RecordPaymentParams> = { invoice: ANN }) {
  render(<ThemeProvider><RecordPayment session={session} params={{ termId: "term-3", ...params }} onRecorded={onRecorded} /></ThemeProvider>);
  await screen.findByText(params.proof ? "Confirm payment proof" : "Record a payment", {}, { timeout: 5000 });
}

/** Presses the button, then the button of that name in the question that follows. */
async function pressAndConfirm(button: string, confirmLabel: string) {
  fireEvent.press(screen.getByText(button));
  const buttons = alert.mock.calls[alert.mock.calls.length - 1]![2] as { text: string; onPress?: () => void }[];
  await act(async () => { buttons.find((b) => b.text === confirmLabel)!.onPress!(); });
}

describe("recording a payment for a balance", () => {
  it("shows whose invoice it is and what is owed, and starts as cash with nothing filled in", async () => {
    await open();
    expect(screen.getByText("Ann Wanjiru · 1042")).toBeTruthy();
    expect(screen.getByText("Form 1A")).toBeTruthy();
    expect(screen.getByText("KSh 6,000")).toBeTruthy();
    expect(screen.getByLabelText("Amount received").props.value).toBe("");
    expect(screen.getByLabelText("Receipt book number")).toBeTruthy();
    expect(screen.getByText("Optional for cash.")).toBeTruthy();
    // the learner is the one the balance was opened from: no way to pick another
    expect(screen.queryByText("Change")).toBeNull();
  });

  it("asks for the amount, for no more than is owed, and for the number of anything but cash, before it asks to record", async () => {
    await open();
    fireEvent.press(screen.getByText("Record payment"));
    expect(await screen.findByText("Enter the amount received.")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "6001");
    fireEvent.press(screen.getByText("Record payment"));
    expect(await screen.findByText("That is more than the KSh 6,000 still owed.")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "500.50");
    fireEvent.press(screen.getByText("Record payment"));
    expect(await screen.findByText("Enter whole shillings: cents can't be paid or recorded.")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "5000");
    fireEvent.press(screen.getByText("M-Pesa"));
    fireEvent.press(screen.getByText("Record payment"));
    expect(await screen.findByText("Enter the m-pesa receipt.")).toBeTruthy();
    expect(alert).not.toHaveBeenCalled();
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("asks first, naming the learner, the amount, how it was paid and its number, and says it cannot be undone from the phone", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "5,000");
    fireEvent.press(screen.getByText("M-Pesa"));
    fireEvent.changeText(screen.getByLabelText("M-Pesa receipt"), "sfc1234abc");
    fireEvent.press(screen.getByText("Record payment"));
    expect(alert).toHaveBeenCalledWith(
      "Record KSh 5,000 for Ann Wanjiru?",
      "M-Pesa, ref sfc1234abc. It goes on the invoice at once and cannot be undone from the phone.",
      expect.any(Array),
    );
    expect(recordPayment).not.toHaveBeenCalled();
  });

  it("records it with the invoice, the amount in cents, the method and the number, then says it was recorded", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "5000");
    fireEvent.press(screen.getByText("Bank"));
    fireEvent.changeText(screen.getByLabelText("Slip or transaction number"), "SLIP-88");
    await pressAndConfirm("Record payment", "Record payment");
    expect(recordPayment).toHaveBeenCalledWith({ invoiceId: "inv-1", cents: 500_000, method: "bank", reference: "SLIP-88", proofId: undefined });
    expect(onRecorded).toHaveBeenCalledWith("KSh 5,000 recorded for Ann Wanjiru");
  });

  it("records cash with no number", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "6000");
    await pressAndConfirm("Record payment", "Record payment");
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ cents: 600_000, method: "cash", reference: "" }));
  });

  it("takes exactly what is still owed even when that has cents, so a balance can be cleared", async () => {
    await open({ invoice: { ...ANN, balanceCents: 600_050 } });
    fireEvent.changeText(screen.getByLabelText("Amount received"), "6000.50");
    await pressAndConfirm("Record payment", "Record payment");
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ cents: 600_050 }));
  });

  it("says what the database said when it refuses, such as a receipt recorded before, and stays on the form", async () => {
    recordPayment.mockRejectedValue(new Error("M-Pesa receipt SFC1234ABC has already been recorded."));
    await open();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "5000");
    fireEvent.press(screen.getByText("M-Pesa"));
    fireEvent.changeText(screen.getByLabelText("M-Pesa receipt"), "SFC1234ABC");
    await pressAndConfirm("Record payment", "Record payment");
    expect(await screen.findByText("M-Pesa receipt SFC1234ABC has already been recorded.")).toBeTruthy();
    expect(onRecorded).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Amount received").props.value).toBe("5000");
  });

  it("asks for nothing more of a person who backs out of the question", async () => {
    await open();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "5000");
    fireEvent.press(screen.getByText("Record payment"));
    expect(alert).toHaveBeenCalled();
    expect(recordPayment).not.toHaveBeenCalled();
    expect(onRecorded).not.toHaveBeenCalled();
  });
});

describe("confirming a family's proof", () => {
  it("says what to check, shows the message and the note, and fills the form with what the message showed", async () => {
    await open({ invoice: ANN, proof: SMS_PROOF });
    expect(screen.getByText("Confirm payment proof")).toBeTruthy();
    expect(screen.getByText(/Find this code on the school's M-Pesa or bank statement/)).toBeTruthy();
    expect(screen.getByText("Message the parent pasted")).toBeTruthy();
    expect(screen.getByText("SFC1234ABC Confirmed. Ksh5,000.00 paid")).toBeTruthy();
    expect(screen.getByText("Parent's note: Paid on Friday")).toBeTruthy();
    expect(screen.getByLabelText("Amount received").props.value).toBe("5000");
    expect(screen.getByLabelText("M-Pesa receipt").props.value).toBe("SFC1234ABC");
  });

  it("records the payment and confirms the proof with it, and the question says so", async () => {
    await open({ invoice: ANN, proof: SMS_PROOF });
    fireEvent.press(screen.getByText("Confirm and record"));
    expect(alert.mock.calls[0]![1]).toContain("The family's proof is confirmed with it.");
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === "Record payment")!.onPress!(); });
    expect(recordPayment).toHaveBeenCalledWith({ invoiceId: "inv-1", cents: 500_000, method: "mpesa", reference: "SFC1234ABC", proofId: "p1" });
    expect(onRecorded).toHaveBeenCalledWith("KSh 5,000 recorded for Ann Wanjiru");
  });

  it("asks to check the file when the proof is a photo and not a message, and starts as a bank payment", async () => {
    await open({ invoice: ANN, proof: { id: "p2", fileName: "slip.jpg", note: null, smsText: null, code: null, amountCents: null, method: null } });
    expect(screen.getByText("Check slip.jpg and enter what it shows. The balance only moves once the payment is recorded.")).toBeTruthy();
    expect(screen.getByLabelText("Slip or transaction number")).toBeTruthy();
    expect(screen.getByLabelText("Amount received").props.value).toBe("");
  });

  it("never fills in more than is owed", async () => {
    await open({ invoice: { ...ANN, balanceCents: 400_000 }, proof: SMS_PROOF });
    expect(screen.getByLabelText("Amount received").props.value).toBe("4000");
  });
});

describe("finding the learner", () => {
  it("searches the term for a name or admission number once two letters are typed, and lists what it finds with what each owes", async () => {
    await open({});
    fireEvent.changeText(screen.getByLabelText("Learner"), "A");
    // longer than the pause before a search: one letter is not one
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(searchPayableInvoices).not.toHaveBeenCalled();
    fireEvent.changeText(screen.getByLabelText("Learner"), "Ann");
    expect(await screen.findByLabelText("Ann Wanjiru · 1042, Form 1A, balance KSh 6,000", {}, { timeout: 5000 })).toBeTruthy();
    expect(searchPayableInvoices).toHaveBeenCalledWith("term-3", "Ann");
    expect(screen.getByLabelText("Dan Otieno · 1077, Form 2B, balance KSh 10,000")).toBeTruthy();
    // no amount, method or number until there is an invoice
    expect(screen.queryByLabelText("Amount received")).toBeNull();
  });

  it("shows the form for the one chosen, and lets another be chosen with Change", async () => {
    await open({});
    fireEvent.changeText(screen.getByLabelText("Learner"), "Ann");
    fireEvent.press(await screen.findByLabelText("Ann Wanjiru · 1042, Form 1A, balance KSh 6,000", {}, { timeout: 5000 }));
    expect(screen.getByLabelText("Amount received")).toBeTruthy();
    fireEvent.changeText(screen.getByLabelText("Amount received"), "1000");
    fireEvent.press(screen.getByText("Change"));
    expect(screen.getByLabelText("Learner").props.value).toBe("");
    expect(screen.queryByLabelText("Amount received")).toBeNull();
  });

  it("records for the learner chosen", async () => {
    await open({});
    fireEvent.changeText(screen.getByLabelText("Learner"), "Dan");
    fireEvent.press(await screen.findByLabelText("Dan Otieno · 1077, Form 2B, balance KSh 10,000", {}, { timeout: 5000 }));
    fireEvent.changeText(screen.getByLabelText("Amount received"), "2500");
    await pressAndConfirm("Record payment", "Record payment");
    expect(recordPayment).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "inv-3", cents: 250_000 }));
    expect(onRecorded).toHaveBeenCalledWith("KSh 2,500 recorded for Dan Otieno");
  });

  it("says when no invoice this term matches, and why the search failed", async () => {
    searchPayableInvoices.mockResolvedValueOnce([]);
    await open({});
    fireEvent.changeText(screen.getByLabelText("Learner"), "Zed");
    expect(await screen.findByText("No invoice this term matches.", {}, { timeout: 5000 })).toBeTruthy();
    searchPayableInvoices.mockRejectedValueOnce(new Error("Network request failed"));
    fireEvent.changeText(screen.getByLabelText("Learner"), "Zede");
    expect(await screen.findByText("Network request failed", {}, { timeout: 5000 })).toBeTruthy();
  });
});
