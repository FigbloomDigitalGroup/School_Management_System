import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  daysOverdue, fetchLearnerInventory, formatShortDate, isOverdue, ISSUE_STATUS_LABEL, ITEM_CONDITION_LABEL, sortIssues,
  type InventoryIssueRow,
} from "@figbloom/shared";
import { s, t } from "../theme";

/**
 * What a learner has been issued from the school's inventory, read-only:
 * out first with anything overdue on top, then what has been handed back.
 * Used by the learner (whose = "you") and by their parent (whose = a first name).
 */
export function IssuedItemsView({ studentId, whose, tint }: { studentId: string; whose: string; tint: string }) {
  const [rows, setRows] = useState<InventoryIssueRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    fetchLearnerInventory([studentId])
      .then((r) => { if (alive) setRows(r); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load issued items."); });
    return () => { alive = false; };
  }, [studentId]);

  if (error) return <Text style={[s.small, { color: t.status.warnInk }]}>Could not load issued items: {error}</Text>;
  if (!rows) return <ActivityIndicator color={tint} style={{ marginTop: 24 }} />;

  const sorted = sortIssues(rows);
  const out = sorted.filter((r) => r.status === "out");
  const overdue = out.filter((r) => isOverdue(r));
  const yourself = whose === "you";
  const issuedOn = (iso: string) => formatShortDate(iso.slice(0, 10));

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.row, { gap: 10, alignItems: "stretch" }]}>
        <View style={[s.card, { flex: 1, padding: 14 }]}>
          <Text style={s.eyebrow}>WITH {yourself ? "YOU" : whose.toUpperCase()}</Text>
          <Text style={{ fontSize: 24, fontWeight: "600", marginTop: 4 }}>{out.reduce((a, r) => a + r.quantity, 0).toLocaleString()}</Text>
          <Text style={s.faint}>items out now</Text>
        </View>
        <View style={[s.card, { flex: 1, padding: 14 }]}>
          <Text style={s.eyebrow}>OVERDUE</Text>
          <Text style={{ fontSize: 24, fontWeight: "600", marginTop: 4, color: overdue.length ? t.status.warnInk : t.appSurface.ink }}>{overdue.length.toLocaleString()}</Text>
          <Text style={s.faint}>past their return date</Text>
        </View>
      </View>

      {sorted.length === 0 ? (
        <View style={[s.card, { alignItems: "center", padding: 24 }]}>
          <Text style={{ fontSize: 15, fontWeight: "600" }}>Nothing issued</Text>
          <Text style={[s.small, { marginTop: 6, textAlign: "center" }]}>
            {yourself
              ? "Textbooks, equipment and anything else the school hands you will be listed here."
              : `Textbooks and anything else the school hands ${whose} will be listed here, with when it's due back.`}
          </Text>
        </View>
      ) : sorted.map((r) => {
        const late = r.status === "out" ? daysOverdue(r) : 0;
        const tone = r.status === "out" ? { bg: t.status.infoBg, ink: t.status.infoInk } : r.status === "returned" ? { bg: t.status.okBg, ink: t.status.okInk } : { bg: t.status.warnBg, ink: t.status.warnInk };
        return (
          <View key={r.id} style={[s.card, { padding: 14 }]}>
            <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start" }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "600" }}>{r.itemName}{r.quantity > 1 ? ` × ${r.quantity}` : ""}</Text>
                {!!r.assetTag && <Text style={[s.mono, { color: t.appSurface.inkFaint, marginTop: 2 }]}>{r.assetTag}</Text>}
              </View>
              <View style={[s.pill, { backgroundColor: tone.bg, marginLeft: 8 }]}>
                <Text style={[s.pillLabel, { color: tone.ink }]}>
                  {ISSUE_STATUS_LABEL[r.status]}{r.returned_condition && r.status !== "lost" ? ` · ${ITEM_CONDITION_LABEL[r.returned_condition].toLowerCase()}` : ""}
                </Text>
              </View>
            </View>
            <View style={[s.row, { justifyContent: "space-between", marginTop: 8 }]}>
              <Text style={s.small}>Issued {issuedOn(r.issued_at)}</Text>
              {r.status === "out" ? (
                late > 0
                  ? <Text style={{ fontSize: 12.5, fontWeight: "700", color: t.status.warnInk }}>{late} day{late === 1 ? "" : "s"} overdue</Text>
                  : <Text style={s.small}>Due back {r.due_on ? formatShortDate(r.due_on) : "(no date)"}</Text>
              ) : (
                <Text style={s.small}>{r.closed_at ? `Back ${issuedOn(r.closed_at)}` : ""}</Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}
