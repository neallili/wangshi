'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const zlib = require('zlib');
const { Store } = require('../extension/server/lib/store');
const { normalizeConversation } = require('../extension/server/lib/chatgpt');
const { search } = require('../extension/server/lib/search');
const { tmpDir } = require('./helpers/tmp');

const root = tmpDir('search');
let n = 0;

/** Minimal synthetic conversation: id, title, update_time, then message texts (user/assistant alternating). */
function conv(id, title, time, ...texts) {
  const mapping = { r: { id: 'r', message: null, parent: null, children: [] } };
  let parent = 'r';
  texts.forEach((text, i) => {
    const nid = `${id}-${i}`;
    mapping[nid] = { id: nid, parent, children: [], message: {
      author: { role: i % 2 ? 'assistant' : 'user' }, create_time: time, recipient: 'all',
      content: { content_type: 'text', parts: [text] }, metadata: {} } };
    mapping[parent].children.push(nid);
    parent = nid;
  });
  return { id, title, create_time: time - 10, update_time: time, current_node: parent, mapping };
}

function storeWith(convs) {
  const store = new Store(path.join(root, `db${n++}`, 'w.db'));
  const importId = store.beginImport({ origin: 'test', kind: 'dir', filesTotal: 1 });
  store.transaction(() => {
    for (const raw of convs) store.importConversation(importId, normalizeConversation(raw), raw);
  });
  return store;
}

const ids = (r) => r.results.map((x) => x.id);

test('relevance: title hits first, more occurrences next, ties go to the newer conversation', () => {
  const store = storeWith([
    conv('newer-one-hit', '杂谈', 300, '朋友周末去露营'),
    conv('old-many-hits', '家里的事', 100, '露营预算', '露营装备怎么选', '露营地点'),
    conv('title-hit', '周末露营计划', 50, '先定预算'),
    conv('older-one-hit', '杂谈', 200, '朋友周末去露营'),
    conv('no-hit', '别的', 400, '完全无关'),
  ]);
  assert.deepEqual(ids(search(store, { query: '露营' })), ['title-hit', 'old-many-hits', 'newer-one-hit', 'older-one-hit']);
  store.close();
});

test('Chinese keywords without spaces are segmented; any word matches, more words rank higher', () => {
  const store = storeWith([
    conv('both', '温室', 100, 'Raspberry Pi 入门', '智能温室的传感器'),
    conv('english-only', 'Board', 300, 'raspberry pi details'),
    conv('chinese-only', '项目', 200, '智能温室设计'),
    conv('unrelated', '无关', 400, '今天天气'),
  ]);
  const r = search(store, { query: 'Raspberry Pi智能温室' });
  assert.ok(r.terms.length >= 3, `segmented into words: ${r.terms}`);
  assert.equal(r.results[0].id, 'both');
  assert.equal(r.results[0].match, 'all');
  assert.deepEqual(r.results.slice(1).map((x) => x.id).sort(), ['chinese-only', 'english-only']);
  assert.ok(r.results.slice(1).every((x) => x.match === 'some' && x.matched_terms.length < r.terms.length));
  store.close();
});

test('matching and snippets use clean text; markup never shows up', () => {
  const cite = 'citeturn0search0';
  const store = storeWith([
    conv('marked', '吊顶', 100, '问题', `<text color="red">吊顶</text>用石膏板${cite}比较好。<Cite refs=["turn0news1"] />`),
  ]);
  const r = search(store, { query: '石膏板' });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].snippet, '吊顶用石膏板比较好。');
  assert.doesNotMatch(r.results[0].snippet, /[-<>]|turn0/);
  assert.equal(search(store, { query: 'turn0search0' }).results.length, 0);
  assert.equal(search(store, { query: 'color' }).results.length, 0);
  store.close();
});

test('time filter, limit, empty and punctuation-only queries', () => {
  const store = storeWith([conv('a', 't', 100, '关键词'), conv('b', 't', 200, '关键词'), conv('c', 't', 300, '关键词')]);
  assert.deepEqual(ids(search(store, { query: '关键词' })), ['c', 'b', 'a']);
  assert.deepEqual(ids(search(store, { query: '关键词', since: 150 })), ['c', 'b']);
  assert.deepEqual(ids(search(store, { query: '关键词', until: 150 })), ['a']);
  assert.equal(search(store, { query: '关键词', limit: 2 }).results.length, 2);
  assert.deepEqual(search(store, { query: '   ' }).results, []);
  assert.deepEqual(search(store, { query: '？！"' }).results, []);
  // function words alone do not drag in everything
  const fw = storeWith([conv('p', 't', 100, 'the cat 问题'), conv('q', 't', 100, 'the dog 东西')]);
  assert.deepEqual(search(fw, { query: '不存在的词' }).results, []);
  assert.deepEqual(search(fw, { query: '不存在的词' }).terms, ['不存在'], 'function word and the lone 词 dropped');
  assert.equal(search(fw, { query: 'the' }).results.length, 2, 'a query of only function words still searches');
  assert.deepEqual(ids(search(fw, { query: 'the cat' })), ['p'], '"the" is dropped next to a content word');
  fw.close();
  store.close();
});

