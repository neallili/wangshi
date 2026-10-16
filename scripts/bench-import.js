'use strict';
// Import benchmark on synthetic data (no real content). The export is generated into a temp
// folder (written incrementally), then preview + import run in a fresh child process (through the
// same worker the extension uses) so the reported peak memory belongs to the import alone.
//
//   node scripts/bench-import.js [--conversations 3500] [--files 2] [--messages 40] [--chars 400] [--zip]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;

async function measure(exportPath) {
  const { findExport } = require('../extension/server/lib/source');
  const { previewInWorker, importInWorker } = require('../extension/server/lib/import-worker');
  const found = findExport({ exportPath, downloadsDir: os.tmpdir() });
  if (!found.ok) throw new Error(found.message);
  const { candidate, origin } = found;
  const dbPath = path.join(path.dirname(exportPath), 'db', 'wangshi.db');
  let t = Date.now();
  const p = await previewInWorker({ candidate, origin });
  const previewMs = Date.now() - t;
  t = Date.now();
  const r = await importInWorker({ candidate, origin, dbPath, expectedTotal: p.count });
  const importMs = Date.now() - t;
  t = Date.now();
  const r2 = await importInWorker({ candidate, origin, dbPath });
  const reimportMs = Date.now() - t;
  const dbFile = dbPath;
  return {
    node: process.version, count: p.count, previewMs, imported: r.new, importOk: r.ok, importMs,
    unchanged: r2.unchanged, reimportMs, peakRss: process.resourceUsage().maxRSS * 1024, dbBytes: fs.statSync(dbFile).size,
  };
}

function generate(dir, { conversations, files, messages, chars }) {
  const { longConversation } = require('../test/helpers/long-conversation');
  const exportDir = path.join(dir, 'export');
  fs.mkdirSync(exportDir);
  fs.writeFileSync(path.join(exportDir, 'chat.html'), '');
  for (let f = 0; f < files; f++) {
    const fd = fs.openSync(path.join(exportDir, files === 1 ? 'conversations.json' : `conversations-${String(f).padStart(3, '0')}.json`), 'w');
    fs.writeSync(fd, '[');
    let first = true;
    for (let i = f; i < conversations; i += files) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      fs.writeSync(fd, (first ? '' : ',\n') + JSON.stringify(longConversation({ id, turns: messages / 2, charsPerMessage: chars })));
      first = false;
    }
    fs.writeSync(fd, ']');
    fs.closeSync(fd);
  }
  return exportDir;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--measure') {
    process.stdout.write(JSON.stringify(await measure(args[1])));
    return;
  }
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? Number(args[i + 1]) : dflt;
  };
  const cfg = { conversations: opt('conversations', 3500), files: opt('files', 2), messages: opt('messages', 40), chars: opt('chars', 400) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangshi-bench-'));
  try {
    const exportDir = generate(dir, cfg);
    const sizes = fs.readdirSync(exportDir).filter((n) => n.endsWith('.json')).map((n) => fs.statSync(path.join(exportDir, n)).size);
    let target = exportDir;
    let zipInfo = '';
    if (args.includes('--zip')) {
      const { zipFolder } = require('../test/helpers/zip-writer');
      target = path.join(dir, 'export.zip');
      zipFolder(exportDir, target);
      zipInfo = `, zip ${mb(fs.statSync(target).size)}`;
    }
    console.log(`${cfg.conversations} conversations in ${cfg.files} file(s): largest json ${mb(Math.max(...sizes))}, total ${mb(sizes.reduce((a, b) => a + b, 0))}${zipInfo}`);
    const out = JSON.parse(execFileSync(process.execPath, ['--no-warnings', __filename, '--measure', target], { encoding: 'utf8', maxBuffer: 1 << 20 }));
    console.log(`${out.node}: preview ${out.count} in ${out.previewMs} ms; import ${out.importOk ? 'ok' : 'FAILED'} new=${out.imported} in ${out.importMs} ms; ` +
      `re-import unchanged=${out.unchanged} in ${out.reimportMs} ms; peak RSS ${mb(out.peakRss)}; db ${mb(out.dbBytes)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
