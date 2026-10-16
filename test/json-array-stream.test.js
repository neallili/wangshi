'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ArraySplitter, JsonArrayError } = require('../extension/server/lib/json-array-stream');
const { FIXTURES } = require('./helpers/tmp');

function split(text, chunkSize) {
  const s = new ArraySplitter();
  const out = [];
  for (let i = 0; i < text.length; i += chunkSize) out.push(...s.push(text.slice(i, i + chunkSize)));
  s.end();
  return out;
}

const tricky = [
  { a: '含有 } 和 ] 和 { 的字符串', b: '引号 \\" 和反斜杠 \\\\ 结尾\\' },
  { nested: [[{}], { x: [1, 2, { y: '}' }] }], empty: {} },
  { esc: 'a\\\\"b', unicode: '中😀', newline: 'l1\nl2' },
];

test('splits every element at any chunk boundary', () => {
  const text = '﻿ [\n' + tricky.map((o) => JSON.stringify(o)).join(' ,\n') + '\n]\n';
  for (const size of [1, 2, 3, 7, 64, text.length]) {
    const objs = split(text, size).map((t) => JSON.parse(t));
    assert.deepEqual(objs, tricky, `chunk size ${size}`);
  }
});

test('fixture files split into the same objects JSON.parse sees', () => {
  for (const f of ['export-v1/conversations-000.json', 'export-v1/conversations-001.json']) {
    const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    assert.deepEqual(split(text, 97).map((t) => JSON.parse(t)), JSON.parse(text));
  }
});

test('non-object elements are skipped; empty array is fine', () => {
  assert.deepEqual(split('[1, "x", null, [ {"a":1} ], {"b":2}]', 4), ['{"b":2}']);
  assert.deepEqual(split('[]', 1), []);
});

test('rejects truncated, non-array and trailing content', () => {
  assert.throws(() => split('[{"a":1}, {"b":', 3), JsonArrayError);
  assert.throws(() => split('{"a":1}', 3), JsonArrayError);
  assert.throws(() => split('[{"a":1}] x', 3), JsonArrayError);
  assert.throws(() => split('', 3), JsonArrayError);
});
