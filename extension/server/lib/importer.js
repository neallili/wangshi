'use strict';
// Preview and import of a located export. Files are streamed one conversation at a time, and
// conversations are committed in batches so that progress is visible to other connections
// (status) and an interrupted import can simply be re-run.
const { iterateConversations, looksLikeClaudeConversation, SourceError } = require('./source');
const { normalizeConversation } = require('./chatgpt');
const msg = require('./messages');

// A batch is committed at 200 conversations or ~8M characters of JSON, whichever comes first,
// so a run of huge conversations cannot pile up in memory.
const BATCH = 200;
const BATCH_CHARS = 8 * 1024 * 1024;

function asFailure(e) {
  if (e instanceof SourceError) return { ok: false, code: e.code, message: e.message };
  throw e;
}

const totalBytes = (candidate) => candidate.files.reduce((s, f) => s + (f.bytes || 0), 0);

/** Reads the export once to tell the user what was found. Nothing is written. */
async function previewExport({ candidate, origin }) {
  let count = 0;
  let firstTime = null;
  let lastTime = null;
  try {
    for (const file of candidate.files) {
      for await (const { value: c } of iterateConversations(candidate, file)) {
        if (looksLikeClaudeConversation(c)) return { ok: false, code: 'claude_export', message: msg.looksLikeClaude(origin) };
        if (!c || typeof c !== 'object' || !c.mapping) continue;
        count++;
        const ct = typeof c.create_time === 'number' ? c.create_time * 1000 : null;
        const ut = typeof c.update_time === 'number' ? c.update_time * 1000 : ct;
        if (ct !== null && (firstTime === null || ct < firstTime)) firstTime = ct;
        if (ut !== null && (lastTime === null || ut > lastTime)) lastTime = ut;
      }
    }
  } catch (e) {
    return asFailure(e);
  }
  if (!count) return { ok: false, code: 'empty', message: msg.emptyExport(origin) };
  return {
    ok: true, count, firstTime, lastTime, exportDate: candidate.exportDate,
    message: msg.foundPreview({ origin, exportDate: candidate.exportDate, count, firstTime, lastTime }),
  };
}

/**
 * Imports every conversations*.json of the candidate. Safe to re-run: unchanged conversations
 * are skipped, changed ones get a new snapshot. `expectedTotal` (from the preview) makes the
 * conversation progress exact; byte progress is always available.
 */
async function runImport({ store, candidate, origin, expectedTotal = null, onProgress = () => {} }) {
  const importId = store.beginImport({
    origin, kind: candidate.kind, exportDate: candidate.exportDate,
    filesTotal: candidate.files.length, bytesTotal: totalBytes(candidate),
  });
  const counts = { new: 0, updated: 0, unchanged: 0, older: 0, invalid: 0 };
  let done = 0;
  let bytesDone = 0;
  let filesDone = 0;
  store.updateImport(importId, { convs_total: expectedTotal });

  const report = () => {
    store.updateImport(importId, {
      files_done: filesDone, bytes_done: bytesDone, convs_done: done,
      convs_new: counts.new, convs_updated: counts.updated, convs_unchanged: counts.unchanged,
      convs_older: counts.older, convs_invalid: counts.invalid,
    });
    onProgress({
      importId, done, total: expectedTotal, filesDone, filesTotal: candidate.files.length,
      bytesDone, bytesTotal: totalBytes(candidate), ...counts,
    });
  };

  let batch = [];
  let batchChars = 0;
  const flush = () => {
    if (!batch.length) return;
    batchChars = 0;
    store.transaction(() => {
      for (const { value, text } of batch) {
        const conv = normalizeConversation(value);
        if (conv) counts[store.importConversation(importId, conv, text)]++;
        else counts.invalid++;
        done++;
      }
      batch = [];
      report();
    });
  };

  try {
    for (const file of candidate.files) {
      for await (const item of iterateConversations(candidate, file, { onBytes: (n) => { bytesDone += n; } })) {
        if (looksLikeClaudeConversation(item.value)) throw new SourceError('claude_export', msg.looksLikeClaude(origin));
        batch.push(item);
        batchChars += item.text.length;
        if (batch.length >= BATCH || batchChars >= BATCH_CHARS) flush();
      }
      flush();
      filesDone++;
      report();
    }
  } catch (e) {
    // Conversations parsed before a damaged spot are still worth keeping.
    if (e instanceof SourceError && e.code === 'unreadable') flush();
    const code = e instanceof SourceError ? e.code : 'internal';
    store.finishImport(importId, 'failed', code);
    if (e instanceof SourceError) return { ok: false, importId, code, message: e.message, ...counts };
    return { ok: false, importId, code, message: msg.importFailed(), error: e, ...counts };
  }
  store.finishImport(importId, 'done');
  return {
    ok: true, importId, ...counts,
    message: msg.importDone({ added: counts.new, updated: counts.updated, unchanged: counts.unchanged }),
  };
}

module.exports = { previewExport, runImport };
