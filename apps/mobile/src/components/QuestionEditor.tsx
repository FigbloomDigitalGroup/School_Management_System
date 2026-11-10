import { Alert, Text, View } from "react-native";
import {
  QUESTION_KIND_LABEL, addOption, blankQuestion, canAddOption, canRemoveOption, changeQuestionKind, moveQuestion, removeOption, totalPoints,
  type QuestionKind, type ReviewQuestion,
} from "@figbloom/shared";
import { accentFor } from "../theme";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";
import { PillPicker } from "./PillPicker";

const KINDS = (Object.keys(QUESTION_KIND_LABEL) as QuestionKind[]).map((k) => ({ id: k, name: QUESTION_KIND_LABEL[k] }));
const letter = (k: number) => String.fromCharCode(65 + k);

/**
 * The questions of an online paper, as the website's builder has them: a type, the marks, the question,
 * and either the options with the correct one marked (multiple choice) or a model answer only staff see
 * (short and long answers). Questions can be moved and removed. A question Bloom was not sure of when it
 * imported a paper carries notes saying what to check, and a "Looks right" button that clears them once the
 * teacher has compared it with the paper. `locked` is a paper learners have already started: it shows the
 * questions and changes nothing. The list is the screen's to keep; every change goes out through `onChange`.
 */
