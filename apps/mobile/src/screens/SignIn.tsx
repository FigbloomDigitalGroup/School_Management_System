import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import {
  isBannedAuthError, isSchoolSuspendedError, passwordResetRequestedMessage, requestPasswordReset, resolveLoginId,
  roleFromLoginId, searchSchools, SITE_ORIGIN, supabase, type ResolvedLogin, type SchoolSearchResult,
} from "@figbloom/shared";
import { fontSize } from "../theme";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { SuspendedNotice } from "../ui/SuspendedNotice";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

/**
 * Unified sign-in (FIG-396/403) — no parent/student/driver tabs. The path
 * every role but a school admin takes is school + ID + password: search for
 * a school, pick it, type the school-assigned login_id ("PT-0029"), see the
 * real name come back as confirmation, then a password. Replaces phone+SMS-OTP
 * for parents and admission+PIN for students with the exact same flow every
 * role now uses.
 *
 * A school admin has a real email and no login_id (invite-admin), so a link
 * under the form switches to email + password, as the web's Admin portal does.
 *
 * "Forgot password?" for an ID asks the school (login-ID accounts have no
 * mailbox): same school + ID, then request-password-reset, and the school
 * office (or a learner's parent) sets a new temporary password. For an email
 * it sends the usual reset link, which opens the web's reset page.
 */
