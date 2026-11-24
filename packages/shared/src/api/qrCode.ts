/**
 * Minimal ISO/IEC 18004 QR Code encoder (Byte mode, ECC level L, versions 1–9, up to 230 UTF-8 bytes).
 * Zero dependencies and DOM-free so both web (SVG) and mobile can render TOTP enrolment QR codes (FIG-1890).
 */

interface VersionSpec {
  version: number;
  size: number;
  dataBytes: number;
  blocks: number;
  dataPerBlock: number;
  eccPerBlock: number;
  alignment: readonly number[];
}

// ISO/IEC 18004 Table 7 & Table 9 (Error Correction Level L, versions 1–9).
const VERSIONS: readonly VersionSpec[] = [
  { version: 1, size: 21, dataBytes: 17, blocks: 1, dataPerBlock: 19, eccPerBlock: 7, alignment: [] },
  { version: 2, size: 25, dataBytes: 32, blocks: 1, dataPerBlock: 34, eccPerBlock: 10, alignment: [6, 18] },
  { version: 3, size: 29, dataBytes: 53, blocks: 1, dataPerBlock: 55, eccPerBlock: 15, alignment: [6, 22] },
  { version: 4, size: 33, dataBytes: 78, blocks: 1, dataPerBlock: 80, eccPerBlock: 20, alignment: [6, 26] },
  { version: 5, size: 37, dataBytes: 106, blocks: 1, dataPerBlock: 108, eccPerBlock: 26, alignment: [6, 30] },
  { version: 6, size: 41, dataBytes: 134, blocks: 2, dataPerBlock: 68, eccPerBlock: 18, alignment: [6, 34] },
  { version: 7, size: 45, dataBytes: 154, blocks: 2, dataPerBlock: 78, eccPerBlock: 20, alignment: [6, 22, 38] },
  { version: 8, size: 49, dataBytes: 192, blocks: 2, dataPerBlock: 97, eccPerBlock: 24, alignment: [6, 24, 42] },
  { version: 9, size: 53, dataBytes: 230, blocks: 2, dataPerBlock: 116, eccPerBlock: 30, alignment: [6, 26, 46] },
];

// GF(256) with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i]!;
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] ?? 0) ^ poly[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(poly[j]!, factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, eccLen: number): Uint8Array {
  const gen = rsGenerator(eccLen);
  const rem = new Uint8Array(eccLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i]! ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[eccLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < eccLen; j++) {
        rem[j] = rem[j]! ^ gfMul(gen[j + 1]!, factor);
      }
    }
  }
  return rem;
}

function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(++i);
      const cp = 0x10000 + (((c - 0xd800) << 10) | (low - 0xdc00));
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/** 15-bit BCH format info for ECC Level L (01) and mask 0..7. */
export function formatInfoBits(mask: number): number {
  const data = (0b01 << 3) | (mask & 7);
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit Golay BCH version info for versions 7–40. */
export function versionInfoBits(version: number): number {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) {
    if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
  }
  return (version << 12) | rem;
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function penaltyScore(grid: boolean[][]): number {
  const n = grid.length;
  let score = 0;
  let dark = 0;

  // Rule 1: runs of 5+ same-color modules in rows and columns.
  for (let r = 0; r < n; r++) {
    let runRow = 1;
    let runCol = 1;
    for (let c = 0; c < n; c++) {
      if (grid[r]![c]) dark++;
      if (c > 0) {
        if (grid[r]![c] === grid[r]![c - 1]) runRow++;
        else { if (runRow >= 5) score += 3 + (runRow - 5); runRow = 1; }
        if (grid[c]![r] === grid[c - 1]![r]) runCol++;
        else { if (runCol >= 5) score += 3 + (runCol - 5); runCol = 1; }
      }
    }
    if (runRow >= 5) score += 3 + (runRow - 5);
    if (runCol >= 5) score += 3 + (runCol - 5);
  }

  // Rule 2: 2x2 blocks of same color.
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r]![c];
      if (v === grid[r]![c + 1] && v === grid[r + 1]![c] && v === grid[r + 1]![c + 1]) score += 3;
    }
  }

  // Rule 4: dark/light balance.
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export interface QrMatrix {
  size: number;
  version: number;
  /** `modules[row][col]` is true for dark modules. */
  modules: boolean[][];
}

