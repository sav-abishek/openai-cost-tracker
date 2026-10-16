'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { decimal, format, convert } = require('../src/money');
const { fresh, consume, consumeLine, deduplicate, usage, source } = require('../src/parser');
const { price, validCard } = require('../src/pricing');
const { Indexer, summarize } = require('../src/indexer');
const { fetchCosts, fetchFx, scopeKey, getJson } = require('../src/billing');
const { dashboard, escape } = require('../src/dashboard');

const NOW = new Date('2026-10-16T12:00:00.000Z');
const STAMP = '2026-10-16T10:00:00.000Z';
const raw = (input = 100, cached = 20, write = 30, output = 10, reasoning = 4) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
  output_tokens: output, reasoning_output_tokens: reasoning
});
const meta = (id = 'synthetic-session', timestamp = STAMP, extra = {}) => ({
  type: 'session_meta', timestamp, payload: { id, timestamp, model_provider: 'openai', originator: 'codex_vscode', ...extra }
});
const context = (model = 'gpt-6-astra', tier = 'standard') => ({ type: 'turn_context', payload: { model, service_tier: tier } });
const counter = (total = raw(), last = total, timestamp = STAMP) => ({
  type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } }
});
const event = (extra = {}) => ({
  id: 'synthetic-id', session: 'synthetic-session', timestamp: STAMP, model: 'gpt-6-astra',
  tier: 'standard', provider: 'openai', source: 'Codex in VS Code', usage: usage(raw()), issue: null, ...extra
});
const records = (items) => items.map(item => JSON.stringify(item)).join('\n') + '\n';
const response = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const result = (value, extra = {}) => ({ object: 'organization.costs.result', amount: { value, currency: 'usd' }, project_id: 'proj_fixture', line_item: 'model tokens', ...extra });
const bucket = (day, results) => ({ start_time: Date.UTC(2026, 9, day) / 1000, end_time: Date.UTC(2026, 9, day + 1) / 1000, results });
const page = (data, has_more = false, next_page = null) => ({ data, has_more, next_page });
const customCard = (extra = {}) => ({ model: 'fixture-model', tier: 'standard', from: '2026-10-01', to: '2026-11-01', threshold: 1000, short: ['2', '0.2', '2.5', '10'], long: ['4', '0.4', '5', '15'], ...extra });

test('money accumulates exact fractional dollars and rounds only for display', () => {
  assert.equal(decimal('0.1') + decimal('0.2'), decimal('0.3'));
  assert.equal(decimal('1e-12'), 1n);
  assert.equal(decimal('1.234567890123'), 1234567890123n);
  assert.equal(format(decimal('1234.565')), '1234.57');
  assert.equal(format(decimal('-0.125')), '-0.13');
  assert.equal(format(convert(decimal('2.50'), '83.125')), '207.81');
  assert.equal(format(decimal('12.5'), 0), '13');
  for (const bad of ['NaN', 'Infinity', 'not money', '1e1000']) assert.throws(() => decimal(bad));
});

test('rates apply separately to fresh input, cache reads, cache writes, and output', () => {
  // 50 fresh × $10 + 20 read × $1 + 30 write × $12.50 + 10 output × $50, per million.
  const cost = price(event());
  assert.equal(cost.amount, decimal('0.001395').toString());
  assert.deepEqual(cost.components, { uncachedInput:'500000000', cacheRead:'20000000', cacheWrite:'375000000', output:'500000000' });
  assert.equal(Object.values(cost.components).reduce((sum, n) => sum + BigInt(n), 0n).toString(), cost.amount);
  assert.equal(Object.hasOwn(cost.components, 'reasoning'), false);
  assert.deepEqual(cost.outputDetails,{reasoning:'200000000',other:'300000000'});
  assert.equal(BigInt(cost.outputDetails.reasoning)+BigInt(cost.outputDetails.other),BigInt(cost.components.output));
  const missingReasoning=raw();delete missingReasoning.reasoning_output_tokens;
  assert.equal(usage(missingReasoning).reasoning,null);
  assert.equal(price(event({usage:usage(missingReasoning)})).outputDetails,null);
  assert.equal(price(event({usage:usage(missingReasoning)})).amount,cost.amount);
  const noReasoning = event({ usage: usage(raw(100, 20, 30, 10, 0)) });
  assert.equal(price(noReasoning).amount, price(event()).amount, 'reasoning is a subset of output, not a second charge');
});

