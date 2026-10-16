'use strict';
// SQLite storage (node:sqlite, built into Claude Desktop's Node 24). Append-only for snapshots:
// a conversation whose update_time changed gets a new snapshot; old snapshots are never deleted.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { cleanText, storedCleanText } = require('./clean');
const { indexText } = require('./tokenize');

// 1: first schema. 2: nodes.search_text (clean text for search and snippets; see clean.js).
// 3: search_index (FTS5 over Intl.Segmenter words, one row per conversation; see tokenize.js).
const SCHEMA_VERSION = 3;

// Contentless: the index only stores what it needs to match and rank; text comes from nodes.
const SEARCH_INDEX = `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  title, body, content = '', contentless_delete = 1, tokenize = 'unicode61 remove_diacritics 2')`;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  origin TEXT,               -- 'downloads' | 'export_path'
  kind TEXT,                 -- 'zip' | 'dir'
  export_date REAL,          -- ms since epoch, from file name or mtime
  started_at REAL NOT NULL,  -- ms since epoch
  finished_at REAL,
  status TEXT NOT NULL,      -- 'running' | 'done' | 'failed'
  files_total INTEGER, files_done INTEGER DEFAULT 0,
  bytes_total INTEGER, bytes_done INTEGER DEFAULT 0,  -- uncompressed conversations*.json bytes
  convs_total INTEGER, convs_done INTEGER DEFAULT 0,
  convs_new INTEGER DEFAULT 0, convs_updated INTEGER DEFAULT 0,
  convs_unchanged INTEGER DEFAULT 0, convs_older INTEGER DEFAULT 0, convs_invalid INTEGER DEFAULT 0,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  source TEXT NOT NULL,      -- 'chatgpt' (reserved: 'claude' in v2)
  id TEXT NOT NULL,
  title TEXT,
  create_time REAL,          -- seconds since epoch, as in the export
  update_time REAL,
  version_time REAL NOT NULL,
  model TEXT,
  gizmo_id TEXT, gizmo_type TEXT, gizmo_kind TEXT,
  current_snapshot INTEGER NOT NULL,
  first_import INTEGER, last_import INTEGER,
  PRIMARY KEY (source, id)
);
CREATE INDEX IF NOT EXISTS conversations_update ON conversations(update_time);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  version_time REAL NOT NULL,
  import_id INTEGER NOT NULL,
  current_node TEXT,
  node_count INTEGER, branch_count INTEGER, hidden_count INTEGER,
  raw BLOB NOT NULL,         -- deflated original JSON of the conversation
  UNIQUE (source, conversation_id, version_time)
);

CREATE TABLE IF NOT EXISTS nodes (
  snapshot_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  parent_id TEXT,
  seq INTEGER NOT NULL,      -- order in the export's mapping
  branch_pos INTEGER,        -- position on the current branch; NULL = other branch
  role TEXT, author_name TEXT, recipient TEXT, content_type TEXT, model TEXT,
  create_time REAL,
  hidden INTEGER NOT NULL,
  hidden_reason TEXT,
  text TEXT NOT NULL,         -- original message text, as rendered by read_conversation
  search_text TEXT           -- text without ChatGPT UI markup / citation placeholders; NULL = same as text
);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_key ON nodes(snapshot_id, node_id);
CREATE INDEX IF NOT EXISTS nodes_branch ON nodes(snapshot_id, branch_pos);

