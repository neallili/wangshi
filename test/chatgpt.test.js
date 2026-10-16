'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { normalizeConversation } = require('../extension/server/lib/chatgpt');
const { longConversation } = require('./helpers/long-conversation');
const { FIXTURES } = require('./helpers/tmp');

const v1 = [
  ...JSON.parse(fs.readFileSync(path.join(FIXTURES, 'export-v1/conversations-000.json'), 'utf8')),
  ...JSON.parse(fs.readFileSync(path.join(FIXTURES, 'export-v1/conversations-001.json'), 'utf8')),
];
const byPrefix = (p) => normalizeConversation(v1.find((c) => c.id.startsWith(p)));
const visible = (conv) => conv.nodes.filter((n) => n.branch_pos !== null && !n.hidden)
  .sort((a, b) => a.branch_pos - b.branch_pos);

test('linear conversation: system node hidden, metadata kept', () => {
  const a = byPrefix('a');
  assert.equal(a.title, '温哥华买房讨论');
  assert.equal(a.model, 'gpt-4o');
  assert.equal(a.create_time, 1700000000.5);
  assert.equal(a.version_time, 1700000300.25);
  assert.deepEqual(visible(a).map((n) => n.node_id), ['a-u1', 'a-a1', 'a-u2', 'a-a2']);
  assert.equal(a.nodes.find((n) => n.node_id === 'a-sys').hidden_reason, 'visually_hidden');
  assert.equal(a.nodes.find((n) => n.node_id === 'a-root').hidden_reason, 'empty');
  assert.equal(a.nodes.length, 6);
});

test('edit branches: current_node decides the default view, other branches are kept', () => {
  const b = byPrefix('b');
  assert.deepEqual(visible(b).map((n) => n.node_id), ['b-u1e', 'b-a2r']);
  const off = b.nodes.filter((n) => n.branch_pos === null).map((n) => n.node_id).sort();
  assert.deepEqual(off, ['b-a1', 'b-a2', 'b-u1']);
  assert.equal(b.nodes.find((n) => n.node_id === 'b-u1').text, '原始问题：怎么学习 Rust？');
});

test('tool calls, tool output, reasoning and custom instructions are hidden with a reason', () => {
  const c = byPrefix('c');
  const reason = Object.fromEntries(c.nodes.map((n) => [n.node_id, n.hidden_reason]));
  assert.deepEqual(reason, {
    'c-root': 'empty', 'c-ctx': 'visually_hidden', 'c-u1': null, 'c-a1': 'tool_call',
    'c-t1': 'tool', 'c-th': 'reasoning', 'c-q': 'tool', 'c-a2': null,
  });
  assert.deepEqual(visible(c).map((n) => n.text), ['帮我算一下 2 的 10 次方', '结果是 1024。']);
  // Hidden content is still kept as text for include_hidden.
  assert.equal(c.nodes.find((n) => n.node_id === 'c-t1').text, '1024');
  assert.match(c.nodes.find((n) => n.node_id === 'c-a1').text, /print\(2 \*\* 10\)/);
  assert.match(c.nodes.find((n) => n.node_id === 'c-th').text, /核对结果/);
});

test('attachments: file metadata, image pointers, attachment-only messages stay visible', () => {
  const d = byPrefix('d');
  const u1 = d.nodes.find((n) => n.node_id === 'd-u1');
  assert.equal(u1.text, '[图片]\n这张图里是什么？');
  assert.deepEqual(u1.attachments.map((a) => [a.kind, a.name]), [['file', 'photo.png'], ['image', null]]);
  const u2 = d.nodes.find((n) => n.node_id === 'd-u2');
  assert.equal(u2.hidden, 0);
  assert.deepEqual(u2.attachments[0], { kind: 'file', file_id: 'file-CSV0001', name: 'data.csv', mime_type: 'text/csv', size: 300 });
  assert.equal(d.nodes.find((n) => n.node_id === 'd-u3').attachments[0].name, '合同草稿.pdf');
});

test('empty and null titles become null; model falls back to the branch', () => {
  const e = byPrefix('e');
  assert.equal(e.title, null);
  assert.equal(e.model, 'gpt-4o-mini');
  assert.equal(byPrefix('f').title, null);
});

test('missing current_node falls back to the latest leaf; projects and GPTs are told apart', () => {
  const f = byPrefix('f');
  assert.equal(f.current_node, 'f-a1b');
  assert.deepEqual(visible(f).map((n) => n.node_id), ['f-u1', 'f-a1b']);
  assert.equal(f.gizmo_kind, 'project');
  const g = byPrefix('g');
  assert.equal(g.id, 'g0000000-0000-4000-8000-000000000007'); // only "id", no "conversation_id"
  assert.equal(g.gizmo_kind, 'gpt');
  assert.equal(byPrefix('a').gizmo_kind, null);
});

test('objects without mapping or id are rejected', () => {
  assert.equal(byPrefix('z'), null);
  assert.equal(normalizeConversation({ mapping: {} }), null);
  assert.equal(normalizeConversation(null), null);
});

test('parent cycles do not hang', () => {
  const conv = normalizeConversation({
    id: 'cycle', current_node: 'x', mapping: {
      x: { parent: 'y', children: [], message: { author: { role: 'user' }, content: { parts: ['x'] } } },
      y: { parent: 'x', children: ['x'], message: { author: { role: 'user' }, content: { parts: ['y'] } } },
    },
  });
  assert.equal(conv.nodes.filter((n) => n.branch_pos !== null).length, 2);
});

test('very long conversation (3,000 messages, ~6M chars)', () => {
  const raw = longConversation({ turns: 1500, charsPerMessage: 2000 });
  const conv = normalizeConversation(raw);
  const branch = visible(conv);
  assert.equal(branch.length, 3000);
  assert.equal(branch[0].node_id, 'l-0');
  assert.equal(branch[2999].node_id, 'l-2999');
});
