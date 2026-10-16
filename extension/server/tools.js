'use strict';
// The five MCP tools. Every description says these are the user's ChatGPT chats, not Claude's
// own history — in testing, "往事" alone made Claude reach for its built-in past-chats search.
const fs = require('fs');
const { Store, SCHEMA_VERSION } = require('./lib/store');
const { findExport } = require('./lib/source');
const { previewInWorker, importInWorker, migrateInWorker } = require('./lib/import-worker');
const { search } = require('./lib/search');
const fmt = require('./lib/format');
const msg = require('./lib/messages');
const paths = require('./lib/paths');

const ABOUT = '这是用户以前在 ChatGPT 里的对话记录（从用户的 ChatGPT 导出包导入，只存在用户自己的电脑上），' +
  '不是 Claude 的历史对话。用户提到 ChatGPT、GPT、"以前问过 GPT"、"我在 ChatGPT 里聊过"时使用。' +
  ' / These are the user\'s past ChatGPT conversations (imported from their ChatGPT export, stored only on this computer), ' +
  'NOT Claude\'s own chat history. Use when the user mentions ChatGPT or GPT.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const TOOLS = [
  {
    name: 'search',
    title: '往事：搜索 ChatGPT 记录',
    description: '按关键词搜索用户的 ChatGPT 对话，中文优先，按相关程度排序。返回对话 ID、标题、日期和命中片段；需要全文时再用 read_conversation。' +
      '没找到或结果不对时，换同义词、换成英文或中文、拆成单个词，再搜一两次。' +
      ' / If nothing relevant comes back, retry once or twice with synonyms, the other language (English/Chinese), or single words. ' +
      ABOUT,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，多个词用空格分开 / keywords' },
        since: { type: 'string', description: '只看这个时间之后的对话，如 2024、2024-05、2024-05-01（可选）' },
        until: { type: 'string', description: '只看这个时间之前的对话，格式同上（可选）' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '最多返回几条对话，默认 10' },
      },
      required: ['query'],
    },
    annotations: { title: '往事：搜索 ChatGPT 记录', ...READ_ONLY },
  },
  {
    name: 'list_conversations',
    title: '往事：浏览 ChatGPT 对话',
    description: `按时间（从新到旧）或标题浏览用户的 ChatGPT 对话列表。${ABOUT}`,
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: '标题里包含的文字（可选）' },
        since: { type: 'string', description: '只看这个时间之后的对话，如 2024-05-01（可选）' },
        until: { type: 'string', description: '只看这个时间之前的对话（可选）' },
        project: { type: 'string', description: 'ChatGPT 项目或 GPT 的 ID（g-p-… 或 g-…，可选）' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '每页条数，默认 20' },
        offset: { type: 'integer', minimum: 0, description: '跳过前面多少条，用于翻页，默认 0' },
      },
    },
    annotations: { title: '往事：浏览 ChatGPT 对话', ...READ_ONLY },
  },
  {
    name: 'read_conversation',
    title: '往事：读取一条 ChatGPT 对话',
    description: `读取一条 ChatGPT 对话的全文（当前分支），按页返回。id 可以是完整 ID、ID 的前几位，或者 chatgpt.com 的对话链接。${ABOUT}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '对话 ID、ID 前缀，或 chatgpt.com/c/… 链接' },
        page: { type: 'integer', minimum: 1, description: '第几页，默认 1' },
        include_hidden: { type: 'boolean', description: '是否包含隐藏内容（系统消息、工具调用、推理过程等），并显示原文，默认 false' },
        raw: { type: 'boolean', description: '显示原文（含 ChatGPT 的界面标记和引用占位符），默认 false：显示去掉这些标记的干净文本' },
      },
      required: ['id'],
    },
    annotations: { title: '往事：读取 ChatGPT 对话', ...READ_ONLY },
  },
  {
    name: 'status',
    title: '往事：导入状态',
    description: `查看往事里已经导入了多少条 ChatGPT 对话、时间范围、上次导入时间，以及正在进行的导入进度。${ABOUT}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: '往事：导入状态', ...READ_ONLY },
  },
  {
    name: 'import',
    title: '往事：导入 ChatGPT 记录',
    description: '导入或更新用户的 ChatGPT 记录（这是用户在 ChatGPT 里的对话，不是 Claude 的历史）。用户说"帮我导入 ChatGPT 记录"，或者问到 ChatGPT 里的内容但往事还没导入过时使用。' +
      '会自动在"下载"文件夹里找 ChatGPT 导出包（zip 或解压后的文件夹都行）。' +
      '先用 confirm=false 调用，把找到的结果原样告诉用户并请用户确认；用户同意后再用 confirm=true 调用才会真正导入。可以重复运行，只会补充新内容。' +
      ' / Imports the user\'s ChatGPT export (found automatically in Downloads). Call with confirm=false first and ask the user; ' +
      'call with confirm=true only after the user agrees. Re-running only adds what is new. This is ChatGPT data, not Claude\'s history.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'false：只查找并报告找到了什么；true：用户已同意，开始导入。默认 false' },
      },
    },
    annotations: { title: '往事：导入 ChatGPT 记录', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const intro = (n) => `在用户的 ChatGPT 记录里找到 ${n} 条相关对话（按相关程度排序，标题命中的更靠前）`;

const NOT_IMPORTED = '往事里还没有导入任何 ChatGPT 记录。可以调用 import（先不带 confirm）在"下载"文件夹里查找导出包，再请用户确认导入。';
const FOR_CLAUDE = (s) => `\n\n（给 Claude 的说明：${s}）`;
const IMPORT_WAIT_MS = 20000;
const MIGRATE_WAIT_MS = 10000; // a few thousand conversations upgrade in ~4 s; only slower cases see the notice

function intIn(value, dflt, min, max) {
  const n = Number.isInteger(value) ? value : dflt;
  return Math.min(max, Math.max(min, n));
}

class Wangshi {
  constructor({
    exportPath = process.env.WANGSHI_EXPORT_PATH, dbPath = paths.dbPath(), downloadsDir = paths.downloadsDir(),
    migrateWaitMs = MIGRATE_WAIT_MS,
  } = {}) {
    this.migrateWaitMs = migrateWaitMs;
    this.exportPath = exportPath;
    this.dbPath = dbPath;
    this.downloadsDir = downloadsDir;
    this._store = null;
    this.job = null; // { promise, progress }
    this.lastPreview = null; // { path, count }
    this.migration = null; // Promise while an older database is being upgraded on the worker
  }

  /**
   * Upgrades a database written by an older Wangshi on the worker thread (the first upgrade to
   * the search index takes a few seconds on a few thousand conversations). Returns null when the
   * database is ready, otherwise a message telling Claude to come back in a moment.
   */
  async ready() {
    if (this._store) return null;
    if (!this.migration) {
      const v = Store.schemaVersionOf(this.dbPath);
      if (v === null || v >= SCHEMA_VERSION) return null;
      this.migration = migrateInWorker({ dbPath: this.dbPath }).then((r) => {
        this.migration = null;
        return r;
      }, (e) => {
        this.migration = null;
        process.stderr.write(`[wangshi] migration failed: ${e && e.stack}\n`);
        return { ok: false, code: 'internal' };
      });
    }
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), this.migrateWaitMs); });
    const r = await Promise.race([this.migration, timeout]);
    clearTimeout(timer);
    if (!r) return msg.upgrading() + FOR_CLAUDE('请告诉用户稍等，过半分钟左右再调用一次同样的工具。');
    if (!r.ok) return r.code === 'no_fts5' ? msg.noFts5() : msg.upgradeFailed();
    return null;
  }

  get store() {
    if (!this._store) this._store = new Store(this.dbPath);
    return this._store;
  }

  close() {
    if (this._store) this._store.close();
  }

  /** Read-only calls never create the database; it appears with the first import. */
  hasDatabase() {
    return Boolean(this._store) || fs.existsSync(this.dbPath);
  }

  isEmpty() {
    return !this.hasDatabase() || this.store.stats().conversations === 0;
  }

  parseRange(args) {
    const since = fmt.parseDate(args.since);
    const until = fmt.parseDate(args.until, { end: true });
    if (since === undefined || until === undefined) return { error: '日期格式没看懂。请用 2024、2024-05 或 2024-05-01 这样的格式。' };
    return { since, until };
  }

  // ---------------- tools

  async search(args) {
    const notReady = await this.ready();
    if (notReady) return notReady;
    const query = String(args.query || '').trim();
    if (!query) return '请告诉我要搜索的关键词。';
    if (this.isEmpty()) return NOT_IMPORTED;
    const range = this.parseRange(args);
    if (range.error) return range.error;
    const { terms, results } = search(this.store, { query, ...range, limit: intIn(args.limit, 10, 1, 30) });
    if (!results.length) {
      return `在用户的 ChatGPT 记录里，没有找到和"${query}"相关的对话。` +
        FOR_CLAUDE('可以换同义词、换成英文或中文、或者只用一个最关键的词，再搜一两次；都没有的话再告诉用户没找到。');
    }
    const partialCount = results.filter((r) => r.match === 'some').length;
    const lines = results.map((r, i) => {
      const head = `${i + 1}. **${fmt.titleOf(r)}** · ${fmt.day(r.update_time ?? r.create_time)} · id: ${r.id}`;
      const partial = r.match === 'some' && terms.length > 1 ? `\n   （只包含：${r.matched_terms.join('、')}）` : '';
      if (!r.snippet) return `${head}\n   （标题命中）${partial}`;
      const who = r.role === 'user' ? '用户' : 'ChatGPT';
      return `${head}\n   ${who}说：${r.snippet}${r.hits > 1 ? `\n   （这条对话里共 ${r.hits} 处命中）` : ''}${partial}`;
    });
    const listed = `${intro(results.length)}：\n\n${lines.join('\n\n')}`;
    if (terms.length > 1 && partialCount === results.length) {
      return fmt.clip(`没有找到同时包含"${terms.join('、')}"的对话，下面是只沾边的结果（每条只包含其中一部分词）。\n\n${listed}` +
        FOR_CLAUDE('这些很可能不是用户要找的。请先换个说法再搜一两次（同义词、换成英文或中文、拆成单个词），' +
          '都不行再决定是否采用这些部分匹配的结果，并如实告诉用户只找到了沾边的内容。'));
    }
    const note = terms.length > 1 && partialCount ? `；其中 ${partialCount} 条只包含部分关键词，已标出` : '';
    return fmt.clip(`${intro(results.length)}${note}：\n\n${lines.join('\n\n')}` +
      FOR_CLAUDE('需要看全文时，用 read_conversation 并传入 id。'));
  }

  async list_conversations(args) {
    const notReady = await this.ready();
    if (notReady) return notReady;
    if (this.isEmpty()) return NOT_IMPORTED;
    const range = this.parseRange(args);
    if (range.error) return range.error;
    const limit = intIn(args.limit, 20, 1, 100);
    const offset = intIn(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const { total, rows } = this.store.listConversations({
      titleContains: args.title_contains ? String(args.title_contains) : null,
      project: args.project ? String(args.project) : null, ...range, limit, offset,
    });
    if (!rows.length) return total ? `一共只有 ${total} 条，没有更多了。` : '没有符合条件的 ChatGPT 对话。';
    const lines = rows.map((r, i) => `${offset + i + 1}. **${fmt.titleOf(r)}** · ${fmt.day(r.update_time ?? r.create_time)} · ` +
      `${r.message_count} 条消息${r.gizmo_kind === 'project' ? ' · 项目对话' : r.gizmo_kind === 'gpt' ? ' · GPT 对话' : ''} · id: ${r.id}`);
    const more = offset + rows.length < total ? FOR_CLAUDE(`还有更多，下一页用 offset=${offset + rows.length}。`) : '';
    return fmt.clip(`共 ${total} 条 ChatGPT 对话，这里是第 ${offset + 1}–${offset + rows.length} 条（从新到旧）：\n\n${lines.join('\n')}${more}`);
  }

  async read_conversation(args) {
    const notReady = await this.ready();
    if (notReady) return notReady;
    if (this.isEmpty()) return NOT_IMPORTED;
    const id = fmt.normalizeIdInput(args.id);
    if (id.length < 4) return '请提供对话 ID（至少前 4 位）或 chatgpt.com 的对话链接。';
    let conv = this.store.getConversation(id);
    if (!conv) {
      const matches = this.store.findByIdPrefix(id);
      if (!matches.length) return '在用户的 ChatGPT 记录里没有找到这条对话。可以先用 search 或 list_conversations 找到它的 id。';
      if (matches.length > 1) {
        return `有 ${matches.length} 条对话的 id 以"${id}"开头，请用更长的 id：\n\n` +
          matches.map((m) => `- **${fmt.titleOf(m)}** · ${fmt.day(m.update_time)} · id: ${m.id}`).join('\n');
      }
      conv = this.store.getConversation(matches[0].id);
    }
    const snap = conv.current_snapshot;
    const includeHidden = args.include_hidden === true;
    const raw = args.raw === true || includeHidden;
    const attachments = new Map();
    for (const a of this.store.attachments(snap)) {
      if (!attachments.has(a.node_id)) attachments.set(a.node_id, []);
      attachments.get(a.node_id).push(a);
    }
    const blocks = this.store.branch(snap, { includeHidden }).map((n) => fmt.renderMessage(n, attachments.get(n.node_id) || [], { raw }));
    const pages = fmt.paginate(blocks);
    const page = intIn(args.page, 1, 1, Number.MAX_SAFE_INTEGER);
    if (page > pages.length) return `这条对话一共只有 ${pages.length} 页。`;

    const meta = [`创建 ${fmt.dayTime(conv.create_time)}`, `最后更新 ${fmt.dayTime(conv.update_time)}`];
    if (conv.model) meta.push(`模型 ${conv.model}`);
    if (conv.gizmo_kind === 'project') meta.push(`所属项目 ${conv.gizmo_id}`);
    if (conv.gizmo_kind === 'gpt') meta.push(`使用的 GPT ${conv.gizmo_id}`);
    const off = this.store.offBranchCount(snap);
    const notes = [];
    if (off) notes.push(`另有 ${off} 条消息在其他分支上（编辑或重新生成之前的版本），这里没有显示。`);
    if (!includeHidden) notes.push('系统消息、工具调用和推理过程默认不显示，需要时可设 include_hidden=true。');
    if (!raw) notes.push('正文已去掉 ChatGPT 的界面标记和引用占位符；需要原文可设 raw=true。');
    const header = `# ${fmt.titleOf(conv)}\n${meta.join(' · ')}\nid: ${conv.id}\n${notes.join('\n')}\n\n`;
    const left = pages.length - page;
    const footer = pages.length > 1
      ? `\n—— 第 ${page}/${pages.length} 页${left ? `，后面还有 ${left} 页${FOR_CLAUDE(`继续读请用 page=${page + 1}；只需要部分内容时可以先用 search 找到相关片段。`)}` : '（最后一页）'}`
      : '';
    return fmt.clip(header + pages[page - 1] + footer);
  }

  async status() {
    const notReady = await this.ready();
    if (notReady) return notReady;
    const lines = [];
    if (this.job) lines.push(msg.importRunning(this.job.progress || {}));
    const hasDb = this.hasDatabase();
    if (hasDb && !this.job && this.store.runningImport()) {
      lines.push('上次导入没有完成（可能是 Claude 中途被关闭了）。再导入一次，往事会从断开的地方接着导入。');
    }
    const s = hasDb ? this.store.stats() : { conversations: 0 };
    if (s.conversations === 0) {
      if (!this.job) {
        const found = findExport({ exportPath: this.exportPath, downloadsDir: this.downloadsDir });
        lines.push(found.ok
          ? `往事里还没有导入任何 ChatGPT 记录。${found.origin === 'export_path' ? '在你设置里选的位置' : '在"下载"文件夹里'}发现了 ChatGPT 导出包。` +
            FOR_CLAUDE('可以调用 import（先不带 confirm）请用户确认后导入。')
          : `往事里还没有导入任何 ChatGPT 记录。\n${found.message}`);
      }
    } else {
      lines.push(`往事里已经有 ${msg.formatCount(s.conversations)} 条 ChatGPT 对话，时间从 ${fmt.day(s.first_time)} 到 ${fmt.day(s.last_time)}。`);
      const last = this.store.lastFinishedImport();
      if (last) {
        const when = fmt.dayTime(last.finished_at / 1000);
        lines.push(last.status === 'done'
          ? `上次导入：${when}，新增 ${last.convs_new} 条，更新 ${last.convs_updated} 条。`
          : `上次导入（${when}）没有成功，已经导入的部分都保存了。`);
      }
    }
    lines.push(`（诊断信息：Node ${process.version}）`);
    return lines.join('\n');
  }

  async import(args) {
    const notReady = await this.ready();
    if (notReady) return notReady;
    if (this.job) return msg.importRunning(this.job.progress || {}) + FOR_CLAUDE('导入还在后台进行，稍后用 status 查看进度。');
    const found = findExport({ exportPath: this.exportPath, downloadsDir: this.downloadsDir });
    if (!found.ok) return found.message;
    const { candidate, origin } = found;

    if (args.confirm !== true) {
      const p = await previewInWorker({ candidate, origin });
      if (!p.ok) return p.message;
      this.lastPreview = { path: candidate.path, count: p.count };
      return p.message + FOR_CLAUDE('请把上面这句话转述给用户，等用户同意后，再调用 import 并设 confirm=true。');
    }

    const expectedTotal = this.lastPreview && this.lastPreview.path === candidate.path ? this.lastPreview.count : null;
    void this.store; // make sure the schema exists before the worker opens the database
    const job = { progress: { done: 0, total: expectedTotal } };
    job.promise = importInWorker({ candidate, origin, dbPath: this.dbPath, expectedTotal }, (p) => { job.progress = p; })
      .catch((e) => {
        process.stderr.write(`[wangshi] import worker failed: ${e && e.stack}\n`);
        return { ok: false, message: msg.importFailed() };
      })
      .finally(() => {
        if (this.job === job) this.job = null;
      });
    this.job = job;

    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), IMPORT_WAIT_MS); });
    const result = await Promise.race([job.promise, timeout]);
    clearTimeout(timer);
    if (!result) return msg.importRunning(job.progress) + FOR_CLAUDE('导入会在后台继续，可以先告诉用户正在导入，稍后用 status 查看进度。');
    if (result.error) process.stderr.write(`[wangshi] import failed: ${result.error}\n`);
    return result.message + (result.ok ? FOR_CLAUDE('导入已完成，可以接着回答用户原来的问题，比如用 search 搜索。') : '');
  }
}

module.exports = { TOOLS, Wangshi };
