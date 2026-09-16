import { useState } from "react";
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from "react-native";
import { OTP_LENGTH, countryProfile, normalisePhoneForCountry, studentLoginEmail, supabase, validateOtp, validatePin } from "@figbloom/shared";
import { HIT, s, t } from "../theme";

type Tab = "parent" | "student" | "driver";

// A parent hasn't been identified with a school yet at sign-in time, so
// there is no tenant.country in scope — "KE" is every real account today.
const SIGNIN_COUNTRY = "KE";

// Mirrors the web sign-in's same simplification: there is no "choose your
// school" step yet, so an admission number only resolves against one tenant.
const STUDENT_SLUG = "alliance";

/**
 * The mobile app has three doors, not the web console's four — school admins
 * and teachers use the web console. Parents get phone + SMS code because most
 * have no working email; students get an admission number and PIN because
 * they have neither; drivers sign in the same way staff do, email + password.
 */
export function SignIn() {
  const [tab, setTab] = useState<Tab>("parent");
  const [sent, setSent] = useState(false);
  const [value, setValue] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function switchTab(next: Tab) {
    setTab(next);
    setSent(false);
    setValue("");
    setCode("");
    setError("");
  }

  async function submit() {
    setError("");
    setBusy(true);
    try {
      if (tab === "parent") {
        const phone = normalisePhoneForCountry(value, SIGNIN_COUNTRY);
        if (!sent) {
          const { error: err } = await supabase().auth.signInWithOtp({
            phone, options: { shouldCreateUser: false },
          });
          if (err) { setError("We don't have that number on file. Check with the school office."); return; }
          setSent(true);
          return;
        }
        const v = validateOtp(code);
        if (!v.ok) { setError(v.message || `The code is ${OTP_LENGTH} numbers.`); return; }
        const { error: err } = await supabase().auth.verifyOtp({ phone, token: code, type: "sms" });
        if (err) { setError("That code is wrong or has expired."); return; }
      } else if (tab === "student") {
        const v = validatePin(code);
        if (!v.ok) { setError(v.message); return; }
        const { error: err } = await supabase().auth.signInWithPassword({
          email: studentLoginEmail(value.trim(), STUDENT_SLUG), password: code,
        });
        if (err) { setError("Check the admission number and PIN."); return; }
      } else {
        const { error: err } = await supabase().auth.signInWithPassword({ email: value.trim(), password: code });
        if (err) { setError("Check the email and password."); return; }
      }
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

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 20 }}>
        {(["parent", "student", "driver"] as const).map((k) => (
          <TouchableOpacity
            key={k}
            accessibilityRole="button"
            accessibilityState={{ selected: tab === k }}
            onPress={() => switchTab(k)}
            style={{
              ...HIT, flex: 1, borderRadius: 12, alignItems: "center", justifyContent: "center",
              backgroundColor: tab === k ? t.brand.orange : t.appSurface.lineSoft,
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: tab === k ? "#fff" : t.appSurface.inkMuted }}>
              {k === "parent" ? "Parent" : k === "student" ? "Student" : "Driver"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {tab === "parent" ? (
        <>
          <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Mobile number</Text>
          <TextInput
            placeholder={countryProfile(SIGNIN_COUNTRY).phonePlaceholder}
            keyboardType="phone-pad"
            value={value}
            onChangeText={setValue}
            editable={!sent}
            style={fieldStyle(false)}
          />
          {sent && (
            <>
              <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>The six-digit code</Text>
              <TextInput
                placeholder="000000"
                keyboardType="number-pad"
                value={code}
                onChangeText={setCode}
                style={fieldStyle(!!error)}
              />
            </>
          )}
        </>
      ) : tab === "student" ? (
        <>
          <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Admission number</Text>
          <TextInput
            placeholder="4102"
            keyboardType="number-pad"
            value={value}
            onChangeText={setValue}
            style={fieldStyle(false)}
          />
          <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>PIN</Text>
          <TextInput
            placeholder="••••"
            keyboardType="number-pad"
            secureTextEntry
            value={code}
            onChangeText={setCode}
            style={fieldStyle(!!error)}
          />
        </>
      ) : (
        <>
          <Text style={[s.small, { fontWeight: "600", marginBottom: 6 }]}>Email</Text>
          <TextInput
            placeholder="you@school.sc.ke"
            keyboardType="email-address"
            autoCapitalize="none"
            value={value}
            onChangeText={setValue}
            style={fieldStyle(false)}
          />
          <Text style={[s.small, { fontWeight: "600", marginTop: 14, marginBottom: 6 }]}>Password</Text>
          <TextInput
            placeholder="••••••••"
            secureTextEntry
            value={code}
            onChangeText={setCode}
            style={fieldStyle(!!error)}
          />
        </>
      )}

      {!!error && <Text style={{ fontSize: 11.5, color: t.status.warnInk, marginTop: 8 }}>{error}</Text>}

      <TouchableOpacity
        accessibilityRole="button"
        disabled={busy}
        onPress={submit}
        style={[s.primary, { backgroundColor: t.brand.orange, marginTop: 20, opacity: busy ? 0.6 : 1 }]}
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.primaryLabel}>{tab === "parent" && !sent ? "Text me a code" : "Sign in"}</Text>}
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
