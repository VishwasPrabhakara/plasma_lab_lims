// Minimal store-only ZIP writer. No deflate — fine for already-compressed
// images (JPEG/PNG) and small JSON manifests, which is all the archive
// bundle contains. Returns a Uint8Array ready to send as the response body.
//
// Store-only (compression method 0) + CRC-32 + ZIP64 off, 32-bit limits only.
// Bundles over ~4 GB would overflow; that's not a concern for this lab.

export async function buildZip(entries) {
  const enc = new TextEncoder();
  const files = [];
  let offset = 0;
  const chunks = [];

  function crc32(buf) {
    let c;
    const table = crc32.table || (crc32.table = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
      }
      return t;
    })());
    c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
    return (c ^ 0xffffffff) >>> 0;
  }
  function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
  function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }

  for (const { name, data } of entries) {
    const nameBuf = enc.encode(name);
    const crc = crc32(data);
    const size = data.length;
    const localHeader = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0,
      0, 0, 0, 0,
      ...u32(crc),
      ...u32(size), ...u32(size),
      ...u16(nameBuf.length), 0, 0,
    ]);
    chunks.push(localHeader, nameBuf, data);
    files.push({ name: nameBuf, crc, size, offset });
    offset += localHeader.length + nameBuf.length + size;
  }

  const centralStart = offset;
  for (const f of files) {
    const central = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0,
      0, 0, 0, 0,
      ...u32(f.crc),
      ...u32(f.size), ...u32(f.size),
      ...u16(f.name.length), 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0,
      ...u32(f.offset),
    ]);
    chunks.push(central, f.name);
    offset += central.length + f.name.length;
  }

  const centralSize = offset - centralStart;
  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0,
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(centralStart),
    0, 0,
  ]);
  chunks.push(eocd);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
