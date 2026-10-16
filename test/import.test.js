'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../extension/server/lib/store');
const { findExport } = require('../extension/server/lib/source');
const { previewExport, runImport } = require('../extension/server/lib/importer');
const { zipFolder, writeZip } = require('./helpers/zip-writer');
const { longConversation } = require('./helpers/long-conversation');
const { tmpDir, FIXTURES } = require('./helpers/tmp');

const root = tmpDir('import');
const V1 = path.join(FIXTURES, 'export-v1');
const V2 = path.join(FIXTURES, 'export-v2');
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
let n = 0;

function freshStore() {
  return new Store(path.join(root, `db${n++}`, 'wangshi.db'));
}

function locate(dirOrZip) {
  const r = findExport({ exportPath: dirOrZip, downloadsDir: root });
  assert.equal(r.ok, true, r.message);
  return r;
}

async function importFrom(store, dirOrZip, opts = {}) {
  const { candidate, origin } = locate(dirOrZip);
  return runImport({ store, candidate, origin, ...opts });
}

test('preview counts conversations without writing anything', async () => {
  const { candidate } = locate(V1);
  const p = await previewExport({ candidate, origin: 'downloads' });
  assert.equal(p.ok, true);
  assert.equal(p.count, 7); // the object without mapping is not counted
  assert.match(p.message, /^在"下载"文件夹找到了你 .*日的 ChatGPT 导出，共 7 条对话（从 .* 到 .*），现在导入吗？$/);
});

test('first import, re-import, then a newer export', async () => {
  const store = freshStore();
  const progress = [];
  const r1 = await importFrom(store, V1, { onProgress: (p) => progress.push(p) });
  assert.equal(r1.ok, true);
  assert.deepEqual([r1.new, r1.updated, r1.unchanged, r1.invalid], [7, 0, 0, 1]);
  assert.equal(r1.message, '导入完成：新增 7 条对话。');
  assert.equal(progress.at(-1).filesDone, 2);
  assert.equal(progress.at(-1).done, 8);
  const imp = store.getImport(r1.importId);
  assert.equal(imp.status, 'done');
  assert.equal(imp.convs_new, 7);
  assert.equal(imp.files_done, 2);

  // Same export again: nothing new.
  const r2 = await importFrom(store, V1);
  assert.deepEqual([r2.new, r2.updated, r2.unchanged], [0, 0, 7]);
  assert.match(r2.message, /之前都已经导入过了/);
  assert.equal(store.stats().snapshots, 7);

  // Newer export: A updated, B unchanged, H new.
  const r3 = await importFrom(store, V2);
  assert.deepEqual([r3.new, r3.updated, r3.unchanged], [1, 1, 1]);
  assert.equal(r3.message, '导入完成：新增 1 条对话，更新 1 条，1 条之前已导入过、没有变化。');

  const snaps = store.snapshotsOf(A);
  assert.equal(snaps.length, 2, 'old snapshot is kept');
  const conv = store.getConversation(A);
  assert.equal(conv.current_snapshot, snaps[1].id);
  assert.equal(conv.update_time, 1708000000.75);
  assert.equal(conv.first_import, r1.importId);
  assert.equal(conv.last_import, r3.importId);
  assert.equal(store.branch(snaps[0].id).length, 4);
  assert.equal(store.branch(snaps[1].id).at(-1).text, '利率下降会降低月供，但还要看房价走势和你的收入稳定性。');
  assert.equal(store.snapshotsOf(B).length, 1);
  assert.equal(store.stats().conversations, 8);
  store.close();
});

test('importing an older export after a newer one keeps the newer view', async () => {
  const store = freshStore();
  await importFrom(store, V2);
  const r = await importFrom(store, V1);
  assert.equal(r.older, 1); // A from v1 is older than what we have
  const conv = store.getConversation(A);
  assert.equal(conv.update_time, 1708000000.75);
  assert.equal(store.snapshotsOf(A).length, 2);
  store.close();
});

test('stored rows: branch, hidden, attachments, raw JSON round trip', async () => {
  const store = freshStore();
  await importFrom(store, V1);
  const c = store.getConversation('c0000000-0000-4000-8000-000000000003');
  assert.deepEqual(store.branch(c.current_snapshot).map((x) => x.text), ['帮我算一下 2 的 10 次方', '结果是 1024。']);
  assert.equal(store.branch(c.current_snapshot, { includeHidden: true }).length, 8);

  const b = store.getConversation(B);
  assert.equal(store.nodes(b.current_snapshot).length, 6, 'other branches are stored');

  const d = store.getConversation('d0000000-0000-4000-8000-000000000004');
  assert.deepEqual(store.attachments(d.current_snapshot).map((a) => a.name),
    ['photo.png', null, 'data.csv', '合同草稿.pdf']);

  const f = store.getConversation('f0000000-0000-4000-8000-000000000006');
  assert.equal(f.title, null);
  assert.equal(f.gizmo_kind, 'project');

  const original = JSON.parse(fs.readFileSync(path.join(V1, 'conversations-000.json'), 'utf8'))[0];
  assert.deepEqual(store.raw(store.getConversation(A).current_snapshot), original);
  store.close();
});

test('zip import (incl. zip64) matches folder import', async () => {
  const zip = path.join(root, 'v1.zip');
  zipFolder(V1, zip, { zip64: true });
  const s1 = freshStore();
  const s2 = freshStore();
  await importFrom(s1, V1);
  await importFrom(s2, zip);
  const dump = (s) => s.db.prepare('SELECT n.node_id, n.branch_pos, n.hidden, n.text FROM nodes n ORDER BY n.node_id').all();
  assert.deepEqual(dump(s1), dump(s2));
  s1.close();
  s2.close();
});

