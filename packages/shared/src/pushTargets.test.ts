import { describe, expect, it } from "vitest";
import { pushTargetFrom } from "./pushTargets";

const ID = "4f2c9a0e-7b1d-4c55-9a3e-0d1f2b3c4d5e";

describe("pushTargetFrom", () => {
  it("opens the conversation a chat push is about", () => {
    expect(pushTargetFrom({ type: "chat", conversation_id: ID })).toEqual({ kind: "chat", conversationId: ID });
  });

  it("opens the visitors list for a visit push", () => {
    expect(pushTargetFrom({ type: "visit", visit_id: ID })).toEqual({ kind: "visit", visitId: ID });
  });

  it("opens Health for a sick bay notice, on the child it names when it names one", () => {
    expect(pushTargetFrom({ type: "health", student_id: ID, visit_id: ID })).toEqual({ kind: "health", studentId: ID, visitId: ID });
    expect(pushTargetFrom({ type: "health" })).toEqual({ kind: "health", studentId: null, visitId: null });
  });

  it("knows nothing of a push that names no destination, or one from a newer server", () => {
    expect(pushTargetFrom(undefined)).toBeNull();
    expect(pushTargetFrom(null)).toBeNull();
    expect(pushTargetFrom({})).toBeNull();
    expect(pushTargetFrom({ type: "bus" })).toBeNull();
  });

  it("refuses a chat with no usable id, and ids that are not ids", () => {
    expect(pushTargetFrom({ type: "chat" })).toBeNull();
    expect(pushTargetFrom({ type: "chat", conversation_id: 42 })).toBeNull();
    expect(pushTargetFrom({ type: "chat", conversation_id: "../../etc" })).toBeNull();
    expect(pushTargetFrom({ type: "visit", visit_id: "" })).toBeNull();
    // a health push with a bad child id still opens Health, just not on a chosen child
    expect(pushTargetFrom({ type: "health", student_id: "<script>" })).toEqual({ kind: "health", studentId: null, visitId: null });
  });
});