test('re-import keeps the index in sync: updated conversations are found by new words only once', () => {
  const store = storeWith([conv('x', '苹果', 100, '原来的内容')]);
  const importId = store.beginImport({ origin: 'test', kind: 'dir', filesTotal: 1 });
  const v2 = conv('x', '香蕉', 200, '原来的内容', '后来补充了温哥华');
  store.transaction(() => store.importConversation(importId, normalizeConversation(v2), v2));
  assert.deepEqual(ids(search(store, { query: '温哥华' })), ['x']);
  assert.deepEqual(ids(search(store, { query: '苹果' })), [], 'old title no longer indexed');
  assert.deepEqual(ids(search(store, { query: '香蕉' })), ['x']);
  assert.deepEqual(ids(search(store, { query: '原来' })), ['x']);
  store.close();
});

// The v1 schema of the first version (no nodes.search_text, no search_index).
const V1_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE imports (id INTEGER PRIMARY KEY, source TEXT NOT NULL, origin TEXT, kind TEXT, export_date REAL,
  started_at REAL NOT NULL, finished_at REAL, status TEXT NOT NULL, files_total INTEGER, files_done INTEGER DEFAULT 0,
  bytes_total INTEGER, bytes_done INTEGER DEFAULT 0, convs_total INTEGER, convs_done INTEGER DEFAULT 0,
  convs_new INTEGER DEFAULT 0, convs_updated INTEGER DEFAULT 0, convs_unchanged INTEGER DEFAULT 0,
  convs_older INTEGER DEFAULT 0, convs_invalid INTEGER DEFAULT 0, error_code TEXT);
CREATE TABLE conversations (source TEXT NOT NULL, id TEXT NOT NULL, title TEXT, create_time REAL, update_time REAL,
  version_time REAL NOT NULL, model TEXT, gizmo_id TEXT, gizmo_type TEXT, gizmo_kind TEXT,
  current_snapshot INTEGER NOT NULL, first_import INTEGER, last_import INTEGER, PRIMARY KEY (source, id));
CREATE TABLE snapshots (id INTEGER PRIMARY KEY, source TEXT NOT NULL, conversation_id TEXT NOT NULL,
  version_time REAL NOT NULL, import_id INTEGER NOT NULL, current_node TEXT, node_count INTEGER,
  branch_count INTEGER, hidden_count INTEGER, raw BLOB NOT NULL, UNIQUE (source, conversation_id, version_time));
CREATE TABLE nodes (snapshot_id INTEGER NOT NULL, node_id TEXT NOT NULL, parent_id TEXT, seq INTEGER NOT NULL,
  branch_pos INTEGER, role TEXT, author_name TEXT, recipient TEXT, content_type TEXT, model TEXT, create_time REAL,
  hidden INTEGER NOT NULL, hidden_reason TEXT, text TEXT NOT NULL);
CREATE UNIQUE INDEX nodes_key ON nodes(snapshot_id, node_id);
CREATE TABLE attachments (snapshot_id INTEGER NOT NULL, node_id TEXT NOT NULL, kind TEXT NOT NULL,
  file_id TEXT, name TEXT, mime_type TEXT, size INTEGER);