export function SignIn({ suspendedAtStart = false, unsupportedAtStart = false }: {
  /** Set by App when an open session found its school suspended and signed this phone out. */
  suspendedAtStart?: boolean;
  /** Set by App when the account that was signed in has no screens in this app (yet) and was signed out. */
  unsupportedAtStart?: boolean;
} = {}) {
  const { t, s } = useTheme();
  // The school is suspended: said by Auth (user_banned), by resolve-login-id
  // (school_suspended), or by App for a session that was already open.
  const [suspended, setSuspended] = useState(suspendedAtStart);
  const [unsupported, setUnsupported] = useState(unsupportedAtStart);
  // "id": school + ID. "email": a school admin's real email.
  const [mode, setMode] = useState<"id" | "email">("id");
  const [email, setEmail] = useState("");
  const [school, setSchool] = useState<SchoolSearchResult | null>(null);
  const [schoolQuery, setSchoolQuery] = useState("");
  const [schoolResults, setSchoolResults] = useState<SchoolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  // The query the current results answer, so "No school matches" only shows for a search that actually ran.
  const [searchedFor, setSearchedFor] = useState("");
  const [retry, setRetry] = useState(0);

  const [loginId, setLoginId] = useState("");
  const [resolved, setResolved] = useState<ResolvedLogin | null>(null);
  const [resolving, setResolving] = useState(false);
  const [idHint, setIdHint] = useState("");

  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const passwordRef = useRef<TextInput>(null);
  // Set when the keyboard's "next" key asked for the ID to be looked up: once it has been, the password field takes focus.
  const wantPassword = useRef(false);

  useEffect(() => {
    const q = schoolQuery.trim();
    setSearchFailed(false);
    if (q.length < 2) { setSchoolResults([]); setSearching(false); setSearchedFor(""); return; }
    setSearching(true);
    // A slow answer to an earlier keystroke must not overwrite the answer to the current one.
    let current = true;
    const timer = setTimeout(() => {
      searchSchools(q)
        .then((schools) => { if (current) { setSchoolResults(schools); setSearchedFor(q); } })
        .catch((err) => { if (current) { console.warn("School search failed:", err); setSchoolResults([]); setSearchFailed(true); } })
        .finally(() => { if (current) setSearching(false); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [schoolQuery, retry]);

  useEffect(() => {
    if (resolved && wantPassword.current) {
      wantPassword.current = false;
      passwordRef.current?.focus();
    }
  }, [resolved]);

  function selectSchool(picked: SchoolSearchResult) {
    setSuspended(false);
    setSchool(picked);
    setSchoolQuery("");
    setSchoolResults([]);
    setLoginId("");
    setResolved(null);
    setIdHint("");
  }

  function changeSchool() {
    setSuspended(false);
    setSchool(null);
    setLoginId("");
    setResolved(null);
    setIdHint("");
  }

  async function resolveId() {
    // Already looked up (moving on to the password blurs this field a second time) or still looking: don't ask again.
    if (!school || !loginId.trim() || resolving || resolved) return;
    setResolving(true);
    try {
      const r = await resolveLoginId(school.id, loginId.trim());
      setResolved(r);
      setIdHint("");
    } catch (err) {
      wantPassword.current = false;
      setResolved(null);
      if (isSchoolSuspendedError(err)) { setIdHint(""); setSuspended(true); return; }
      setIdHint(err instanceof Error ? err.message : "Could not find that ID.");
    } finally {
      setResolving(false);
    }
  }

  function toggleForgot(on: boolean) {
    setForgot(on);
    setForgotSent(false);
    setError("");
    setPassword("");
  }

  function switchMode(to: "id" | "email") {
    setMode(to);
    setForgot(false);
    setForgotSent(false);
    setError("");
    setPassword("");
    setSuspended(false);
    setUnsupported(false);
  }

  async function askForReset() {
    setError("");
    try {
      if (mode === "email") {
        if (!email.trim()) return;
        setBusy(true);
        const { error: err } = await supabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${SITE_ORIGIN}/reset-password` });
        if (err) throw err;
      } else {
        if (!school || !loginId.trim()) return;
        setBusy(true);
        await requestPasswordReset(school.id, loginId.trim());
      }
      setForgotSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : mode === "email" ? "Could not send the link. Try again." : "Could not send the request. Try again, or ask the school office.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const signInEmail = mode === "email" ? email.trim() : resolved?.email;
    if (!signInEmail) return;
    setError("");
    setSuspended(false);
    setUnsupported(false);
    setBusy(true);
    try {
      const { error: err } = await supabase().auth.signInWithPassword({ email: signInEmail, password });
      if (err) {
        // Auth's own answer for a banned account: it already says the account exists, so this adds nothing to that
        if (isBannedAuthError(err)) setSuspended(true);
        else setError(mode === "email" ? "Check the email and password." : "Check your ID and password.");
        return;
      }
      // No navigation call here — App.tsx listens for the auth state change
      // and swaps in the signed-in screens itself.
    } finally {
      setBusy(false);
    }
  }

  return (
    // A scroll, not a centred View: with the keyboard up on a small phone the form is taller than what is left.
    <ScrollView
      style={s.screen}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ fontSize: fontSize.header, fontWeight: "700", textAlign: "center", color: t.appSurface.ink }}>Figbloom</Text>
      <Text style={[s.small, { textAlign: "center", marginTop: 4, marginBottom: 24 }]}>
        {mode === "email" ? "School admins sign in with the email they were set up with." : "Sign in with the login your school gave you."}
      </Text>

      {suspended && <SuspendedNotice style={{ marginBottom: 16 }} />}
      {unsupported && (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ borderWidth: 1, borderColor: t.status.warnInk, borderRadius: t.radius.lg, backgroundColor: t.status.warnBg, padding: 14, marginBottom: 16 }}
        >
          <Text style={{ fontSize: fontSize.lead, fontWeight: "700", color: t.status.warnInk }}>Not on the phone yet</Text>
          <Text style={{ fontSize: 14, lineHeight: 20, marginTop: 4, color: t.status.warnInk }}>
            This app doesn't have screens for your account yet. Use the web console instead.
          </Text>
        </View>
      )}

      {mode === "email" ? null : school ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: t.appSurface.line, borderRadius: t.radius.lg, backgroundColor: t.appSurface.card, paddingLeft: 14, paddingVertical: 4 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: fontSize.micro, fontWeight: "700", color: t.appSurface.inkFaint, letterSpacing: 0.6 }}>SCHOOL</Text>
            <Text style={{ fontSize: fontSize.lead, fontWeight: "600", color: t.appSurface.ink }}>{school.name}</Text>
          </View>
          <Button variant="quiet" label="Change" accessibilityHint="Pick a different school" onPress={changeSchool} style={{ paddingVertical: 10 }} />
        </View>
      ) : (
        <>
          <Field
            label="School"
            placeholder="Start typing your school's name"
            autoCapitalize="words"
            value={schoolQuery}
            onChangeText={setSchoolQuery}
            error={!searching && searchFailed ? "We couldn't search just now. Check your connection." : undefined}
            hint={searching ? "Searching…" : !searchFailed && !!searchedFor && schoolResults.length === 0 ? "No school matches that name. Check the spelling, or ask the school office." : undefined}
          />
          {!searching && searchFailed && (
            <Button variant="quiet" label="Try again" onPress={() => setRetry((n) => n + 1)} style={{ alignSelf: "flex-start", paddingVertical: 10, paddingHorizontal: 4 }} />
          )}
          {!searching && schoolResults.length > 0 && (
            <View style={{ marginTop: 8, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: t.radius.lg, overflow: "hidden", backgroundColor: t.appSurface.card }}>
              {schoolResults.map((r) => (
                <Tap
                  key={r.id}
                  onPress={() => selectSchool(r)}
                  pressedScale={1}
                  style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "600", color: t.appSurface.ink }}>{r.name}</Text>
                  {r.county && <Text style={s.faint}>{r.county}</Text>}
                </Tap>
              ))}
            </View>
          )}
        </>
      )}

      {mode === "id" && school && (
        <>
          <Field
            label="Your ID"
            placeholder="e.g. PT-0029"
            autoCapitalize="characters"
            autoComplete="username"
            autoCorrect={false}
            returnKeyType={forgot ? "done" : "next"}
            submitBehavior={forgot ? "blurAndSubmit" : "submit"}
            value={loginId}
            onChangeText={(v) => { setLoginId(v); setResolved(null); setIdHint(""); setSuspended(false); }}
            onBlur={() => { if (!forgot) void resolveId(); }}
            onSubmitEditing={() => {
              if (forgot) return;
              if (resolved) passwordRef.current?.focus();
              else { wantPassword.current = true; void resolveId(); }
            }}
            error={idHint || undefined}
            style={{ marginTop: 14 }}
          />
          {forgot ? null : resolving ? (
            <Text style={[s.faint, { marginTop: 6 }]}>Checking…</Text>
          ) : resolved ? (
            <Text accessibilityLiveRegion="polite" style={[s.small, { marginTop: 6, color: t.status.okInk }]}>Signing in as {resolved.display_name}</Text>
          ) : null}
        </>
      )}

      {mode === "email" && (
        <Field
          label="Email"
          placeholder="you@school.sc.ke"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          returnKeyType={forgot ? "done" : "next"}
          value={email}
          onChangeText={(v) => { setEmail(v); setError(""); setSuspended(false); setUnsupported(false); }}
          onSubmitEditing={() => { if (!forgot) passwordRef.current?.focus(); }}
          style={{ marginTop: 14 }}
        />
      )}

      {(mode === "email" || resolved) && !forgot && (
        <Field
          ref={passwordRef}
          label="Password"
          placeholder="••••••••"
          secret
          autoComplete="current-password"
          returnKeyType="go"
          value={password}
          onChangeText={(v) => { setPassword(v); if (error) setError(""); }}
          onSubmitEditing={() => { if (password && !busy) void submit(); }}
          error={error || undefined}
          style={{ marginTop: 14 }}
        />
      )}

      {forgot && !!error && <Text accessibilityLiveRegion="polite" style={{ fontSize: fontSize.caption, color: t.status.warnInk, marginTop: 8 }}>{error}</Text>}

      {forgot ? (
        forgotSent ? (
          <Text accessibilityLiveRegion="polite" style={[s.small, { marginTop: 20, color: t.status.okInk, lineHeight: 19 }]}>
            {mode === "email" ? "If that email has an account, a link to choose a new password is on its way." : passwordResetRequestedMessage(roleFromLoginId(loginId))}
          </Text>
        ) : mode === "email" ? (
          <>
            <Text style={[s.faint, { marginTop: 14, lineHeight: 17 }]}>We'll email you a link to choose a new password.</Text>
            <Button label="Email me a link" loading={busy} disabled={!email.trim()} onPress={askForReset} style={{ marginTop: 14 }} />
          </>
        ) : (
          <>
            <Text style={[s.faint, { marginTop: 14, lineHeight: 17 }]}>
              {school ? "We'll ask your school to set you a new temporary password." : "Pick your school, then enter your ID, and we'll ask the school to set you a new temporary password."}
            </Text>
            <Button label="Ask for a new password" loading={busy} disabled={!school || !loginId.trim()} onPress={askForReset} style={{ marginTop: 14 }} />
          </>
        )
      ) : (
        <Button label="Sign in" loading={busy} disabled={(mode === "email" ? !email.trim() : !resolved) || !password} onPress={submit} style={{ marginTop: 20 }} />
      )}

      <Button variant="quiet" label={forgot ? "Back to sign in" : "Forgot password?"} onPress={() => toggleForgot(!forgot)} style={{ alignSelf: "center", marginTop: 8 }} />
      <Button
        variant="quiet"
        label={mode === "email" ? "Sign in with your school ID instead" : "School admin? Sign in with your email"}
        onPress={() => switchMode(mode === "email" ? "id" : "email")}
        style={{ alignSelf: "center" }}
      />
    </ScrollView>
  );
}
