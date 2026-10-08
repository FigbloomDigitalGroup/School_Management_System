/**
 * Drives all three Kijani Ridge buses at once from one terminal:
 *
 *   npm run db:simulate-kijani
 *
 * The primary bus (Amani) leaves now, the junior school bus (Zawadi) follows on
 * the same road 5 minutes later, and the Lang'ata bus (Baraka) runs alongside.
 * Each bus is its own simulate-trip.ts process; output is prefixed by plate.
 * Ctrl+C stops them all after their current leg, the same as stopping one.
 */

import { spawn } from "node:child_process";

const BUSES = [
  { plate: "KDK 482M", label: "primary   ", delayMin: 0 },
  { plate: "KDN 640P", label: "junior    ", delayMin: Number(process.env.JUNIOR_DELAY_MIN ?? 5) },
  { plate: "KDM 917T", label: "lang'ata  ", delayMin: 0 },
];

let running = BUSES.length;
for (const bus of BUSES) {
  const child = spawn("npx tsx --env-file=.env supabase/simulate-trip.ts", {
    shell: true,
    env: { ...process.env, SCHOOL: "kijani-ridge", PLATE: bus.plate, START_DELAY_MIN: String(bus.delayMin) },
  });
  const prefix = `[${bus.label}${bus.plate}] `;
  const relay = (out: NodeJS.WriteStream) => (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) out.write(prefix + line + "\n");
  };
  child.stdout.on("data", relay(process.stdout));
  child.stderr.on("data", relay(process.stderr));
  child.on("exit", (code) => {
    console.log(`${prefix}stopped${code ? ` (exit ${code})` : ""}`);
    if (--running === 0) process.exit(0);
  });
}

// Ctrl+C reaches every process in the terminal; stay alive until the buses finish their legs
process.on("SIGINT", () => console.log("\nStopping all buses after their current leg (Ctrl+C again to quit immediately)…"));
