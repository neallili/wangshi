'use strict';
// End to end: the real MCP server over stdio, with HOME pointed at a temp folder whose
// Downloads holds the synthetic exports. Set WANGSHI_SERVER to test an unpacked .mcpb instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { zipFolder } = require('./helpers/zip-writer');
const { tmpDir, FIXTURES } = require('./helpers/tmp');

const SERVER = process.env.WANGSHI_SERVER || path.join(__dirname, '..', 'extension', 'server', 'index.js');
const A = 'a0000000-0000-4000-8000-000000000001';

class Client {
  constructor(env) {
    this.proc = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
    this.pending = new Map();
    this.nextId = 1;
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p(msg);
        }
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async call(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args });
    assert.ok(r.result, JSON.stringify(r));
    return r.result.content[0].text;
  }

  close() {
    return new Promise((resolve) => {
      this.proc.on('exit', resolve);
      this.proc.stdin.end();
    });
  }
}

function assertNoLeaks(text, home) {
  assert.ok(!text.includes(home), `path leaked:\n${text}`);
  assert.ok(!/\/Users\/|\/tmp\/|\/private\/|Error:|ENOENT|EPERM|\bat .+:\d+:\d+/.test(text), `leak:\n${text}`);
  assert.ok(text.length <= 40000, 'response over 40K chars');
}