test('long context is selected per request, strictly above the threshold', () => {
  const at = price(event({ usage: usage(raw(272000, 0, 0, 100, 0)) }));
  const above = price(event({ usage: usage(raw(272001, 0, 0, 100, 0)) }));
  assert.equal(at.longContext, false);
  assert.equal(at.amount, decimal('2.725').toString());
  assert.equal(above.longContext, true);
  assert.equal(above.amount, decimal('5.44752').toString());
});

test('processing tiers and assumptions are visible and unknown tiers remain unpriced', () => {
  const standard = BigInt(price(event()).amount);
  assert.equal(BigInt(price(event({ tier: 'priority' })).amount), standard * 2n);
  assert.equal(BigInt(price(event({ tier: 'ultrafast' })).amount), standard * 6n);
  assert.equal(BigInt(price(event({ tier: 'flex' })).amount), standard / 2n);
  assert.equal(price(event({ tier: 'default' })).amount, standard.toString());
  const assumed = price(event({ tier: null }), { assumedTier: 'fast' });
  assert.equal(BigInt(assumed.amount), standard * 2n);
  assert.match(assumed.notes.join(' '), /assumed: fast/);
  assert.equal(price(event({ tier: null }), { assumedTier: 'unknown' }).amount, null);
  assert.equal(price(event({ tier: 'unrecognized' })).amount, null);
});

test('unverified model, historic or expired rates, missing writes, and inconsistent usage cannot become zero-cost estimates', () => {
  for (const candidate of [
    event({ model: 'unverified-model' }),
    event({ timestamp: '2026-10-15T23:59:59Z' }),
    event({ timestamp: '2026-11-16T00:00:00Z' }),
    event({ provider: 'unknown' }),
    event({ usage: { ...usage(raw()), write: null } }),
    event({ usage: { ...usage(raw()), cached: 90, write: 30 } }),
    event({ issue: 'Usage gap; per-request allocation unavailable' })
  ]) {
    const cost = price(candidate);
    assert.equal(cost.amount, null);
    assert.ok(cost.reason.length > 0);
  }
});

test('historical custom rates are bounded by dates and conflicting cards fail closed', () => {
  const custom = customCard();
  assert.equal(validCard(custom), true);
  const candidate = event({ model: 'fixture-model', timestamp: '2026-10-01T00:00:00Z' });
  assert.equal(price(candidate, { rateOverrides: [custom] }).amount, decimal('0.000279').toString());
  assert.match(price(candidate, { rateOverrides: [custom] }).notes.join(' '), /User-specified/);
  assert.equal(price(event({ ...candidate, timestamp: '2026-11-01T00:00:00Z' }), { rateOverrides: [custom] }).amount, null);
  assert.match(price(candidate, { rateOverrides: [custom, { ...custom }] }).reason, /Overlapping/);
  for (const invalid of [customCard({ short: ['-1','0','0','0'] }), customCard({ threshold: -1 }), customCard({ to: '2026-09-01' }), customCard({ short: ['1','2'] })]) assert.equal(validCard(invalid), false);
});

test('parser validates integer token counters and disjoint input categories', () => {
  assert.deepEqual(usage(raw()), { input: 100, cached: 20, write: 30, output: 10, reasoning: 4 });
  const missingWrite = raw(); delete missingWrite.cache_write_input_tokens;
  assert.equal(usage(missingWrite).write, null);
  const missingRead = raw(); delete missingRead.cached_input_tokens;
  assert.equal(usage(missingRead).cached, null);
  const noReadPrice = price(event({ usage: usage(missingRead) }));
  assert.equal(noReadPrice.amount, null);
  assert.match(noReadPrice.reason, /Cache-read token count missing/);
  for (const invalid of [raw(-1), raw(100, 80, 30), raw(100,20,30,10,11), raw(100.5), raw(Number.MAX_SAFE_INTEGER + 1)]) assert.equal(usage(invalid), null);
});

test('parser counts successive request deltas and ignores repeated cumulative snapshots', () => {
  const state = fresh();
  for (const rec of [meta(), context(), counter(), counter(raw(), raw(), '2026-10-16T10:00:01Z'), counter(raw(200,40,60,20,8), raw(), '2026-10-16T10:00:02Z')]) consume(rec, state);
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.map(e => e.usage), [usage(raw()), usage(raw())]);
  assert.equal(state.events.every(e => e.issue === null), true);
  assert.equal(summarize(state.events, {}, NOW).totals.month.amount, decimal('0.00279').toString());
});

