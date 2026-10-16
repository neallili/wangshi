'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listEntries, readEntry, entryChunks, ZipError } = require('../extension/server/lib/zip');
const { writeZip } = require('./helpers/zip-writer');
const { tmpDir } = require('./helpers/tmp');

const dir = tmpDir('zip');
const entries = [
  { name: 'conversations.json', data: Buffer.from('[{"title":"中文标题"}]') },
  { name: '文件夹/说明.txt', data: Buffer.from('stored 内容'), method: 0 },
  { name: 'big.bin', data: Buffer.alloc(300000, 7) },
];

for (const zip64 of [false, true]) {
  test(`reads deflate and stored entries (zip64=${zip64})`, () => {
    const p = path.join(dir, `t${zip64 ? 64 : 32}.zip`);
    writeZip(p, entries, { zip64 });
    const list = listEntries(p);
    assert.deepEqual(list.map((e) => e.name), entries.map((e) => e.name));
    for (const e of entries) {
      const got = readEntry(p, list.find((x) => x.name === e.name));
      assert.ok(got.equals(e.data), e.name);
    }
  });

  test(`streams entries in small chunks (zip64=${zip64})`, async () => {
    const p = path.join(dir, `s${zip64 ? 64 : 32}.zip`);
    writeZip(p, entries, { zip64 });
    for (const e of listEntries(p)) {
      const parts = [];
      for await (const c of entryChunks(p, e, { chunkSize: 1024 })) parts.push(c);
      assert.ok(Buffer.concat(parts).equals(entries.find((x) => x.name === e.name).data), e.name);
    }
  });
}

test('rejects non-zip files and corrupted data', () => {
  const notZip = path.join(dir, 'not.zip');
  fs.writeFileSync(notZip, 'hello');
  assert.throws(() => listEntries(notZip), ZipError);

  const p = path.join(dir, 'corrupt.zip');
  writeZip(p, [{ name: 'a.txt', data: Buffer.from('abcdefgh'.repeat(10)), method: 0 }]);
  const buf = fs.readFileSync(p);
  buf[40] ^= 0xff; // flip a data byte -> crc mismatch
  fs.writeFileSync(p, buf);
  assert.throws(() => readEntry(p, listEntries(p)[0]), /crc mismatch/);
});

test('streaming detects corrupted and truncated data', async () => {
  const drain = async (p) => { for await (const _ of entryChunks(p, listEntries(p)[0])) { /* drain */ } };
  const p = path.join(dir, 'corrupt-stream.zip');
  writeZip(p, [{ name: 'a.txt', data: Buffer.from('abcdefgh'.repeat(10)), method: 0 }]);
  const buf = fs.readFileSync(p);
  buf[40] ^= 0xff;
  fs.writeFileSync(p, buf);
  await assert.rejects(drain(p), /crc mismatch/);

  const q = path.join(dir, 'deflate-corrupt.zip');
  writeZip(q, [{ name: 'b.json', data: Buffer.from('[{"x":"' + 'y'.repeat(5000) + '"}]') }]);
  const qb = fs.readFileSync(q);
  qb.fill(0xff, 35, 60); // garbage in the deflate stream
  fs.writeFileSync(q, qb);
  await assert.rejects(drain(q));
});
