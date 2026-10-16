'use strict';
const { cleanText } = require('./clean');
// ChatGPT export conversation -> normalized rows.
// Follows the export's mapping tree: the current branch is current_node -> parent -> … -> root,
// with a fallback to the latest leaf when current_node is missing. Nothing is dropped:
// every node of every branch is kept; nodes that are not normal visible chat are marked hidden.

const REASONING_TYPES = new Set(['thoughts', 'reasoning_recap']);
const CONTEXT_TYPES = new Set(['user_editable_context', 'model_editable_context']);

function partText(p) {
  if (typeof p === 'string') return p;
  if (!p || typeof p !== 'object') return p == null ? '' : JSON.stringify(p);
  if (typeof p.text === 'string') return p.text;
  if (p.content_type === 'image_asset_pointer') return '[图片]';
  if (p.content_type === 'audio_asset_pointer' || p.content_type === 'real_time_user_audio_video_asset_pointer') return '[语音]';
  if (p.asset_pointer) return '[附件]';
  return '';
}

function contentText(content) {
  if (!content || typeof content !== 'object') return '';
  const ct = content.content_type;
  if (Array.isArray(content.parts)) {
    return content.parts.map(partText).filter((t) => t !== '').join('\n');
  }
  switch (ct) {
    case 'code':
      return `\`\`\`${content.language && content.language !== 'unknown' ? content.language : ''}\n${content.text || ''}\n\`\`\``;
    case 'execution_output':
      return content.text || '';
    case 'thoughts':
      return (content.thoughts || []).map((t) => [t.summary, t.content].filter(Boolean).join('\n')).join('\n\n');
    case 'reasoning_recap':
      return content.content || '';
    case 'tether_quote':
      return [content.title, content.text].filter(Boolean).join('\n');
    case 'tether_browsing_display':
      return content.result || content.summary || '';
    case 'user_editable_context':
      return [content.user_profile, content.user_instructions].filter(Boolean).join('\n');
    case 'model_editable_context':
      return content.model_set_context || '';
    case 'system_error':
      return [content.name, content.text].filter(Boolean).join(': ');
    default:
      return typeof content.text === 'string' ? content.text : '';
  }
}

function attachmentsOf(message) {
  const out = [];
  const md = message.metadata || {};
  for (const a of Array.isArray(md.attachments) ? md.attachments : []) {
    if (!a || typeof a !== 'object') continue;
    out.push({
      kind: 'file',
      file_id: a.id || null,
      name: a.name || null,
      mime_type: a.mime_type || a.mimeType || null,
      size: Number.isFinite(a.size) ? a.size : null,
    });
  }
  const parts = message.content && Array.isArray(message.content.parts) ? message.content.parts : [];
  for (const p of parts) {
    if (p && typeof p === 'object' && p.asset_pointer) {
      out.push({
        kind: p.content_type === 'image_asset_pointer' ? 'image' : 'asset',
        file_id: p.asset_pointer,
        name: null,
        mime_type: null,
        size: Number.isFinite(p.size_bytes) ? p.size_bytes : null,
      });
    }
  }
  return out;
}

function hiddenReason(message, role, ct, text, attachments) {
  const md = message.metadata || {};
  if (md.is_visually_hidden_from_conversation) return 'visually_hidden';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  if (role === 'assistant' && message.recipient && message.recipient !== 'all') return 'tool_call';
  if (REASONING_TYPES.has(ct)) return 'reasoning';
  if (CONTEXT_TYPES.has(ct)) return 'context';
  if (ct === 'system_error') return 'system';
  if (!text.trim() && !attachments.length) return 'empty';
  return null;
}

function toTime(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return null;
}

/** Leaf used when current_node is missing or not in the mapping: the latest message wins. */
function fallbackLeaf(mapping) {
  let best = null;
  let bestTime = -Infinity;
  for (const [id, node] of Object.entries(mapping)) {
    const kids = (node && node.children) || [];
    if (kids.some((k) => k in mapping)) continue;
    if (!node || !node.message) continue;
    const t = toTime(node.message.create_time);
    const key = t === null ? -Infinity : t;
    if (best === null || key >= bestTime) {
      best = id;
      bestTime = key;
    }
  }
  return best;
}

/**
 * @returns {object|null} normalized conversation, or null when the object is not a usable conversation.
 */
function normalizeConversation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.conversation_id || raw.id;
  if (typeof id !== 'string' || !id) return null;
  const mapping = raw.mapping && typeof raw.mapping === 'object' ? raw.mapping : null;
  if (!mapping) return null;

  let current = raw.current_node;
  if (!(current in mapping)) current = fallbackLeaf(mapping);

  // Current branch: current_node -> parent -> ... -> root (cycle-safe).
  const branch = [];
  const seen = new Set();
  for (let n = current; n && n in mapping && !seen.has(n); n = mapping[n] && mapping[n].parent) {
    seen.add(n);
    branch.push(n);
  }
  branch.reverse();
  const branchPos = new Map(branch.map((n, i) => [n, i]));

  const nodes = [];
  const branchModels = [];
  let seq = 0;
  for (const [nodeId, node] of Object.entries(mapping)) {
    const message = node && node.message && typeof node.message === 'object' ? node.message : null;
    const row = {
      node_id: nodeId,
      parent_id: (node && node.parent) || null,
      seq: seq++,
      branch_pos: branchPos.has(nodeId) ? branchPos.get(nodeId) : null,
      role: null, author_name: null, recipient: null, content_type: null, model: null,
      create_time: null, hidden: 1, hidden_reason: 'empty', text: '', search_text: '', attachments: [],
    };
    if (message) {
      const author = message.author || {};
      const content = message.content || {};
      const md = message.metadata || {};
      row.role = author.role || null;
      row.author_name = author.name || null;
      row.recipient = message.recipient || null;
      row.content_type = content.content_type || null;
      row.model = md.model_slug || null;
      row.create_time = toTime(message.create_time);
      row.text = contentText(content);
      row.search_text = cleanText(row.text);
      row.attachments = attachmentsOf(message);
      row.hidden_reason = hiddenReason(message, row.role, row.content_type, row.text, row.attachments);
      row.hidden = row.hidden_reason ? 1 : 0;
      if (row.branch_pos !== null && row.model && row.role === 'assistant') branchModels.push(row.model);
    }
    nodes.push(row);
  }

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : null;
  const createTime = toTime(raw.create_time);
  const updateTime = toTime(raw.update_time);
  const gizmoId = typeof raw.gizmo_id === 'string' && raw.gizmo_id ? raw.gizmo_id : null;
  return {
    id,
    title,
    create_time: createTime,
    update_time: updateTime,
    // Dedup key: exports occasionally lack update_time; fall back so the key is never NULL.
    version_time: updateTime ?? createTime ?? 0,
    model: raw.default_model_slug || branchModels[branchModels.length - 1] || null,
    gizmo_id: gizmoId,
    gizmo_type: raw.gizmo_type || null,
    // Project ids look like "g-p-…"; other gizmo ids are custom GPTs.
    gizmo_kind: gizmoId ? (gizmoId.startsWith('g-p-') || raw.gizmo_type === 'snorlax' ? 'project' : 'gpt') : null,
    current_node: current || null,
    nodes,
  };
}

module.exports = { normalizeConversation, contentText };
