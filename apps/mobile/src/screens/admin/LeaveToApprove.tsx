import { useState } from "react";
import { Alert, Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import {
  approvalDecisionMessage, decideApproval, fetchHrHandoffStatus, HR_CONNECT_ONCE, HR_ITEM_LABEL, hrStatusLabel, leaveDaysWords, leaveRange, linkExpired,
  loadApprovals, mayDecline, mayOfferHr, requestHrLink, showsHrItem, type ApprovalItem, type HrDocumentLink,
} from "@figbloom/shared";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { useLoad } from "../../lib/useLoad";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";

/** What the last decision did, said at the top until the next one. */
type Outcome = { kind: "done" | "failed"; text: string };

/** The colour of a step in the approval so far, from HR's own word for it. */
function stepTone(status: string): "ok" | "warn" | "muted" {
  const word = status.toLowerCase();
  if (word === "approved" || word === "done" || word === "completed") return "ok";
  if (word === "pending" || word === "current" || word === "waiting") return "warn";
  return "muted";
}

/**
 * A person HR cannot match to one of its users yet (they never opened HR & Payroll from Schools) is asked to do that
 * once. The button is there for those who may have it (the school's admins, the bursar), when the database says it is on.
 */
function ConnectOnce({ session, onCheckAgain }: { session: StaffSession; onCheckAgain: () => void }) {
  const { t } = useTheme();
  const eligible = mayOfferHr(session.role, session.adminAreas);
  const handoff = useLoad(eligible ? () => fetchHrHandoffStatus(session.tenantId) : null, session.tenantId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canOpen = showsHrItem(eligible, handoff.data);

  async function open() {
    setBusy(true);
    setProblem(null);
    try {
      // One link, good for a minute: it is opened the moment it arrives, and never kept.
      const { url } = await requestHrLink(session.tenantId);
      await Linking.openURL(url);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : `Could not open ${HR_ITEM_LABEL}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <EmptyState
      title="Connect your HR account"
      body={`${HR_CONNECT_ONCE} After that, applications waiting on you show up here.${canOpen ? " Come back here when you have, and check again." : " If you don't have HR & Payroll, ask the school office."}`}
      action={
        <View style={{ marginTop: 14, gap: 10, alignSelf: "stretch" }}>
          {canOpen && <Button label={`Open ${HR_ITEM_LABEL}`} loading={busy} onPress={() => void open()} />}
          <Button variant="secondary" label="Check again" onPress={onCheckAgain} />
          {!!problem && <Text accessibilityRole="alert" style={{ textAlign: "center", fontSize: fontSize.small, color: t.status.badInk }}>{problem}</Text>}
        </View>
      }
    />
  );
}

/**
 * Leave applications waiting on this person in Figbloom HR, at a school whose leave runs there: the head teacher,
 * deputies, the bursar and the school's admins. HR decides whose turn it is, and the decision is made in HR as this
 * person's HR user (HR's permissions, delegation and audit apply), so the screen only shows what HR sends and says
 * what HR answers. A decline needs a comment; a document is a link HR made for five minutes.
 */
export function LeaveToApprove({ session }: { session: StaffSession }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, loading, refreshing, refresh, retry } = useLoad(() => loadApprovals(), session.tenantId);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const tone = {
    ok: { bg: t.status.okBg, ink: t.status.okInk },
    warn: { bg: t.brand.orangeSoft, ink: t.brand.orangeInk },
    muted: { bg: t.status.mutedBg, ink: t.status.mutedInk },
  };

  async function decide(item: ApprovalItem, decision: "approve" | "decline") {
    setBusyId(item.id);
    setOutcome(null);
    try {
      await decideApproval(item.id, decision, comments[item.id] ?? "");
      setComments((c) => { const next = { ...c }; delete next[item.id]; return next; });
      setOutcome({ kind: "done", text: approvalDecisionMessage(decision, item.employee) });
    } catch (err) {
      // HR's own words: not_your_approval, already_decided, a decline without a comment, approver_no_access
      setOutcome({ kind: "failed", text: err instanceof Error ? err.message : "Could not record the decision." });
    } finally {
      setBusyId(null);
    }
    // Either way the list is read again: a decided application drops out, one decided by someone else too.
    void refresh();
  }

  function confirm(item: ApprovalItem, decision: "approve" | "decline") {
    const verb = decision === "approve" ? "Approve" : "Decline";
    const what = `${item.type}, ${leaveRange(item.from, item.to)}.`;
    Alert.alert(`${verb} ${item.employee}'s leave?`, decision === "approve" ? `${what} It is approved in Figbloom HR, as you.` : `${what} ${item.employee} will see your comment in HR.`, [
      { text: "Cancel", style: "cancel" },
      { text: verb, onPress: () => void decide(item, decision) },
    ]);
  }

  function openDocument(doc: HrDocumentLink) {
    // HR's link works for five minutes: once it has run out, ask HR for new ones instead of opening a dead page.
    if (linkExpired(doc)) {
      setOutcome({ kind: "failed", text: `The link to ${doc.name} has expired. The list was read again, with a new one.` });
      void refresh();
      return;
    }
    Linking.openURL(doc.url!).catch(() => setOutcome({ kind: "failed", text: `Could not open ${doc.name}.` }));
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Leave to approve" sub="Waiting on you in Figbloom HR" color={a.deep} back />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {outcome && (
          <View
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            style={{
              borderWidth: 1, borderRadius: t.radius.lg, padding: 12, marginBottom: 14,
              borderColor: outcome.kind === "done" ? t.status.okDot : t.status.badLine,
              backgroundColor: outcome.kind === "done" ? t.status.okBg : t.status.badBg,
            }}
          >
            <Text style={{ fontSize: fontSize.small, fontWeight: "600", color: outcome.kind === "done" ? t.status.okInk : t.status.badInk }}>{outcome.text}</Text>
          </View>
        )}

        {error ? (
          <ErrorState title="Couldn't load leave to approve" body={error} onRetry={retry} />
        ) : loading || !data ? (
          <View style={{ gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[s.card, { padding: 14, gap: 8 }]}>
                <Skeleton width="50%" height={14} />
                <Skeleton width="35%" height={11} />
              </View>
            ))}
          </View>
        ) : data.kind === "not_linked" ? (
          <ConnectOnce session={session} onCheckAgain={() => void refresh()} />
        ) : data.kind === "list" ? (
          <View style={{ gap: 10 }}>
            {data.items.map((item) => {
              const days = leaveDaysWords(item.days, item.halfDay);
              return (
                <View key={item.id} accessibilityLabel={`${item.employee}: ${item.type}`} style={[s.card, { padding: 14 }]}>
                  <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{item.employee}</Text>
                  <Text style={[s.small, { marginTop: 2 }]}>{item.type} · {leaveRange(item.from, item.to)}{days ? ` · ${days}` : ""}</Text>
                  {!!item.reason && <Text style={[s.faint, { marginTop: 2 }]}>{item.reason}</Text>}
                  {!!item.step && <Text style={[s.faint, { marginTop: 2 }]}>Your step: {item.step}</Text>}

                  {item.documents.map((doc) => (
                    linkExpired(doc) ? (
                      <View key={doc.name} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <Text style={[s.small, { flex: 1 }]}>{doc.name}: link expired.</Text>
                        <Button variant="quiet" label="Reload" onPress={() => void refresh()} />
                      </View>
                    ) : (
                      <Button key={doc.name} variant="quiet" label={`View ${doc.name}`} accessibilityHint="Opens HR's copy. The link works for 5 minutes" onPress={() => openDocument(doc)} style={{ alignSelf: "flex-start", marginTop: 4 }} />
                    )
                  ))}

                  {item.steps.length > 0 && (
                    <View accessibilityLabel="Approval so far" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                      {item.steps.map((step, i) => (
                        <View key={i} style={[s.pill, { backgroundColor: tone[stepTone(step.status)].bg }]}>
                          <Text style={[s.pillLabel, { color: tone[stepTone(step.status)].ink }]}>{step.label}: {hrStatusLabel(step.status)}{step.who ? ` (${step.who})` : ""}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  <Field
                    label="Comment (needed to decline)"
                    value={comments[item.id] ?? ""}
                    onChangeText={(text) => setComments((c) => ({ ...c, [item.id]: text }))}
                    accessibilityLabel={`Comment for ${item.employee}'s request`}
                    maxLength={1000}
                    style={{ marginTop: 10 }}
                  />
                  <View style={{ flexDirection: "row", gap: 10, marginTop: 12 }}>
                    <Button
                      variant="secondary" label="Decline" accessibilityHint="Say why in the comment first"
                      disabled={busyId !== null || !mayDecline(comments[item.id] ?? "")} onPress={() => confirm(item, "decline")} style={{ flex: 1 }}
                    />
                    <Button label="Approve" loading={busyId === item.id} disabled={busyId !== null} onPress={() => confirm(item, "approve")} style={{ flex: 1 }} />
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <EmptyState title="Nothing waiting on you" body="Leave applications that need your decision in Figbloom HR will show up here." />
        )}
      </ScrollView>
    </View>
  );
}
