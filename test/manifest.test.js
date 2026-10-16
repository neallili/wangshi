'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../extension/manifest.json');
const pkg = require('../extension/package.json');
const { TOOLS } = require('../extension/server/tools');
const { EXPORT_PATH_DESCRIPTION } = require('../extension/server/lib/messages');

test('manifest matches the server', () => {
  assert.equal(manifest.name, 'wangshi');
  assert.equal(manifest.display_name, '往事 Wangshi');
  assert.equal(manifest.version, pkg.version);
  assert.deepEqual(manifest.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  const ep = manifest.user_config.export_path;
  assert.equal(ep.type, 'directory');
  assert.equal(ep.required, false);
  assert.ok(ep.description.startsWith(EXPORT_PATH_DESCRIPTION));
  assert.equal(manifest.server.mcp_config.env.WANGSHI_EXPORT_PATH, '${user_config.export_path}');
  assert.deepEqual(pkg.dependencies, {});
});

test('brand rule: no OpenAI brand words other than ChatGPT / GPT', () => {
  const text = JSON.stringify([manifest, TOOLS]);
  assert.doesNotMatch(text, /OpenAI|DALL|Sora|Codex|Whisper|Afterchat/i);
});

test('icon: a 512×512 PNG inside the bundle, identical to assets/logo-512.png', () => {
  const fs = require('fs');
  const path = require('path');
  const ext = path.join(__dirname, '..', 'extension');
  assert.equal(manifest.icon, 'icon.png');
  const png = fs.readFileSync(path.join(ext, manifest.icon));
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [512, 512]);
  assert.ok(png.equals(fs.readFileSync(path.join(__dirname, '..', 'assets', 'logo-512.png'))));
});
