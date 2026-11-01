import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Package } from "lucide-react-native";
import {
  daysOverdue, fetchLearnerInventory, fetchMyInventory, formatShortDate, isOverdue, ISSUE_STATUS_LABEL, ITEM_CONDITION_LABEL, sortIssues,
  type InventoryIssueRow, type IssueHolder,
} from "@figbloom/shared";
import { EmptyState, ErrorState } from "../ui/StateView";
import { useTheme } from "../ui/ThemeContext";

/**
 * What a learner or a member of staff has been issued from the school's
 * inventory, read-only: out first with anything overdue on top, then what has
 * been handed back. Used by the learner (whose = "you"), by their parent
 * (whose = a first name) and by a teacher (holder = their own profile).
 * The same file is in both phone apps; change both.
 */
export function IssuedItemsView({ holder, whose, tint }: { holder: IssueHolder; whose: string; tint: string }) {
  const { t, s, accentInk } = useTheme();
  const [rows, setRows] = useState<InventoryIssueRow[] | null>(null);
  /** The load failed: not the same as "nothing issued", and it can be retried. */
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // `holder` is a new object on every render of the caller; what identifies it is its kind and id.
  const kind = holder.kind;
  const id = holder.kind === "learner" ? holder.studentId : holder.profileId;

  useEffect(() => {
    let alive = true;
    setRows(null);
    setFailed(false);
    (kind === "learner" ? fetchLearnerInventory([id]) : fetchMyInventory(id))
      .then((r) => { if (alive) setRows(r); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [kind, id, reloadKey]);

  if (failed) return <ErrorState title="Couldn't load issued items" onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!rows) return <ActivityIndicator color={accentInk(tint)} style={{ marginTop: 24 }} />;

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
          <Text style={{ color: t.appSurface.ink, fontSize: 24, fontWeight: "600", marginTop: 4 }}>{out.reduce((a, r) => a + r.quantity, 0).toLocaleString()}</Text>
          <Text style={s.faint}>items out now</Text>
        </View>
        <View style={[s.card, { flex: 1, padding: 14 }]}>
          <Text style={s.eyebrow}>OVERDUE</Text>
          <Text style={{ fontSize: 24, fontWeight: "600", marginTop: 4, color: overdue.length ? t.status.warnInk : t.appSurface.ink }}>{overdue.length.toLocaleString()}</Text>
          <Text style={s.faint}>past their return date</Text>
        </View>
      </View>

      {sorted.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Nothing issued"
          body={
            holder.kind === "staff"
              ? "A laptop, lab keys or a class set the school issues you will be listed here, with when it's due back."
              : yourself
                ? "Textbooks, equipment and anything else the school hands you will be listed here."
                : `Textbooks and anything else the school hands ${whose} will be listed here, with when it's due back.`
          }
        />
      ) : sorted.map((r) => {
        const late = r.status === "out" ? daysOverdue(r) : 0;
        const tone = r.status === "out" ? { bg: t.status.infoBg, ink: t.status.infoInk } : r.status === "returned" ? { bg: t.status.okBg, ink: t.status.okInk } : { bg: t.status.warnBg, ink: t.status.warnInk };
        return (
          <View key={r.id} style={[s.card, { padding: 14 }]}>
            <View style={[s.row, { justifyContent: "space-between", alignItems: "flex-start" }]}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: t.appSurface.ink, fontSize: 14.5, fontWeight: "600" }}>{r.itemName}{r.quantity > 1 ? ` × ${r.quantity}` : ""}</Text>
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
