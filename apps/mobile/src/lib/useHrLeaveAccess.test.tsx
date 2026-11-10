import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { useHrLeaveAccess } from "./useHrLeaveAccess";

// What HR says about leave for the signed-in person: asked once, null until it answers, "off" when it cannot be asked.

jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchHrLeaveAccess: jest.fn() }));
const fetchHrLeaveAccess = shared.fetchHrLeaveAccess as unknown as jest.Mock;

beforeEach(() => { fetchHrLeaveAccess.mockReset(); });

/** Lets HR's answer (or refusal) reach the hook, so "still null" is said of an answer on its way and "off" of one that arrived. */
const answered = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("what HR says about this person's leave", () => {
  it("is null while HR is being asked, then HR's answer", async () => {
    fetchHrLeaveAccess.mockResolvedValue({ status: "available", approver: true });
    const { result } = renderHook(() => useHrLeaveAccess("grace"));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual({ status: "available", approver: true }));
  });

  it("passes on a school whose leave is not HR's as it is", async () => {
    fetchHrLeaveAccess.mockResolvedValue({ status: "not_enabled", approver: false });
    const { result } = renderHook(() => useHrLeaveAccess("grace"));
    await answered();
    expect(fetchHrLeaveAccess).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ status: "not_enabled", approver: false });
  });

  it("is 'off' when HR cannot be asked, so the school's own form stays and nobody is offered approvals", async () => {
    fetchHrLeaveAccess.mockRejectedValue(new Error("Network request failed"));
    const { result } = renderHook(() => useHrLeaveAccess("grace"));
    expect(result.current).toBeNull();
    await answered();
    expect(result.current).toEqual({ status: "off", approver: false });
  });

  it("asks again for a different person, and does not carry the last person's answer over while it waits", async () => {
    fetchHrLeaveAccess.mockResolvedValue({ status: "available", approver: true });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useHrLeaveAccess(id), { initialProps: { id: "grace" } });
    await waitFor(() => expect(result.current?.approver).toBe(true));
    let answer!: (access: { status: string; approver: boolean }) => void;
    fetchHrLeaveAccess.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    rerender({ id: "dan" });
    await answered();
    expect(fetchHrLeaveAccess).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();
    await act(async () => { answer({ status: "available", approver: false }); });
    expect(result.current).toEqual({ status: "available", approver: false });
  });
});
