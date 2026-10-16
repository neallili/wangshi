'use strict';
// Locates a ChatGPT export (zip or unzipped folder) and reads its conversations*.json files.
// Exports are only ever read, never modified.
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { listEntries, entryChunks } = require('./zip');
const { ArraySplitter } = require('./json-array-stream');
const msg = require('./messages');

const CONV_FILE = /^conversations(-[^/\\]*)?\.json$/i;
// Files that only appear in ChatGPT exports / only in Claude exports.
const CHATGPT_MARKERS = new Set(['chat.html', 'message_feedback.json', 'user.json', 'model_comparisons.json', 'shared_conversations.json']);
const CLAUDE_MARKERS = new Set(['users.json']);
// e.g. "<hash>-2025-10-14-08-30-00.zip" or the folder Safari unpacks it into.
const NAME_DATE = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:\.zip)?$/i;

class SourceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  return { ok: false, code, message };
}

function isUnset(value) {
  return !value || !String(value).trim() || String(value).includes('${');
}

function naturalCompare(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

/** Classifies a set of file names sitting in one directory. */
function classify(names) {
  const lower = names.map((n) => n.toLowerCase());
  const convFiles = names.filter((n) => CONV_FILE.test(n)).sort(naturalCompare);
  if (!convFiles.length) return null;
  let product = 'unknown';
  if (lower.some((n) => CHATGPT_MARKERS.has(n))) product = 'chatgpt';
  else if (lower.some((n) => CLAUDE_MARKERS.has(n))) product = 'claude';
  return { product, convFiles };
}

function exportDateOf(name, stat) {
  const m = NAME_DATE.exec(name);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (!Number.isNaN(t)) return t;
  }
  return stat.mtimeMs;
}

/** Inspects a zip; returns a candidate or null. Only the central directory is read. */
function inspectZip(zipPath, stat) {
  let entries;
  try {
    entries = listEntries(zipPath);
  } catch {
    return null;
  }
  // Group entry names by directory, looking at the root and one folder down.
  const byDir = new Map();
  for (const e of entries) {
    if (e.isDirectory) continue;
    const parts = e.name.split('/');
    if (parts.length > 2) continue;
    const dir = parts.length === 2 ? parts[0] : '';
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(e);
  }
  for (const dir of [...byDir.keys()].sort()) {
    const group = byDir.get(dir);
    const base = (e) => e.name.split('/').pop();
    const c = classify(group.map(base));
    if (!c) continue;
    const files = c.convFiles.map((n) => {
      const entry = group.find((e) => base(e) === n);
      return { name: n, entry, bytes: entry.size };
    });
    return {
      kind: 'zip', path: zipPath, product: c.product, files,
      exportDate: exportDateOf(path.basename(zipPath), stat), mtime: stat.mtimeMs,
    };
  }
  return null;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Inspects an unzipped export folder (files at its root, or one folder down). */
function inspectDir(dirPath, stat, { nested = true } = {}) {
  const tryDir = (d) => {
    const names = safeReaddir(d).filter((e) => e.isFile()).map((e) => e.name);
    const c = classify(names);
    if (!c) return null;
    return {
      kind: 'dir', path: d, product: c.product,
      files: c.convFiles.map((n) => ({ name: n, bytes: fs.statSync(path.join(d, n)).size })),
      exportDate: exportDateOf(path.basename(dirPath), stat), mtime: stat.mtimeMs,
    };
  };
  const direct = tryDir(dirPath);
  if (direct || !nested) return direct;
  for (const e of safeReaddir(dirPath)) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      const inner = tryDir(path.join(dirPath, e.name));
      if (inner) return inner;
    }
  }
  return null;
}

