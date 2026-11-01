/**
 * The smallest zip writer that office files need: entries stored as they are
 * (no compression), ASCII names, one fixed timestamp. Enough for an .xlsx of a
 * few tables (xlsx.ts), without shipping a zip library to the browser. Pure
 * and DOM-free; it builds bytes and never reads a zip.
 */

/** A string as UTF-8 bytes (TextEncoder isn't available everywhere this package runs). */
export function utf8(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // a lone surrogate can't be encoded; write U+FFFD as TextEncoder does
    const k = c >= 0xd800 && c <= 0xdfff ? 0xfffd : c;
    if (k < 0x80) out.push(k);
    else if (k < 0x800) out.push(0xc0 | (k >> 6), 0x80 | (k & 63));
    else if (k < 0x10000) out.push(0xe0 | (k >> 12), 0x80 | ((k >> 6) & 63), 0x80 | (k & 63));
    else out.push(0xf0 | (k >> 18), 0x80 | ((k >> 12) & 63), 0x80 | ((k >> 6) & 63), 0x80 | (k & 63));
  }
  return Uint8Array.from(out);
}

let table: Uint32Array | null = null;

/** CRC-32 (IEEE), as zip stores it. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** The date and time as MS-DOS stores them in a zip entry (local time, two-second steps, from 1980). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A zip of the files, in order, each stored uncompressed. Names must be ASCII. */
export function storedZip(files: { name: string; data: Uint8Array }[], when: Date): Uint8Array {
  const { time, date } = dosTime(when);
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    if (!/^[\x20-\x7e]+$/.test(f.name)) throw new Error(`A zip entry name must be ASCII: ${f.name}`);
    const name = utf8(f.name);
    const crc = crc32(f.data);
    const head = new Uint8Array(30 + name.length);
    const h = new DataView(head.buffer);
    h.setUint32(0, 0x04034b50, true); // local file header
    h.setUint16(4, 20, true); // version needed: 2.0
    h.setUint16(6, 0, true); // flags
    h.setUint16(8, 0, true); // method: stored
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, f.data.length, true);
    h.setUint32(22, f.data.length, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, 0, true);
    head.set(name, 30);
    local.push(head, f.data);

    const entry = new Uint8Array(46 + name.length);
    const e = new DataView(entry.buffer);
    e.setUint32(0, 0x02014b50, true); // central directory header
    e.setUint16(4, 20, true); // made by
    e.setUint16(6, 20, true); // needed
    e.setUint16(8, 0, true);
    e.setUint16(10, 0, true);
    e.setUint16(12, time, true);
    e.setUint16(14, date, true);
    e.setUint32(16, crc, true);
    e.setUint32(20, f.data.length, true);
    e.setUint32(24, f.data.length, true);
    e.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes: all 0
    e.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);
    offset += head.length + f.data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const z = new DataView(end.buffer);
  z.setUint32(0, 0x06054b50, true); // end of central directory
  z.setUint16(8, files.length, true);
  z.setUint16(10, files.length, true);
  z.setUint32(12, centralSize, true);
  z.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...local, ...central, end]) { out.set(part, at); at += part.length; }
  return out;
}