test('long conversation in a zip imports and reads back in order', async () => {
  const zip = path.join(root, 'long.zip');
  const raw = longConversation({ turns: 1500, charsPerMessage: 2000 });
  writeZip(zip, [
    { name: 'conversations.json', data: Buffer.from(JSON.stringify([raw])) },
    { name: 'chat.html', data: Buffer.from('<html></html>') },
  ]);
  const store = freshStore();
  const r = await importFrom(store, zip);
  assert.equal(r.new, 1);
  const branch = store.branch(store.getConversation(raw.id).current_snapshot);
  assert.equal(branch.length, 3000);
  assert.ok(branch.every((x, i) => x.node_id === `l-${i}`));
  store.close();
});

test('Claude data behind a ChatGPT-looking zip is refused in plain words', async () => {
  const zip = path.join(root, 'mislabelled.zip');
  zipFolder(path.join(FIXTURES, 'claude-export'), zip, {
    extra: [{ name: 'chat.html', data: Buffer.from('<html></html>') }],
  });
  const { candidate, origin } = locate(zip);
  assert.equal((await previewExport({ candidate, origin })).code, 'claude_export');
  const store = freshStore();
  const r = await runImport({ store, candidate, origin });
  assert.equal(r.code, 'claude_export');
  assert.equal(store.latestImport().status, 'failed');
  store.close();
});

test('a damaged second file: first file stays imported, re-run resumes', async () => {
  const dir = path.join(root, 'damaged');
  fs.cpSync(V1, dir, { recursive: true });
  const good = fs.readFileSync(path.join(dir, 'conversations-001.json'));
  fs.writeFileSync(path.join(dir, 'conversations-001.json'), good.subarray(0, 200));
  const store = freshStore();
  const { candidate, origin } = locate(dir);
  assert.equal((await previewExport({ candidate, origin })).code, 'unreadable');

  const r1 = await runImport({ store, candidate, origin });
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'unreadable');
  assert.match(r1.message, /没下载完整或者已经损坏/);
  assert.equal(r1.new, 3);
  assert.equal(store.getImport(r1.importId).status, 'failed');
  assert.equal(store.stats().conversations, 3);

  fs.writeFileSync(path.join(dir, 'conversations-001.json'), good);
  const r2 = await runImport({ store, candidate: locate(dir).candidate, origin });
  assert.deepEqual([r2.new, r2.unchanged], [4, 3]);
  store.close();
});

test('empty export is explained', async () => {
  const dir = path.join(root, 'empty-export');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'conversations.json'), '[]');
  fs.writeFileSync(path.join(dir, 'chat.html'), '');
  const { candidate, origin } = locate(dir);
  const p = await previewExport({ candidate, origin });
  assert.equal(p.code, 'empty');
  assert.match(p.message, /一条对话都没有/);
});

test('a conversation damaged mid-file: earlier ones in that file are kept', async () => {
  const dir = path.join(root, 'damaged-mid');
  fs.cpSync(V1, dir, { recursive: true });
  const text = fs.readFileSync(path.join(dir, 'conversations-001.json'), 'utf8');
  const cut = text.indexOf('"e0000000'); // inside the 2nd conversation of the file
  fs.writeFileSync(path.join(dir, 'conversations-001.json'), text.slice(0, cut) + '"broken": }, ]');
  const store = freshStore();
  const { candidate, origin } = locate(dir);
  const r = await runImport({ store, candidate, origin });
  assert.equal(r.code, 'unreadable');
  assert.equal(r.new, 4); // 3 from the first file + D before the damage
  store.close();
});

test('progress reports bytes and is stored for status', async () => {
  const store = freshStore();
  const seen = [];
  const r = await importFrom(store, V1, { onProgress: (p) => seen.push(p) });
  const last = seen.at(-1);
  assert.ok(last.bytesTotal > 0);
  assert.equal(last.bytesDone, last.bytesTotal);
  const imp = store.getImport(r.importId);
  assert.equal(imp.bytes_done, imp.bytes_total);
  store.close();
});

test('preview and import through the worker thread', async () => {
  const { previewInWorker, importInWorker } = require('../extension/server/lib/import-worker');
  const { candidate, origin } = locate(V1);
  const p = await previewInWorker({ candidate, origin });
  assert.equal(p.count, 7);
  const dbPath = path.join(root, `db${n++}`, 'wangshi.db');
  const progress = [];
  const r = await importInWorker({ candidate, origin, dbPath, expectedTotal: p.count }, (x) => progress.push(x));
  assert.equal(r.ok, true);
  assert.equal(r.new, 7);
  assert.ok(progress.length >= 2);
  const store = new Store(dbPath);
  assert.equal(store.stats().conversations, 7);
  assert.equal(store.getImport(r.importId).status, 'done');
  store.close();
});

test('a second connection can read status while the worker is importing', async () => {
  const { importInWorker } = require('../extension/server/lib/import-worker');
  const { candidate, origin } = locate(V1);
  const dbPath = path.join(root, `db${n++}`, 'wangshi.db');
  new Store(dbPath).close(); // schema exists before the worker starts writing
  let reads = 0;
  const r = await importInWorker({ candidate, origin, dbPath }, () => {
    const s = new Store(dbPath); // opening + reading while the worker holds the database
    assert.ok(s.latestImport());
    s.close();
    reads++;
  });
  assert.equal(r.ok, true);
  assert.ok(reads >= 2);
});