/** Encodes a short string (up to 230 UTF-8 bytes) as a standard QR code matrix (ECC Level L). */
export function encodeQrMatrix(text: string): QrMatrix {
  const payload = utf8Bytes(text);
  const spec = VERSIONS.find((v) => payload.length <= v.dataBytes);
  if (!spec) throw new Error(`QR payload too long (${payload.length} bytes; max 230).`);

  // 1. Build bit stream: 4-bit Byte mode (0100), 8-bit char count (v1–v9), payload, terminator, pad bytes.
  const totalData = spec.blocks * spec.dataPerBlock;
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(payload.length, 8);
  for (const b of payload) pushBits(b, 8);
  const capBits = totalData * 8;
  pushBits(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(totalData);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]!;
    data[i] = byte;
  }
  const padBytes = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < totalData; i++, p++) data[i] = padBytes[p % 2]!;

  // 2. Split into blocks, compute Reed-Solomon ECC, and interleave.
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  for (let b = 0; b < spec.blocks; b++) {
    const slice = data.subarray(b * spec.dataPerBlock, (b + 1) * spec.dataPerBlock);
    dataBlocks.push(slice);
    eccBlocks.push(rsRemainder(slice, spec.eccPerBlock));
  }
  const codewords: number[] = [];
  for (let i = 0; i < spec.dataPerBlock; i++) for (const blk of dataBlocks) codewords.push(blk[i]!);
  for (let i = 0; i < spec.eccPerBlock; i++) for (const blk of eccBlocks) codewords.push(blk[i]!);

  // 3. Place function patterns on an empty matrix.
  const n = spec.size;
  const fixed: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const base: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const setFixed = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < n && c >= 0 && c < n) { fixed[r]![c] = true; base[r]![c] = dark; }
  };

  // Finder patterns + separators (top-left, top-right, bottom-left).
  for (const [fr, fc] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inOuter && (
          dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
        );
        setFixed(fr + dr, fc + dc, dark);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < n - 8; i++) {
    setFixed(6, i, i % 2 === 0);
    setFixed(i, 6, i % 2 === 0);
  }

  // Alignment patterns (skipping centers that overlap finder patterns).
  for (const ar of spec.alignment) {
    for (const ac of spec.alignment) {
      if ((ar <= 8 && ac <= 8) || (ar <= 8 && ac >= n - 9) || (ar >= n - 9 && ac <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFixed(ar + dr, ac + dc, dist === 2 || dist === 0);
        }
      }
    }
  }

  // Dark module and reserve format-info areas.
  setFixed(n - 8, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (!fixed[8]![i]) setFixed(8, i, false);
    if (!fixed[i]![8]) setFixed(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setFixed(8, n - 1 - i, false);
    setFixed(n - 1 - i, 8, false);
  }

  // Version info for V >= 7.
  if (spec.version >= 7) {
    const vBits = versionInfoBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = n - 11 + (i % 3);
      setFixed(a, b, bit);
      setFixed(b, a, bit);
    }
  }

  // 4. Zigzag data placement.
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = n - 1; col >= 1; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (fixed[r]![c]) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          dark = ((codewords[bitIndex >> 3]! >> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        base[r]![c] = dark;
      }
    }
    upward = !upward;
  }

  // 5. Try all 8 masks and pick the lowest penalty.
  let bestGrid: boolean[][] = base;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = base.map((row, r) => row.map((v, c) => (fixed[r]![c] ? v : (maskBit(mask, r, c) ? !v : v))));
    const fmt = formatInfoBits(mask);
    // Top-left format strip.
    const tlCoords: [number, number][] = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    for (let i = 0; i < 15; i++) {
      const bit = ((fmt >> (14 - i)) & 1) === 1;
      const [r, c] = tlCoords[i]!;
      grid[r]![c] = bit;
    }
    // Bottom-left & top-right format strips.
    for (let i = 0; i < 7; i++) grid[n - 1 - i]![8] = ((fmt >> (14 - i)) & 1) === 1;
    for (let i = 0; i < 8; i++) grid[8]![n - 8 + i] = ((fmt >> (7 - i)) & 1) === 1;

    const p = penaltyScore(grid);
    if (p < bestPenalty) { bestPenalty = p; bestGrid = grid; }
  }

  return { size: n, version: spec.version, modules: bestGrid };
}
