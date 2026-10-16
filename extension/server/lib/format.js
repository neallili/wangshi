'use strict';
// Text rendering for tool results. Everything here ends up in front of Claude (and often the
// user), so it is plain Chinese, never paths or stack traces, and each response stays below
// MAX_CHARS (Claude Desktop struggles with single responses far above ~40K characters).

const MAX_CHARS = 38000;
// read_conversation pages: ~13K characters, so one page does not eat a large part of Claude's context.
const PAGE_CHARS = 13000;

const pad = (n) => String(n).padStart(2, '0');

/** Seconds since epoch -> "2024-05-01" (local time). */
function day(sec) {
  if (sec === null || sec === undefined) return '日期不详';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayTime(sec) {
  if (sec === null || sec === undefined) return '';
  const d = new Date(sec * 1000);
  return `${day(sec)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Parses "2024", "2024-05", "2024-05-01" or a full ISO time into seconds since epoch (local time).
 * With `end`, a partial date means the end of that year / month / day.
 * @returns {number|null|undefined} null when empty, undefined when not understood
 */
function parseDate(value, { end = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  const m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(s);
  if (m) {
    const y = +m[1];
    const mo = m[2] ? +m[2] - 1 : null;
    const d = m[3] ? +m[3] : null;
    let t;
    if (!end) t = new Date(y, mo ?? 0, d ?? 1);
    else if (d !== null) t = new Date(y, mo, d + 1);
    else if (mo !== null) t = new Date(y, mo + 1, 1);
    else t = new Date(y + 1, 0, 1);
    return Math.floor(t.getTime() / 1000) - (end ? 1 : 0);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Accepts a full id, a prefix, or a pasted chatgpt.com conversation link. */
function normalizeIdInput(input) {
  const s = String(input || '').trim();
  const link = /\/c\/([0-9a-f-]{8,})/i.exec(s);
  if (link) return link[1].toLowerCase();
  const full = UUID.exec(s);
  if (full) return full[0].toLowerCase();
  return s.toLowerCase();
}

const ROLE = { user: '用户', assistant: 'ChatGPT', tool: '工具', system: '系统' };
const HIDDEN = {
  visually_hidden: '界面上不显示', system: '系统消息', tool: '工具输出', tool_call: '工具调用',
  reasoning: '推理过程', context: '自定义说明或记忆', empty: '空消息',
};

function titleOf(conv) {
  return conv.title || '（无标题）';
}

/** Clean text by default (no ChatGPT UI markup / citation placeholders); original text with raw. */
function renderMessage(n, attachments, { raw = false } = {}) {
  const who = ROLE[n.role] || n.role || '（未知）';
  const when = n.create_time ? `（${dayTime(n.create_time)}）` : '';
  const hidden = n.hidden ? ` [隐藏：${HIDDEN[n.hidden_reason] || n.hidden_reason}]` : '';
  const files = attachments.filter((a) => a.name).map((a) => a.name);
  const att = files.length ? `\n[附件：${files.join('、')}]` : '';
  const text = raw || n.search_text === null || n.search_text === undefined ? n.text : n.search_text;
  return `### ${who}${when}${hidden}\n${text}${att}\n`;
}

/** Splits rendered messages into pages of about PAGE_CHARS, breaking long messages if needed. */
function paginate(blocks) {
  const pages = [];
  let cur = '';
  for (let b of blocks) {
    while (b.length > PAGE_CHARS) {
      if (cur) {
        pages.push(cur);
        cur = '';
      }
      pages.push(b.slice(0, PAGE_CHARS) + '\n（这条消息很长，下一页继续）\n');
      b = b.slice(PAGE_CHARS);
    }
    if (cur.length + b.length > PAGE_CHARS && cur) {
      pages.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + b;
  }
  if (cur || !pages.length) pages.push(cur);
  return pages;
}

function clip(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + '\n\n（内容太长，后面的已省略）';
}

module.exports = { MAX_CHARS, PAGE_CHARS, day, dayTime, parseDate, normalizeIdInput, titleOf, renderMessage, paginate, clip };
