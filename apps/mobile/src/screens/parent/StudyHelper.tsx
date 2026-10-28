import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import {
  AI_HELPER_BILLING_AVAILABLE, fetchAiHelperStatus, formatMoney, optInOutcomeText, setAiHelperOptIn, type AiHelperStatus,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useChild, useChildren } from "../../data";
import { ChildSwitcher } from "../../components/ChildSwitcher";
import { SubScreen } from "../../components/SubScreen";

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";

/**
 * The Bloom study helper for one child: what it is, what it can't do, what is
 * kept, and (at a school that asks parents) a switch to turn it on or off for
 * this child. Either guardian may change it; the screen says who did. The
 * price shows only once the school bills for it (AI_HELPER_BILLING_AVAILABLE
 * and the school's own switch); until then nothing here costs anything.
 * The learner uses the helper from the Today screen of their own app, or the website.
 */
export function ParentStudyHelper() {
  const { child, index, setIndex, accent, country } = useChild();
  const kids = useChildren();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;
  const first = child.first;
  const [status, setStatus] = useState<AiHelperStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    setStatus(undefined);
    setError(null);
    setNote(null);
    fetchAiHelperStatus(child.id)
      .then((r) => { if (alive) setStatus(r); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load the study helper."); });
    return () => { alive = false; };
  }, [child.id, reloadKey]);

  async function change(on: boolean) {
    setSaving(true);
    setNote(null);
    try {
      const outcome = await setAiHelperOptIn(child.id, on);
      setNote({ text: optInOutcomeText(outcome, first), bad: false });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : "Could not save.", bad: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SubScreen
      tint={tint}
      title="Bloom study helper"
      sub={`An AI tutor ${first} can ask about their schoolwork.`}
      headerRight={<ChildSwitcher children={kids} index={index} onChange={setIndex} tint={tint} />}
    >
      <View style={{ gap: 14 }}>
        {error ? (
          <Text style={[s.small, { color: t.status.warnInk }]}>{error}</Text>
        ) : status === undefined ? (
          <ActivityIndicator color={tint} style={{ marginTop: 24 }} />
        ) : status ? (
          <Choice status={status} first={first} saving={saving} tint={tint} country={country} onChange={(on) => void change(on)} />
        ) : (
          <Text style={s.small}>There's nothing to show for this child.</Text>
        )}
        {!!note && <Text style={[s.small, { color: note.bad ? t.status.warnInk : t.status.okInk }]}>{note.text}</Text>}

        <Info title="What it is">
          <Text style={s.small}>
            Bloom is an AI tutor. {first} types a question about something they're learning, and Bloom explains it and asks questions
            back, so they work the answer out themselves instead of copying one. It's written for their class level and the curriculum
            they follow.
          </Text>
        </Info>

        <Info title="What it can and can't do">
          <Bullets items={[
            "It helps with schoolwork: explaining a topic, working through an example, quizzing for revision.",
            "It guides rather than handing over answers, and keeps conversations age-appropriate.",
            `It switches itself off while ${first} has an exam open or in progress, and comes back once it's handed in or closed.`,
            "It doesn't search the internet, and it's an AI, not a teacher: it can get things wrong.",
            "There's a daily limit on questions, and the school can turn it off at any time.",
          ]} />
        </Info>

        <Info title="Privacy">
          <Bullets items={[
            "Conversations aren't stored. Leaving the page starts afresh, and neither the school nor Figbloom can read them later.",
            `What is kept is a count: when ${first} asked a question and how long the answer was. The school can see how much each learner uses it, and so can you, above.`,
            "Questions are answered by an AI service the school uses through Figbloom, with no name or admission number attached.",
            "Bloom reminds learners not to share their full name, phone number or address, and points them to Childline Kenya on 116 if something is worrying them.",
          ]} />
        </Info>
      </View>
    </SubScreen>
  );
}

function Info({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={[s.card, { padding: 14, gap: 6 }]}>
      <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.appSurface.ink }}>{title}</Text>
      {children}
    </View>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <View style={{ gap: 4 }}>
      {items.map((text) => (
        <View key={text} style={{ flexDirection: "row", gap: 8 }}>
          <Text style={s.small}>•</Text>
          <Text style={[s.small, { flex: 1 }]}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

function Choice({ status, first, saving, tint, country, onChange }: {
  status: AiHelperStatus; first: string; saving: boolean; tint: string; country: string; onChange: (on: boolean) => void;
}) {
  const priced = AI_HELPER_BILLING_AVAILABLE && status.billingEnabled && status.priceCents > 0 && status.access === "opt_in";
  const who = status.status === "on"
    ? status.turnedOnBy ? `Turned on by ${status.turnedOnBy}${status.turnedOnAt ? ` on ${when(status.turnedOnAt)}` : ""}.` : ""
    : status.status === "off" && status.changedBy ? `Turned off by ${status.changedBy}${status.changedAt ? ` on ${when(status.changedAt)}` : ""}.` : "";

  let state: string;
  let action: { label: string; on: boolean } | null = null;
  if (!status.schoolOn) {
    state = "The school hasn't turned on the study helper.";
    if (status.status === "on") action = { label: "Turn off", on: false };
  } else if (status.access === "all") {
    state = `The school has the study helper on for every learner, so ${first} can already use it.`;
  } else if (status.optInActive) {
    state = `On for ${first}.`;
    action = { label: "Turn off", on: false };
  } else {
    state = status.status === "on" && priced
      ? `Off for ${first} this term. Turn it on again to use it this term.`
      : `Off for ${first}. The school asks a parent or guardian to turn it on.`;
    action = { label: priced ? `Turn on (${formatMoney(status.priceCents, country)} this term)` : "Turn on", on: true };
  }
  const running = status.schoolOn && (status.access === "all" || status.optInActive);

  return (
    <View style={[s.card, { padding: 14 }]}>
      <View style={[s.row, { alignItems: "flex-start", gap: 8 }]}>
        <View style={{ width: 10, height: 10, borderRadius: 5, marginTop: 5, backgroundColor: running ? t.status.okDot : t.appSurface.line }} />
        <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "600", color: t.appSurface.ink }}>{state}</Text>
      </View>
      {!!who && <Text style={[s.faint, { marginTop: 6 }]}>{who} Either parent or guardian can change this.</Text>}

      {action && (
        <TouchableOpacity
          accessibilityRole="button"
          disabled={saving}
          onPress={() => onChange(action.on)}
          style={[s.primary, { marginTop: 12, backgroundColor: action.on ? tint : t.appSurface.card, borderWidth: action.on ? 0 : 1, borderColor: t.appSurface.line, opacity: saving ? 0.6 : 1 }]}
        >
          {saving
            ? <ActivityIndicator color={action.on ? "#fff" : tint} />
            : <Text style={[s.primaryLabel, action.on ? null : { color: t.appSurface.ink }]}>{action.label}</Text>}
        </TouchableOpacity>
      )}

      {priced && (
        <Text style={[s.small, { marginTop: 12, padding: 10, borderRadius: 10, backgroundColor: t.appSurface.shell }]}>
          {formatMoney(status.priceCents, country)} per term, added to {first}'s fee invoice as "Bloom study helper" for the term it's turned on.
          Turn it off within {status.cancelDays} {status.cancelDays === 1 ? "day" : "days"} of being charged and the charge is taken off;
          after that it stays for the term.
          {status.chargeCents != null && ` This term's ${formatMoney(status.chargeCents, country)} is on the invoice.`}
        </Text>
      )}

      <View style={{ flexDirection: "row", gap: 24, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft }}>
        <View>
          <Text style={s.faint}>Questions this month</Text>
          <Text style={[s.mono, { fontSize: 15, fontWeight: "700", marginTop: 2 }]}>{status.questionsThisMonth.toLocaleString()}</Text>
        </View>
        <View>
          <Text style={s.faint}>Last used</Text>
          <Text style={{ fontSize: 13, marginTop: 2 }}>{status.lastUsedAt ? when(status.lastUsedAt) : "Not yet"}</Text>
        </View>
      </View>

      <Text style={[s.faint, { marginTop: 12 }]}>{first} uses the study helper from the Today screen of their own Figbloom app, or from the website.</Text>
    </View>
  );
}