export function QuestionEditor({ questions, onChange, locked, accent }: {
  questions: ReviewQuestion[];
  onChange: (questions: ReviewQuestion[]) => void;
  locked: boolean;
  accent: string;
}) {
  const { t, s, fieldLine, accentInk } = useTheme();
  const a = accentFor(accent);
  // A marks box someone has just emptied is NaN until they type a number: it counts as nothing, not as "NaN marks".
  const marks = totalPoints(questions.map((q) => ({ points: Number.isNaN(q.points) ? 0 : q.points })));
  const change = (i: number, next: (q: ReviewQuestion) => ReviewQuestion) => onChange(questions.map((q, j) => (j === i ? next(q) : q)));

  function remove(i: number) {
    const go = () => onChange(questions.filter((_, j) => j !== i));
    // An empty question is taken away at once; one with something typed in it is asked about first.
    if (!questions[i]!.prompt.trim()) { go(); return; }
    Alert.alert(`Remove question ${i + 1}?`, "Its text, options and marks are removed from this paper.", [
      { text: "Keep it", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: go },
    ]);
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={[s.small, { fontWeight: "600", color: t.appSurface.ink }]}>Questions</Text>
        <Text style={s.faint}>{marks} marks in total</Text>
      </View>
      {questions.length === 0 && <Text style={s.faint}>No questions yet. Add the first one below.</Text>}

      {questions.map((q, i) => (
        <View key={i} style={{ gap: 10, padding: 12, borderRadius: t.radius.lg, borderWidth: q.check?.length ? 2 : 1, borderColor: q.check?.length ? t.status.warnInk : fieldLine, backgroundColor: t.appSurface.card }}>
          <View style={[s.row, { justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }]}>
            <Text style={[s.eyebrow, { color: t.appSurface.ink }]}>QUESTION {i + 1}</Text>
            {!locked && (
              <View style={[s.row, { flexWrap: "wrap" }]}>
                <Button variant="quiet" tint={a.deep} label="Move up" disabled={i === 0} onPress={() => onChange(moveQuestion(questions, i, -1))} style={{ paddingHorizontal: 8 }} />
                <Button variant="quiet" tint={a.deep} label="Move down" disabled={i === questions.length - 1} onPress={() => onChange(moveQuestion(questions, i, 1))} style={{ paddingHorizontal: 8 }} />
                <Button variant="quiet" tint={t.status.warnInk} label="Remove" onPress={() => remove(i)} style={{ paddingHorizontal: 8 }} />
              </View>
            )}
          </View>

          {locked ? (
            <Text style={s.small}>{QUESTION_KIND_LABEL[q.kind]}</Text>
          ) : (
            <PillPicker items={KINDS} selectedId={q.kind} onPick={(k) => change(i, (x) => changeQuestionKind(x, k as QuestionKind))} accent={accent} />
          )}

          <Field
            label="Marks"
            value={Number.isNaN(q.points) ? "" : String(q.points)}
            onChangeText={(v) => change(i, (x) => ({ ...x, points: v.replace(/\D/g, "") === "" ? Number.NaN : Number(v.replace(/\D/g, "")) }))}
            keyboardType="number-pad"
            editable={!locked}
            style={{ width: 120 }}
          />
          <Field
            label={`Question ${i + 1}`}
            value={q.prompt}
            onChangeText={(v) => change(i, (x) => ({ ...x, prompt: v }))}
            placeholder="Write the question"
            multiline
            editable={!locked}
          />

          {q.check?.length ? (
            <View style={{ gap: 4, padding: 10, borderRadius: t.radius.lg, backgroundColor: t.status.warnBg }}>
              <Text style={{ fontSize: 12.5, fontWeight: "600", color: t.status.warnInk }}>Check this against the paper</Text>
              {q.check.map((note, k) => (
                <Text key={k} style={{ fontSize: 12.5, lineHeight: 18, color: t.status.warnInk }}>• {note}</Text>
              ))}
              {!locked && (
                <Button
                  variant="quiet"
                  tint={t.status.warnInk}
                  label="Looks right"
                  accessibilityHint={`Question ${i + 1}`}
                  onPress={() => change(i, (x) => ({ ...x, check: undefined }))}
                  style={{ alignSelf: "flex-start", paddingHorizontal: 8 }}
                />
              )}
            </View>
          ) : null}

          {q.kind === "choice" ? (
            <View style={{ gap: 6 }}>
              {q.options.map((option, k) => {
                const correct = q.correctOption === k;
                return (
                  <View key={k} style={[s.row, { alignItems: "flex-start", gap: 4 }]}>
                    <Tap
                      accessibilityRole="radio"
                      accessibilityLabel={`Option ${letter(k)} is correct`}
                      accessibilityState={{ checked: correct, disabled: locked }}
                      disabled={locked}
                      onPress={() => change(i, (x) => ({ ...x, correctOption: k }))}
                      style={{ minWidth: 44, minHeight: 44, marginTop: 18, alignItems: "center", justifyContent: "center" }}
                    >
                      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: correct ? accentInk(a.deep) : fieldLine, alignItems: "center", justifyContent: "center" }}>
                        {correct && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: accentInk(a.deep) }} />}
                      </View>
                    </Tap>
                    <Field
                      style={{ flex: 1 }}
                      label={`Option ${letter(k)}`}
                      value={option}
                      onChangeText={(v) => change(i, (x) => ({ ...x, options: x.options.map((o, j) => (j === k ? v : o)) }))}
                      editable={!locked}
                    />
                    {!locked && canRemoveOption(q) && (
                      <Tap
                        accessibilityRole="button"
                        accessibilityLabel={`Remove option ${letter(k)}`}
                        onPress={() => change(i, (x) => removeOption(x, k))}
                        style={{ minWidth: 44, minHeight: 44, marginTop: 18, alignItems: "center", justifyContent: "center" }}
                      >
                        <Text style={{ fontSize: 16, color: t.appSurface.inkFaint }}>✕</Text>
                      </Tap>
                    )}
                  </View>
                );
              })}
              <Text style={s.faint}>Tap the circle beside the correct option.</Text>
              {!locked && canAddOption(q) && (
                <Button variant="quiet" tint={a.deep} label="Add an option" onPress={() => change(i, addOption)} style={{ alignSelf: "flex-start", paddingHorizontal: 8 }} />
              )}
            </View>
          ) : (
            <Field
              label="Model answer (optional)"
              hint="Only staff see this."
              value={q.modelAnswer}
              onChangeText={(v) => change(i, (x) => ({ ...x, modelAnswer: v }))}
              multiline
              editable={!locked}
            />
          )}
        </View>
      ))}

      {!locked && (
        <View style={{ gap: 8 }}>
          {KINDS.map((k) => (
            <Button key={k.id} variant="secondary" label={`Add ${k.name.toLowerCase()}`} onPress={() => onChange([...questions, blankQuestion(k.id)])} />
          ))}
        </View>
      )}
    </View>
  );
}
