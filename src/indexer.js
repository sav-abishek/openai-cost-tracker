'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { fresh, consumeLine, deduplicate } = require('./parser');
const { price, validCard, VERIFIED } = require('./pricing');
const { acquireLock, atomicJson } = require('./shared-state');
const homeIdentity=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
async function walk(dir, result, errors) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') errors.push('Cannot read a log directory: ' + error.code); return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, result, errors);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
  }
}
async function readAppend(file, state, end) {
  if (state.offset >= end) return 0;
  let pending = Buffer.alloc(0), consumed = state.offset, discard = false, readBytes = 0;
  const stream = fs.createReadStream(file, { start: state.offset, end: end - 1, highWaterMark: 65536 });
  for await (const chunk of stream) {
    readBytes += chunk.length;
    let buffer = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0, next;
    while ((next = buffer.indexOf(10, start)) !== -1) {
      if (!discard) consumeLine(buffer.subarray(start, next).toString('utf8'), state);
      discard = false; consumed += next - start + 1; start = next + 1;
      state.offset = consumed;
    }
    pending = buffer.subarray(start);
    if (pending.length > 8 * 1024 * 1024 || discard) {
      // Large attachments are not accounting data. Retain no content in the checkpoint.
      if (!discard) state.errors++;
      discard = true; consumed += pending.length; pending = Buffer.alloc(0);
    }
  }
  return readBytes;
}
function summarize(events, settings = {}, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const month = typeof settings.selectedMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(settings.selectedMonth) ? settings.selectedMonth : today.slice(0, 7);
  const blank = label => ({ label, amount: '0', input: 0, cached: 0, write: 0, output: 0, reasoning: 0, count: 0, unpriced: 0, assumed: 0 });
  const totals = { today: blank(today), month: blank(month), all: blank('All indexed logs') };
  const models = new Map(), sources = new Map(), days = new Map(), sessions = new Map(), reasons = new Map(), months = new Map();
  const tokenCosts = ['uncachedInput','cacheRead','cacheWrite','output'].map(key=>({key,quantity:0,unknownQuantity:0,amount:'0',unpriced:0}));
  const outputDetails = {reasoning:'0',other:'0',reasoningTokens:0,otherTokens:0,unknownRecords:0,unpriced:0};
  const add = (row, event, cost) => {
    row.count++;
    for (const key of ['input','cached','write','output','reasoning']) row[key] += event.usage[key] || 0;
    if (cost.amount === null) row.unpriced++; else row.amount = (BigInt(row.amount) + BigInt(cost.amount)).toString();
    if (cost.notes.some(n => n.startsWith('Processing tier assumed'))) row.assumed++;
  };
  const get = (map, key) => { if (!map.has(key)) map.set(key, blank(key)); return map.get(key); };
  for (const event of events) {
    const cost = price(event, settings), date = new Date(event.timestamp).toISOString().slice(0, 10);
    add(totals.all, event, cost);
    add(get(months, date.slice(0, 7)), event, cost);
    if (date === today) add(totals.today, event, cost);
    if (date.slice(0, 7) !== month) continue;
    if(event.usage.reasoning === null)outputDetails.unknownRecords++;
    else {outputDetails.reasoningTokens+=event.usage.reasoning;outputDetails.otherTokens+=event.usage.output-event.usage.reasoning;}
    if(cost.amount === null || !cost.outputDetails)outputDetails.unpriced++;
    else for(const key of ['reasoning','other'])outputDetails[key]=(BigInt(outputDetails[key])+BigInt(cost.outputDetails[key])).toString();
    const quantities = { uncachedInput: event.usage.cached === null || event.usage.write === null ? null : event.usage.input-event.usage.cached-event.usage.write,
      cacheRead:event.usage.cached,cacheWrite:event.usage.write,output:event.usage.output };
    for (const item of tokenCosts) {
      if(quantities[item.key] === null) item.unknownQuantity++; else item.quantity += quantities[item.key];
      if(cost.amount === null) item.unpriced++; else item.amount=(BigInt(item.amount)+BigInt(cost.components[item.key])).toString();
    }
    add(totals.month, event, cost); add(get(models, event.model), event, cost); add(get(sources, event.source), event, cost); add(get(days, date), event, cost);
    const session = get(sessions, event.session); add(session, event, cost);
    session.source = event.source; session.last = event.timestamp > (session.last || '') ? event.timestamp : session.last;
    if (cost.reason) reasons.set(cost.reason, (reasons.get(cost.reason) || 0) + 1);
  }
  return { totals, months: [...months.values()].sort((a,b)=>b.label.localeCompare(a.label)), tokenCosts, outputDetails, models: [...models.values()], sources: [...sources.values()], days: [...days.values()].sort((a,b)=>a.label.localeCompare(b.label)),
    sessions: [...sessions.values()].sort((a,b)=>b.last.localeCompare(a.last)).slice(0, 12), reasons: [...reasons].map(([reason,count])=>({reason,count})),
    invalidCards: (settings.rateOverrides || []).filter(c=>!validCard(c)).length, verified: VERIFIED, asOf: now.toISOString() };
}
class Indexer {
  constructor(cachePath) { this.cachePath = cachePath; this.files = {}; this.loaded = false; this.home = null; }
  async scan(home, settings = {}, now) {
    if (!this.cachePath) return this.scanLocked(home,settings,now);
    const release=await acquireLock(this.cachePath+'.index',{waitMs:15000});
    if(!release)throw new Error('Another VS Code window is indexing usage; refresh shortly.');
    try {
      // The preceding window may have indexed new or archived logs. Rehydrate inside the lock.
      this.loaded=false;this.files={};this.home=null;
      return await this.scanLocked(home,settings,now);
    } finally { await release(); }
  }
  async scanLocked(home, settings = {}, now) {
    const started = Date.now(), errors = [], found = [];
    if (!this.loaded) {
      try {
        const c = JSON.parse(await fsp.readFile(this.cachePath, 'utf8'));
        if (c.version !== 4 || !c.files || typeof c.files !== 'object' || Array.isArray(c.files) || typeof c.home !== 'string') throw new Error('Invalid checkpoint');
        for (const state of Object.values(c.files)) {
          if (!state || !Number.isSafeInteger(state.offset) || state.offset<0 || !Array.isArray(state.events) || !state.context || !Number.isSafeInteger(state.errors) || !Number.isSafeInteger(state.resets) ||
            !state.events.every(e=>e && /^[a-f0-9]{64}$/.test(e.id) && typeof e.session==='string' && Number.isFinite(Date.parse(e.timestamp)) && e.usage &&
              ['input','output'].every(k=>Number.isSafeInteger(e.usage[k]) && e.usage[k]>=0) &&
              ['cached','write','reasoning'].every(k=>e.usage[k]===null || Number.isSafeInteger(e.usage[k]) && e.usage[k]>=0))) throw new Error('Invalid checkpoint state');
        }
        this.files = c.files; this.home = homeIdentity(c.home);
      }
      catch (e) { if (e.code !== 'ENOENT') errors.push('Index cache rebuilt after unreadable checkpoint'); }
      this.loaded = true;
    }
    if (this.home !== homeIdentity(home)) { this.files = {}; this.home = homeIdentity(home); }
    for (const dir of ['sessions', 'archived_sessions']) await walk(path.join(home, dir), found, errors);
    let changed = false, bytesRead = 0;
    for (const file of found) {
      try {
        const stat = await fsp.stat(file);
        let state = this.files[file];
        if (state && state.size === stat.size && state.mtime === stat.mtimeMs) continue;
        if (!state || stat.size < state.offset || (state.size === stat.size && state.mtime !== stat.mtimeMs) || state.birth !== stat.birthtimeMs) state = fresh();
        bytesRead += await readAppend(file, state, stat.size);
        state.size = stat.size; state.mtime = stat.mtimeMs; state.birth = stat.birthtimeMs;
        this.files[file] = state; changed = true;
      } catch (error) { errors.push('Log read failed: ' + error.code); }
    }
    if (changed && this.cachePath) {
      await fsp.mkdir(path.dirname(this.cachePath), { recursive: true });
      await atomicJson(this.cachePath,{ version: 4, home: this.home, files: this.files });
    }
    const events = deduplicate(this.files);
    const summary = summarize(events, settings, now);
    return { ...summary, diagnostics: { files: found.length, retainedFiles: Object.keys(this.files).length, bytesRead, elapsedMs: Date.now() - started,
      parseErrors: Object.values(this.files).reduce((n,f)=>n+f.errors,0), resets: Object.values(this.files).reduce((n,f)=>n+f.resets,0), errors } };
  }
  export(settings) { return deduplicate(this.files).map(e=>({...e, estimate: price(e,settings)})); }
}
module.exports = { Indexer, summarize, readAppend };