test('repeated files are deduplicated and a complete event wins over its incomplete copy', () => {
  const state = fresh();
  [meta(), context(), counter()].forEach(rec => consume(rec, state));
  const incomplete = { ...state, events: state.events.map(e => ({ ...e, issue: 'Usage gap' })) };
  assert.equal(deduplicate({ copied: incomplete, original: state }).length, 1);
  assert.equal(deduplicate({ copied: incomplete, original: state })[0].issue, null);
});

test('fork replay advances the inherited baseline without charging parent history again', () => {
  const state = fresh();
  [meta('fork-session', '2026-10-16T10:05:00Z', { forked_from_id: 'parent-session' }), context(),
    counter(raw(200,40,60,20,8), raw(), '2026-10-16T10:04:00Z'),
    counter(raw(300,60,90,30,12), raw(), '2026-10-16T10:06:00Z')].forEach(rec => consume(rec, state));
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0].usage, usage(raw()));
  assert.equal(state.events[0].session, 'fork-session');
  assert.equal(state.events[0].issue, null);
});

test('fork metadata survives replayed parent session metadata and keeps the child identity', () => {
  const state = fresh();
  [meta('child-session', '2026-10-16T10:05:00Z', { forked_from_id:'parent-session', originator:'codex_desktop' }),
    meta('parent-session', '2026-10-16T10:00:00Z'), context(),
    counter(raw(200,40,60,20,8), raw(), '2026-10-16T10:04:00Z'),
    counter(raw(300,60,90,30,12), raw(), '2026-10-16T10:06:00Z')].forEach(rec => consume(rec, state));
  assert.equal(state.meta.id, 'child-session');
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0].usage, usage(raw()));
  assert.equal(state.events[0].session, 'child-session');
  assert.equal(state.events[0].source, 'Codex desktop');
  assert.equal(state.events[0].issue, null);
});

test('counter resets and gaps remain visible and unpriced', () => {
  const reset = fresh();
  [meta(), context(), counter(), counter(raw(50,10,15,5,2), undefined, '2026-10-16T10:01:00Z')].forEach(rec => consume(rec, reset));
  assert.equal(reset.resets, 1);
  assert.match(reset.events[1].issue, /Counter reset/);
  assert.equal(price(reset.events[1]).amount, null);
  const gap = fresh();
  [meta(), context(), counter(raw(200,40,60,20,8), raw())].forEach(rec => consume(rec, gap));
  assert.match(gap.events[0].issue, /Usage gap/);
  assert.equal(price(gap.events[0]).amount, null);
});

test('malformed records are counted and prompts and tool output never enter the retained state', () => {
  const state = fresh();
  consumeLine('{"type":"event_msg","payload":{"type":"token_count", broken', state);
  consumeLine(JSON.stringify({ type:'response_item', payload: { type:'message', content:'SYNTHETIC_PRIVATE_PROMPT' } }), state);
  [meta(), context(), counter()].forEach(rec => consumeLine(JSON.stringify(rec), state));
  assert.equal(state.errors, 1);
  assert.equal(state.events.length, 1);
  assert.equal(JSON.stringify(state).includes('SYNTHETIC_PRIVATE_PROMPT'), false);
});

