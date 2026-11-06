/**
 * Test support: the KCSE and CBC (8 level) tables typed out BY HAND, one band per grade, never read from the code under test.
 * Where each table comes from, and how far it can be trusted, is written at the top of gradeTables.test.ts.
 */
export type Band = [grade: string, points: number, lo: number, hi: number];

export const KCSE: Band[] = [
  ["A", 12, 80, 100], ["A-", 11, 75, 79], ["B+", 10, 70, 74], ["B", 9, 65, 69], ["B-", 8, 60, 64], ["C+", 7, 55, 59],
  ["C", 6, 50, 54], ["C-", 5, 45, 49], ["D+", 4, 40, 44], ["D", 3, 35, 39], ["D-", 2, 30, 34], ["E", 1, 0, 29],
];

export const CBC: Band[] = [
  ["EE1", 8, 90, 100], ["EE2", 7, 75, 89], ["ME1", 6, 58, 74], ["ME2", 5, 41, 57],
  ["AE1", 4, 31, 40], ["AE2", 3, 21, 30], ["BE1", 2, 11, 20], ["BE2", 1, 1, 10],
];

/** The band a whole mark falls in, or undefined when the table has no band for it (CBC has none for 0). */
export const expected = (table: Band[], mark: number) => table.find(([, , lo, hi]) => mark >= lo && mark <= hi);
