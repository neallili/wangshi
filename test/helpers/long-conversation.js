'use strict';
// Deterministic synthetic long conversation (no real content): `turns` user/assistant pairs.
function longConversation({ id = 'l0000000-0000-4000-8000-000000000010', turns = 1500, charsPerMessage = 2000 } = {}) {
  const filler = '这是一段用于测试超长对话的合成文字。'.repeat(Math.ceil(charsPerMessage / 18)).slice(0, charsPerMessage);
  const mapping = { 'l-root': { id: 'l-root', message: null, parent: null, children: [] } };
  let parent = 'l-root';
  let t = 1709000000;
  for (let i = 0; i < turns * 2; i++) {
    const nid = `l-${i}`;
    const role = i % 2 === 0 ? 'user' : 'assistant';
    mapping[nid] = {
      id: nid, parent, children: [],
      message: {
        id: nid, author: { role }, create_time: t++, recipient: 'all',
        content: { content_type: 'text', parts: [`第 ${i} 条 ${filler}`] },
        metadata: role === 'assistant' ? { model_slug: 'gpt-4o' } : {},
      },
    };
    mapping[parent].children.push(nid);
    parent = nid;
  }
  return {
    title: '超长对话（合成）', create_time: 1709000000, update_time: t, id, conversation_id: id,
    current_node: parent, mapping,
  };
}

module.exports = { longConversation };
