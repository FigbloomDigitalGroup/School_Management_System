import { act, renderHook } from "@testing-library/react-native";
import { useSearch } from "./useSearch";

// Searching as a person types: after a pause, from two letters, and never from an answer that is out of date.

const pause = (ms = 400) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

describe("searching as a person types", () => {
  it("waits for the pause, and for enough letters, before it asks", async () => {
    const search = jest.fn().mockResolvedValue(["Ann"]);
    const { result, rerender } = renderHook(({ q }: { q: string }) => useSearch(q, search), { initialProps: { q: "A" } });
    await pause();
    expect(search).not.toHaveBeenCalled();
    expect(result.current.enough).toBe(false);
    rerender({ q: "An" });
    expect(result.current.searching).toBe(true);
    expect(search).not.toHaveBeenCalled();
    await pause();
    expect(search).toHaveBeenCalledWith("An");
    expect(result.current).toMatchObject({ results: ["Ann"], searching: false, error: null, enough: true });
  });

  it("waits a quarter of a second after the last letter, not less", () => {
    jest.useFakeTimers();
    try {
      const search = jest.fn().mockResolvedValue([]);
      renderHook(() => useSearch("Ann", search));
      act(() => { jest.advanceTimersByTime(249); });
      expect(search).not.toHaveBeenCalled();
      act(() => { jest.advanceTimersByTime(1); });
      expect(search).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("asks once for letters typed in a quick run, with all of them", async () => {
    const search = jest.fn().mockResolvedValue([]);
    const { rerender } = renderHook(({ q }: { q: string }) => useSearch(q, search), { initialProps: { q: "An" } });
    rerender({ q: "Ann" });
    rerender({ q: "Anne" });
    await pause();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("Anne");
  });

  it("trims what was typed, and counts spaces as nothing", async () => {
    const search = jest.fn().mockResolvedValue([]);
    const { result } = renderHook(() => useSearch("  A ", search));
    await pause();
    expect(search).not.toHaveBeenCalled();
    expect(result.current.enough).toBe(false);
  });

  it("drops an answer that arrives after the person has typed on", async () => {
    let first!: (v: string[]) => void;
    const search = jest.fn()
      .mockReturnValueOnce(new Promise<string[]>((resolve) => { first = resolve; }))
      .mockResolvedValueOnce(["Annette"]);
    const { result, rerender } = renderHook(({ q }: { q: string }) => useSearch(q, search), { initialProps: { q: "Ann" } });
    await pause();
    expect(search).toHaveBeenCalledTimes(1);
    rerender({ q: "Annette" });
    await pause();
    await act(async () => { first(["Ann (late answer)"]); });
    expect(result.current.results).toEqual(["Annette"]);
  });

  it("says why it could not search, and finds nothing", async () => {
    const search = jest.fn().mockRejectedValue(new Error("Network request failed"));
    const { result } = renderHook(() => useSearch("Ann", search));
    await pause();
    expect(result.current).toMatchObject({ results: [], error: "Network request failed", searching: false });
  });

  it("clears what it found when it is paused, because the person has chosen", async () => {
    const search = jest.fn().mockResolvedValue(["Ann"]);
    const { result, rerender } = renderHook(({ paused }: { paused: boolean }) => useSearch("Ann", search, { paused }), { initialProps: { paused: false } });
    await pause();
    expect(result.current.results).toEqual(["Ann"]);
    rerender({ paused: true });
    expect(result.current.results).toEqual([]);
    expect(result.current.searching).toBe(false);
  });

  it("searches again for a different thing with the same letters (the key)", async () => {
    const search = jest.fn().mockResolvedValue([]);
    const { rerender } = renderHook(({ key }: { key: string }) => useSearch("Ann", search, { key }), { initialProps: { key: "learners" } });
    await pause();
    rerender({ key: "staff" });
    await pause();
    expect(search).toHaveBeenCalledTimes(2);
  });
});
