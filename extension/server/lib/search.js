'use strict';
// search() — the interface the `search` tool depends on.
//
// Implementation ("Seg OR bm25", the winner of the retrieval benchmark in scripts/m0-bench.js):
//  - query and documents are segmented with Intl.Segmenter (tokenize.js); query terms are words or
//    phrases (stitched single characters), without function words and lone single characters;
//  - FTS5 matches conversations containing ANY of the query terms;
//  - order: bm25 with the title weighted 10× the body (more words, rarer words, title hits rank
//    higher), ties broken by most recently updated;
//  - snippet: from the clean text of the visible message that contains the most query words.
const { queryTerms, matchAny } = require('./tokenize');

const SNIPPET_RADIUS = 200;
const TITLE_WEIGHT = 10.0;

function countOcc(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function snippetAround(text, words) {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = w.length;
    }
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + len + SNIPPET_RADIUS);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/**
 * @param {import('./store').Store} store
 * @param {{query: string, since?: number|null, until?: number|null, limit?: number}} q
 *   since/until: seconds since epoch; a conversation matches when its active period overlaps.
 * @returns {{terms: string[], results: Array<{id: string, title: string|null, create_time: number|null,
 *   update_time: number|null, match: 'all'|'some', matched_terms: string[], title_hits: number,
 *   hits: number, role: string|null, snippet: string}>}}
 *   terms: the query terms actually searched for (after segmentation and filtering).
 */
function search(store, { query, since = null, until = null, limit = 10 }) {
  const qterms = queryTerms(query);
  const terms = qterms.map((t) => t.text);
  if (!terms.length) return { terms, results: [] };
  const cond = [];
  const args = [matchAny(qterms)];
  if (since !== null && since !== undefined) {
    cond.push('coalesce(c.update_time, c.create_time, 0) >= ?');
    args.push(since);
  }
  if (until !== null && until !== undefined) {
    cond.push('coalesce(c.create_time, c.update_time, 0) <= ?');
    args.push(until);
  }
  const rows = store.db.prepare(`SELECT c.id, c.title, c.create_time, c.update_time, c.current_snapshot
    FROM search_index s JOIN conversations c ON c.rowid = s.rowid
    WHERE search_index MATCH ? AND c.source = 'chatgpt'${cond.map((x) => ` AND ${x}`).join('')}
    ORDER BY bm25(search_index, ${TITLE_WEIGHT}, 1.0), coalesce(c.update_time, c.create_time) DESC
    LIMIT ?`).all(...args, limit);

  const messages = store.db.prepare(`SELECT role, coalesce(search_text, text) AS text FROM nodes WHERE snapshot_id = ?
    AND branch_pos IS NOT NULL AND hidden = 0 ORDER BY branch_pos`);
  const results = rows.map((c) => {
    const title = (c.title || '').toLowerCase();
    const present = new Set(terms.filter((t) => title.includes(t)));
    const titleHits = present.size;
    let hits = 0;
    let best = null;
    let bestScore = 0;
    for (const m of messages.all(c.current_snapshot)) {
      if (!m.text) continue;
      const lower = m.text.toLowerCase();
      let distinct = 0;
      for (const t of terms) {
        const n = countOcc(lower, t);
        if (n) {
          distinct++;
          hits += n;
          present.add(t);
        }
      }
      if (distinct > bestScore) {
        bestScore = distinct;
        best = m;
      }
    }
    return {
      id: c.id, title: c.title, create_time: c.create_time, update_time: c.update_time,
      match: present.size === terms.length ? 'all' : 'some',
      matched_terms: terms.filter((t) => present.has(t)),
      title_hits: titleHits, hits,
      role: best ? best.role : null,
      snippet: best ? snippetAround(best.text, terms) : '',
    };
  });
  return { terms, results };
}

module.exports = { search };
