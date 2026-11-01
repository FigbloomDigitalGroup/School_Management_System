import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * One listener for the whole app, not one per button: a screen can hold a few
 * hundred tappable rows. Android reports "reduce motion" when the person has
 * turned animations off (Settings > Accessibility > Remove animations).
 */
let reduced = false;
let started = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === reduced) return;
  reduced = next;
  listeners.forEach((l) => l());
}

function start() {
  if (started) return;
  started = true;
  AccessibilityInfo.isReduceMotionEnabled().then(set).catch(() => {});
  AccessibilityInfo.addEventListener("reduceMotionChanged", set);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True when the person has asked the phone to cut animation; skip or shorten motion when it is. */
export function useReducedMotion(): boolean {
  start();
  return useSyncExternalStore(subscribe, () => reduced, () => false);
}
