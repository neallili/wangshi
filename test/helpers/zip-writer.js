'use strict';
// Test-only zip writer, used to build export zips from the fixture folders.
// `zip64: true` writes zip64 records even for small files, to exercise that reader path.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function writeZip(zipPath, entries, { zip64 = false } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method = 8 } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x6000, 10); // 12:00
    local.writeUInt16LE(0x5b2e, 12); // 2025-09-14
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    let extra = Buffer.alloc(0);
    if (zip64) {
      extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(zip64 ? 45 : 20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0x6000, 12);
    cd.writeUInt16LE(0x5b2e, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    cd.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(extra.length, 30);
    cd.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(cd, nameBuf, extra);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const cdOffset = offset;
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdBuf.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdBuf.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdOffset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, cdBuf, ...tail, eocd]));
}

/** Zips every file of a fixture folder, optionally under a top-level folder prefix. */
function zipFolder(dir, zipPath, { prefix = '', zip64 = false, extra = [] } = {}) {
  const entries = fs.readdirSync(dir).sort().map((name) => ({
    name: prefix + name, data: fs.readFileSync(path.join(dir, name)),
  }));
  writeZip(zipPath, [...entries, ...extra], { zip64 });
}

module.exports = { writeZip, zipFolder };
