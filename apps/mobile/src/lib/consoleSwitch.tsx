import { createContext, useContext } from "react";

/** Which of a person's two consoles is on screen: their own (the teacher's) or the school's admin console. */
export type Console = "own" | "admin";

interface ConsoleSwitchValue {
  current: Console;
  /** A teacher who holds admin areas has both; everyone else has the one console they were given. */
  canSwitch: boolean;
  switchTo: (to: Console) => void;
}

const Ctx = createContext<ConsoleSwitchValue>({ current: "own", canSwitch: false, switchTo: () => {} });

/** Provided by App.tsx, which decides what is on screen. Without a provider (a screen under test) nothing can switch. */
export const ConsoleSwitchProvider = Ctx.Provider;

export const useConsoleSwitch = (): ConsoleSwitchValue => useContext(Ctx);
