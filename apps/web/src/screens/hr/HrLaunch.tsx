import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { EdgeError, hrLaunchProblem, isHttpsLink, readHrLaunchParams, requestHrLink, supabase, type HrLaunchProblem } from "@figbloom/shared";
import { HrLaunchView } from "./HrLaunchView";
import "./hrLaunch.css";

const STILL_WORKING_MS = 8_000;
/** Outfit 300, as Figbloom HR loads it (Google Fonts, already allowed for the app's own fonts); system-ui until it's in. */
const OUTFIT = "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400&display=swap";

/**
 * The new tab Figbloom HR opens in (/hr/launch?school=<id>&slug=<slug>, opened by the HR & Payroll sidebar item and
 * card): no console around it. It asks open-hr for a one-time sign-in link itself (same origin, so this tab has the
 * session) and replaces itself with it, https only. If that fails, it says why in plain words. The link holds a
 * one-time code: never shown or logged.
 */
export function HrLaunch() {
  const { search } = useLocation();
  const params = useMemo(() => readHrLaunchParams(search), [search]);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{ attempt: number; problem: HrLaunchProblem } | null>(null);
  const [slowAttempt, setSlowAttempt] = useState<number | null>(null);
  const [cantClose, setCantClose] = useState(false);
  const started = useRef(-1);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (document.querySelector(`link[href="${OUTFIT}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = OUTFIT;
    document.head.appendChild(link);
  }, []);

  useEffect(() => {
    if (!params || started.current === attempt) return;
    // once per attempt (React runs effects twice in development)
    started.current = attempt;
    const slow = window.setTimeout(() => setSlowAttempt(attempt), STILL_WORKING_MS);
    (async () => {
      const { data } = await supabase().auth.getSession();
      if (!data.session) throw new EdgeError("Sign in first.", 401, false, "unauthorized");
      const { url } = await requestHrLink(params.tenantId);
      if (!isHttpsLink(url)) throw new Error("The sign-in link isn't an https address.");
      window.location.replace(url);
    })().catch((err: unknown) => {
      window.clearTimeout(slow);
      setFailure({ attempt, problem: hrLaunchProblem(err instanceof EdgeError ? err : null) });
    });
  }, [params, attempt]);

  const problem: HrLaunchProblem | null = !params ? "unreachable" : failure?.attempt === attempt ? failure.problem : null;

  useEffect(() => {
    if (problem) titleRef.current?.focus();
  }, [problem]);

  function closeTab() {
    window.close();
    // only a tab opened by a script can close itself
    window.setTimeout(() => { if (!window.closed) setCantClose(true); }, 300);
  }

  return (
    <HrLaunchView
      problem={problem}
      stillWorking={slowAttempt === attempt}
      slug={params?.slug ?? null}
      cantClose={cantClose}
      onRetry={() => setAttempt((n) => n + 1)}
      onClose={closeTab}
      titleRef={titleRef}
    />
  );
}
