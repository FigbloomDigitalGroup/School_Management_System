import { leftEarlyText, type EarlySignOut } from "@figbloom/shared";

/** "Left early at 10:45, collected by Jane Doe (Mother)". The collector's ID number and phone are never shown on a phone. */
export function leftEarlyLine(s: Pick<EarlySignOut, "signed_out_local" | "collected_by_name" | "collected_by_relationship">): string {
  const text = leftEarlyText(s);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}, collected by ${s.collected_by_name} (${s.collected_by_relationship})`;
}
