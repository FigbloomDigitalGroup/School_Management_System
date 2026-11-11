import { Alert } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { EdgeError } from "@figbloom/shared";
import * as pick from "../lib/pickFile";
import { ThemeProvider } from "../ui/ThemeContext";
import { HrLeave } from "./HrLeave";

// Leave through Figbloom HR, from the phone: apply with HR's own types and rules, follow each application, cancel while HR allows.

// lucide-react-native ships ES modules, which Jest does not transform; the icons are not what this test is about.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_target, name) => (name === "__esModule" ? true : () => null) }));
// The skeleton pulses with a timer, which a test has no reason to wait on.
jest.mock("./Skeleton", () => ({ Skeleton: () => null }));
jest.mock("../lib/pickFile", () => ({ LEAVE_DOCUMENT_FILES: ["application/pdf"], pickFile: jest.fn(), readPickedBase64: jest.fn() }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchLeaveForm: jest.fn(), fetchHrLeaveApplications: jest.fn(), applyForLeave: jest.fn(), cancelHrLeave: jest.fn(),
}));

const fetchLeaveForm = shared.fetchLeaveForm as unknown as jest.Mock;
const fetchApplications = shared.fetchHrLeaveApplications as unknown as jest.Mock;
const applyForLeave = shared.applyForLeave as unknown as jest.Mock;
const cancelHrLeave = shared.cancelHrLeave as unknown as jest.Mock;
const pickFile = pick.pickFile as unknown as jest.Mock;
const readPickedBase64 = pick.readPickedBase64 as unknown as jest.Mock;

/** HR's answers (my-hr leave/form and leave), in its own field names: the screen reads them with the shared readers. */
const FORM = {
  leave_types: [
    { id: "annual", name: "Annual", half_days: true, max_days_per_request: 21, balance: { available_days: 18 } },
    { id: "sick", name: "Sick", half_days: false, document: { name: "Doctor's note", when: "with_application", required_if_longer_than: 2 }, balance: { available_days: 5 } },
  ],
  approval_chain: [{ label: "Head teacher", waiting_on: "Mary", skipped: false }],
  reason_min_length: 10,
};
const MINE = {
  balances: [{ leave_type: "Annual", available_days: 18 }],
  applications: [
    { id: "p1", leave_type: "Annual", start_date: "2026-11-16", end_date: "2026-11-18", days: 3, status: "pending", reason: "Family wedding in Kisumu", cancellable: true, approval: { steps: [{ label: "Head teacher", status: "current", waiting_on: "Mary" }] } },
    { id: "a1", leave_type: "Sick", start_date: "2026-10-05", end_date: "2026-10-05", days: 1, status: "approved", reason: "Clinic visit", cancellable: false, approval: { steps: [{ label: "Head teacher", status: "approved", actor_name: "Mary" }] } },
  ],
};
const NOTE = { uri: "file:///cache/note.pdf", name: "note.pdf", mimeType: "application/pdf", sizeBytes: 1000 };

