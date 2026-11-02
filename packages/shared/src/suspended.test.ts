import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeError } from "./edge";
import * as client from "./supabase";
import {
  isBannedAuthError, isSchoolSuspendedError, isSuspendedSignInError, mySchoolSuspended, sessionSchoolSuspended,
  SUSPENDED_SCHOOL_BODY, SUSPENDED_SCHOOL_CONTACT, SUSPENDED_SCHOOL_MESSAGE, SUSPENDED_SCHOOL_TITLE,
} from "./suspended";

/** A stand-in Supabase client whose rpc() answers as given. */
function rpcAnswers(answer: { data?: unknown; error?: unknown } | Error) {
  const rpc = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return { data: answer.data ?? null, error: answer.error ?? null };
  });
  vi.spyOn(client, "supabase").mockReturnValue({ rpc } as unknown as ReturnType<typeof client.supabase>);
  return rpc;
}

afterEach(() => vi.restoreAllMocks());

describe("the message", () => {
  it("says the school's account is suspended and who to contact, in Mike's words", () => {
    expect(SUSPENDED_SCHOOL_TITLE).toBe("Your school's account is suspended.");
    expect(SUSPENDED_SCHOOL_BODY).toBe("Please contact your school's administrator or Figbloom support.");
    expect(SUSPENDED_SCHOOL_MESSAGE).toBe(`${SUSPENDED_SCHOOL_TITLE} ${SUSPENDED_SCHOOL_BODY}`);
    expect(SUSPENDED_SCHOOL_CONTACT).toBe("support@figbloom.org");
  });
});

describe("isBannedAuthError", () => {
  it("recognises Supabase Auth's user_banned code", () => {
    expect(isBannedAuthError({ name: "AuthApiError", code: "user_banned", status: 400, message: "User is banned" })).toBe(true);
  });
  it("recognises the message alone, from a GoTrue that sends no code", () => {
    expect(isBannedAuthError({ message: "User is banned" })).toBe(true);
    expect(isBannedAuthError(new Error("user is banned"))).toBe(true);
  });
  it("is false for wrong credentials and anything else", () => {
    expect(isBannedAuthError({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe(false);
    expect(isBannedAuthError({ message: "Network request failed" })).toBe(false);
    expect(isBannedAuthError(null)).toBe(false);
    expect(isBannedAuthError("User is banned")).toBe(false);
  });
});

describe("isSchoolSuspendedError", () => {
  it("recognises resolve-login-id's school_suspended answer", () => {
    expect(isSchoolSuspendedError(new EdgeError(SUSPENDED_SCHOOL_MESSAGE, 403, false, "school_suspended"))).toBe(true);
  });
  it("is false for an ID that isn't found, or a 403 without the code", () => {
    expect(isSchoolSuspendedError(new EdgeError("We couldn't find that ID at this school.", 404))).toBe(false);
    expect(isSchoolSuspendedError(new EdgeError("Forbidden", 403))).toBe(false);
    expect(isSchoolSuspendedError({ code: "school_suspended" })).toBe(false);
  });
  it("isSuspendedSignInError covers both", () => {
    expect(isSuspendedSignInError({ code: "user_banned" })).toBe(true);
    expect(isSuspendedSignInError(new EdgeError("x", 403, false, "school_suspended"))).toBe(true);
    expect(isSuspendedSignInError({ code: "invalid_credentials" })).toBe(false);
  });
});

describe("mySchoolSuspended", () => {
  it("asks my_school_suspended() and answers what it says", async () => {
    const rpc = rpcAnswers({ data: true });
    expect(await mySchoolSuspended()).toBe(true);
    expect(rpc).toHaveBeenCalledWith("my_school_suspended");
    rpcAnswers({ data: false });
    expect(await mySchoolSuspended()).toBe(false);
  });
  it("never invents a suspension when the check fails", async () => {
    rpcAnswers({ error: { message: "connection refused" } });
    expect(await mySchoolSuspended()).toBe(false);
    rpcAnswers(new Error("offline"));
    expect(await mySchoolSuspended()).toBe(false);
  });
  it("counts a refusal that is itself the Auth ban as suspended", async () => {
    rpcAnswers({ error: { code: "user_banned", message: "User is banned" } });
    expect(await mySchoolSuspended()).toBe(true);
  });
});

describe("sessionSchoolSuspended", () => {
  it("only asks about someone who belongs to a school they can't see", async () => {
    const rpc = rpcAnswers({ data: true });
    expect(await sessionSchoolSuspended({ tenant_id: "t1" }, false)).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("doesn't ask when the school is visible, or for someone with no school", async () => {
    const rpc = rpcAnswers({ data: true });
    expect(await sessionSchoolSuspended({ tenant_id: "t1" }, true)).toBe(false);
    expect(await sessionSchoolSuspended({ tenant_id: null }, false)).toBe(false);
    expect(await sessionSchoolSuspended(null, false)).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
