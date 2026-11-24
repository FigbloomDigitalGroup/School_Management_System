import { afterEach, describe, expect, it } from "vitest";
import { setLogSink } from "../src/log.js";
import type { AccountMessage } from "../src/modules/account/notifier.js";
import { accountEmail, createResendNotifier, resendNotifierFromEnv } from "../src/modules/account/resendNotifier.js";

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz+/=0123";
const BASE = "https://schoolmanagement.figbloom.org";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { calls, impl };
}

let restoreSink: (() => void) | null = null;
function captureLogs(): string[] {
  const lines: string[] = [];
  restoreSink = setLogSink((l) => lines.push(l));
  return lines;
}
afterEach(() => {
  restoreSink?.();
  restoreSink = null;
});

const invitation: AccountMessage = { kind: "invitation", email: "new.admin@school.example", token: TOKEN, tenantId: "t1" };
const reset: AccountMessage = { kind: "password_reset", email: "someone@school.example", token: TOKEN };

describe("account e-mail through Resend", () => {
  it("sends an invitation with a link to the web app's accept page, and reports sent", async () => {
    const f = fakeFetch(() => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const n = createResendNotifier({ apiKey: "re_test", from: "FigBloom <no-reply@figbloom.org>", linkBaseUrl: BASE, fetchImpl: f.impl });
    expect(await n.send(invitation)).toBe("sent");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((f.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body.from).toBe("FigBloom <no-reply@figbloom.org>");
    expect(body.to).toEqual(["new.admin@school.example"]);
    const link = `${BASE}/accept-invite?token=${encodeURIComponent(TOKEN)}`;
    expect(body.text).toContain(link);
    expect(body.html).toContain(link.replace(/&/g, "&amp;"));
    expect(body.text).toContain("72 hours");
  });

  it("sends a password reset with a link to the reset page and the 30-minute expiry", () => {
    const e = accountEmail(reset, BASE)!;
    expect(e.subject).toMatch(/reset/i);
    expect(e.text).toContain(`${BASE}/reset-password?token=${encodeURIComponent(TOKEN)}`);
    expect(e.text).toContain("30 minutes");
  });

  it("never sends a guardian invitation or a message without an address (the issuer keeps the token)", async () => {
    const f = fakeFetch(() => new Response("{}", { status: 200 }));
    const n = createResendNotifier({ apiKey: "re_test", from: "a@b.co", linkBaseUrl: BASE, fetchImpl: f.impl });
    expect(await n.send({ kind: "guardian_invitation", email: "", token: TOKEN })).toBe("not_configured");
    expect(await n.send({ ...invitation, email: "   " })).toBe("not_configured");
    expect(f.calls).toHaveLength(0);
  });

  it("a refused or failed send falls back to not_configured, and the log holds neither token nor address", async () => {
    const lines = captureLogs();
    const refused = createResendNotifier({
      apiKey: "re_test",
      from: "a@b.co",
      linkBaseUrl: BASE,
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ message: `bad ${TOKEN}` }), { status: 422 })).impl,
    });
    expect(await refused.send(invitation)).toBe("not_configured");
    const broken = createResendNotifier({
      apiKey: "re_test",
      from: "a@b.co",
      linkBaseUrl: BASE,
      fetchImpl: (async () => {
        throw new TypeError(`fetch failed for ${invitation.email}`);
      }) as typeof fetch,
    });
    expect(await broken.send(reset)).toBe("not_configured");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: "account_email_failed", outcome: "invitation", status: 422 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ msg: "account_email_failed", outcome: "password_reset", error_class: "TypeError" });
    const all = lines.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain("school.example");
  });

  it("escapes the link in the HTML body", () => {
    const e = accountEmail({ ...invitation, token: `a"><script>x</script>` }, BASE)!;
    expect(e.html).not.toContain("<script>");
  });
});

describe("account e-mail configuration", () => {
  const good = {
    RESEND_API_KEY: "re_live_123",
    ACCOUNT_EMAIL_FROM: "FigBloom <no-reply@figbloom.org>",
    ACCOUNT_LINK_BASE_URL: "https://schoolmanagement.figbloom.org",
  };

  it("is off without a real Resend key (missing, empty or a placeholder)", () => {
    expect(resendNotifierFromEnv({}, "production")).toBeNull();
    expect(resendNotifierFromEnv({ ...good, RESEND_API_KEY: "" }, "production")).toBeNull();
    expect(resendNotifierFromEnv({ ...good, RESEND_API_KEY: "placeholder-set-me" }, "production")).toBeNull();
  });

  it("is on with a key, a sender and an https origin (a trailing slash is accepted)", () => {
    expect(resendNotifierFromEnv(good, "production")).not.toBeNull();
    expect(resendNotifierFromEnv({ ...good, ACCOUNT_LINK_BASE_URL: `${good.ACCOUNT_LINK_BASE_URL}/` }, "production")).not.toBeNull();
    expect(resendNotifierFromEnv({ ...good, ACCOUNT_EMAIL_FROM: "no-reply@figbloom.org" }, "production")).not.toBeNull();
  });

  it("refuses to start with a key but a bad sender or link base, naming the variable and never a value", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...good, ACCOUNT_EMAIL_FROM: "" }, "ACCOUNT_EMAIL_FROM"],
      [{ ...good, ACCOUNT_EMAIL_FROM: "not an address" }, "ACCOUNT_EMAIL_FROM"],
      [{ ...good, ACCOUNT_LINK_BASE_URL: "" }, "ACCOUNT_LINK_BASE_URL"],
      [{ ...good, ACCOUNT_LINK_BASE_URL: "https://schoolmanagement.figbloom.org/app" }, "ACCOUNT_LINK_BASE_URL"],
      [{ ...good, ACCOUNT_LINK_BASE_URL: "http://schoolmanagement.figbloom.org" }, "https"],
    ];
    for (const [env, word] of cases) {
      let message = "";
      try {
        resendNotifierFromEnv(env, "production");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, JSON.stringify(env)).toMatch(/^Invalid API config: /);
      expect(message).toContain(word);
      expect(message).not.toContain("re_live_123");
    }
  });

  it("allows an http link base in local and test", () => {
    expect(resendNotifierFromEnv({ ...good, ACCOUNT_LINK_BASE_URL: "http://localhost:5173" }, "local")).not.toBeNull();
  });
});