test('source attribution distinguishes desktop, IDE, CLI and local ChatGPT origins', () => {
  assert.equal(source({ originator:'codex_vscode' }), 'Codex in VS Code');
  assert.equal(source({ originator:'codex_desktop' }), 'Codex desktop');
  assert.equal(source({ originator:'chatgpt_desktop' }), 'ChatGPT desktop (local)');
  assert.equal(source({ source: { subagent: 'spawned' } }), 'Codex subagent');
  assert.equal(source({ source:'cli' }), 'Codex CLI');
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-cost-ledger-tests-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'codex'), sessionDir = path.join(home, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  return { root, home, sessionDir, file: path.join(sessionDir, 'fixture.jsonl'), cache: path.join(root, 'storage', 'index.json') };
}

test('indexer handles partial final lines, process restarts, and zero-read unchanged scans', async t => {
  const f = await fixture(t);
  const first = records([meta(), context(), counter()]);
  const next = JSON.stringify(counter(raw(200,40,60,20,8), raw(), '2026-10-16T10:01:00Z'));
  await fs.writeFile(f.file, first + next.slice(0, 45));
  const initial = new Indexer(f.cache);
  assert.equal((await initial.scan(f.home, {}, NOW)).totals.month.count, 1);
  assert.equal((await initial.scan(f.home, {}, NOW)).diagnostics.bytesRead, 0);
  const restarted = new Indexer(f.cache);
  assert.equal((await restarted.scan(f.home, {}, NOW)).totals.month.count, 1);
  await fs.appendFile(f.file, next.slice(45) + '\n');
  const completed = await restarted.scan(f.home, {}, NOW);
  assert.equal(completed.totals.month.count, 2);
  assert.equal(completed.totals.month.amount, decimal('0.00279').toString());
  assert.ok(completed.diagnostics.bytesRead < Buffer.byteLength(first + next + '\n'));
  assert.equal(completed.diagnostics.parseErrors, 0);
});

test('indexer deduplicates active and archived copies and retains records after deletion', async t => {
  const f = await fixture(t);
  const text = records([meta(), context(), counter()]);
  await fs.writeFile(f.file, text);
  const archived = path.join(f.home, 'archived_sessions');
  await fs.mkdir(archived);
  await fs.writeFile(path.join(archived, 'copy.jsonl'), text);
  const indexer = new Indexer(f.cache);
  let summary = await indexer.scan(f.home, {}, NOW);
  assert.equal(summary.diagnostics.files, 2);
  assert.equal(summary.totals.month.count, 1);
  await fs.unlink(f.file);
  summary = await indexer.scan(f.home, {}, NOW);
  assert.equal(summary.diagnostics.files, 1);
  assert.equal(summary.totals.month.count, 1);
  assert.equal(indexer.export({}).length, 1);
});

test('indexer rebuilds a truncated file instead of keeping stale counters', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, records([meta(), context(), counter(), counter(raw(200,40,60,20,8), raw(), '2026-10-16T10:01:00Z')]));
  const indexer = new Indexer(f.cache);
  assert.equal((await indexer.scan(f.home, {}, NOW)).totals.month.count, 2);
  await fs.writeFile(f.file, records([meta(), context(), counter()]));
  const rebuilt = await indexer.scan(f.home, {}, NOW);
  assert.equal(rebuilt.totals.month.count, 1);
  assert.equal(rebuilt.diagnostics.parseErrors, 0);
});

test('indexer byte offsets remain correct across UTF-8 and large discarded message lines', async t => {
  const f = await fixture(t);
  const privateLine = { type:'response_item', payload:{ text:'SYNTHETIC_PRIVATE_₹'.repeat(9000) } };
  const first = records([meta(), context(), privateLine, counter()]);
  await fs.writeFile(f.file, first, 'utf8');
  const indexer = new Indexer(f.cache);
  assert.equal((await indexer.scan(f.home, {}, NOW)).totals.month.count, 1);
  await fs.appendFile(f.file, records([privateLine, counter(raw(200,40,60,20,8), raw(), '2026-10-16T10:01:00Z')]), 'utf8');
  const updated = await indexer.scan(f.home, {}, NOW);
  assert.equal(updated.totals.month.count, 2);
  assert.equal(updated.diagnostics.parseErrors, 0);
  assert.equal((await fs.readFile(f.cache, 'utf8')).includes('SYNTHETIC_PRIVATE'), false);
});

test('index cache stores counters only and a bad JSON checkpoint rebuilds', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, records([meta(), context(), { type: 'response_item', payload: { text:'SYNTHETIC_PRIVATE_PROMPT' } }, counter()]));
  const indexer = new Indexer(f.cache);
  await indexer.scan(f.home, {}, NOW);
  const stored = await fs.readFile(f.cache, 'utf8');
  assert.equal(stored.includes('SYNTHETIC_PRIVATE_PROMPT'), false);
  await fs.writeFile(f.cache, '{broken');
  const rebuilt = await new Indexer(f.cache).scan(f.home, {}, NOW);
  assert.equal(rebuilt.totals.month.count, 1);
  assert.match(rebuilt.diagnostics.errors.join(' '), /rebuilt/);
});

test('a syntactically valid but malformed cache checkpoint rebuilds without losing availability', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, records([meta(), context(), counter()]));
  await new Indexer(f.cache).scan(f.home, {}, NOW);
  const checkpoint = JSON.parse(await fs.readFile(f.cache, 'utf8'));
  checkpoint.files = null;
  await fs.writeFile(f.cache, JSON.stringify(checkpoint));
  const rebuilt = await new Indexer(f.cache).scan(f.home, {}, NOW);
  assert.equal(rebuilt.totals.month.count, 1);
  assert.match(rebuilt.diagnostics.errors.join(' '), /rebuilt/);
});

