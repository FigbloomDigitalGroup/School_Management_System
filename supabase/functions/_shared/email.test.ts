import { describe, it } from "jsr:@std/testing/bdd";
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "jsr:@std/assert";
import { deliverLoginDetails, emailDomain, isDeliverable, NO_MAILER, resendMailer, signInPath } from "./email.ts";
import { escapeHtml, loginEmail } from "./emailTemplates.ts";
import { captureLogs, countingLimiter, FakeMailer } from "./fakeMailer.ts";

const PASSWORD = "Xy7kPq3mZr";

const env = (vars: Record<string, string>) => (name: string) => vars[name];
const CONFIGURED = { RESEND_API_KEY: "re_test_key", EMAIL_FROM: "Figbloom <no-reply@figbloom.org>", APP_URL: "https://app.example.test/" };

const message = {
  to: "otieno@gmail.com",
  subject: "Your Figbloom account at Green Valley",
  html: `<p>${PASSWORD}</p>`,
  text: PASSWORD,
  template: "login-welcome",
};

/** A fetch that answers from a list, in order, and records each call. */
function fakeFetch(answers: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift() ?? new Response("{}", { status: 500 });
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = () => new Response(JSON.stringify({ id: "re_msg_123" }), { status: 200 });

describe("resendMailer", () => {
  it("is not configured without RESEND_API_KEY, and sends nothing", async () => {
    const { fn, calls } = fakeFetch([]);
    const mailer = resendMailer(env({ EMAIL_FROM: "x@y.org" }), fn);
    assertFalse(mailer.configured);
    assertEquals(await mailer.send(message), { status: "not_configured" });
    assertEquals(calls.length, 0);
  });

  it("is not configured with a key but no EMAIL_FROM", async () => {
    let mailer = NO_MAILER;
    await captureLogs(() => { mailer = resendMailer(env({ RESEND_API_KEY: "re_x" }), fakeFetch([]).fn); return Promise.resolve(); });
    assertFalse(mailer.configured);
  });

  it("posts to Resend with the key, sender, both bodies and an idempotency key; trims APP_URL", async () => {
    const { fn, calls } = fakeFetch([ok()]);
    const mailer = resendMailer(env({ ...CONFIGURED, EMAIL_REPLY_TO: "help@figbloom.org" }), fn);
    assertEquals(mailer.appUrl, "https://app.example.test");
    const result = await mailer.send(message);
    assertEquals(result, { status: "sent", id: "re_msg_123" });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    assertEquals(headers.Authorization, "Bearer re_test_key");
    assert(headers["Idempotency-Key"]);
    const body = JSON.parse(String(calls[0].init.body));
    assertEquals(body.to, ["otieno@gmail.com"]);
    assertEquals(body.from, CONFIGURED.EMAIL_FROM);
    assertEquals(body.reply_to, "help@figbloom.org");
    assertEquals(body.text, PASSWORD);
    assert(calls[0].init.signal, "has a timeout");
  });

  it("retries once on a 5xx with the same idempotency key", async () => {
    const { fn, calls } = fakeFetch([new Response("oops", { status: 502 }), ok()]);
    const result = await resendMailer(env(CONFIGURED), fn).send(message);
    assertEquals(result.status, "sent");
    assertEquals(calls.length, 2);
    const key = (i: number) => (calls[i].init.headers as Record<string, string>)["Idempotency-Key"];
    assertEquals(key(0), key(1));
  });

  it("retries once after a network error, then gives up", async () => {
    const { fn, calls } = fakeFetch([new TypeError("connection reset"), new TypeError("connection reset")]);
    let result;
    await captureLogs(async () => { result = await resendMailer(env(CONFIGURED), fn).send(message); });
    assertEquals(result, { status: "failed", reason: "Could not reach Resend" });
    assertEquals(calls.length, 2);
  });

  it("doesn't retry a 4xx, and reports Resend's reason", async () => {
    const { fn, calls } = fakeFetch([new Response(JSON.stringify({ message: "The figbloom.org domain is not verified" }), { status: 403 })]);
    let result;
    await captureLogs(async () => { result = await resendMailer(env(CONFIGURED), fn).send(message); });
    assertEquals(result, { status: "failed", reason: "Resend answered 403: The figbloom.org domain is not verified" });
    assertEquals(calls.length, 1);
  });

  it("logs the template, the recipient's domain and the message id, never the password or the address", async () => {
    const logs = await captureLogs(async () => {
      await resendMailer(env(CONFIGURED), fakeFetch([ok()]).fn).send(message);
      await resendMailer(env(CONFIGURED), fakeFetch([new Response("{}", { status: 422 })]).fn).send(message);
      await resendMailer(env(CONFIGURED), fakeFetch([new Response("{}", { status: 500 }), new Response("{}", { status: 500 })]).fn).send(message);
    });
    assertStringIncludes(logs, "login-welcome");
    assertStringIncludes(logs, "@gmail.com");
    assertStringIncludes(logs, "re_msg_123");
    assertFalse(logs.includes(PASSWORD), "password logged");
    assertFalse(logs.includes("otieno@"), "full address logged");
    assertFalse(logs.includes("re_test_key"), "API key logged");
  });
});

describe("isDeliverable", () => {
  it("takes a real address and refuses synthetic sign-in addresses and junk", () => {
    assert(isDeliverable("otieno@gmail.com"));
    assertFalse(isDeliverable("tc-0001@login.green-valley.figbloom.internal"));
    assertFalse(isDeliverable("not an email"));
    assertFalse(isDeliverable("a@b"));
    assertFalse(isDeliverable("a@b.com, c@d.com"));
    assertFalse(isDeliverable(null));
  });
  it("emailDomain is only the part after the @", () => {
    assertEquals(emailDomain("Otieno@Gmail.com"), "gmail.com");
  });
});

describe("signInPath", () => {
  it("sends each role to its own portal at the school", () => {
    assertEquals(signInPath("teacher", "green-valley"), "/s/green-valley/teacher");
    assertEquals(signInPath("school_admin", "green-valley"), "/s/green-valley/admin");
    assertEquals(signInPath("parent", "green-valley"), "/s/green-valley/parent");
    assertEquals(signInPath("org_admin", "nairobi-county"), "/org/nairobi-county/dashboard");
    assertEquals(signInPath("teacher", null), "/signin");
  });
});

describe("loginEmail", () => {
  const details = {
    kind: "welcome" as const,
    fullName: "Otieno <b>Ouma</b>",
    placeName: "Green & Valley \"School\"",
    login: "TC-0001",
    loginIsId: true,
    password: PASSWORD,
    signInUrl: "https://app.example.test/s/green-valley/teacher",
    actor: "Mary <script>alert(1)</script> (school admin)",
  };

  it("has the login ID, password, link, the first-sign-in line and who added them, in both versions", () => {
    const m = loginEmail(details);
    assertEquals(m.subject, "Your Figbloom account at Green & Valley \"School\"");
    for (const body of [m.html, m.text]) {
      assertStringIncludes(body, "TC-0001");
      assertStringIncludes(body, PASSWORD);
      assertStringIncludes(body, "https://app.example.test/s/green-valley/teacher");
      assertStringIncludes(body, "you'll choose your own password when you first sign in".replace("'", body === m.html ? "&#39;" : "'"));
    }
    assertStringIncludes(m.text, "Mary <script>alert(1)</script> (school admin) added you.");
    assertStringIncludes(m.html, '<meta name="viewport"');
  });

  it("escapes every interpolated value in the HTML", () => {
    const m = loginEmail(details);
    assertFalse(m.html.includes("<script>"));
    assertFalse(m.html.includes("<b>Ouma"));
    assertStringIncludes(m.html, "Green &amp; Valley &quot;School&quot;");
    assertStringIncludes(m.html, "&lt;script&gt;");
    assertEquals(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("keeps a line break out of the subject", () => {
    assertEquals(loginEmail({ ...details, placeName: "Green\r\nBcc: x@y.com" }).subject, "Your Figbloom account at Green Bcc: x@y.com");
  });

  it("has a reset version, and copes with no link", () => {
    const m = loginEmail({ ...details, kind: "reset", signInUrl: null, loginIsId: false, login: "otieno@gmail.com" });
    assertMatch(m.subject, /^Your new Figbloom password for /);
    assertEquals(m.template, "login-reset");
    assertStringIncludes(m.text, "Email: otieno@gmail.com");
    assertStringIncludes(m.text, "Open Figbloom to sign in.");
    assertFalse(m.html.includes("<a href"));
  });
});

describe("deliverLoginDetails", () => {
  const details = {
    kind: "welcome" as const, fullName: "Otieno Ouma", placeName: "Green Valley", login: "TC-0001", loginIsId: true,
    password: PASSWORD, signInPath: "/s/green-valley/teacher", actor: null,
  };

  it("sends with the app's sign-in link when there's an address and email is set up", async () => {
    const mailer = new FakeMailer();
    const out = await deliverLoginDetails({ mailer, limiter: countingLimiter(), callerKey: "k" }, " otieno@gmail.com ", details);
    assertEquals(out, { status: "sent", to: "otieno@gmail.com" });
    assertEquals(mailer.sent[0].to, "otieno@gmail.com");
    assertStringIncludes(mailer.sent[0].text, "https://app.example.test/s/green-valley/teacher");
  });

  it("says no_address with no or a synthetic address, and not_configured without a mailer, sending nothing", async () => {
    const limiter = countingLimiter();
    assertEquals(await deliverLoginDetails({ mailer: new FakeMailer(), limiter, callerKey: "k" }, null, details), { status: "no_address" });
    assertEquals(await deliverLoginDetails({ mailer: new FakeMailer(), limiter, callerKey: "k" }, "tc-0001@login.gv.figbloom.internal", details), { status: "no_address" });
    assertEquals(await deliverLoginDetails({ mailer: NO_MAILER, limiter, callerKey: "k" }, "otieno@gmail.com", details), { status: "not_configured" });
    assertEquals(limiter.calls, 0);
  });

  it("is refused past the caller's rate limit", async () => {
    const mailer = new FakeMailer();
    const out = await deliverLoginDetails({ mailer, limiter: countingLimiter(0), callerKey: "k" }, "otieno@gmail.com", details);
    assertEquals(out.status, "failed");
    assertEquals(mailer.sent.length, 0);
  });

  it("turns a throwing mailer into a failure rather than an exception", async () => {
    const mailer = new FakeMailer();
    mailer.throws = new Error(`boom ${PASSWORD}`);
    let out;
    const logs = await captureLogs(async () => { out = await deliverLoginDetails({ mailer, limiter: countingLimiter(), callerKey: "k" }, "otieno@gmail.com", details); });
    assertEquals(out, { status: "failed", to: "otieno@gmail.com", reason: "something went wrong sending it" });
    assertFalse(logs.includes(PASSWORD));
  });
});
