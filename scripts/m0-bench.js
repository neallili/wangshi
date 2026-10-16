'use strict';
// Retrieval comparison on your own imported data, with your own question set.
//   node scripts/m0-bench.js [--db ~/.wangshi/wangshi.db] [--questions bench-out/m0-questions.json]
// The live database is only read (VACUUM INTO a private copy under bench-out/m0/). Output contains
// question ids, keyword-group numbers and ranks only — never conversation text or the keywords.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { cleanText } = require('../extension/server/lib/clean');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ROOT = path.join(__dirname, '..');
const DB = opt('db', path.join(os.homedir(), '.wangshi', 'wangshi.db'));
const QUESTIONS = opt('questions', path.join(ROOT, 'bench-out', 'm0-questions.json'));
const OUT = path.join(ROOT, 'bench-out', 'm0');
const TOP = 5;

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

// ---------------------------------------------------------------- data

function loadDocs() {
  fs.mkdirSync(OUT, { recursive: true });
  const copy = path.join(OUT, 'work.db');
  fs.rmSync(copy, { force: true });
  const live = new DatabaseSync(DB, { readOnly: true });
  live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
  live.close();
  const db = new DatabaseSync(copy);
  const convs = db.prepare(`SELECT id, title, create_time, update_time, current_snapshot FROM conversations
    WHERE source = 'chatgpt' ORDER BY rowid`).all();
  const msgs = db.prepare(`SELECT text, role FROM nodes WHERE snapshot_id = ? AND branch_pos IS NOT NULL AND hidden = 0
    ORDER BY branch_pos`);
  const docs = convs.map((c) => {
    const parts = msgs.all(c.current_snapshot);
    return {
      id: c.id, time: c.update_time ?? c.create_time ?? 0,
      title: cleanText(c.title || ''),
      body: parts.map((m) => cleanText(m.text)).join('\n'),
      rawBody: parts.map((m) => m.text).join('\n'),
      msgs: parts.map((m) => m.text),
    };
  });
  return { db, docs };
}

// ---------------------------------------------------------------- helpers

const seg = new Intl.Segmenter('zh', { granularity: 'word' });
const segTokens = (s) => [...seg.segment(s)].filter((x) => x.isWordLike).map((x) => x.segment.toLowerCase());
const splitTerms = (q) => q.trim().split(/\s+/).filter(Boolean);
const ftsQuote = (t) => `"${t.replace(/"/g, '""')}"`;