test('UTC summaries distinguish unpriced records from zero-valued billed estimates', () => {
  const summary = summarize([
    event(), event({ id:'unknown', model:'unknown' }),
    event({ id:'last-month', timestamp:'2026-09-30T23:59:59Z' }),
    event({ id:'previous-day', timestamp:'2026-10-15T23:59:59Z' })
  ], {}, NOW);
  assert.equal(summary.totals.today.count, 2);
  assert.equal(summary.totals.month.count, 3);
  assert.equal(summary.totals.all.count, 4);
  assert.equal(summary.totals.month.unpriced, 2);
  assert.equal(summary.totals.month.amount, decimal('0.001395').toString());
});

test('individual token-type totals reconcile with the monthly subtotal and preserve unknown quantities', () => {
  const unknownCache = { ...usage(raw()), cached:null };
  const summary = summarize([event(), event({ id:'priced-two' }), event({ id:'unknown-model', model:'unknown' }),
    event({ id:'missing-cache', usage:unknownCache }), event({ id:'excluded-month', timestamp:'2026-09-30T23:59:59Z' })], {}, NOW);
  assert.deepEqual(summary.tokenCosts, [
    { key:'uncachedInput', quantity:150, unknownQuantity:1, amount:'1000000000', unpriced:2 },
    { key:'cacheRead', quantity:60, unknownQuantity:1, amount:'40000000', unpriced:2 },
    { key:'cacheWrite', quantity:120, unknownQuantity:0, amount:'750000000', unpriced:2 },
    { key:'output', quantity:40, unknownQuantity:0, amount:'1000000000', unpriced:2 }
  ]);
  assert.equal(summary.tokenCosts.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString(), summary.totals.month.amount);
  assert.equal(summary.totals.month.reasoning, 16, 'reasoning tokens remain reported within output');
  assert.equal(summary.tokenCosts.some(row => row.key === 'reasoning'), false, 'no additional reasoning charge');
});

test('selecting historical months switches every breakdown while today and all-month history remain intact', () => {
  const historyRate = customCard({model:'gpt-6-astra', from:'2026-01-01', to:'2027-01-01'});
  const events = [
    event({id:'now'}),
    event({id:'september-start', session:'september-session', timestamp:'2026-09-01T00:00:00Z', source:'Historical desktop'}),
    event({id:'september-end', session:'september-session', timestamp:'2026-09-30T23:59:59.999Z', source:'Historical desktop'}),
    event({id:'september-unknown', session:'unknown-session', timestamp:'2026-09-20T12:00:00Z', model:'unknown-model', source:'Historical desktop'}),
    event({id:'august', timestamp:'2026-08-31T23:59:59.999Z', source:'Older CLI'})
  ];
  const settings = {selectedMonth:'2026-09', rateOverrides:[historyRate]};
  const selected = summarize(events, settings, NOW);
  assert.equal(selected.totals.month.label, '2026-09');
  assert.equal(selected.totals.month.count, 3);
  assert.equal(selected.totals.month.unpriced, 1);
  assert.equal(selected.totals.month.amount, decimal('0.000558').toString());
  assert.equal(selected.totals.today.label, '2026-10-16');
  assert.equal(selected.totals.today.count, 1);
  assert.equal(selected.totals.all.count, 5);
  assert.deepEqual(selected.months.map(row => [row.label,row.count]), [['2026-10',1],['2026-09',3],['2026-08',1]]);
  assert.deepEqual(selected.months.find(row => row.label === '2026-09'), selected.totals.month);
  assert.equal(selected.months.reduce((sum, row) => sum + BigInt(row.amount), 0n).toString(), selected.totals.all.amount);
  assert.deepEqual(selected.sources.map(row => row.label), ['Historical desktop']);
  assert.deepEqual(selected.days.map(row => row.label), ['2026-09-01','2026-09-20','2026-09-30']);
  assert.equal(selected.models.reduce((sum,row) => sum + row.count, 0), 3);
  assert.equal(selected.sessions.reduce((sum,row) => sum + row.count, 0), 3);
  assert.equal(selected.reasons.reduce((sum,row) => sum + row.count, 0), 1);
  assert.equal(selected.tokenCosts.find(row => row.key === 'output').quantity, 30);
  assert.equal(selected.tokenCosts.reduce((sum,row) => sum + BigInt(row.amount), 0n).toString(), selected.totals.month.amount);
  assert.equal(selected.outputDetails.reasoningTokens, 12);
  assert.equal(selected.outputDetails.otherTokens, 18);
  assert.equal(selected.outputDetails.unpriced, 1);
  assert.equal(BigInt(selected.outputDetails.reasoning) + BigInt(selected.outputDetails.other), BigInt(selected.tokenCosts.find(row => row.key === 'output').amount));
  const empty = summarize(events, {...settings, selectedMonth:'2026-07'}, NOW);
  assert.equal(empty.totals.month.count, 0);
  assert.equal(empty.totals.month.amount, '0');
  assert.deepEqual(empty.models, []);
  assert.deepEqual(empty.sources, []);
  assert.deepEqual(empty.days, []);
  assert.deepEqual(empty.reasons, []);
  assert.equal(empty.totals.today.count, 1);
  assert.deepEqual(empty.months, selected.months);
});

