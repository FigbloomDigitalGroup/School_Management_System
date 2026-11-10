import { useState } from "react";
import { Text, View } from "react-native";
import { assignCoverage, formatShortDate, type CoverageItem } from "@figbloom/shared";
import { PillPicker } from "../../components/PillPicker";
import type { StaffSession } from "../../lib/staffSession";
import { fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

const keyFor = (item: Pick<CoverageItem, "date" | "classId" | "time">) => `${item.date}|${item.classId}|${item.time}`;

/**
 * "Needs cover this week": each period whose teacher is on approved leave, with who else can take it (never someone out
 * that day, or teaching or covering another class then). The principal picks a substitute or marks the period free, and
 * can change an earlier choice. Assigning tells the substitute in the app, and the one who had it before if it moves.
 * Nothing at all when no period needs cover, as on the web Dashboard.
 */
export function CoverageSection({ session, items, onChanged }: { session: StaffSession; items: readonly CoverageItem[]; onChanged: () => void }) {
  const { t, s } = useTheme();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (items.length === 0) return null;
  const unresolved = items.filter((c) => !c.assignment).length;

  async function assign(item: CoverageItem, coveringTeacherId: string | null) {
    const key = keyFor(item);
    setSavingKey(key);
    setErrors((e) => { const next = { ...e }; delete next[key]; return next; });
    try {
      await assignCoverage({ tenantId: session.tenantId, assignedBy: session.profileId, item, coveringTeacherId });
      setEditing((set) => { const next = new Set(set); next.delete(key); return next; });
      setPicked((p) => { const next = { ...p }; delete next[key]; return next; });
      onChanged();
    } catch (err) {
      setErrors((e) => ({ ...e, [key]: err instanceof Error ? err.message : "Could not save." }));
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <View style={[s.banner, { flexDirection: "column", gap: 10, marginTop: 14 }]}>
      <Text style={{ fontSize: fontSize.lead, fontWeight: "600", color: t.brand.orangeInk }}>Needs cover this week · {unresolved}</Text>
      {items.map((c) => {
        const key = keyFor(c);
        const saving = savingKey === key;
        const changing = editing.has(key) || !c.assignment;
        return (
          <View key={key} style={{ backgroundColor: t.appSurface.card, borderRadius: t.radius.lg, padding: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ flex: 1, fontSize: fontSize.small, fontWeight: "700", color: t.brand.orangeInk }}>{c.subjectName} · {c.className}</Text>
              <Text style={[s.mono, { color: t.brand.orangeInk }]}>{c.weekday} {c.time}</Text>
            </View>
            <Text style={[s.small, { marginTop: 2, color: t.brand.orangeInk }]}>{c.absentTeacherName} is on approved leave {formatShortDate(c.date)}.</Text>

            {!changing && c.assignment ? (
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
                <Text style={{ flex: 1, fontSize: fontSize.small, fontWeight: "600", color: t.status.okInk }}>
                  {c.assignment.coveringTeacherId ? `Covered by ${c.assignment.coveringTeacherName}` : "Marked as a free period"}
                </Text>
                <Tap accessibilityLabel={`Change cover for ${c.subjectName}, ${c.className}`} onPress={() => setEditing((set) => new Set(set).add(key))} style={{ minHeight: 40, justifyContent: "center", paddingHorizontal: 8 }}>
                  <Text style={{ fontSize: fontSize.small, fontWeight: "700", color: t.brand.orangeInk }}>Change</Text>
                </Tap>
              </View>
            ) : (
              <View style={{ marginTop: 8 }}>
                {c.substitutes.length > 0 ? (
                  <PillPicker
                    items={c.substitutes}
                    selectedId={picked[key] ?? null}
                    onPick={(id) => setPicked((p) => ({ ...p, [key]: id }))}
                    accent={session.accent}
                  />
                ) : (
                  <Text style={[s.small, { color: t.brand.orangeInk }]}>Nobody else on file teaches this.</Text>
                )}
                <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
                  <Button
                    label="Assign"
                    loading={saving}
                    disabled={!picked[key] || savingKey !== null}
                    onPress={() => void assign(c, picked[key]!)}
                    accessibilityHint="Tells them in the app"
                    style={{ flex: 1 }}
                  />
                  <Button variant="secondary" label="Mark free period" disabled={savingKey !== null} onPress={() => void assign(c, null)} style={{ flex: 1 }} />
                </View>
                {!!errors[key] && <Text accessibilityRole="alert" style={[s.small, { marginTop: 6, color: t.status.badText }]}>Could not save: {errors[key]}</Text>}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
