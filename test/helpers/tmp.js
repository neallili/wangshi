'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Fresh temp dir per test file, removed at process exit. */
function tmpDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wangshi-${label}-`));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FIXTURES = path.join(__dirname, '..', 'fixtures');

module.exports = { tmpDir, FIXTURES };