test('month selection falls back safely and daily buckets respect UTC across month and year boundaries', () => {
  const events = [event(), event({id:'new-year', timestamp:'2026-01-01T00:15:00+05:30'}),
    event({id:'month-boundary', timestamp:'2026-10-01T00:15:00+05:30'})];
  for (const selectedMonth of [undefined, '', '2026-13', '2026-00', '2026-1', '<script>']) {
    assert.equal(summarize(events, {selectedMonth}, NOW).totals.month.label, '2026-10');
  }
  const pastYear = summarize(events, {selectedMonth:'2025-12'}, NOW);
  assert.equal(pastYear.totals.month.count, 1);
  assert.deepEqual(pastYear.days.map(row => row.label), ['2025-12-31']);
  assert.deepEqual(pastYear.months.map(row => row.label), ['2026-10','2026-09','2025-12']);
  assert.equal(summarize(events, {selectedMonth:'2026-09'}, NOW).totals.month.count, 1);
});

test('billing follows all pages, preserves negative credits, and scopes the request', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return response(calls.length === 1 ? page([bucket(1, [result(0.1), result(0.2)])], true, 'cursor-two') : page([bucket(2, [result(-0.05, { line_item:'credit' })])]));
  };
  const settings = { organizationId:'org_fixture', billingProjectIds:['proj_fixture'] };
  const costs = await fetchCosts('synthetic-admin-key', settings, NOW, fetcher);
  assert.equal(costs.amount, decimal('0.25').toString());
  assert.equal(costs.rows.length, 3);
  assert.equal(costs.rows[2].amount, decimal('-0.05').toString());
  assert.equal(calls[0].url.origin, 'https://api.openai.com');
  assert.equal(calls[0].url.searchParams.get('start_time'), String(Date.UTC(2026,9,1) / 1000));
  assert.equal(calls[0].url.searchParams.get('end_time'), String(NOW.getTime() / 1000));
  assert.deepEqual(calls[0].url.searchParams.getAll('project_ids'), ['proj_fixture']);
  assert.deepEqual(calls[0].url.searchParams.getAll('group_by'), ['project_id','line_item']);
  assert.equal(calls[1].url.searchParams.get('page'), 'cursor-two');
  assert.equal(calls[0].options.headers['OpenAI-Organization'], 'org_fixture');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(costs.scope, scopeKey(settings));
});

test('historical billing requests exactly the selected UTC calendar month', async () => {
  const selectedMonth = '2026-09';
  const start = Date.UTC(2026,8,1) / 1000, end = Date.UTC(2026,9,1) / 1000;
  const costs = await fetchCosts('synthetic-admin-key', {selectedMonth}, NOW, async url => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('start_time'), String(start));
    assert.equal(parsed.searchParams.get('end_time'), String(end));
    return response(page([{start_time:Date.UTC(2026,8,30)/1000,end_time:end,results:[result(1.25),result(-0.25)]}]));
  });
  assert.equal(costs.month, selectedMonth);
  assert.equal(costs.start, start);
  assert.equal(costs.end, end);
  assert.equal(costs.amount, decimal('1').toString());
  assert.deepEqual(costs.rows.map(row => row.date), ['2026-09-30','2026-09-30']);
});

