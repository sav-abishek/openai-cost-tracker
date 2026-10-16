'use strict';
const crypto = require('node:crypto');
const FIELDS = { input: 'input_tokens', cached: 'cached_input_tokens', write: 'cache_write_input_tokens', output: 'output_tokens', reasoning: 'reasoning_output_tokens' };
function usage(raw) {
  if (!raw || !Number.isSafeInteger(raw.input_tokens) || !Number.isSafeInteger(raw.output_tokens)) return null;
  const value = {};
  for (const [key, field] of Object.entries(FIELDS)) {
    value[key] = raw[field] === undefined ? null : raw[field];
    if (value[key] !== null && (!Number.isSafeInteger(value[key]) || value[key] < 0)) return null;
  }
  if (value.cached + (value.write || 0) > value.input || value.reasoning > value.output) return null;
  return value;
}
function source(meta) {
  const name = String(meta.originator || '');
  if (typeof meta.source === 'object' && meta.source !== null) return /desktop/i.test(name) ? 'Codex desktop · subagent' : 'Codex subagent';
  if (/chatgpt/i.test(name)) return 'ChatGPT desktop (local)';
  if (/desktop/i.test(name)) return 'Codex desktop';
  if (/vscode|vs.code/i.test(name)) return 'Codex in VS Code';
  if (meta.source === 'cli' || /cli/i.test(name)) return 'Codex CLI';
  return meta.source === 'vscode' ? 'Codex IDE / desktop (unspecified)' : 'Codex (unspecified)';
}
function fresh() { return { offset: 0, events: [], meta: null, context: {}, previous: null, errors: 0, resets: 0 }; }
function consume(record, state) {
  const p = record.payload;
  if (!p) return;
  if (record.type === 'session_meta') {
    // Fork rollouts begin with the child's metadata, then replay the parent's session_meta.
    if (state.meta) return;
    state.meta = { id: p.id, timestamp: p.timestamp || record.timestamp, originator: p.originator,
      source: p.source, provider: p.model_provider || 'unknown', forked: p.forked_from_id || null };
    return;
  }
  if (record.type === 'turn_context') {
    state.context = { model: p.model || 'unknown', tier: p.service_tier || null };
    return;
  }
  if (record.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return;
  const total = usage(p.info.total_token_usage);
  const last = usage(p.info.last_token_usage);
  if (!total || !state.meta?.id || !Number.isFinite(Date.parse(record.timestamp))) { state.errors++; return; }
  const prior = state.previous;
  state.previous = total;
  // Fork files can replay the parent's history. Advance the baseline without charging it again.
  if (Date.parse(record.timestamp) < Date.parse(state.meta.timestamp)) return;
  if (prior && Object.keys(FIELDS).every(k => total[k] === prior[k])) return;
  let delta = prior ? Object.fromEntries(Object.keys(FIELDS).map(k => [k, total[k] === null || prior[k] === null ? null : total[k] - prior[k]])) : total;
  let issue = null;
  if (Object.values(delta).some(v => v !== null && v < 0)) {
    state.resets++; delta = last || total; issue = 'Counter reset; request continuity uncertain';
  }
  // Only price request-sized deltas: long-context pricing cannot be applied to a multi-request aggregate.
  if (!last || !['input','cached','write','output'].every(k => last[k] === delta[k])) issue ||= 'Usage gap; per-request allocation unavailable';
  if (delta.input === 0 && delta.output === 0) return;
  if (delta.cached + (delta.write || 0) > delta.input) issue = 'Inconsistent token delta';
  if (!state.context.model) issue ||= 'Model not recorded';
  const identity = [state.meta.id, record.timestamp, total];
  const id = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  state.events.push({ id, session: state.meta.id, timestamp: record.timestamp, model: state.context.model || 'unknown',
    tier: p.info.service_tier || state.context.tier || null, provider: state.meta.provider,
    source: source(state.meta), usage: delta, issue });
}
function consumeLine(line, state) {
  // Skip prompts, responses and tool output before JSON parsing. Only counters and metadata are retained.
  if (!/"type"\s*:\s*"(?:session_meta|turn_context|event_msg)"/.test(line.slice(0, 400))) return;
  if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) return;
  try { consume(JSON.parse(line), state); } catch { state.errors++; }
}
function deduplicate(files) {
  const map = new Map();
  for (const state of Object.values(files)) for (const event of state.events) {
    const existing = map.get(event.id);
    if (!existing || (existing.issue && !event.issue)) map.set(event.id, event);
  }
  return [...map.values()];
}
module.exports = { fresh, consume, consumeLine, deduplicate, usage, source };
