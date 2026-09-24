import { useSearchParams } from "react-router-dom";
import { fetchTeacherClasses, rubricFor } from "@figbloom/shared";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { CbeGradebook } from "./CbeGradebook";
import { Gradebook } from "./Gradebook";

type Mode = "cbe" | "exam";

/**
 * A K-12 teacher's gradebook: strand assessment for classes on the CBE
 * rubric, exam marks for everything (8-4-4 Form classes only have marks;
 * CBE classes can still sit numeric exams). The tabs only appear once the
 * teacher has a CBE class — an all-8-4-4 teacher sees the marks gradebook
 * exactly as before. The choice lives in ?mode= so links and refresh keep it.
 */
export function K12Gradebook() {
  const { profile, tenant } = useTenantSession();
  const [params, setParams] = useSearchParams();
  const { data: classes } = useAsync(() => fetchTeacherClasses(profile.id), [profile.id]);
  const hasCbe = (classes ?? []).some((c) => rubricFor(tenant.country, c.level));
  const hasMarksOnly = (classes ?? []).some((c) => !rubricFor(tenant.country, c.level));
  const requested = params.get("mode");
  const mode: Mode = requested === "cbe" || requested === "exam" ? requested : hasCbe && !hasMarksOnly ? "cbe" : "exam";

  if (!hasCbe) return <Gradebook />;

  function pick(next: Mode) {
    const p = new URLSearchParams(params);
    p.set("mode", next);
    p.delete("class");
    setParams(p, { replace: true });
  }

  return (
    <>
      <div role="tablist" aria-label="Gradebook" className="flex gap-1 border-b border-line bg-white px-7 pt-3">
        {([["cbe", "Strand assessment (CBE)"], ["exam", "Exam marks"]] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => pick(m)}
            className="-mb-px border-b-2 px-3 pb-2 text-[13px]"
            style={mode === m ? { borderColor: "var(--accent)", fontWeight: 600 } : { borderColor: "transparent", color: "#5F6B62" }}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "cbe" ? <CbeGradebook /> : <Gradebook />}
    </>
  );
}
