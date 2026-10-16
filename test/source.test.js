'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { findExport } = require('../extension/server/lib/source');
const { zipFolder, writeZip } = require('./helpers/zip-writer');
const { tmpDir, FIXTURES } = require('./helpers/tmp');

const root = tmpDir('source');
const V1 = path.join(FIXTURES, 'export-v1');
const CLAUDE = path.join(FIXTURES, 'claude-export');

function downloads(name) {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// User-facing text must never leak paths or English error text.
function assertPlain(message) {
  assert.ok(!message.includes(root), 'message leaks a path');
  assert.ok(!/[A-Za-z]:\\|\/Users\/|\/tmp\//.test(message), 'message contains a path');
  assert.ok(!/error|errno|ENOENT|EPERM|stack/i.test(message), 'message contains English error text');
}

test('empty Downloads: plain-language instructions', () => {
  const r = findExport({ downloadsDir: downloads('empty') });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
  assert.match(r.message, /设置 → 数据控制 → 导出数据/);
  assertPlain(r.message);
});

test('missing Downloads folder behaves like empty', () => {
  const r = findExport({ downloadsDir: path.join(root, 'does-not-exist') });
  assert.equal(r.code, 'not_found');
});

test('finds a zip export, ignoring unrelated zips and folders', () => {
  const d = downloads('zip-only');
  writeZip(path.join(d, 'photos.zip'), [{ name: 'a.jpg', data: Buffer.from('x') }]);
  fs.mkdirSync(path.join(d, 'some folder'));
  fs.writeFileSync(path.join(d, 'broken.zip'), 'not a zip');
  zipFolder(V1, path.join(d, 'abc123-2025-03-01-10-00-00.zip'));
  const r = findExport({ downloadsDir: d });
  assert.equal(r.ok, true);
  assert.equal(r.origin, 'downloads');
  assert.equal(r.candidate.kind, 'zip');
  assert.equal(r.candidate.product, 'chatgpt');
  assert.deepEqual(r.candidate.files.map((f) => f.name), ['conversations-000.json', 'conversations-001.json']);
  assert.equal(r.candidate.exportDate, Date.UTC(2025, 2, 1, 10, 0, 0));
});

test('picks the newest of several exports (zip vs Safari-unzipped folder)', () => {
  const d = downloads('several');
  zipFolder(V1, path.join(d, 'old-2024-05-01-08-00-00.zip'));
  fs.cpSync(V1, path.join(d, 'new-2025-06-01-08-00-00'), { recursive: true });
  zipFolder(V1, path.join(d, 'mid-2025-01-01-08-00-00.zip'), { prefix: 'inner/' });
  const r = findExport({ downloadsDir: d });
  assert.equal(r.candidate.kind, 'dir');
  assert.equal(path.basename(r.candidate.path), 'new-2025-06-01-08-00-00');
  assert.equal(r.others, 2);
});

test('zip with the export one folder down is recognised', () => {
  const d = downloads('nested-zip');
  zipFolder(V1, path.join(d, 'export.zip'), { prefix: 'chatgpt-export/' });
  const r = findExport({ downloadsDir: d });
  assert.equal(r.ok, true);
  assert.equal(r.candidate.files.length, 2);
});

test('a Claude export is recognised and explained, not imported', () => {
  const d = downloads('claude-only');
  zipFolder(CLAUDE, path.join(d, 'data-2025-01-01-00-00-00.zip'));
  const r = findExport({ downloadsDir: d });
  assert.equal(r.code, 'claude_export');
  assert.match(r.message, /Claude 的导出包/);
  assertPlain(r.message);

  // When both exist, the ChatGPT one wins even if older.
  zipFolder(V1, path.join(d, 'gpt-2024-01-01-00-00-00.zip'));
  assert.equal(findExport({ downloadsDir: d }).candidate.product, 'chatgpt');
});

test('Downloads without permission: explains how to allow access', { skip: process.getuid && process.getuid() === 0 }, () => {
  const d = downloads('locked');
  fs.chmodSync(d, 0o000);
  try {
    const r = findExport({ downloadsDir: d });
    assert.equal(r.code, 'no_permission');
    assert.match(r.message, /隐私与安全性/);
    assertPlain(r.message);
  } finally {
    fs.chmodSync(d, 0o755);
  }
});

test('export_path: zip file, export folder, parent folder, single json, invalid', () => {
  const d = downloads('picked');
  const zip = path.join(d, 'picked.zip');
  zipFolder(V1, zip);
  const unused = downloads('unused');

  const z = findExport({ exportPath: zip, downloadsDir: unused });
  assert.equal(z.origin, 'export_path');
  assert.equal(z.candidate.kind, 'zip');

  const folder = path.join(d, 'unzipped');
  fs.cpSync(V1, folder, { recursive: true });
  assert.equal(findExport({ exportPath: folder, downloadsDir: unused }).candidate.path, folder);

  // Picking the folder that contains exports scans it and takes the newest.
  fs.cpSync(V1, path.join(d, 'x-2099-01-01-00-00-00'), { recursive: true });
  const parent = findExport({ exportPath: d, downloadsDir: unused });
  assert.equal(path.basename(parent.candidate.path), 'x-2099-01-01-00-00-00');

  const single = findExport({ exportPath: path.join(folder, 'conversations-000.json'), downloadsDir: unused });
  assert.deepEqual(single.candidate.files.map((f) => f.name), ['conversations-000.json']);

  const bad = findExport({ exportPath: path.join(root, 'nope'), downloadsDir: unused });
  assert.equal(bad.code, 'export_path_invalid');
  assertPlain(bad.message);
  assert.equal(findExport({ exportPath: downloads('empty-picked'), downloadsDir: unused }).code, 'export_path_invalid');
});

test('unset or unsubstituted export_path falls back to Downloads', () => {
  const d = downloads('fallback');
  zipFolder(V1, path.join(d, 'e.zip'));
  for (const exportPath of [undefined, '', '   ', '${user_config.export_path}']) {
    const r = findExport({ exportPath, downloadsDir: d });
    assert.equal(r.origin, 'downloads', String(exportPath));
  }
});
