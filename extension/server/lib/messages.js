'use strict';
// Every sentence a user might see, in plain Chinese. No paths, no English errors, no stack traces.
// Claude is expected to relay these as-is.

const HOW_TO_EXPORT =
  '请在 ChatGPT 里打开 设置 → 数据控制 → 导出数据，收到邮件后点链接下载，文件留在"下载"文件夹就行（不用解压），然后再跟我说一声。';

function formatDate(ms, now = Date.now()) {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return sameYear ? md : `${d.getFullYear()} 年 ${md}`;
}

function formatCount(n) {
  return n.toLocaleString('en-US');
}

// user_config.export_path description (a folder picker: the export folder, or any folder containing exports).
const EXPORT_PATH_DESCRIPTION = '选择装着 ChatGPT 导出文件的文件夹（比如"下载"）';

const where = (origin) => (origin === 'export_path' ? '在你设置里选的位置' : '在"下载"文件夹');

module.exports = {
  EXPORT_PATH_DESCRIPTION,
  formatDate,
  formatCount,

  notFound: () => `还没找到你的 ChatGPT 导出包。${HOW_TO_EXPORT}`,

  noPermission: () =>
    '往事暂时没法查看你的"下载"文件夹。如果刚才弹出了"想访问下载文件夹"的提示，请点"允许"后再跟我说一声；' +
    '如果没有弹出，请打开 系统设置 → 隐私与安全性 → 文件和文件夹，找到 Claude，把"下载文件夹"打开，然后再试一次。',

  exportPathInvalid: () =>
    '你在往事设置里选的文件夹里，没有找到 ChatGPT 导出包。请在 设置 → 扩展 → 往事 里点"Browse"，选择装着 ChatGPT 导出文件的文件夹（比如"下载"），' +
    '选完记得点"Save"；或者把那一栏清空，往事会自动去"下载"文件夹里找。',

  looksLikeClaude: (origin) =>
    `${where(origin)}找到的是 Claude 的导出包，不是 ChatGPT 的。往事目前只能导入 ChatGPT 的记录。${HOW_TO_EXPORT}`,

  unreadable: () =>
    '找到了 ChatGPT 导出包，但它好像没下载完整或者已经损坏，没法读取。请重新从邮件里的链接下载一次（链接过期的话，就在 ChatGPT 里再导出一次），然后再跟我说一声。',

  tooLarge: () =>
    '这个 ChatGPT 导出包里有一个文件太大，往事一次读不下。请把这个情况通过 GitHub Issue 告诉我们，我们会尽快处理。',

  emptyExport: (origin) =>
    `${where(origin)}找到了 ChatGPT 导出包，但里面一条对话都没有。如果你确实在 ChatGPT 里聊过天，请重新导出一次再试。`,

  foundPreview: ({ origin, exportDate, count, firstTime, lastTime }) => {
    let s = `${where(origin)}找到了你 ${formatDate(exportDate)}的 ChatGPT 导出，共 ${formatCount(count)} 条对话`;
    if (firstTime && lastTime) s += `（从 ${formatDate(firstTime)} 到 ${formatDate(lastTime)}）`;
    return `${s}，现在导入吗？`;
  },

  importDone: ({ added, updated, unchanged }) => {
    const parts = [];
    if (added) parts.push(`新增 ${formatCount(added)} 条对话`);
    if (updated) parts.push(`更新 ${formatCount(updated)} 条`);
    if (!added && !updated) return `导入完成。这个导出包里的 ${formatCount(unchanged)} 条对话之前都已经导入过了，没有新内容。`;
    if (unchanged) parts.push(`${formatCount(unchanged)} 条之前已导入过、没有变化`);
    return `导入完成：${parts.join('，')}。`;
  },

  importFailed: () =>
    '导入中途出了问题，已经导入的部分都保存好了。请再跟我说一次"导入 ChatGPT 记录"，往事会从断开的地方接着导入。',

  upgrading: () => '往事正在升级本地索引（只需要一次），还需要一点时间，通常不超过半分钟，请稍等。',

  upgradeFailed: () =>
    '往事升级本地索引时出了问题，已有的数据没有受影响。请完全退出 Claude 再打开试一次；如果还是不行，请通过 GitHub Issue 告诉我们。',

  noFts5: () =>
    '往事需要 Claude 自带的 Node.js 运行环境才能搜索。请在 Claude 的设置里，确认扩展使用的是"内置 Node.js"（不要改成系统里的 Node），然后完全退出 Claude 再打开。',

  importRunning: ({ done = 0, total = null, bytesDone = 0, bytesTotal = 0 } = {}) => {
    if (total) return `正在导入，已完成 ${formatCount(done)} / ${formatCount(total)} 条对话。`;
    if (bytesTotal) return `正在导入，已完成约 ${Math.floor((bytesDone / bytesTotal) * 100)}%（${formatCount(done)} 条对话）。`;
    return '正在导入，请稍等。';
  },
};