INSERT INTO meta VALUES ('schema_version', '1');
`;

function writeV1(dbPath, raw) {
  require('fs').mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(V1_SCHEMA);
  const c = normalizeConversation(raw);
  db.prepare(`INSERT INTO imports (id, source, started_at, status) VALUES (1, 'chatgpt', 0, 'done')`).run();
  db.prepare(`INSERT INTO snapshots (id, source, conversation_id, version_time, import_id, raw)
    VALUES (1, 'chatgpt', ?, ?, 1, ?)`).run(c.id, c.version_time, zlib.deflateSync(JSON.stringify(raw)));
  for (const nd of c.nodes) {
    db.prepare(`INSERT INTO nodes (snapshot_id, node_id, parent_id, seq, branch_pos, role, hidden, text)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`).run(nd.node_id, nd.parent_id, nd.seq, nd.branch_pos, nd.role, nd.hidden, nd.text);
  }
  db.prepare(`INSERT INTO conversations (source, id, title, create_time, update_time, version_time, current_snapshot)
    VALUES ('chatgpt', ?, ?, ?, ?, ?, 1)`).run(c.id, c.title, c.create_time, c.update_time, c.version_time);
  db.close();
}

test('a v1 database is upgraded to v3: clean text backfilled, index built, original text untouched', () => {
  const dbPath = path.join(root, 'v1', 'w.db');
  writeV1(dbPath, conv('old', '旧库', 100, '<text color="red">重点</text>内容citeturn0search0'));
  assert.equal(Store.schemaVersionOf(dbPath), 1);
  const store = new Store(dbPath);
  assert.equal(Store.schemaVersionOf(dbPath), 3);
  const node = store.db.prepare("SELECT text, search_text FROM nodes WHERE node_id = 'old-0'").get();
  assert.equal(node.search_text, '重点内容');
  assert.match(node.text, /<text color="red">/);
  assert.deepEqual(ids(search(store, { query: '重点' })), ['old']);
  store.close();
  assert.equal(Store.schemaVersionOf(path.join(root, 'nope.db')), null);
});

test('server: an old database is upgraded on the worker while tools answer "正在升级"', async () => {
  const { Wangshi } = require('../extension/server/tools');
  const home = path.join(root, 'upgrade-home');
  const dbPath = path.join(home, '.wangshi', 'wangshi.db');
  writeV1(dbPath, conv('old', '旧库', 100, '温哥华买房'));
  const app = new Wangshi({ dbPath, downloadsDir: path.join(home, 'Downloads'), exportPath: '', migrateWaitMs: 0 });
  const first = await app.search({ query: '温哥华' });
  assert.match(first, /^往事正在升级本地索引（只需要一次），还需要一点时间/);
  assert.match(await app.status(), /正在升级本地索引/, 'other tools say the same while it runs');
  await app.migration;
  assert.equal(Store.schemaVersionOf(dbPath), 3);
  assert.match(await app.search({ query: '温哥华' }), /旧库/);
  app.close();
});

// ---- 0.2.1: searches that should come back empty ("没找到"), so Claude retries with other words

function noiseStore() {
  return storeWith([
    conv('fan', '空调风扇推荐', 100, '这款风扇风量大', '落地扇和空调扇怎么选', '用笔画个圈'),
    conv('car', '租车', 200, '在机场租车', '本田和丰田哪个好'),
    conv('hotpot', '火锅', 300, '火锅底料怎么炒', '牛油火锅'),
    conv('physics', '物理', 400, '量子力学入门', '薛定谔的猫'),
    conv('chat', '问 GPT', 500, '我以前问过 ChatGPT 这个问题', 'GPT 回答说可以'),
  ]);
}

test('single characters left by segmentation do not make everything match', () => {
  const store = noiseStore();
  // the fragment exists on its own ("用笔画个圈"), so an empty result below is the filtering at work
  assert.deepEqual(ids(search(store, { query: '圈' })), ['fan']);
  for (const q of ['乾坤圈', '料理机', '底部 料子', '我想问一下关于乾坤圈的事', '车厘子']) {
    assert.deepEqual(search(store, { query: q }).results, [], `${q} should find nothing`);
  }
  store.close();
});

test('a name the segmenter splits must appear as a whole; other words still count', () => {
  const store = storeWith([...[conv('toy', '玩具车', 50, '乾坤圈的道具套装')], conv('car', '租车', 200, '本田和丰田')]);
  const r = search(store, { query: '乾坤圈 本田' });
  assert.deepEqual(r.terms, ['乾坤圈', '本田']);
  assert.deepEqual(r.results.map((x) => [x.id, x.match]).sort(), [['car', 'some'], ['toy', 'some']]);
  store.close();
});

test('gpt / chatgpt and "以前问过……" phrasing are not search terms', () => {
  const store = noiseStore();
  assert.deepEqual(search(store, { query: '我以前问过 GPT 关于火锅底料' }).terms, ['火锅', '底料']);
  assert.deepEqual(ids(search(store, { query: '我以前问过 GPT 关于火锅底料' })), ['hotpot']);
  assert.deepEqual(search(store, { query: 'ChatGPT 宇宙飞船' }).results, []);
  store.close();
});

test('nonsense multi-word queries find nothing instead of fragments', () => {
  const store = noiseStore();
  for (const q of ['量子底料风扇丰田', '紫色 斑马 钢琴 课', 'xqzvw blorp', '不存在的词']) {
    const r = search(store, { query: q });
    assert.ok(r.results.every((x) => x.match === 'some'), `${q}: no conversation can contain every term`);
  }
  assert.deepEqual(search(store, { query: '紫色 斑马 钢琴 课' }).results, []);
  assert.deepEqual(search(store, { query: 'xqzvw blorp' }).results, []);
  store.close();
});

test('search tool: no full match → says so first and tells Claude to retry', async () => {
  const { Wangshi } = require('../extension/server/tools');
  const dir = path.join(root, `tool${n++}`);
  const store = new Store(path.join(dir, 'w.db'));
  const importId = store.beginImport({ origin: 'test', kind: 'dir', filesTotal: 1 });
  store.transaction(() => {
    for (const raw of [conv('car', '租车', 200, '本田和丰田'), conv('hotpot', '火锅', 300, '牛油火锅')]) {
      store.importConversation(importId, normalizeConversation(raw), raw);
    }
  });
  store.close();
  const app = new Wangshi({ dbPath: path.join(dir, 'w.db'), downloadsDir: dir, exportPath: '' });
  const loose = await app.search({ query: '乾坤圈 本田' });
  assert.match(loose, /^没有找到同时包含"乾坤圈、本田"的对话，下面是只沾边的结果/);
  assert.match(loose, /请先换个说法再搜一两次/);
  const none = await app.search({ query: '乾坤圈' });
  assert.match(none, /^在用户的 ChatGPT 记录里，没有找到和"乾坤圈"相关的对话。/);
  assert.match(none, /换成英文或中文/);
  assert.match(await app.search({ query: '本田' }), /^在用户的 ChatGPT 记录里找到 1 条相关对话/);
  app.close();
});
