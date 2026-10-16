'use strict';
// Runs preview / import on a worker thread. Two reasons:
//  1. Memory: streaming allocates a lot of short-lived garbage; capping the worker's young
//     generation keeps peak RSS ~230 MB instead of ~330 MB for a 192 MB export (Claude Desktop
//     gives us no way to pass V8 flags to the extension process itself).
//  2. The MCP server's own thread stays free, so `status` can answer during an import.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const RESOURCE_LIMITS = { maxYoungGenerationSizeMb: 16 };

/**
 * @param {'preview'|'import'} task
 * @param {{candidate: object, origin: string, dbPath?: string, expectedTotal?: number}} args
 * @param {(progress: object) => void} [onProgress]
 * @returns {Promise<object>} the same result object previewExport / runImport return
 */
function runInWorker(task, args, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { task, ...args }, resourceLimits: RESOURCE_LIMITS });
    let settled = false;
    worker.on('message', (m) => {
      if (m.type === 'progress') onProgress(m.progress);
      else if (m.type === 'result') {
        settled = true;
        resolve(m.result);
      }
    });
    worker.on('error', (e) => {
      settled = true;
      reject(e);
    });
    worker.on('exit', (code) => {
      if (!settled) reject(new Error(`import worker exited with code ${code}`));
    });
  });
}

async function workerMain() {
  const { previewExport, runImport } = require('./importer');
  const { task, candidate, origin, dbPath, expectedTotal } = workerData;
  if (task === 'migrate') {
    const { Store } = require('./store');
    let result = { ok: true };
    try {
      new Store(dbPath).close(); // opening upgrades the schema
    } catch (e) {
      result = { ok: false, code: e.code === 'no_fts5' ? 'no_fts5' : 'internal', error: String(e && e.stack) };
    }
    parentPort.postMessage({ type: 'result', result });
    return;
  }
  if (task === 'preview') {
    parentPort.postMessage({ type: 'result', result: await previewExport({ candidate, origin }) });
    return;
  }
  const { Store } = require('./store');
  const store = new Store(dbPath);
  let result;
  try {
    result = await runImport({
      store, candidate, origin, expectedTotal,
      onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress }),
    });
  } finally {
    store.close();
  }
  if (result.error) result.error = String(result.error && result.error.stack);
  parentPort.postMessage({ type: 'result', result });
}

// An unhandled rejection ends the worker and surfaces as its 'error' event.
if (!isMainThread && workerData && workerData.task) workerMain();

module.exports = {
  previewInWorker: (args) => runInWorker('preview', args),
  importInWorker: (args, onProgress) => runInWorker('import', args, onProgress),
  migrateInWorker: (args) => runInWorker('migrate', args),
};