CREATE TABLE IF NOT EXISTS attachments (
  snapshot_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,        -- 'file' | 'image' | 'asset'
  file_id TEXT, name TEXT, mime_type TEXT, size INTEGER
);
CREATE INDEX IF NOT EXISTS attachments_node ON attachments(snapshot_id, node_id);
`;

class Store {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // busy_timeout first: another connection (the import worker) may hold the lock right now.
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) {
      this._createSearchIndex();
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (Number(row.value) < SCHEMA_VERSION) {
      this._migrate(Number(row.value));
    }
    this._prepare();
  }

  /**
   * Schema version of an existing database without opening it for writing, or null when there
   * is no database yet. Lets the server run a slow migration on a worker instead of blocking.
   */
  static schemaVersionOf(dbPath) {
    if (!fs.existsSync(dbPath)) return null;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      return row ? Number(row.value) : null;
    } catch {
      return null;
    } finally {
      if (db) db.close();
    }
  }

  _createSearchIndex() {
    try {
      this.db.exec(SEARCH_INDEX);
    } catch (e) {
      if (/no such module: fts5/i.test(String(e && e.message))) throw new StoreError('no_fts5', 'SQLite without FTS5');
      throw e;
    }
  }

  /** Upgrades a database written by an older version. Original text and raw JSON are not touched. */
  _migrate(from) {
    if (from < 2) {
      this.transaction(() => {
        const cols = this.db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name);
        if (!cols.includes('search_text')) this.db.exec('ALTER TABLE nodes ADD COLUMN search_text TEXT');
        const read = this.db.prepare('SELECT rowid AS r, text FROM nodes');
        const write = this.db.prepare('UPDATE nodes SET search_text = ? WHERE rowid = ?');
        for (const n of read.all()) {
          const clean = storedCleanText(n.text);
          if (clean !== null) write.run(clean, n.r);
        }
        this.db.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
      });
    }
    if (from < 3) {
      this.transaction(() => {
        this._createSearchIndex();
        this.db.exec('DELETE FROM search_index');
        const convs = this.db.prepare('SELECT rowid AS r, title, current_snapshot FROM conversations').all();
        const texts = this.db.prepare(`SELECT coalesce(search_text, text) AS search_text FROM nodes WHERE snapshot_id = ?
          AND branch_pos IS NOT NULL AND hidden = 0 ORDER BY branch_pos`);
        const insert = this.db.prepare('INSERT INTO search_index(rowid, title, body) VALUES (?, ?, ?)');
        for (const c of convs) {
          const body = texts.all(c.current_snapshot).map((n) => n.search_text || '').join('\n');
          insert.run(c.r, indexText(cleanText(c.title || '')), indexText(body));
        }
        this.db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
      });
    }
  }

  /** Replaces the conversation's row in search_index with its current branch. */
  _index(source, conv) {
    const { r } = this.q.rowidOf.get(source, conv.id);
    const body = conv.nodes.filter((n) => n.branch_pos !== null && !n.hidden)
      .sort((a, b) => a.branch_pos - b.branch_pos).map((n) => n.search_text || '').join('\n');
    this.q.unindex.run(r);
    this.q.index.run(r, indexText(cleanText(conv.title || '')), indexText(body));
  }

  _prepare() {
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      snapshotExists: p('SELECT id FROM snapshots WHERE source = ? AND conversation_id = ? AND version_time = ?'),
      touch: p('UPDATE conversations SET last_import = ? WHERE source = ? AND id = ?'),
      insertSnapshot: p(`INSERT INTO snapshots (source, conversation_id, version_time, import_id, current_node,
        node_count, branch_count, hidden_count, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertNode: p(`INSERT INTO nodes (snapshot_id, node_id, parent_id, seq, branch_pos, role, author_name,
        recipient, content_type, model, create_time, hidden, hidden_reason, text, search_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertAttachment: p(`INSERT INTO attachments (snapshot_id, node_id, kind, file_id, name, mime_type, size)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      getConversation: p('SELECT * FROM conversations WHERE source = ? AND id = ?'),
      rowidOf: p('SELECT rowid AS r FROM conversations WHERE source = ? AND id = ?'),
      unindex: p('DELETE FROM search_index WHERE rowid = ?'),
      index: p('INSERT INTO search_index(rowid, title, body) VALUES (?, ?, ?)'),
      insertConversation: p(`INSERT INTO conversations (source, id, title, create_time, update_time, version_time,
        model, gizmo_id, gizmo_type, gizmo_kind, current_snapshot, first_import, last_import)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateConversation: p(`UPDATE conversations SET title = ?, create_time = ?, update_time = ?, version_time = ?,
        model = ?, gizmo_id = ?, gizmo_type = ?, gizmo_kind = ?, current_snapshot = ?, last_import = ?
        WHERE source = ? AND id = ?`),
    };
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---------------- imports bookkeeping (status / progress)

  beginImport({ source = 'chatgpt', origin, kind, exportDate, filesTotal, bytesTotal = null }) {
    const r = this.db.prepare(`INSERT INTO imports (source, origin, kind, export_date, started_at, status, files_total, bytes_total)
      VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`).run(source, origin, kind, exportDate ?? null, Date.now(), filesTotal, bytesTotal);
    return Number(r.lastInsertRowid);
  }

  updateImport(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE imports SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  }

  finishImport(id, status, errorCode = null) {
    this.updateImport(id, { status, finished_at: Date.now(), error_code: errorCode });
  }

  getImport(id) {
    return this.db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
  }

  latestImport() {
    return this.db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 1').get();
  }

  // ---------------- conversations

  /**
   * Stores one normalized conversation. Must run inside a transaction.
   * `raw` is the conversation's original JSON text (or the parsed object).
   * @returns {'new'|'updated'|'unchanged'|'older'}
   */
  importConversation(importId, conv, raw, source = 'chatgpt') {
    if (this.q.snapshotExists.get(source, conv.id, conv.version_time)) {
      this.q.touch.run(importId, source, conv.id);
      return 'unchanged';
    }
    let hiddenCount = 0;
    let branchCount = 0;
    for (const n of conv.nodes) {
      hiddenCount += n.hidden;
      if (n.branch_pos !== null) branchCount++;
    }
    const snap = this.q.insertSnapshot.run(
      source, conv.id, conv.version_time, importId, conv.current_node,
      conv.nodes.length, branchCount, hiddenCount, zlib.deflateSync(typeof raw === 'string' ? raw : JSON.stringify(raw)),
    );
    const snapshotId = Number(snap.lastInsertRowid);
    for (const n of conv.nodes) {
      this.q.insertNode.run(snapshotId, n.node_id, n.parent_id, n.seq, n.branch_pos, n.role, n.author_name,
        n.recipient, n.content_type, n.model, n.create_time, n.hidden, n.hidden_reason, n.text,
        storedCleanText(n.text, n.search_text));
      for (const a of n.attachments) {
        this.q.insertAttachment.run(snapshotId, n.node_id, a.kind, a.file_id, a.name, a.mime_type, a.size);
      }
    }

    const existing = this.q.getConversation.get(source, conv.id);
    const meta = [conv.title, conv.create_time, conv.update_time, conv.version_time, conv.model,
      conv.gizmo_id, conv.gizmo_type, conv.gizmo_kind, snapshotId];
    if (!existing) {
      this.q.insertConversation.run(source, conv.id, ...meta, importId, importId);
      this._index(source, conv);
      return 'new';
    }
    if (conv.version_time >= existing.version_time) {
      this.q.updateConversation.run(...meta, importId, source, conv.id);
      this._index(source, conv);
      return 'updated';
    }
    // An older export imported after a newer one: keep the snapshot, but not as the current view.
    this.q.touch.run(importId, source, conv.id);
    return 'older';
  }

  // ---------------- reads (used by the tools)

  getConversation(id, source = 'chatgpt') {
    return this.q.getConversation.get(source, id);
  }

  snapshotsOf(id, source = 'chatgpt') {
    return this.db.prepare(`SELECT id, version_time, import_id, current_node, node_count, branch_count, hidden_count
      FROM snapshots WHERE source = ? AND conversation_id = ? ORDER BY version_time`).all(source, id);
  }

  /** Current branch in order; hidden nodes only when asked. */
  branch(snapshotId, { includeHidden = false } = {}) {
    return this.db.prepare(`SELECT * FROM nodes WHERE snapshot_id = ? AND branch_pos IS NOT NULL
      ${includeHidden ? '' : 'AND hidden = 0'} ORDER BY branch_pos`).all(snapshotId);
  }

  nodes(snapshotId) {
    return this.db.prepare('SELECT * FROM nodes WHERE snapshot_id = ? ORDER BY seq').all(snapshotId);
  }

  attachments(snapshotId) {
    return this.db.prepare('SELECT * FROM attachments WHERE snapshot_id = ? ORDER BY rowid').all(snapshotId);
  }

  raw(snapshotId) {
    const row = this.db.prepare('SELECT raw FROM snapshots WHERE id = ?').get(snapshotId);
    return row ? JSON.parse(zlib.inflateSync(row.raw).toString('utf8')) : null;
  }

  stats(source = 'chatgpt') {
    const c = this.db.prepare(`SELECT count(*) AS conversations, min(create_time) AS first_time,
      max(update_time) AS last_time FROM conversations WHERE source = ?`).get(source);
    const s = this.db.prepare('SELECT count(*) AS snapshots FROM snapshots WHERE source = ?').get(source);
    return { ...c, ...s };
  }

  /** Conversations whose id starts with `prefix` (newest first, at most `limit`). */
  findByIdPrefix(prefix, { limit = 10, source = 'chatgpt' } = {}) {
    const like = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`) + '%';
    return this.db.prepare(`SELECT id, title, create_time, update_time FROM conversations
      WHERE source = ? AND id LIKE ? ESCAPE '\\' ORDER BY update_time DESC LIMIT ?`).all(source, like, limit);
  }

  /**
   * Browse conversations, newest first. Times are seconds since epoch; a conversation is kept
   * when its active period [create_time, update_time] overlaps [since, until].
   */
  listConversations({ titleContains = null, since = null, until = null, project = null, limit = 20, offset = 0, source = 'chatgpt' } = {}) {
    const where = ['c.source = ?'];
    const args = [source];
    if (titleContains) {
      where.push("instr(lower(coalesce(c.title, '')), lower(?)) > 0");
      args.push(titleContains);
    }
    if (since !== null) {
      where.push('coalesce(c.update_time, c.create_time, 0) >= ?');
      args.push(since);
    }
    if (until !== null) {
      where.push('coalesce(c.create_time, c.update_time, 0) <= ?');
      args.push(until);
    }
    if (project) {
      where.push('(c.gizmo_id = ? OR c.gizmo_id LIKE ?)');
      args.push(project, `${project}%`);
    }
    const cond = where.join(' AND ');
    const total = this.db.prepare(`SELECT count(*) AS n FROM conversations c WHERE ${cond}`).get(...args).n;
    const rows = this.db.prepare(`SELECT c.*, (SELECT count(*) FROM nodes n WHERE n.snapshot_id = c.current_snapshot
        AND n.branch_pos IS NOT NULL AND n.hidden = 0) AS message_count
      FROM conversations c WHERE ${cond}
      ORDER BY coalesce(c.update_time, c.create_time) DESC, c.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { total, rows };
  }

  /** Visible messages that are not on the current branch (edits / regenerations). */
  offBranchCount(snapshotId) {
    return this.db.prepare(`SELECT count(*) AS n FROM nodes WHERE snapshot_id = ? AND branch_pos IS NULL
      AND hidden = 0`).get(snapshotId).n;
  }

  runningImport() {
    return this.db.prepare("SELECT * FROM imports WHERE status = 'running' ORDER BY id DESC LIMIT 1").get();
  }

  lastFinishedImport() {
    return this.db.prepare("SELECT * FROM imports WHERE status != 'running' ORDER BY id DESC LIMIT 1").get();
  }
}

module.exports = { Store, StoreError, SCHEMA_VERSION };
