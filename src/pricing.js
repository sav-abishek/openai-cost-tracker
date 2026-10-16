'use strict';
const { decimal, format, SCALE } = require('./money');
const VERIFIED = '2026-10-16';
const SOURCE = 'https://developers.openai.com/api/docs/pricing';
const baseModels = {
  'gpt-6-astra': [10, 1, 12.5, 50], 'gpt-6.1-sol': [2, 0.1, 2.5, 10],
  'gpt-6-sol': [2, 0.2, 2.5, 10], 'gpt-6-luna': [0.1, 0.01, 0.125, 0.5],
  'gpt-5.6-sol': [4, 0.4, 5, 20], 'gpt-5.6-terra': [2, 0.2, 2.5, 12],
  'gpt-5.6-luna': [0.2, 0.02, 0.25, 1.2]
};
const cards = [];
const scaledRate=(value,factor)=>format(decimal(value)*decimal(factor)/SCALE,6).replace(/\.?0+$/,'');
for (const [model, rates] of Object.entries(baseModels)) {
  const modes = model.startsWith('gpt-6') ? { standard: 1, fast: 2, flex: 0.5, batch: 0.5 } : { standard: 1 };
  if (['gpt-6-astra', 'gpt-6.1-sol'].includes(model)) modes.ultrafast = 6;
  for (const [tier, factor] of Object.entries(modes)) cards.push({
    model, tier, from: VERIFIED, to: '2026-11-16', verified: VERIFIED, source: SOURCE,
    threshold: 272000, short: rates.map(n => scaledRate(n,factor)),
    long: rates.map((n, i) => scaledRate(n,factor * (i === 3 ? 1.5 : 2)))
  });
}
function validCard(c) {
  return c && typeof c.model === 'string' && typeof c.tier === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(c.from) && /^\d{4}-\d{2}-\d{2}$/.test(c.to) && c.to > c.from &&
    Number.isSafeInteger(c.threshold) && c.threshold >= 0 &&
    [c.short, c.long].every(a => Array.isArray(a) && a.length === 4 && a.every(n => Number.isFinite(Number(n)) && Number(n) >= 0 && /^\d+(\.\d{1,6})?$/.test(String(n))));
}
function normalizeTier(tier) { return ({ default: 'standard', priority: 'fast' })[tier] || tier; }
function price(event, settings = {}) {
  const notes = [];
  const no = reason => ({ amount: null, reason, notes });
  if (event.issue) return no(event.issue);
  if (event.provider !== 'openai') return no('Provider is not verified as OpenAI');
  if (event.usage.cached === null) return no('Cache-read token count missing');
  if (event.usage.write === null) return no('Cache-write token count missing');
  let tier = normalizeTier(event.tier);
  if (!tier || tier === 'auto') {
    tier = settings.assumedTier || 'standard'; notes.push('Processing tier assumed: ' + tier);
  }
  if(!Number.isFinite(Date.parse(event.timestamp)))return no('Invalid usage timestamp');
  const date = new Date(event.timestamp).toISOString().slice(0, 10);
  const overrides = (settings.rateOverrides || []).filter(validCard);
  const custom = overrides.filter(c => c.model === event.model && c.tier === tier && c.from <= date && date < c.to);
  if (custom.length > 1) return no('Overlapping custom rate cards');
  const card = custom[0] || cards.find(c => c.model === event.model && c.tier === tier && c.from <= date && date < c.to);
  if (!card) return no('No verified rate for this model, tier and date');
  if (custom.length) notes.push('User-specified rate card');
  const u = event.usage;
  if (![u.input,u.cached,u.write,u.output].every(n => Number.isSafeInteger(n) && n >= 0) || u.cached + u.write > u.input) return no('Invalid token accounting');
  const rate = u.input > card.threshold ? card.long : card.short;
  const quantities = [u.input - u.cached - u.write, u.cached, u.write, u.output];
  const names = ['uncachedInput','cacheRead','cacheWrite','output'];
  const components = Object.fromEntries(quantities.map((n,i)=>[names[i],(BigInt(n)*decimal(rate[i])/1_000_000n).toString()]));
  const amount = Object.values(components).reduce((sum,n)=>sum+BigInt(n),0n);
  const outputDetails = !Number.isSafeInteger(u.reasoning) || u.reasoning<0 || u.reasoning>u.output ? null : {
    reasoning: (BigInt(u.reasoning)*decimal(rate[3])/1_000_000n).toString(),
    other: (BigInt(u.output-u.reasoning)*decimal(rate[3])/1_000_000n).toString()
  };
  return { amount: amount.toString(), components, outputDetails, notes, tier, longContext: u.input > card.threshold,
    rateSource: card.source || 'User override', rateDate: card.verified || card.from };
}
module.exports = { price, validCard, cards, VERIFIED, SOURCE };