test('a failure after a billing page rejects the whole refresh instead of returning a partial total', async () => {
  let calls = 0;
  const fetcher = async () => ++calls === 1 ? response(page([bucket(1,[result(1)])], true, 'more')) : { ok:false, status:429, text:async () => 'sensitive response must not be shown' };
  await assert.rejects(fetchCosts('synthetic-admin-key', {}, NOW, fetcher), error => {
    assert.match(error.message, /HTTP 429/);
    assert.equal(error.message.includes('sensitive'), false);
    assert.equal(error.message.includes('synthetic-admin-key'), false);
    return true;
  });
});

test('billing rejects unsupported currencies, invalid amounts and missing schemas', async () => {
  const invalids = [
    page([bucket(1, [result(1, { amount: { value:1, currency:'inr' } })])]),
    page([bucket(1, [result(1, { amount: { value:'1.00', currency:'usd' } })])]),
    page([bucket(1, [result(1, { object:'not-a-cost' })])]),
    { data: [] },
    page([{ ...bucket(1, []), end_time: Date.UTC(2026,9,1) / 1000 }])
  ];
  for (const invalid of invalids) await assert.rejects(fetchCosts('synthetic-key', {}, NOW, async () => response(invalid)));
});

test('billing rejects repeated buckets, missing cursors and cyclic pagination', async () => {
  await assert.rejects(fetchCosts('synthetic-key', {}, NOW, async () => response(page([bucket(1,[result(1)]), bucket(1,[result(1)])]))), /Repeated billing bucket/);
  await assert.rejects(fetchCosts('synthetic-key', {}, NOW, async () => response(page([], true))), /pagination/);
  await assert.rejects(fetchCosts('synthetic-key', {}, NOW, async () => response(page([], true, 'same-cursor'))), /pagination/);
});

test('billing scope identity is stable across project ordering and differs across organizations', () => {
  assert.equal(scopeKey({billingProjectIds:['b','a']}), scopeKey({billingProjectIds:['a','b']}));
  assert.notEqual(scopeKey({organizationId:'one'}), scopeKey({organizationId:'two'}));
});

test('HTTP responses cannot redirect the Admin key and errors exclude response bodies', async () => {
  await assert.rejects(getJson('https://api.openai.com/v1/organization/costs', {}, async (_, options) => {
    assert.equal(options.redirect, 'error');
    return { ok: false, status:403, text:async () => 'synthetic-sensitive-body' };
  }), error => error.message.includes('Costs access') && !error.message.includes('synthetic-sensitive-body'));
  await assert.rejects(getJson('https://api.openai.com', {}, async () => ({ ok:true, text:async () => 'not JSON' })), /invalid JSON/);
});

test('FX records retain the reference rate date and reject negative rates or wrong pairs', async () => {
  const fx = await fetchFx(async () => response([{ base:'USD', quote:'INR', rate:83.125, date:'2026-10-16' }]));
  assert.equal(fx.rate, 83.125);
  assert.equal(fx.date, '2026-10-16');
  for (const bad of [{base:'USD',quote:'INR',rate:-1,date:'2026-10-16'}, {base:'EUR',quote:'INR',rate:90,date:'2026-10-16'}, {base:'USD',quote:'INR',rate:83,date:'not-a-date'}]) await assert.rejects(fetchFx(async () => response([bad])), /exchange-rate/);
});

test('dashboard escapes all externally supplied text, uses nonce CSP, and separates reported and estimated totals', () => {
  const payload = '<img src=x onerror="alert(1)">&\'';
  const summary = summarize([event({ source:payload, model:payload })], {}, NOW);
  summary.diagnostics = { files:1, parseErrors:0, errors:[], elapsedMs:1, bytesRead:500 };
  const html = dashboard({ summary, billing: { amount:decimal('5').toString(), fetchedAt:NOW.toISOString(), rows:[{date:'2026-10-01',project:payload,lineItem:payload,amount:decimal('-0.25').toString()}] }, fx:{rate:83,date:'2026-10-16',source:payload}, settings:{assumedTier:'standard',billingProjectIds:[payload],billingRefreshMinutes:15}, billingError:payload, connected:true });
  assert.equal(html.includes(payload), false);
  assert.ok(html.includes(escape(payload)));
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-[^']+'/);
  assert.match(html, /OpenAI reported/);
  assert.match(html, /Local token estimate/);
  assert.match(html, /never added together/);
  assert.match(html, /Unpriced/);
  assert.match(html, /\$5\.00/);
  assert.match(html, /₹415\.00/);
});
