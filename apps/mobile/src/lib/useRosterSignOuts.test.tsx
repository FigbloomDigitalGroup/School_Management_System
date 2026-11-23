import { renderHook, waitFor } from "@testing-library/react-native";
import * as shared from "@figbloom/shared";
import { useRosterSignOuts } from "./useRosterSignOuts";

jest.mock("@figbloom/shared", () => ({
  ...jest.requireActual("@figbloom/shared"),
  fetchEarlySignOutsForStudents: jest.fn(),
}));

const fetchMock = shared.fetchEarlySignOutsForStudents as unknown as jest.Mock;
const row = (student_id: string, voided_at: string | null = null) => ({ id: `so-${student_id}`, student_id, signed_out_local: "10:45:00", voided_at });

beforeEach(() => fetchMock.mockReset());

describe("useRosterSignOuts", () => {
  it("maps live sign-outs by learner and leaves voided ones out", async () => {
    fetchMock.mockResolvedValue([row("a"), row("b", "2026-11-06T09:00:00Z")]);
    const { result } = renderHook(() => useRosterSignOuts(["a", "b"]));
    await waitFor(() => expect(result.current.has("a")).toBe(true));
    expect(result.current.has("b")).toBe(false);
  });

  it("fails soft: an error gives no badges and does not throw", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useRosterSignOuts(["a"]));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });

  it("does not read at all for an empty roster", () => {
    const { result } = renderHook(() => useRosterSignOuts([]));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.size).toBe(0);
  });
});