let alert: jest.SpyInstance;
beforeEach(() => {
  fetchLeaveForm.mockReset().mockResolvedValue(FORM);
  fetchApplications.mockReset().mockResolvedValue(MINE);
  applyForLeave.mockReset().mockResolvedValue({});
  cancelHrLeave.mockReset().mockResolvedValue({});
  pickFile.mockReset().mockResolvedValue(NOTE);
  readPickedBase64.mockReset().mockResolvedValue({ base64: "QUJD", size: 3 });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => alert.mockRestore());

async function open() {
  render(<ThemeProvider><HrLeave accent="#7A1F2B" /></ThemeProvider>);
  await screen.findByText("Type of leave", {}, { timeout: 5000 });
}

const field = (label: string) => screen.getByLabelText(label);
async function fill({ type = "Annual", start = "20261116", end = "20261118", reason = "Family wedding in Kisumu" } = {}) {
  pickType(type);
  fireEvent.changeText(field("First day"), start);
  fireEvent.changeText(field("Last day"), end);
  fireEvent.changeText(field("Reason (at least 10 characters)"), reason);
}
const sendButton = () => screen.getByText("Apply for leave");
/** A type is also the title of an application below it, so the pill is the first of that name. */
const pickType = (name: string) => fireEvent.press(screen.getAllByText(name)[0]!);

describe("the form, from HR", () => {
  it("offers HR's types, and says what HR says about the one chosen and who approves", async () => {
    await open();
    expect(screen.getAllByText("Annual").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sick").length).toBeGreaterThan(0);
    pickType("Annual");
    expect(screen.getByText("18 days left · up to 21 days at a time · half days allowed")).toBeTruthy();
    expect(screen.getByText("Approved by: Head teacher (Mary).")).toBeTruthy();
  });

  it("says when HR has no leave type for the person", async () => {
    fetchLeaveForm.mockResolvedValueOnce({ leave_types: [] });
    render(<ThemeProvider><HrLeave accent="#7A1F2B" /></ThemeProvider>);
    expect(await screen.findByText("No leave types yet", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("says why the form could not load, and asks HR again on request", async () => {
    fetchLeaveForm.mockRejectedValueOnce(new Error("That took too long. Check your connection and try again."));
    render(<ThemeProvider><HrLeave accent="#7A1F2B" /></ThemeProvider>);
    expect(await screen.findByText("That took too long. Check your connection and try again.", {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Type of leave")).toBeTruthy();
  });
});

describe("the dates", () => {
  it("lay themselves out as YYYY-MM-DD while the digits are typed", async () => {
    await open();
    fireEvent.changeText(field("First day"), "20261116");
    expect(field("First day").props.value).toBe("2026-11-16");
    fireEvent.changeText(field("Last day"), "202611");
    expect(field("Last day").props.value).toBe("2026-11");
  });

  it("say when a date is not one, and when the last day is before the first", async () => {
    await open();
    fireEvent.changeText(field("First day"), "20260230");
    expect(await screen.findByText("That isn't a date.")).toBeTruthy();
    fireEvent.changeText(field("First day"), "20261118");
    fireEvent.changeText(field("Last day"), "20261116");
    expect(await screen.findByText("The last day is before the first.")).toBeTruthy();
  });

  it("make a half day one day: the last day follows the first and cannot be typed", async () => {
    await open();
    pickType("Annual");
    fireEvent.changeText(field("First day"), "20261116");
    fireEvent.press(screen.getByLabelText("Half a day"));
    expect(field("Last day").props.value).toBe("2026-11-16");
    expect(field("Last day").props.editable).toBe(false);
    fireEvent.changeText(field("First day"), "20261117");
    expect(field("Last day").props.value).toBe("2026-11-17");
  });

  it("offer a half day only for the types HR gives one", async () => {
    await open();
    pickType("Sick");
    expect(screen.queryByLabelText("Half a day")).toBeNull();
    pickType("Annual");
    expect(screen.getByLabelText("Half a day")).toBeTruthy();
  });

  it("drop a half day when another type is chosen that has none: the last day can be typed again and the application is for whole days", async () => {
    await open();
    pickType("Annual");
    fireEvent.changeText(field("First day"), "20261116");
    fireEvent.press(screen.getByLabelText("Half a day"));
    pickType("Sick");
    expect(field("Last day").props.editable).toBe(true);
    fireEvent.changeText(field("Last day"), "20261117");
    fireEvent.changeText(field("Reason (at least 10 characters)"), "Clinic follow up visit");
    await act(async () => { fireEvent.press(sendButton()); });
    expect(applyForLeave).toHaveBeenCalledWith(expect.objectContaining({ typeId: "sick", halfDay: false, startDate: "2026-11-16", endDate: "2026-11-17" }));
  });
});

describe("applying", () => {
  it("waits until there is a type, two real days in order, and a reason of HR's least length", async () => {
    await open();
    fireEvent.press(sendButton());
    expect(applyForLeave).not.toHaveBeenCalled();
    await fill({ reason: "too short" });
    fireEvent.press(sendButton());
    expect(applyForLeave).not.toHaveBeenCalled();
    fireEvent.changeText(field("Reason (at least 10 characters)"), "Family wedding in Kisumu");
    await act(async () => { fireEvent.press(sendButton()); });
    expect(applyForLeave).toHaveBeenCalledTimes(1);
  });

  it("sends the application to HR as typed, says it was sent, clears the form, and reads HR's lists again", async () => {
    await open();
    await fill();
    await act(async () => { fireEvent.press(sendButton()); });
    expect(applyForLeave).toHaveBeenCalledWith({
      typeId: "annual", startDate: "2026-11-16", endDate: "2026-11-18", halfDay: false, reason: "Family wedding in Kisumu", document: null,
    });
    expect(await screen.findByText("Sent to Figbloom HR for approval.")).toBeTruthy();
    expect(field("First day").props.value).toBe("");
    expect(field("Reason (at least 10 characters)").props.value).toBe("");
    expect(fetchApplications).toHaveBeenCalledTimes(2);
    expect(fetchLeaveForm).toHaveBeenCalledTimes(2);
  });

  it("sends a half day as a half day, on one date", async () => {
    await open();
    pickType("Annual");
    fireEvent.changeText(field("First day"), "20261116");
    fireEvent.press(screen.getByLabelText("Half a day"));
    fireEvent.changeText(field("Reason (at least 10 characters)"), "Dentist appointment");
    await act(async () => { fireEvent.press(sendButton()); });
    expect(applyForLeave).toHaveBeenCalledWith(expect.objectContaining({ halfDay: true, startDate: "2026-11-16", endDate: "2026-11-16" }));
  });

  it("shows HR's refusal as it words it, with one line for each rule, and keeps what was typed", async () => {
    applyForLeave.mockRejectedValue(new EdgeError("HR did not accept this application.", 422, false, "leave_rules", { problems: ["Annual leave needs 2 days' notice.", "You have 1 day left."] }));
    await open();
    await fill();
    await act(async () => { fireEvent.press(sendButton()); });
    expect(await screen.findByText("HR did not accept this application.")).toBeTruthy();
    expect(screen.getByText("• Annual leave needs 2 days' notice.")).toBeTruthy();
    expect(screen.getByText("• You have 1 day left.")).toBeTruthy();
    expect(field("First day").props.value).toBe("2026-11-16");
    expect(screen.queryByText("Sent to Figbloom HR for approval.")).toBeNull();
  });

  it("says why when HR could not be reached, and keeps what was typed", async () => {
    applyForLeave.mockRejectedValue(new Error("That took too long. Check your connection and try again."));
    await open();
    await fill();
    await act(async () => { fireEvent.press(sendButton()); });
    expect(await screen.findByText("That took too long. Check your connection and try again.")).toBeTruthy();
    expect(field("Reason (at least 10 characters)").props.value).toBe("Family wedding in Kisumu");
  });
});

describe("the document", () => {
  it("is asked for when HR wants it with the application: the button waits for it, then it goes in the application as base64", async () => {
    await open();
    await fill({ type: "Sick" });
    expect(screen.getByText(/Doctor's note \(needed\)/)).toBeTruthy();
    fireEvent.press(sendButton());
    expect(applyForLeave).not.toHaveBeenCalled();

    await act(async () => { fireEvent.press(screen.getByText("📄 PDF or file")); });
    expect(pickFile).toHaveBeenCalledWith("document", ["application/pdf"], { maxPixels: 2000 });
    expect(screen.getByText("Attached: note.pdf")).toBeTruthy();

    await act(async () => { fireEvent.press(sendButton()); });
    expect(readPickedBase64).toHaveBeenCalledWith(NOTE);
    expect(applyForLeave).toHaveBeenCalledWith(expect.objectContaining({ typeId: "sick", document: { name: "note.pdf", contentType: "application/pdf", base64: "QUJD" } }));
  });

  it("is optional for a short sick leave, and can be taken off again", async () => {
    await open();
    await fill({ type: "Sick", end: "20261117" });
    expect(screen.getByText(/Doctor's note \(optional\)/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByText("📷 Take a photo")); });
    expect(pickFile).toHaveBeenCalledWith("camera", ["application/pdf"], { maxPixels: 2000 });
    fireEvent.press(screen.getByText("Remove"));
    expect(screen.queryByText("Attached: note.pdf")).toBeNull();
  });

  it("is turned away at once when the phone says it is over 3 MB, or empty, or not a kind HR takes", async () => {
    await open();
    pickFile.mockResolvedValueOnce({ ...NOTE, sizeBytes: 4 * 1024 * 1024 });
    await act(async () => { fireEvent.press(screen.getByText("📄 PDF or file")); });
    expect(screen.getByText("The document is larger than 3 MB. Choose a smaller file.")).toBeTruthy();
    expect(screen.queryByText("Attached: note.pdf")).toBeNull();
    pickFile.mockResolvedValueOnce({ ...NOTE, sizeBytes: 0 });
    await act(async () => { fireEvent.press(screen.getByText("📄 PDF or file")); });
    expect(screen.getByText("The document is empty. Choose it again.")).toBeTruthy();
    pickFile.mockResolvedValueOnce({ ...NOTE, name: "song.mp3", mimeType: "audio/mpeg" });
    await act(async () => { fireEvent.press(screen.getByText("📄 PDF or file")); });
    expect(screen.getByText("Attach a PDF, a photo (JPEG, PNG, WebP, HEIC) or a Word document.")).toBeTruthy();
  });

  it("is turned away at sending when the phone did not say its size and it is over 3 MB once read: nothing goes to HR", async () => {
    pickFile.mockResolvedValue({ ...NOTE, sizeBytes: null });
    readPickedBase64.mockResolvedValue({ base64: "QUJD", size: 5 * 1024 * 1024 });
    await open();
    await fill({ type: "Sick" });
    await act(async () => { fireEvent.press(screen.getByText("📄 PDF or file")); });
    expect(screen.getByText("Attached: note.pdf")).toBeTruthy();
    await act(async () => { fireEvent.press(sendButton()); });
    expect(await screen.findByText("The document is larger than 3 MB. Choose a smaller file.")).toBeTruthy();
    expect(applyForLeave).not.toHaveBeenCalled();
  });

  it("says why when the phone could not give the file", async () => {
    pickFile.mockRejectedValue(new Error("Allow the camera in your phone's settings to take a photo here."));
    await open();
    await act(async () => { fireEvent.press(screen.getByText("📷 Take a photo")); });
    expect(screen.getByText("Allow the camera in your phone's settings to take a photo here.")).toBeTruthy();
  });

  it("is left alone when the person backs out of choosing one", async () => {
    pickFile.mockResolvedValue(null);
    await open();
    await act(async () => { fireEvent.press(screen.getByText("📄 PDF or file")); });
    expect(screen.queryByText(/Attached:/)).toBeNull();
  });
});

describe("the applications", () => {
  it("lists each with its type, dates, length, reason, who has approved so far and where it stands, and the days left", async () => {
    await open();
    expect(screen.getByText("Annual: 18 days left")).toBeTruthy();
    expect(screen.getByText("16 Nov – 18 Nov · 3 days")).toBeTruthy();
    expect(screen.getByText("Family wedding in Kisumu")).toBeTruthy();
    expect(screen.getByText("Head teacher: Current (Mary)")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("5 Oct · 1 day")).toBeTruthy();
    expect(screen.getByText("Head teacher: Approved (Mary)")).toBeTruthy();
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("offers Cancel only where HR says the application can be cancelled now", async () => {
    await open();
    expect(screen.getAllByText("Cancel")).toHaveLength(1);
  });

  it("says nothing has been applied for yet when HR has none", async () => {
    fetchApplications.mockResolvedValue({ balances: [], applications: [] });
    render(<ThemeProvider><HrLeave accent="#7A1F2B" /></ThemeProvider>);
    expect(await screen.findByText("Nothing applied for yet", {}, { timeout: 5000 })).toBeTruthy();
  });

  it("says why they could not be read, and asks HR again on request, while the form still works", async () => {
    fetchApplications.mockRejectedValueOnce(new Error("HR is not answering."));
    render(<ThemeProvider><HrLeave accent="#7A1F2B" /></ThemeProvider>);
    expect(await screen.findByText("HR is not answering.", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText("Type of leave")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(await screen.findByText("Head teacher: Current (Mary)")).toBeTruthy();
  });
});

describe("cancelling", () => {
  it("asks first, naming what is cancelled, and says it is cancelled in HR", async () => {
    await open();
    fireEvent.press(screen.getByText("Cancel"));
    expect(alert).toHaveBeenCalledWith("Cancel this leave application?", "Annual, 16 Nov – 18 Nov. It is cancelled in Figbloom HR.", expect.any(Array));
    expect(cancelHrLeave).not.toHaveBeenCalled();
  });

  it("cancels that application in HR, says so, and reads the list again", async () => {
    await open();
    fireEvent.press(screen.getByText("Cancel"));
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === "Cancel it")!.onPress!(); });
    expect(cancelHrLeave).toHaveBeenCalledWith("p1");
    expect(await screen.findByText("Cancelled in Figbloom HR.")).toBeTruthy();
    expect(fetchApplications).toHaveBeenCalledTimes(2);
  });

  it("says in HR's words when HR will not cancel it any more, and reads the list again", async () => {
    cancelHrLeave.mockRejectedValue(new Error("This application can no longer be cancelled."));
    await open();
    fireEvent.press(screen.getByText("Cancel"));
    const buttons = alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[];
    await act(async () => { buttons.find((b) => b.text === "Cancel it")!.onPress!(); });
    expect(await screen.findByText("This application can no longer be cancelled.")).toBeTruthy();
    expect(fetchApplications).toHaveBeenCalledTimes(2);
  });
});
