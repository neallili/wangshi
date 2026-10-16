'use strict';
// "Clean text" for search and snippets: ChatGPT UI component markup and citation placeholders
// removed, readable text kept. Computed at import time and stored next to the original text;
// the original text and raw JSON are never modified.
//
// What ChatGPT puts into message text (seen in real exports, 2023–2026):
//  - Private-use placeholders: U+E200 <kind> U+E202 <field> (U+E202 <field>)* U+E201
//      kinds: cite, filecite, memcite, navlist, image_group, products, … → dropped
//             entity ["category","Display name",…], product_entity → display name kept
//    U+E203 <cited sentence> U+E204 wraps quoted text (kept), U+E205/U+E206 are bare markers.
//  - Old style citations: 【12†source】, 【3:1†source】
//  - UI components: <text color=…>…</text>, <box>, <row>, <Cite refs=[…] />, <Link url=…>label</Link>,
//    <AsyncImage …/>, <icon …/>, <divider/>, <Entity …/>, <WritingBlock id=…>, … → tags dropped, inner text kept
//  - Canvas / writing blocks: ":::writing{…}" header line and the closing ":::" line

const BLOCK = /\ue200([A-Za-z_]+)((?:\ue202[^\ue200\ue201]*)*)\ue201/g;
const NAMED = new Set(['entity', 'product_entity']);
const COMPONENTS = [
  'text', 'box', 'row', 'Cite', 'icon', 'AsyncImage', 'AsyncImageGroup', 'divider', 'Entity', 'Link', 'caption',
  'grid', 'grid-item', 'WritingBlock', 'badge', 'MemoryCite', 'FileCite', 'CodeCite', 'MapWidgetV2', 'list-item',
];
// Component tags are stripped outside fenced code blocks only: real code (SVG <text x=…>, HTML) stays intact.
const TAG = new RegExp(`</?(?:${COMPONENTS.map((t) => t.replace('-', '\\-')).join('|')})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'g');
const OLD_CITE = /【\d+(?::\d+)?†[^】]{0,40}】/g;
const FENCE_OPEN = /^[ \t]*:::[A-Za-z_-]+(?:\{[^\n]*\})?[ \t]*$/gm;
const FENCE_CLOSE = /^[ \t]*:::[ \t]*$/gm;
const PUA = /[\ue000-\uf8ff]/g;

function entityName(fields) {
  const first = fields.split('\ue202')[1] || '';
  try {
    const v = JSON.parse(first);
    if (Array.isArray(v)) return typeof v[1] === 'string' ? v[1] : '';
    if (v && typeof v === 'object') return v.name || v.title || '';
  } catch {
    // not JSON: fall through
  }
  return '';
}

/** Applies fn to the parts of s that are not inside ``` fenced code blocks. */
function outsideCode(s, fn) {
  return s.split(/(^```[^\n]*\n[\s\S]*?^```[ \t]*$)/m).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

function cleanText(text) {
  if (!text) return '';
  let s = text;
  if (s.includes('\ue200')) s = s.replace(BLOCK, (_, kind, fields) => (NAMED.has(kind) ? entityName(fields) : ''));
  if (/[\ue000-\uf8ff]/.test(s)) s = s.replace(PUA, '');
  if (s.includes('【')) s = s.replace(OLD_CITE, '');
  if (s.includes('<')) s = outsideCode(s, (part) => part.replace(TAG, ''));
  if (s.includes(':::')) s = s.replace(FENCE_OPEN, '').replace(FENCE_CLOSE, '');
  return tidy(s);
}

/** Trailing spaces/tabs removed from every line. Linear: /[ \t]+\n/ is quadratic on long space runs. */
function trimLineEnds(s) {
  if (!s.includes(' \n') && !s.includes('\t\n')) return s;
  return s.split('\n').map((line) => {
    let end = line.length;
    while (end > 0 && (line.charCodeAt(end - 1) === 0x20 || line.charCodeAt(end - 1) === 0x09)) end--;
    return end === line.length ? line : line.slice(0, end);
  }).join('\n');
}

function tidy(s) {
  return trimLineEnds(s).replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Clean text worth storing next to the original: null when only whitespace would change,
 * so the (large) majority of messages without markup are not stored twice.
 */
function storedCleanText(text, clean = cleanText(text)) {
  return clean === tidy(text || '') ? null : clean;
}

module.exports = { cleanText, storedCleanText };