function inspectPath(p, opts) {
  let stat;
  try {
    stat = fs.statSync(p);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return inspectDir(p, stat, opts);
  if (stat.isFile() && /\.zip$/i.test(p)) return inspectZip(p, stat);
  if (stat.isFile() && CONV_FILE.test(path.basename(p))) {
    return {
      kind: 'dir', path: path.dirname(p), product: 'unknown',
      files: [{ name: path.basename(p), bytes: stat.size }],
      exportDate: stat.mtimeMs, mtime: stat.mtimeMs,
    };
  }
  return null;
}

/** Scans one folder (non-recursively) for export zips and unzipped export folders. */
function scanFolder(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return { error: 'no_permission' };
    return { candidates: [] };
  }
  const candidates = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if ((e.isFile() && /\.zip$/i.test(e.name)) || e.isDirectory()) {
      const c = inspectPath(p);
      if (c) candidates.push(c);
    }
  }
  return { candidates };
}

function newestFirst(a, b) {
  return b.exportDate - a.exportDate || b.mtime - a.mtime;
}

/**
 * Finds the export to import.
 * @param {{exportPath?: string, downloadsDir: string}} opts
 * @returns {{ok: true, origin: string, candidate: object, others: number} | {ok: false, code: string, message: string}}
 */
function findExport({ exportPath, downloadsDir }) {
  if (!isUnset(exportPath)) {
    const origin = 'export_path';
    let candidates;
    const direct = inspectPath(exportPath, { nested: false });
    if (direct) candidates = [direct];
    else {
      // A plain folder (e.g. the Downloads folder itself) may have been picked.
      let isDir = false;
      try { isDir = fs.statSync(exportPath).isDirectory(); } catch {}
      candidates = isDir ? scanFolder(exportPath).candidates || [] : [];
    }
    return pick(candidates, origin, () => fail('export_path_invalid', msg.exportPathInvalid()));
  }
  const scanned = scanFolder(downloadsDir);
  if (scanned.error === 'no_permission') return fail('no_permission', msg.noPermission());
  return pick(scanned.candidates, 'downloads', () => fail('not_found', msg.notFound()));
}

function pick(candidates, origin, onNone) {
  const chatgpt = candidates.filter((c) => c.product !== 'claude').sort(newestFirst);
  if (chatgpt.length) return { ok: true, origin, candidate: chatgpt[0], others: chatgpt.length - 1 };
  if (candidates.length) return fail('claude_export', msg.looksLikeClaude(origin));
  return onNone();
}

function chunksOf(candidate, file) {
  if (candidate.kind === 'zip') return entryChunks(candidate.path, file.entry);
  return fs.createReadStream(path.join(candidate.path, file.name), { highWaterMark: 1 << 20 });
}

/**
 * Streams one conversations*.json file of a candidate, yielding `{ value, text }` per element
 * object: the parsed conversation and its original JSON text. Memory stays at about one
 * conversation, whatever the file size. `onBytes(n)` reports uncompressed bytes read.
 */
async function* iterateConversations(candidate, file, { onBytes = () => {} } = {}) {
  const splitter = new ArraySplitter();
  const decoder = new StringDecoder('utf8');
  const parse = (text) => {
    try {
      return { value: JSON.parse(text), text };
    } catch {
      throw new SourceError('unreadable', msg.unreadable());
    }
  };
  try {
    for await (const chunk of chunksOf(candidate, file)) {
      onBytes(chunk.length);
      const objects = splitter.push(decoder.write(chunk));
      for (const text of objects) yield parse(text);
    }
    for (const text of splitter.push(decoder.end())) yield parse(text);
    splitter.end();
  } catch (e) {
    if (e instanceof SourceError) throw e;
    if (e instanceof RangeError) throw new SourceError('too_large', msg.tooLarge());
    throw new SourceError('unreadable', msg.unreadable());
  }
}

/** True when an element looks like Claude's export rather than ChatGPT's. */
function looksLikeClaudeConversation(c) {
  return Boolean(c && typeof c === 'object' && !('mapping' in c) && Array.isArray(c.chat_messages));
}

module.exports = {
  findExport, iterateConversations, looksLikeClaudeConversation, scanFolder, inspectPath, SourceError, isUnset,
};
