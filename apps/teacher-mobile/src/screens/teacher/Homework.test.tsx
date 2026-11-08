import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { TeacherHomework } from "./Homework";
import type { TeacherSession } from "../../navigation";

// FIG-1493: the due date is a text box. A date typed the way people write it (31/10/2026) used to be refused
// with "Pick a due date." and nothing said what was wanted.

// The icon library ships as untranspiled ES modules; the icons are not what this tests, so every icon is an empty component.
jest.mock("lucide-react-native", () => new Proxy({}, { get: (_t, name) => (name === "__esModule" ? false : () => null) }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: jest.fn(), canGoBack: () => false }) }));
jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchTeacherClasses: jest.fn(),
  fetchTeacherSubjectsForClass: jest.fn(),
  fetchMyHomework: jest.fn(),
  fetchClassSizes: jest.fn(),
  fetchAttachments: jest.fn(),
  createHomework: jest.fn(),
  notifyHomeworkParents: jest.fn(),
}));

const mocked = (fn: unknown) => fn as jest.Mock;
const api = {
  fetchTeacherClasses: mocked(shared.fetchTeacherClasses),
  fetchTeacherSubjectsForClass: mocked(shared.fetchTeacherSubjectsForClass),
  fetchMyHomework: mocked(shared.fetchMyHomework),
  fetchClassSizes: mocked(shared.fetchClassSizes),
  fetchAttachments: mocked(shared.fetchAttachments),
  createHomework: mocked(shared.createHomework),
  notifyHomeworkParents: mocked(shared.notifyHomeworkParents),
};
const session: TeacherSession = { profileId: "t-1", tenantId: "s-1", fullName: "Teacher Two", accent: "forest", country: "KE", timezone: "Africa/Nairobi" };

beforeEach(() => {
  // Phones in Nairobi are three hours ahead of UTC; the screen reads "today" from the clock, so pin it.
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] }).setSystemTime(new Date("2026-10-25T10:30:00"));
  api.fetchTeacherClasses.mockResolvedValue([{ id: "c-1", name: "Form 2 West", level: "secondary", form_level: 2 }]);
  api.fetchTeacherSubjectsForClass.mockResolvedValue([{ id: "sub-1", name: "Chemistry" }]);
  api.fetchMyHomework.mockResolvedValue([]);
  api.fetchClassSizes.mockResolvedValue({});
  api.fetchAttachments.mockResolvedValue(new Map());
  api.createHomework.mockReset().mockResolvedValue(undefined);
  api.notifyHomeworkParents.mockReset().mockResolvedValue(undefined);
});
afterEach(() => jest.useRealTimers());

/** Renders the screen and waits until its classes, subjects and list of earlier homework have all loaded. */
async function load() {
  const view = render(<TeacherHomework session={session} />);
  await screen.findByText("Chemistry");
  await act(async () => {});
  return view;
}

async function openForm() {
  await load();
  fireEvent.changeText(screen.getByLabelText("Title"), "Exercise 4.2, page 61");
}
const setDate = (text: string) => fireEvent.changeText(screen.getByLabelText("Due date"), text);
const press = () => fireEvent.press(screen.getByText("Set homework"));

describe("the Due date box of the teacher's Homework screen", () => {
  it("always says how to type the date, before anything is typed and after", async () => {
    await openForm();
    expect(screen.getByText("Type it as day/month/year, for example 31/10/2026.")).toBeTruthy();
    setDate("31/10");
    expect(screen.getByText("Type it as day/month/year, for example 31/10/2026.")).toBeTruthy();
  });

  it("takes 31/10/2026 and saves 2026-10-31", async () => {
    await openForm();
    setDate("31/10/2026");
    press();
    await waitFor(() => expect(api.createHomework).toHaveBeenCalledTimes(1));
    await act(async () => {}); // the save finishes: status line, form reset, list reload
    expect(api.createHomework.mock.calls[0]![2]).toMatchObject({ classId: "c-1", subjectId: "sub-1", dueOn: "2026-10-31", title: "Exercise 4.2, page 61" });
    expect(screen.queryByText(/Pick a due date/)).toBeNull();
  });

  it("takes the other usual ways of writing it", async () => {
    for (const typed of ["31-10-2026", "31.10.2026", " 31/10/2026 ", "2026-10-31"]) {
      api.createHomework.mockClear();
      const view = await load();
      fireEvent.changeText(screen.getByLabelText("Title"), "Exercise 4.2");
      setDate(typed);
      press();
      await waitFor(() => expect(api.createHomework).toHaveBeenCalledTimes(1));
      await act(async () => {}); // the save finishes: status line, form reset, list reload
      expect(api.createHomework.mock.calls[0]![2]).toMatchObject({ dueOn: "2026-10-31" });
      view.unmount();
    }
  });

  it("says what is wrong with a date that is not one, under the box, and saves nothing", async () => {
    await openForm();
    setDate("tomorrow");
    press();
    expect(await screen.findByText('"tomorrow" is not a date. Type the date as day/month/year, for example 31/10/2026.')).toBeTruthy();
    expect(api.createHomework).not.toHaveBeenCalled();
    // the hint gives way to the message, and typing again clears it
    expect(screen.queryByText("Type it as day/month/year, for example 31/10/2026.")).toBeNull();
    setDate("31/10/2026");
    expect(screen.queryByText(/is not a date/)).toBeNull();
    expect(screen.getByText("Type it as day/month/year, for example 31/10/2026.")).toBeTruthy();
  });

  it("says there is no such day, and asks for the year in full", async () => {
    await openForm();
    setDate("31/02/2026");
    press();
    expect(await screen.findByText("There is no 31/2/2026: check the day and the month.")).toBeTruthy();
    setDate("31/10/26");
    press();
    expect(await screen.findByText(/Write the year in full\./)).toBeTruthy();
    expect(api.createHomework).not.toHaveBeenCalled();
  });

  it("says a date in the past is in the past, under the box, and says what today is", async () => {
    await openForm();
    setDate("24/10/2026");
    press();
    expect(await screen.findByText("The due date can't be in the past. Today is 25/10/2026.")).toBeTruthy();
    expect(api.createHomework).not.toHaveBeenCalled();
  });

  it("still checks the other fields first: a missing title is said in the status line, and the date is not nagged about yet", async () => {
    await openForm();
    fireEvent.changeText(screen.getByLabelText("Title"), "");
    setDate("tomorrow");
    press();
    expect(await screen.findByText("Give the homework a title, e.g. Exercise 4.2, page 61.")).toBeTruthy();
    expect(screen.queryByText(/is not a date/)).toBeNull();
    expect(api.createHomework).not.toHaveBeenCalled();
  });

  it("asks for the date when the box is empty", async () => {
    await openForm();
    press();
    expect(await screen.findByText("Enter the due date. Type the date as day/month/year, for example 31/10/2026.")).toBeTruthy();
    expect(api.createHomework).not.toHaveBeenCalled();
  });
});
