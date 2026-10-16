'use strict';
// Minimal read-only zip reader (zero dependencies). Reads only the central directory
// and the entries asked for, so multi-GB exports full of images stay cheap to inspect.
// Supports stored + deflate entries and zip64.
const fs = require('fs');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

class ZipError extends Error {}

function readAt(fd, position, length) {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n === 0) throw new ZipError('unexpected end of file');
    done += n;
  }
  return buf;
}

function u64(buf, off) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('zip64 value too large');
  return Number(v);
}

function dosTimeToMs(time, date) {
  const d = new Date(
    1980 + (date >> 9), ((date >> 5) & 0xf) - 1, date & 0x1f,
    time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2,
  );
  return d.getTime();
}

function findEocd(fd, size) {
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = readAt(fd, size - tailLen, tailLen);
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) return { buf: tail.subarray(i), pos: size - tailLen + i };
  }
  throw new ZipError('not a zip file');
}

function readCentralDirectory(fd, size) {
  const { buf: eocd, pos: eocdPos } = findEocd(fd, size);
  let count = eocd.readUInt16LE(10);
  let cdSize = eocd.readUInt32LE(12);
  let cdOffset = eocd.readUInt32LE(16);

  if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    if (eocdPos < 20) throw new ZipError('missing zip64 locator');
    const loc = readAt(fd, eocdPos - 20, 20);
    if (loc.readUInt32LE(0) !== SIG_EOCD64_LOCATOR) throw new ZipError('missing zip64 locator');
    const rec = readAt(fd, u64(loc, 8), 56);
    if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('bad zip64 record');
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (cdOffset + cdSize > size) throw new ZipError('central directory out of range');

  const cd = readAt(fd, cdOffset, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('bad central directory');
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const mtime = dosTimeToMs(cd.readUInt16LE(p + 12), cd.readUInt16LE(p + 14));
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

    // zip64 extended information: present fields appear in this fixed order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === U32_MAX) { size = u64(cd, q); q += 8; }
        if (compressedSize === U32_MAX) { compressedSize = u64(cd, q); q += 8; }
        if (localOffset === U32_MAX) { localOffset = u64(cd, q); q += 8; }
      }
      e += 4 + len;
    }

    entries.push({
      name, method, crc, compressedSize, size, localOffset, mtime,
      encrypted: (flags & 1) === 1,
      isDirectory: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Lists entries without reading any file data. */
function listEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    return readCentralDirectory(fd, fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

function dataStartOf(fd, entry) {
  const local = readAt(fd, entry.localOffset, 30);
  if (local.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('bad local header');
  return entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
}

function checkMethod(entry) {
  if (entry.encrypted) throw new ZipError('encrypted entry');
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`unsupported compression method ${entry.method}`);
}

/**
 * Streams the uncompressed bytes of one entry (from listEntries) as Buffers.
 * Size and CRC are checked at the end; a mismatch throws ZipError after the last chunk.
 */
async function* entryChunks(zipPath, entry, { chunkSize = 1 << 20 } = {}) {
  checkMethod(entry);
  const fd = fs.openSync(zipPath, 'r');
  let dataStart;
  try {
    dataStart = dataStartOf(fd, entry);
  } finally {
    fs.closeSync(fd);
  }
  let crc = 0;
  let size = 0;
  if (entry.compressedSize > 0) {
    const raw = fs.createReadStream(zipPath, {
      start: dataStart, end: dataStart + entry.compressedSize - 1, highWaterMark: chunkSize,
    });
    let source = raw;
    if (entry.method === 8) {
      source = zlib.createInflateRaw({ chunkSize });
      raw.on('error', (e) => source.destroy(e));
      raw.pipe(source);
    }
    try {
      for await (const chunk of source) {
        crc = zlib.crc32(chunk, crc);
        size += chunk.length;
        yield chunk;
      }
    } finally {
      raw.destroy();
      source.destroy();
    }
  }
  if (size !== entry.size) throw new ZipError('size mismatch');
  if (crc !== entry.crc) throw new ZipError('crc mismatch');
}

/** Returns the uncompressed bytes of one entry (from listEntries). For small entries. */
function readEntry(zipPath, entry) {
  checkMethod(entry);
  const fd = fs.openSync(zipPath, 'r');
  let raw;
  try {
    raw = readAt(fd, dataStartOf(fd, entry), entry.compressedSize);
  } finally {
    fs.closeSync(fd);
  }
  let data;
  if (entry.method === 0) data = raw;
  else data = zlib.inflateRawSync(raw);
  if (data.length !== entry.size) throw new ZipError('size mismatch');
  if (zlib.crc32(data) !== entry.crc) throw new ZipError('crc mismatch');
  return data;
}

module.exports = { listEntries, readEntry, entryChunks, ZipError };