test('full flow: install → "import my ChatGPT history" → confirm → search → read', async () => {
  const home = tmpDir('e2e');
  const downloads = path.join(home, 'Downloads');
  fs.mkdirSync(downloads);
  fs.writeFileSync(path.join(downloads, 'unrelated.pdf'), 'x');
  const c = new Client({ HOME: home, WANGSHI_EXPORT_PATH: '' });
  const call = async (name, args) => {
    const text = await c.call(name, args);
    assertNoLeaks(text, home);
    return text;
  };
  try {
    const init = await c.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
    assert.equal(init.result.serverInfo.name, 'wangshi');

    const { result: { tools } } = await c.request('tools/list', {});
    assert.deepEqual(tools.map((t) => t.name).sort(), ['import', 'list_conversations', 'read_conversation', 'search', 'status']);
    for (const t of tools) {
      assert.match(t.description, /不是 Claude 的历史/, t.name);
      assert.equal(t.annotations.readOnlyHint, t.name !== 'import', t.name);
    }

    // Nothing in Downloads yet.
    assert.match(await call('status'), /还没有导入任何 ChatGPT 记录。\n还没找到你的 ChatGPT 导出包/);
    assert.match(await call('search', { query: '温哥华' }), /还没有导入/);
    assert.match(await call('import', {}), /^还没找到你的 ChatGPT 导出包。请在 ChatGPT 里打开 设置 → 数据控制 → 导出数据/);

    // The export arrives in Downloads as a zip.
    zipFolder(path.join(FIXTURES, 'export-v1'), path.join(downloads, 'f00d-2025-10-14-09-00-00.zip'));
    assert.match(await call('status'), /在"下载"文件夹里发现了 ChatGPT 导出包/);
    const preview = await call('import', { confirm: false });
    assert.match(preview, /^在"下载"文件夹找到了你 2025 年 10 月 14 日的 ChatGPT 导出，共 7 条对话（从 .+ 到 .+），现在导入吗？/);
    assert.match(preview, /confirm=true/);
    assert.equal(fs.existsSync(path.join(home, '.wangshi', 'wangshi.db')), false, 'preview must not create the database');

    assert.match(await call('import', { confirm: true }), /^导入完成：新增 7 条对话。/);
    assert.ok(fs.existsSync(path.join(home, '.wangshi', 'wangshi.db')));

    const status = await call('status');
    assert.match(status, /已经有 7 条 ChatGPT 对话/);
    assert.match(status, /新增 7 条/);

    const hits = await call('search', { query: '温哥华' });
    assert.match(hits, /找到 1 条相关对话/);
    assert.match(hits, /温哥华买房讨论/);
    assert.match(hits, new RegExp(`id: ${A}`));
    assert.match(hits, /用户说：我想在温哥华买房子/);
    assert.match(await call('search', { query: '不存在的词' }), /没有找到和"不存在的词"相关的对话/);
    assert.match(await call('search', { query: '学习 Go' }), /学习编程语言/); // terms in one message
    // should come back empty, not with fragments, so Claude retries with other words
    for (const q of ['乾坤圈', '量子底料', '我以前问过 GPT 关于宇宙飞船']) {
      assert.match(await call('search', { query: q }), /^在用户的 ChatGPT 记录里，没有找到和".+"相关的对话。/, q);
    }
    assert.match(await call('search', { query: '温哥华', since: '2024' }), /没有找到/);
    assert.match(await call('search', { query: '温哥华', until: '2023-12' }), /找到 1 条/);
    assert.match(await call('search', { query: 'x', since: '去年' }), /日期格式没看懂/);

    const list = await call('list_conversations', { limit: 3 });
    assert.match(list, /^共 7 条 ChatGPT 对话，这里是第 1–3 条/);
    assert.match(list, /offset=3/);
    assert.match(await call('list_conversations', { title_contains: '编程' }), /学习编程语言/);
    assert.match(await call('list_conversations', { project: 'g-p-' }), /共 1 条.*\n\n1\. \*\*（无标题）\*\*.*项目对话/s);

    const read = await call('read_conversation', { id: `https://chatgpt.com/c/${A}` });
    assert.match(read, /^# 温哥华买房讨论/);
    assert.match(read, /### 用户（.+）\n我想在温哥华买房子/);
    assert.match(read, /### ChatGPT（.+）\n一般需要收入证明/);
    assert.doesNotMatch(read, /隐藏/);
    assert.equal(await call('read_conversation', { id: 'a0000000' }), read, 'prefix works like the full id');

    const b = await call('read_conversation', { id: 'b0000000-0000-4000-8000-000000000002' });
    assert.match(b, /另有 3 条消息在其他分支上/);
    assert.match(b, /重新生成的回答/);
    assert.doesNotMatch(b, /原始问题/);

    const hidden = await call('read_conversation', { id: 'c0000000', include_hidden: true });
    assert.match(hidden, /\[隐藏：工具调用\]/);
    assert.match(hidden, /print\(2 \*\* 10\)/);
    assert.match(await call('read_conversation', { id: 'd0000000' }), /\[附件：合同草稿\.pdf\]/);
    assert.match(await call('read_conversation', { id: '0000' }), /id 以"0000"开头|没有找到/);
    assert.match(await call('read_conversation', { id: 'ffff1234' }), /没有找到这条对话/);

    // A newer export (Safari-unzipped folder) arrives: incremental import.
    fs.cpSync(path.join(FIXTURES, 'export-v2'), path.join(downloads, 'f00d-2026-02-01-09-00-00'), { recursive: true });
    assert.match(await call('import', {}), /共 3 条对话/);
    assert.equal(await call('import', { confirm: true }), '导入完成：新增 1 条对话，更新 1 条，1 条之前已导入过、没有变化。' +
      '\n\n（给 Claude 的说明：导入已完成，可以接着回答用户原来的问题，比如用 search 搜索。）');
    assert.match(await call('search', { query: '利率' }), /温哥华买房讨论/);
    assert.match(await call('status'), /已经有 8 条/);
  } finally {
    await c.close();
  }
  assert.equal(c.stderr.replace(/.*ExperimentalWarning.*\n?|.*--trace-warnings.*\n?/g, ''), '', 'unexpected stderr');
});

test('export_path from settings, and a long conversation paginated under 40K', async () => {
  const home = tmpDir('e2e-setting');
  fs.mkdirSync(path.join(home, 'Downloads'));
  const picked = path.join(home, 'Picked Folder');
  fs.mkdirSync(picked);
  const { longConversation } = require('./helpers/long-conversation');
  const raw = longConversation({ turns: 100, charsPerMessage: 1500 });
  fs.writeFileSync(path.join(picked, 'conversations.json'), JSON.stringify([raw]));
  fs.writeFileSync(path.join(picked, 'chat.html'), '');
  const c = new Client({ HOME: home, WANGSHI_EXPORT_PATH: picked });
  try {
    await c.request('initialize', { protocolVersion: '2025-06-18' });
    assert.match(await c.call('import', {}), /^在你设置里选的位置找到了/);
    assert.match(await c.call('import', { confirm: true }), /新增 1 条/);
    const first = await c.call('read_conversation', { id: raw.id });
    const pages = Number(/第 1\/(\d+) 页/.exec(first)[1]);
    assert.ok(pages >= 5);
    let all = first;
    for (let p = 2; p <= pages; p++) {
      const text = await c.call('read_conversation', { id: raw.id, page: p });
      assert.ok(text.length <= 40000);
      all += text;
    }
    for (const i of [0, 99, 199]) assert.ok(all.includes(`第 ${i} 条`), `message ${i} missing`);
    assert.match(await c.call('read_conversation', { id: raw.id, page: pages + 1 }), /一共只有/);
  } finally {
    await c.close();
  }
});

test('a wrong export_path is explained in plain words', async () => {
  const home = tmpDir('e2e-bad');
  fs.mkdirSync(path.join(home, 'Downloads'));
  const c = new Client({ HOME: home, WANGSHI_EXPORT_PATH: path.join(home, 'gone') });
  try {
    await c.request('initialize', {});
    const text = await c.call('import', {});
    assert.match(text, /选择装着 ChatGPT 导出文件的文件夹/);
    assertNoLeaks(text, home);
  } finally {
    await c.close();
  }
});
