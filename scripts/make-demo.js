'use strict';
// Builds dist/demo/ — a folder holding a synthetic ChatGPT export zip (test/fixtures/export-v1),
// for trying the installed extension without real data: pick dist/demo in
// 设置 → 扩展 → 往事 → Browse. Remove ~/.wangshi afterwards so the demo data does not mix with real data.
const fs = require('fs');
const path = require('path');
const { zipFolder } = require('../test/helpers/zip-writer');

const out = path.join(__dirname, '..', 'dist', 'demo');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
zipFolder(path.join(__dirname, '..', 'test', 'fixtures', 'export-v1'), path.join(out, 'demo-2025-10-14-09-00-00.zip'));
console.log(`demo export written to ${out}`);