function countOcc(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Relevance order: title hits > occurrences in the body > newer first. */
function ruleRank(docs, ids, terms) {
  const lt = terms.map((t) => t.toLowerCase());
  return ids.map((i) => {
    const d = docs[i];
    const title = d.title.toLowerCase();
    const body = d.lowerBody;
    return {
      i,
      titleHits: lt.filter((t) => title.includes(t)).length,
      occ: lt.reduce((s, t) => s + countOcc(body, t), 0),
      time: d.time,
    };
  }).sort((a, b) => b.titleHits - a.titleHits || b.occ - a.occ || b.time - a.time).map((x) => x.i);
}

/** AND first; when fewer than TOP, append OR matches (ranked the same way, after). */
function andThenOr(docs, andIds, orIds, terms) {
  const first = ruleRank(docs, andIds, terms);
  if (first.length >= TOP || !orIds) return first;
  const seen = new Set(first);
  return first.concat(ruleRank(docs, orIds.filter((i) => !seen.has(i)), terms));
}

// ---------------------------------------------------------------- engines

function buildIndexes(db, docs) {
  const t = {};
  let t0 = now();
  for (const d of docs) d.lowerBody = (d.title + '\n' + d.body).toLowerCase();
  t.lower = now() - t0;

  t0 = now();
  db.exec('DROP TABLE IF EXISTS fts_seg; CREATE VIRTUAL TABLE fts_seg USING fts5(title, body, tokenize = "unicode61 remove_diacritics 2")');
  const insSeg = db.prepare('INSERT INTO fts_seg(rowid, title, body) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  docs.forEach((d, i) => insSeg.run(i, segTokens(d.title).join(' '), segTokens(d.body).join(' ')));
  db.exec('COMMIT');
  t.segmenter = now() - t0;

  t0 = now();
  db.exec('DROP TABLE IF EXISTS fts_tri; CREATE VIRTUAL TABLE fts_tri USING fts5(title, body, tokenize = "trigram")');
  const insTri = db.prepare('INSERT INTO fts_tri(rowid, title, body) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  docs.forEach((d, i) => insTri.run(i, d.title, d.body));
  db.exec('COMMIT');
  t.trigram = now() - t0;

  t0 = now();
  const tfidf = buildTfidf(docs);
  t.tfidf = now() - t0;
  return { t, tfidf };
}

// TF-IDF baseline equivalent to scikit-learn TfidfVectorizer defaults: token_pattern (?u)\b\w\w+\b,
// lowercase, smooth idf, l2 norm, cosine ranking. With this tokenizer a run of Chinese characters
// between punctuation is a single token — why default tokenization works poorly for Chinese.
const SK_TOKEN = /[\p{L}\p{N}\p{M}_]{2,}/gu;
const skTokens = (s) => s.toLowerCase().match(SK_TOKEN) || [];

function buildTfidf(docs) {
  const postings = new Map();
  docs.forEach((d, i) => {
    const tf = new Map();
    for (const tok of skTokens(d.title + '\n' + d.body)) tf.set(tok, (tf.get(tok) || 0) + 1);
    for (const [tok, n] of tf) {
      if (!postings.has(tok)) postings.set(tok, []);
      postings.get(tok).push([i, n]);
    }
  });
  const N = docs.length;
  const idf = new Map();
  for (const [tok, list] of postings) idf.set(tok, Math.log((1 + N) / (1 + list.length)) + 1);
  const norm = new Float64Array(N);
  for (const [tok, list] of postings) {
    const w = idf.get(tok);
    for (const [i, n] of list) norm[i] += (n * w) ** 2;
  }
  for (let i = 0; i < N; i++) norm[i] = Math.sqrt(norm[i]) || 1;
  return { postings, idf, norm };
}

function tfidfSearch(index, query) {
  const q = new Map();
  for (const tok of skTokens(query)) if (index.idf.has(tok)) q.set(tok, (q.get(tok) || 0) + 1);
  let qn = 0;
  for (const [tok, n] of q) qn += (n * index.idf.get(tok)) ** 2;
  qn = Math.sqrt(qn) || 1;
  const score = new Map();
  for (const [tok, n] of q) {
    const w = index.idf.get(tok);
    for (const [i, dn] of index.postings.get(tok)) score.set(i, (score.get(i) || 0) + (n * w * dn * w) / (qn * index.norm[i]));
  }
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([i]) => i);
}

function makeEngines(db, docs, tfidf, product) {
  const all = docs.map((_, i) => i);
  const byId = new Map(docs.map((d, i) => [d.id, i]));
  const segMatch = db.prepare('SELECT rowid FROM fts_seg WHERE fts_seg MATCH ?');
  const segBm25 = db.prepare('SELECT rowid FROM fts_seg WHERE fts_seg MATCH ? ORDER BY bm25(fts_seg, 10.0, 1.0) LIMIT 5');
  const triMatch = db.prepare('SELECT rowid FROM fts_tri WHERE fts_tri MATCH ?');
  const triBm25 = db.prepare('SELECT rowid FROM fts_tri WHERE fts_tri MATCH ? ORDER BY bm25(fts_tri, 10.0, 1.0) LIMIT 5');
  const ids = (stmt, q) => stmt.all(q).map((r) => Number(r.rowid));

  const subFilter = (cands, terms, mode) => {
    const lt = terms.map((t) => t.toLowerCase());
    return cands.filter((i) => (mode === 'and' ? lt.every((t) => docs[i].lowerBody.includes(t)) : lt.some((t) => docs[i].lowerBody.includes(t))));
  };

  // Segmenter + FTS5: query words come from the same segmenter as the documents.
  const segSets = (q) => {
    const toks = [...new Set(segTokens(q))];
    if (!toks.length) return { toks, and: [], or: [] };
    return { toks, and: ids(segMatch, toks.map(ftsQuote).join(' AND ')), or: ids(segMatch, toks.map(ftsQuote).join(' OR ')) };
  };
  // Trigram FTS5: terms of 3+ characters use the index; shorter terms fall back to substring.
  const triSets = (q) => {
    const terms = splitTerms(q);
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);
    const and = long.length ? subFilter(ids(triMatch, long.map(ftsQuote).join(' AND ')), short, 'and') : subFilter(all, short, 'and');
    const orLong = long.length ? ids(triMatch, long.map(ftsQuote).join(' OR ')) : [];
    const or = [...new Set([...orLong, ...subFilter(all, short, 'or')])];
    return { terms, long, and, or };
  };

  return {
    // The first search version: every term in the same message (raw text), newest first.
    'substring-shipped': (q) => {
      const terms = splitTerms(q).map((t) => t.toLowerCase());
      const out = [];
      for (const i of [...all].sort((a, b) => docs[b].time - docs[a].time)) {
        if (docs[i].msgs.some((m) => { const l = m.toLowerCase(); return terms.every((t) => l.includes(t)); })) out.push(i);
        if (out.length >= TOP) break;
      }
      if (out.length < TOP) {
        for (const i of [...all].sort((a, b) => docs[b].time - docs[a].time)) {
          if (out.length >= TOP) break;
          if (!out.includes(i) && terms.every((t) => docs[i].title.toLowerCase().includes(t))) out.push(i);
        }
      }
      return out;
    },
    substring: (q) => {
      const terms = splitTerms(q);
      return andThenOr(docs, subFilter(all, terms, 'and'), subFilter(all, terms, 'or'), terms);
    },
    'segmenter': (q) => {
      const s = segSets(q);
      return andThenOr(docs, s.and, s.or, s.toks);
    },
    'segmenter-bm25': (q) => {
      const toks = [...new Set(segTokens(q))];
      if (!toks.length) return [];
      const first = ids(segBm25, toks.map(ftsQuote).join(' AND '));
      if (first.length >= TOP) return first;
      return [...new Set([...first, ...ids(segBm25, toks.map(ftsQuote).join(' OR '))])];
    },
    // OR over segmented words, FTS5 bm25 decides (docs matching more / rarer words rank higher).
    'segmenter-or-bm25': (q) => {
      const toks = [...new Set(segTokens(q))];
      return toks.length ? ids(segBm25, toks.map(ftsQuote).join(' OR ')) : [];
    },
    // OR over segmented words, ranked by the summed idf of the distinct words matched,
    // then title hits > occurrences > time.
    'segmenter-coord': (q) => {
      const toks = [...new Set(segTokens(q))];
      if (!toks.length) return [];
      const df = new Map(toks.map((t) => [t, ids(segMatch, ftsQuote(t)).length]));
      const idf = (t) => Math.log((docs.length + 1) / ((df.get(t) || 0) + 1));
      const matched = new Map();
      for (const t of toks) for (const i of ids(segMatch, ftsQuote(t))) matched.set(i, (matched.get(i) || 0) + idf(t));
      const ranked = ruleRank(docs, [...matched.keys()], toks);
      const pos = new Map(ranked.map((i, k) => [i, k]));
      return [...matched.keys()].sort((a, b) => matched.get(b) - matched.get(a) || pos.get(a) - pos.get(b));
    },
    'trigram': (q) => {
      const s = triSets(q);
      return andThenOr(docs, s.and, s.or, s.terms);
    },
    'trigram-bm25': (q) => {
      const s = triSets(q);
      if (!s.long.length) return andThenOr(docs, s.and, s.or, s.terms); // nothing the index can rank
      const first = ids(triBm25, s.long.map(ftsQuote).join(' AND ')).filter((i) => s.and.includes(i));
      return [...new Set([...first, ...andThenOr(docs, s.and, s.or, s.terms)])];
    },
    // Combined: a conversation matches if the segmenter OR substring/trigram semantics accept it.
    'combined': (q) => {
      const s = segSets(q);
      const t = triSets(q);
      const and = [...new Set([...s.and, ...t.and])];
      const or = [...new Set([...s.or, ...t.or])];
      return andThenOr(docs, and, or, [...new Set([...t.terms, ...s.toks])]);
    },
    'tfidf-baseline': (q) => tfidfSearch(tfidf, q),
    // The shipped search() (extension/server/lib/search.js) on a migrated copy of the database.
    product: (q) => product(q).results.map((r) => byId.get(r.id)),
  };
}

// ---------------------------------------------------------------- run

function main() {
  const { questions } = JSON.parse(fs.readFileSync(QUESTIONS, 'utf8'));
  let t0 = now();
  const { db, docs } = loadDocs();
  const loadMs = now() - t0;
  const { t: buildMs, tfidf } = buildIndexes(db, docs);
  const { Store } = require('../extension/server/lib/store');
  const { search } = require('../extension/server/lib/search');
  let t1 = now();
  const store = new Store(path.join(OUT, 'work.db')); // migrates the copy (adds search_text)
  buildMs.migrate = now() - t1;
  const engines = makeEngines(db, docs, tfidf, (q) => search(store, { query: q, limit: TOP }));
  const idx = new Map(docs.map((d, i) => [d.id, i]));

  const rows = [];
  const latency = Object.fromEntries(Object.keys(engines).map((k) => [k, []]));
  for (const q of questions) {
    const target = idx.get(q.target);
    if (target === undefined) throw new Error(`${q.id}: target not in database`);
    q.keywords.forEach((kw, g) => {
      const toks = [...new Set(segTokens(kw))];
      const terms = splitTerms(kw).map((t) => t.toLowerCase());
      const body = docs[target].lowerBody;
      const row = {
        qid: q.id, type: q.type, group: g + 1, ranks: {},
        // how much of the query the target conversation even contains (counts only)
        coverage: {
          terms: `${terms.filter((t) => body.includes(t)).length}/${terms.length}`,
          words: `${toks.filter((t) => body.includes(t)).length}/${toks.length}`,
        },
      };
      for (const [name, fn] of Object.entries(engines)) {
        const s = now();
        const top = fn(kw).slice(0, TOP);
        latency[name].push(now() - s);
        const r = top.indexOf(target);
        row.ranks[name] = r >= 0 ? r + 1 : null;
      }
      rows.push(row);
    });
  }

  const types = ['title', 'paraphrase', 'cross'];
  const summary = {};
  for (const name of Object.keys(engines)) {
    summary[name] = {};
    for (const type of [...types, 'all']) {
      const sel = rows.filter((r) => type === 'all' || r.type === type);
      const qids = [...new Set(sel.map((r) => r.qid))];
      summary[name][type] = {
        groups: sel.length,
        hit5: sel.filter((r) => r.ranks[name] !== null).length,
        hit1: sel.filter((r) => r.ranks[name] === 1).length,
        questions: qids.length,
        // a question counts when at least one of its keyword groups finds the target
        anyGroup: qids.filter((id) => sel.some((r) => r.qid === id && r.ranks[name] !== null)).length,
      };
    }
    const l = latency[name].sort((a, b) => a - b);
    summary[name].latency = { avg: l.reduce((a, b) => a + b, 0) / l.length, p50: l[Math.floor(l.length / 2)], max: l[l.length - 1] };
  }
  const sizes = {};
  for (const tbl of ['fts_seg', 'fts_tri']) {
    try {
      sizes[tbl] = db.prepare(`SELECT sum(pgsize) AS b FROM dbstat WHERE name LIKE '${tbl}%'`).get().b;
    } catch {
      sizes[tbl] = NaN; // dbstat not compiled in
    }
  }
  store.close();
  const bodyChars = docs.reduce((s, d) => s + d.body.length, 0);
  const rawChars = docs.reduce((s, d) => s + d.rawBody.length, 0);
  db.close();

  const result = {
    node: process.version, conversations: docs.length, bodyChars, rawChars, loadMs, buildMs, indexBytes: sizes, rows, summary,
  };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(result, null, 2));
  fs.rmSync(path.join(OUT, 'work.db'), { force: true });
  print(result, Object.keys(engines), types);
}

