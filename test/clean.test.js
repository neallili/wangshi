'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanText } = require('../extension/server/lib/clean');

const P = { open: '\ue200', sep: '\ue202', close: '\ue201', q1: '\ue203', q2: '\ue204', m: '\ue206' };

test('citation placeholders are dropped, entity names kept', () => {
  const cite = `${P.open}cite${P.sep}turn0search0${P.sep}turn0news3${P.close}`;
  const ent = `${P.open}entity${P.sep}["city","温哥华","加拿大城市"]${P.close}`;
  const mem = `${P.open}memcite${P.sep}abc${P.close}`;
  assert.equal(cleanText(`房价在上涨。${cite} ${ent}的公寓${mem}更贵。`), '房价在上涨。 温哥华的公寓更贵。');
  assert.equal(cleanText(`${P.open}filecite${P.sep}turn1file0${P.sep}L1-L9${P.close}结论`), '结论');
  assert.equal(cleanText(`${P.open}navlist${P.sep}最新消息${P.sep}turn0news1,turn0news2${P.close}`), '');
});

test('quoted spans keep their text, bare markers vanish', () => {
  assert.equal(cleanText(`${P.q1}利率下降了。${P.q2}${P.m} 后面`), '利率下降了。 后面');
});

test('old style citations and UI components', () => {
  assert.equal(cleanText('见文档【12†source】和【3:1†source】。'), '见文档和。');
  assert.equal(cleanText('<text color="red" size=14>重要</text><Cite refs=["turn0search1"] /> <Link url="https://x">链接</Link>'), '重要 链接');
  assert.equal(cleanText('<box flex=1><row align="center"><icon name="star"/>好评</row></box><divider color="gray"/>'), '好评');
});

test('writing block fences are removed, content kept', () => {
  assert.equal(cleanText('前言\n:::writing{id="1" variant="email"}\n正文\n:::\n结尾'), '前言\n\n正文\n\n结尾');
});

test('code blocks and ordinary text are untouched', () => {
  const code = '```svg\n<svg><text x="1">标签</text></svg>\n```';
  assert.equal(cleanText(`例子：\n${code}`), `例子：\n${code}`);
  assert.equal(cleanText('a < b 且 c > d，<html> 标签'), 'a < b 且 c > d，<html> 标签');
  assert.equal(cleanText('普通的中文句子。'), '普通的中文句子。');
  assert.equal(cleanText(''), '');
  assert.equal(cleanText(null), '');
});

test('read_conversation renders clean text by default and the original with raw', () => {
  const { renderMessage } = require('../extension/server/lib/format');
  const n = { role: 'assistant', create_time: null, hidden: 0, text: '<text color="red">重点</text>【1†source】', search_text: '重点' };
  assert.equal(renderMessage(n, []), '### ChatGPT\n重点\n');
  assert.equal(renderMessage(n, [], { raw: true }), '### ChatGPT\n<text color="red">重点</text>【1†source】\n');
  assert.equal(renderMessage({ ...n, search_text: null }, []), '### ChatGPT\n<text color="red">重点</text>【1†source】\n', 'falls back to original');
});

test('clean text is stored only when markup was removed', () => {
  const { storedCleanText } = require('../extension/server/lib/clean');
  assert.equal(storedCleanText('普通文字'), null);
  assert.equal(storedCleanText('  多余   空格  \n\n\n\n下一段 '), null, 'whitespace-only differences are not stored');
  assert.equal(storedCleanText('<text color="red">重点</text>'), '重点');
});

test('whitespace tidying is linear on long runs of spaces', () => {
  const s = 'a' + ' '.repeat(200000) + 'b\nc   \n';
  const t = Date.now();
  assert.equal(cleanText(s), 'a b\nc');
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t} ms`);
});
