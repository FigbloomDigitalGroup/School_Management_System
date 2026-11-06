import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { useHrApprover } from "./useHrApprover";

// Whether the "Leave to approve" row is listed: HR's answer about the signed-in person, never a guess.

jest.mock("@figbloom/shared", () => ({ ...jest.requireActual("@figbloom/shared"), fetchHrLeaveAccess: jest.fn() }));
const fetchHrLeaveAccess = shared.fetchHrLeaveAccess as unknown as jest.Mock;

beforeEach(() => { fetchHrLeaveAccess.mockReset(); });

/** Lets HR's answer (or refusal) reach the hook, so "still false" is said of an answer and not of one still on its way. */
const answered = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("whether HR says this person approves leave", () => {
  it("is false while HR is being asked, then true for an approver at a school whose leave is HR's", async () => {
    fetchHrLeaveAccess.mockResolvedValue({ status: "available", approver: true });
    const { result } = renderHook(() => useHrApprover("grace"));
    expect(result.current).toBe(false);
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("stays false for someone who is not an approver", async () => {
    fetchHrLeaveAccess.mockResolvedValue({ status: "available", approver: false });
    const { result } = renderHook(() => useHrApprover("grace"));
    await answered();
    expect(fetchHrLeaveAccess).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });

  it("stays false where the school's leave is not HR's, even for someone HR calls an approver", async () => {
    fetchHrLeaveAccess.mockResolvedValue({ status: "not_enabled", approver: true });
    const { result } = renderHook(() => useHrApprover("grace"));
    await answered();
    expect(fetchHrLeaveAccess).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });

  it("stays false when HR cannot be asked, and says nothing about it", async () => {
    fetchHrLeaveAccess.mockRejectedValue(new Error("Network request failed"));
    const { result } = renderHook(() => useHrApprover("grace"));
    await answered();
    expect(fetchHrLeaveAccess).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(false);
  });

  it("asks again for a different person, and does not carry the last person's answer over while it waits", async () => {
    fetchHrLeaveAccess.mockResolvedValue({ status: "available", approver: true });
    const { result, rerender } = renderHook(({ id }: { id: string }) => useHrApprover(id), { initialProps: { id: "grace" } });
    await waitFor(() => expect(result.current).toBe(true));
    let answer!: (access: { status: string; approver: boolean }) => void;
    fetchHrLeaveAccess.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    rerender({ id: "dan" });
    await answered();
    expect(fetchHrLeaveAccess).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(false);
    await act(async () => { answer({ status: "available", approver: true }); });
    expect(result.current).toBe(true);
  });
});
