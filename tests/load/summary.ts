/** Peak and mean CPU per container, and Postgres activity, from the files run.sh sampled. Usage: tsx summary.ts <scenario> */
import { readFileSync } from "node:fs";

const scen = process.argv[2];
const dir = "test-results/load";
const lines = (file: string) => readFileSync(`${dir}/${file}`, "utf8").split(/\r?\n/).filter(Boolean).map((l) => l.split(","));

const byContainer: Record<string, number[]> = {};
for (const [, name, cpu] of lines(`samples_${scen}.csv`)) {
  const v = parseFloat(cpu ?? "");
  if (name && !Number.isNaN(v)) (byContainer[name] ??= []).push(v);
}
console.log("CPU, % of one core (sampled every few seconds):");
for (const [name, v] of Object.entries(byContainer)) {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  console.log(`  ${name.padEnd(26)} peak ${Math.max(...v).toFixed(0).padStart(5)}%   mean ${mean.toFixed(0).padStart(5)}%   (${v.length} samples)`);
}
const pg = lines(`pg_${scen}.csv`);
const col = (i: number) => Math.max(0, ...pg.map((r) => Number(r[i])).filter((n) => !Number.isNaN(n)));
console.log(`Postgres: active queries peak ${col(1)}, waiting on a lock peak ${col(2)}, connections peak ${col(4)} (${pg.length} samples)`);
