import { useEffect, useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { resolveLoginId, searchSchools, supabase, type SchoolSearchResult } from "@figbloom/shared";
import { HIT, s, t } from "../theme";

/**
 * Unified sign-in (FIG-396/403) — no parent/student/driver tabs. The mobile
 * app never had a staff/platform door to begin with (school admins and
 * teachers use the web console), so it only ever needs the school+ID+
 * password path: search for a school, pick it, type the school-assigned
 * login_id ("PT-0029"), see the real name come back as confirmation, then
 * a password. Replaces phone+SMS-OTP for parents and admission+PIN for
 * students with the exact same flow every role now uses.
 */
export function SignIn() {
  const [school, setSchool] = useState<SchoolSearchResult | null>(null);
  const [schoolQuery, setSchoolQuery] = useState("");
  const [schoolResults, setSchoolResults] = useState<SchoolSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const [loginId, setLoginId] = useState("");
  const [resolved, setResolved] = useState<{ full_name: string; email: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [idHint, setIdHint] = useState("");

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const q = schoolQuery.trim();
    if (q.length < 2) { setSchoolResults([]); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      searchSchools(q)
        .then(setSchoolResults)
        .catch(() => setSchoolResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [schoolQuery]);

  function selectSchool(picked: SchoolSearchResult) {
    setSchool(picked);
    setSchoolQuery("");
    setSchoolResults([]);
    setLoginId("");
    setResolved(null);
    setIdHint("");
  }

  function changeSchool() {
    setSchool(null);
    setLoginId("");
    setResolved(null);
    setIdHint("");
  }

  async function resolveId() {
    if (!school || !loginId.trim()) return;
    setResolving(true);
    try {
      const r = await resolveLoginId(school.id, loginId.trim());
      setResolved(r);
      setIdHint("");
    } catch (err) {
      setResolved(null);
      setIdHint(err instanceof Error ? err.message : "Could not find that ID.");
    } finally {
      setResolving(false);
    }
  }

  async function submit() {
    if (!resolved) return;
    setError("");
    setBusy(true);
    try {
      const { error: err } = await supabase().auth.signInWithPassword({ email: resolved.email, password });
      if (err) { setError("Check your ID and password."); return; }
      // No navigation call here — App.tsx listens for the auth state change
      // and swaps in the signed-in screens itself.
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[s.screen, { justifyContent: "center", padding: 24 }]}>
      <Text style={{ fontSize: 22, fontWeight: "700", textAlign: "center" }}>Figbloom</Text>
      <Text style={[s.small, { textAlign: "center", marginTop: 4, marginBottom: 24 }]}>
        Sign in to see fees, results and messages.
      </Text>

      {school ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", ...fieldStyle(false), paddingVertical: 12 }}>
          <View>
            <Text style={{ fontSize: 10.5, fontWeight: "700", color: t.appSurface.inkFaint, letterSpacing: 0.6 }}>SCHOOL</Text>
            <Text style={{ fontSize: 15, fontWeight: "600" }}>{school.name}</Text>
          </View>
          <TouchableOpacity accessibilityRole="button" onPress={changeSchool} style={HIT}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: t.brand.orange }}>Change</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>School</Text>
          <TextInput
            placeholder="Start typing your school's name"
            autoCapitalize="words"
            value={schoolQuery}
            onChangeText={setSchoolQuery}
            style={fieldStyle(false)}
          />
          {searching && <Text style={[s.faint, { marginTop: 6 }]}>Searching…</Text>}
          {!searching && schoolResults.length > 0 && (
            <View style={{ marginTop: 6, borderWidth: 1, borderColor: t.appSurface.line, borderRadius: 12, overflow: "hidden" }}>
              {schoolResults.map((r) => (
                <TouchableOpacity
                  key={r.id}
                  accessibilityRole="button"
                  onPress={() => selectSchool(r)}
                  style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}
                >
                  <Text style={{ fontSize: 14, fontWeight: "600" }}>{r.name}</Text>
                  {r.county && <Text style={s.faint}>{r.county}</Text>}
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      )}

      {school && (
        <>
          <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>Your ID</Text>
          <TextInput
            placeholder="e.g. PT-0029"
            autoCapitalize="characters"
            value={loginId}
            onChangeText={(v) => { setLoginId(v); setResolved(null); setIdHint(""); }}
            onBlur={() => void resolveId()}
            style={fieldStyle(!!idHint)}
          />
          {resolving ? (
            <Text style={[s.faint, { marginTop: 6 }]}>Checking…</Text>
          ) : resolved ? (
            <Text style={[s.small, { marginTop: 6, color: t.status.okInk }]}>Signing in as {resolved.full_name}.</Text>
          ) : idHint ? (
            <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 6 }}>{idHint}</Text>
          ) : null}
        </>
      )}

      {resolved && (
        <>
          <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>Password</Text>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <TextInput
              placeholder="••••••••"
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
              style={[fieldStyle(!!error), { flex: 1 }]}
            />
            <TouchableOpacity accessibilityRole="button" onPress={() => setShowPassword((v) => !v)} style={{ ...HIT, marginLeft: 8, justifyContent: "center" }}>
              <Text style={{ fontSize: 12.5, fontWeight: "600", color: t.appSurface.inkMuted }}>{showPassword ? "Hide" : "Show"}</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {!!error && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 8 }}>{error}</Text>}

      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy || !resolved || !password}
        onPress={submit}
        style={[s.primary, { backgroundColor: t.brand.orange, marginTop: 20, opacity: busy || !resolved || !password ? 0.6 : 1 }]}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryLabel}>Sign in</Text>}
      </TouchableOpacity>
    </View>
  );
}

const fieldStyle = (hasError: boolean) => ({
  ...HIT,
  borderWidth: 1,
  borderColor: hasError ? t.status.warnInk : t.appSurface.line,
  borderRadius: 12,
  paddingHorizontal: 14,
  fontSize: 15,
});
