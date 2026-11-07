export type HrTone = "ok" | "warn" | "muted";

/** The colour of a status in Figbloom HR's own words (an application, a step of its approval): done, waiting, or neither. */
export function hrStatusTone(status: string): HrTone {
  const word = status.toLowerCase();
  if (word === "approved" || word === "done" || word === "completed") return "ok";
  if (word === "pending" || word === "current" || word === "waiting") return "warn";
  return "muted";
}
