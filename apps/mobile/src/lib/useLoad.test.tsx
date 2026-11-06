import { act, renderHook } from "@testing-library/react-native";
import { useLoad } from "./useLoad";

// What a screen's loading comes down to: nothing until the first answer, the answer, or why not, and a way to ask again.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("useLoad", () => {
  it("is loading, with no data and no error, until the first answer comes, and then has the data", async () => {
    const first = deferred<string>();
    const { result } = renderHook(() => useLoad(() => first.promise, "school-1"));
    expect(result.current).toMatchObject({ data: null, error: null, loading: true });
    await act(async () => { first.resolve("the overview"); });
    expect(result.current).toMatchObject({ data: "the overview", error: null, loading: false });
  });

  it("loads nothing, and never says it is loading, when it is given nothing to load", async () => {
    const { result } = renderHook(() => useLoad<string>(null, "school-1"));
    await act(async () => { await result.current.refresh(); });
    expect(result.current).toMatchObject({ data: null, error: null, loading: false, refreshing: false });
  });

  it("says why it failed, and loads again on retry", async () => {
    const load = jest.fn().mockRejectedValueOnce(new Error("Network request failed")).mockResolvedValue("the overview");
    const { result } = renderHook(() => useLoad<string>(load, "school-1"));
    await act(async () => {});
    expect(result.current).toMatchObject({ data: null, error: "Network request failed", loading: false });
    await act(async () => { result.current.retry(); });
    expect(result.current).toMatchObject({ data: "the overview", error: null });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps what it had on screen when a refresh fails, and reports the failure beside it", async () => {
    const load = jest.fn().mockResolvedValueOnce("the overview").mockRejectedValueOnce(new Error("Network request failed"));
    const { result } = renderHook(() => useLoad<string>(load, "school-1"));
    await act(async () => {});
    await act(async () => { await result.current.refresh(); });
    expect(result.current).toMatchObject({ data: "the overview", error: "Network request failed", refreshing: false });
  });

  it("starts over when the key changes, and drops an answer to the old one that arrives late", async () => {
    const answers: Record<string, ReturnType<typeof deferred<string>>> = { a: deferred<string>(), b: deferred<string>() };
    const { result, rerender } = renderHook(({ key }: { key: string }) => useLoad(() => answers[key]!.promise, key), { initialProps: { key: "a" } });
    rerender({ key: "b" });
    await act(async () => { answers.b!.resolve("school B"); });
    await act(async () => { answers.a!.resolve("school A"); });
    expect(result.current.data).toBe("school B");
  });

  it("does not update after the screen has gone", async () => {
    const first = deferred<string>();
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(() => useLoad(() => first.promise, "school-1"));
    unmount();
    await act(async () => { first.resolve("too late"); });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