function print(r, names, types) {
  const pct = (a, b) => `${a}/${b}`;
  console.log(`${r.node} · ${r.conversations} conversations · clean text ${(r.bodyChars / 1e6).toFixed(1)}M chars (raw ${(r.rawChars / 1e6).toFixed(1)}M)`);
  console.log(`build ms: ${JSON.stringify(Object.fromEntries(Object.entries(r.buildMs).map(([k, v]) => [k, Math.round(v)])))}` +
    ` · index MB: seg ${(r.indexBytes.fts_seg / 1048576).toFixed(0)}, tri ${(r.indexBytes.fts_tri / 1048576).toFixed(0)}`);
  console.log('\nhit@5 by keyword group (hit@1 in brackets); "any" = questions where at least one group hits');
  console.log(['engine'.padEnd(18), ...types.map((t) => t.padEnd(16)), 'all'.padEnd(16), 'any-group', 'avg/max ms'].join(' '));
  for (const n of names) {
    const s = r.summary[n];
    const cell = (t) => `${pct(s[t].hit5, s[t].groups)} (${s[t].hit1})`.padEnd(16);
    console.log([n.padEnd(18), ...types.map(cell), cell('all'), `${s.all.anyGroup}/${s.all.questions}`.padEnd(9),
      `${s.latency.avg.toFixed(1)}/${s.latency.max.toFixed(0)}`].join(' '));
  }
  console.log('\nper question · group: rank (— = not in top 5)');
  console.log(['q', 'type', 'g', 'terms', 'words', ...names.map((n) => n.slice(0, 10).padEnd(10))].join('\t'));
  for (const row of r.rows) {
    console.log([row.qid, row.type, row.group, row.coverage.terms, row.coverage.words,
      ...names.map((n) => String(row.ranks[n] ?? '—').padEnd(10))].join('\t'));
  }
}

main();
