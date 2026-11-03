import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { QueuedWrite } from "@figbloom/shared";
import { QueueNotice } from "./QueueNotice";
import { queue } from "../storage";

jest.mock("../storage", () => ({ queue: { rejected: jest.fn(), discard: jest.fn() } }));
const fake = queue as unknown as { rejected: jest.Mock; discard: jest.Mock };

const refused = (id: string, table: string, message: string) =>
  ({ id, table, rows: [], queuedAt: "2026-10-31T08:00:00Z", attempts: 1, rejected: { at: "2026-10-31T08:01:00Z", message } }) as unknown as QueuedWrite;

beforeEach(() => {
  fake.rejected.mockReset();
  fake.discard.mockReset();
});

describe("QueueNotice", () => {
  it("says nothing when the server has refused nothing", async () => {
    fake.rejected.mockResolvedValue([]);
    const { toJSON } = render(<QueueNotice />);
    await act(async () => {});
    expect(toJSON()).toBeNull();
  });

  it("tells the teacher what could not be sent and why", async () => {
    fake.rejected.mockResolvedValue([refused("w1", "attendance", "new row violates row-level security policy")]);
    render(<QueueNotice />);
    expect(await screen.findByText(/A register saved on this phone could not be sent/)).toBeTruthy();
    expect(screen.getByText(/new row violates row-level security policy/)).toBeTruthy();
    expect(screen.queryByText(/more\)/)).toBeNull();
  });

  it("says how many more are waiting behind the first", async () => {
    fake.rejected.mockResolvedValue([refused("w1", "marks", "stale"), refused("w2", "attendance", "stale"), refused("w3", "attendance", "stale")]);
    render(<QueueNotice />);
    expect(await screen.findByText(/Marks saved on this phone could not be sent \(and 2 more\)/)).toBeTruthy();
  });

  it("uses a plain word for a kind of write it has no name for", async () => {
    fake.rejected.mockResolvedValue([refused("w1", "something_new", "refused")]);
    render(<QueueNotice />);
    expect(await screen.findByText(/Something saved on this phone could not be sent/)).toBeTruthy();
  });

  it("discards the one on show and then shows the next", async () => {
    const first = refused("w1", "marks", "stale");
    const second = refused("w2", "attendance", "stale");
    fake.rejected.mockResolvedValueOnce([first, second]).mockResolvedValue([second]);
    fake.discard.mockResolvedValue(undefined);
    render(<QueueNotice />);
    expect(await screen.findByText(/Marks saved on this phone/)).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByRole("button", { name: "Discard" })); });
    expect(fake.discard).toHaveBeenCalledWith("w1");
    expect(await screen.findByText(/A register saved on this phone/)).toBeTruthy();
    expect(screen.queryByText(/Marks saved on this phone/)).toBeNull();
  });

  it("disappears once the last one is discarded", async () => {
    fake.rejected.mockResolvedValueOnce([refused("w1", "marks", "stale")]).mockResolvedValue([]);
    fake.discard.mockResolvedValue(undefined);
    const { toJSON } = render(<QueueNotice />);
    await screen.findByText(/Marks saved on this phone/);
    await act(async () => { fireEvent.press(screen.getByRole("button", { name: "Discard" })); });
    expect(toJSON()).toBeNull();
  });
});
