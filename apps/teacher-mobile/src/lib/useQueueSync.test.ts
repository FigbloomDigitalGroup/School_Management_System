import { AppState } from "react-native";
import { renderHook } from "@testing-library/react-native";
import { useQueueSync } from "./useQueueSync";
import { queue } from "../storage";

jest.mock("../storage", () => ({ queue: { setUser: jest.fn(), flush: jest.fn() } }));
const fake = queue as unknown as { setUser: jest.Mock; flush: jest.Mock };

let appStateChanged: (state: string) => void = () => {};
const removeListener = jest.fn();

beforeEach(() => {
  jest.useFakeTimers();
  fake.setUser.mockReset();
  fake.flush.mockReset().mockResolvedValue({ sent: 0, remaining: 0 });
  removeListener.mockReset();
  jest.spyOn(AppState, "addEventListener").mockImplementation(((_type: string, listener: (state: string) => void) => {
    appStateChanged = listener;
    return { remove: removeListener };
  }) as never);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("useQueueSync", () => {
  it("ties the queue to the signed-in teacher and sends what is waiting as soon as the app opens", () => {
    renderHook(() => useQueueSync("teacher-1"));
    expect(fake.setUser).toHaveBeenCalledWith("teacher-1");
    expect(fake.flush).toHaveBeenCalledTimes(1);
  });

  it("tries again when the app comes back to the foreground, and not when it goes to the background", () => {
    renderHook(() => useQueueSync("teacher-1"));
    fake.flush.mockClear();
    appStateChanged("background");
    appStateChanged("inactive");
    expect(fake.flush).not.toHaveBeenCalled();
    appStateChanged("active");
    expect(fake.flush).toHaveBeenCalledTimes(1);
  });

  it("keeps trying every minute for the case where there is signal but the server does not answer", () => {
    renderHook(() => useQueueSync("teacher-1"));
    fake.flush.mockClear();
    jest.advanceTimersByTime(59_000);
    expect(fake.flush).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_000);
    expect(fake.flush).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(120_000);
    expect(fake.flush).toHaveBeenCalledTimes(3);
  });

  it("stops listening and stops the timer when the screen goes away", () => {
    const { unmount } = renderHook(() => useQueueSync("teacher-1"));
    unmount();
    expect(removeListener).toHaveBeenCalledTimes(1);
    fake.flush.mockClear();
    jest.advanceTimersByTime(300_000);
    expect(fake.flush).not.toHaveBeenCalled();
  });

  it("follows a different teacher who signs in on the same phone", () => {
    const { rerender } = renderHook(({ id }: { id: string }) => useQueueSync(id), { initialProps: { id: "teacher-1" } });
    rerender({ id: "teacher-2" });
    expect(fake.setUser).toHaveBeenLastCalledWith("teacher-2");
    expect(fake.flush).toHaveBeenCalledTimes(2);
  });

  it("does not crash when the server refuses or the network is down", async () => {
    fake.flush.mockRejectedValue(new Error("network down"));
    expect(() => renderHook(() => useQueueSync("teacher-1"))).not.toThrow();
    await Promise.resolve();
  });
});
