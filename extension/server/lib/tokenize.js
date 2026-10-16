'use strict';
// Word segmentation for search (Intl.Segmenter + FTS5, see scripts/m0-bench.js). Documents and queries go
// through the same segmenter, then FTS5's unicode61 tokenizer splits on the spaces we insert.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

/** Lowercased word-like segments of s, in order (duplicates kept). */
function words(s) {
  const out = [];
  if (!s) return out;
  for (const part of segmenter.segment(s)) if (part.isWordLike) out.push(part.segment.toLowerCase());
  return out;
}

/** Text as stored in the FTS index: words separated by single spaces. */
function indexText(s) {
  return words(s).join(' ');
}

// Function words that would make an OR query match almost every conversation. Dropped from
// queries (never from the index) unless the query consists of nothing else.
const STOP = new Set([
  '的', '了', '是', '在', '和', '与', '及', '或', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '着', '过', '也', '都', '就',
  '还', '又', '很', '太', '更', '最', '把', '被', '给', '让', '对', '从', '到', '向', '跟', '而', '但', '却', '所',
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '它们', '自己', '这', '那', '这个', '那个', '这些', '那些',
  '有', '没', '没有', '不', '一个', '一些', '什么', '怎么', '怎么样', '为什么', '哪', '哪些', '哪个', '如何', '么',
  '之', '其', '以', '于', '为', '因为', '所以', '如果', '可以', '能', '会', '要', '想', '说', '问', '过去', '以前', '之前',
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'it', 'this', 'that',
  'with', 'as', 'at', 'by', 'from', 'i', 'you', 'my', 'me', 'do', 'did', 'what', 'how', 'why',
  // Every conversation here is a ChatGPT conversation: "我以前问过 GPT……" says nothing about the topic.
  'gpt', 'chatgpt',
  // How people refer to a past chat, not what it was about.
  '关于', '有关', '问过', '聊过', '聊', '讨论过', '提过', '提到', '说过', '记得', '一下', '曾经', '当时',
  '我想', '想要', '请问', '帮我',
]);

/** Distinct query words, in order, without function words (kept if nothing else is left). */
function queryWords(q) {
  return queryTerms(q).map((t) => t.text);
}

const CJK = /^[\u3400-\u9fff\uf900-\ufaff]/u;

/**
 * Search terms of a query. Each term is one or more index words that must appear together:
 *  - function words are dropped (kept only if nothing else is left);
 *  - touching single Chinese characters form one phrase ("底料" = 底|料 → "底 料"); a lone single
 *    character joins the word right after it, or at the end of a run the word right before it
 *    ("买房子" = 买|房子 → "买 房子", "乾坤圈" = 乾坤|圈 → "乾坤 圈"). Names the segmenter does not
 *    know then still have to appear as a whole;
 *  - one-character terms left over are dropped when there is any longer term: a lone character
 *    would match nearly every conversation and make every search "find" something.
 * @returns {Array<{text: string, words: string[]}>}
 */
function queryTerms(q) {
  const segs = [];
  for (const part of segmenter.segment(String(q || ''))) {
    if (part.isWordLike) segs.push({ w: part.segment.toLowerCase(), at: part.index, end: part.index + part.segment.length });
  }
  const keep = segs.filter((x) => !STOP.has(x.w));
  const touches = (a, b) => a && b && a.end === b.at && CJK.test([...a.w].at(-1)) && CJK.test(b.w[0]);
  const single = (x) => [...x.w].length === 1 && CJK.test(x.w);

  const groups = [];
  for (let i = 0; i < keep.length; i++) {
    const g = [keep[i]];
    if (single(g[0])) {
      // touching single characters form one word ("底料" = 底|料) …
      while (single(g[g.length - 1]) && single(keep[i + 1] || { w: '' }) && touches(g[g.length - 1], keep[i + 1])) g.push(keep[++i]);
      // … and a lone single character joins the word that follows it ("买房子" = 买|房子)
      if (g.length === 1 && touches(g[0], keep[i + 1])) g.push(keep[++i]);
    }
    if (g.length === 1 && single(g[0]) && groups.length && touches(groups[groups.length - 1].at(-1), g[0])) {
      groups[groups.length - 1].push(g[0]); // last character of a run joins the word before it
    } else {
      groups.push(g);
    }
  }
  const seen = new Set();
  const terms = groups.map((g) => ({ text: g.map((x) => x.w).join(''), words: g.map((x) => x.w) }))
    .filter((t) => !seen.has(t.text) && seen.add(t.text));
  if (!terms.length) {
    // only function words: search for them after all
    const all = [...new Set(segs.map((x) => x.w))];
    return all.map((w) => ({ text: w, words: [w] }));
  }
  const long = terms.filter((t) => [...t.text].length >= 2);
  return long.length ? long : terms;
}

/** FTS5 MATCH expression: any of the terms (OR); each term is a quoted phrase of its words. */
function matchAny(terms) {
  return terms.map((t) => `"${t.words.join(' ').replace(/"/g, '""')}"`).join(' OR ');
}

module.exports = { words, indexText, queryWords, queryTerms, matchAny };
