'use strict';
const { decimal } = require('./money');
function scopeKey(settings) { return JSON.stringify({ organization: settings.organizationId || '', projects: [...(settings.billingProjectIds || [])].sort() }); }
async function getJson(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    // Never put a key, response body or request headers into an error or log.
    const help = response.status === 401 ? 'Check the OpenAI Admin key.' : response.status === 403 ? 'The key needs organization Costs access.' : response.status === 429 ? 'Rate limited; retry later.' : 'Try again later.';
    throw new Error('HTTP ' + response.status + '. ' + help);
  }
  const body = await response.text();
  if (body.length > 8_000_000) throw new Error('Response exceeds accounting size limit');
  try { return JSON.parse(body); } catch { throw new Error('Service returned invalid JSON'); }
}
async function fetchCosts(key, settings = {}, now = new Date(), fetcher = fetch) {
  const month = settings.selectedMonth || now.toISOString().slice(0,7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month>now.toISOString().slice(0,7)) throw new Error('Choose a current or past billing month');
  const [year,monthNumber]=month.split('-').map(Number);
  const start = Date.UTC(year, monthNumber-1, 1) / 1000;
  const end = Math.min(Math.floor(now.getTime() / 1000),Date.UTC(year,monthNumber,1)/1000);
  const rows = [], visited = new Set(), bucketSet = new Set();
  let page = null;
  for (let iteration = 0; iteration < 100; iteration++) {
    const url = new URL('https://api.openai.com/v1/organization/costs');
    url.searchParams.set('start_time', String(start)); url.searchParams.set('end_time', String(end));
    url.searchParams.set('bucket_width', '1d'); url.searchParams.set('limit', '31');
    url.searchParams.append('group_by', 'project_id'); url.searchParams.append('group_by', 'line_item');
    for (const id of settings.billingProjectIds || []) url.searchParams.append('project_ids', id);
    if (page) url.searchParams.set('page', page);
    const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json' };
    if (settings.organizationId) headers['OpenAI-Organization'] = settings.organizationId;
    const body = await getJson(url, { headers }, fetcher);
    if (!body || !Array.isArray(body.data) || typeof body.has_more !== 'boolean') throw new Error('Unrecognized Costs response; previous total retained');
    for (const bucket of body.data) {
      if (!Number.isSafeInteger(bucket.start_time) || !Number.isSafeInteger(bucket.end_time) || bucket.start_time < start || bucket.start_time >= end || bucket.end_time <= bucket.start_time || !Array.isArray(bucket.results)) throw new Error('Invalid billing bucket');
      const signature = bucket.start_time + ':' + bucket.end_time;
      if (bucketSet.has(signature)) throw new Error('Repeated billing bucket; refusing to double count');
      bucketSet.add(signature);
      for (const result of bucket.results) {
        if (result.object !== 'organization.costs.result' || result.amount?.currency?.toLowerCase() !== 'usd' || !Number.isFinite(result.amount.value)) throw new Error('Missing or unsupported billing amount');
        rows.push({ date: new Date(bucket.start_time * 1000).toISOString().slice(0,10), project: result.project_id || null,
          lineItem: result.line_item || 'Unspecified', amount: decimal(result.amount.value).toString(),
          quantity: Number.isFinite(result.quantity) ? result.quantity : null, quantityUnit: typeof result.quantity_unit === 'string' ? result.quantity_unit : null });
      }
    }
    if (!body.has_more) return { month, amount: rows.reduce((n,r)=>n+BigInt(r.amount),0n).toString(), rows,
      fetchedAt: now.toISOString(), scope: scopeKey(settings), start, end };
    if (!body.next_page || visited.has(body.next_page)) throw new Error('Invalid billing pagination');
    page = body.next_page; visited.add(page);
  }
  throw new Error('Too many billing pages; previous total retained');
}
async function fetchFx(fetcher = fetch) {
  const rows = await getJson('https://api.frankfurter.dev/v2/rates?base=USD&quotes=INR', {}, fetcher);
  const rate = Array.isArray(rows) && rows.find(r => r.base === 'USD' && r.quote === 'INR');
  if (!rate || !Number.isFinite(rate.rate) || rate.rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(rate.date)) throw new Error('Invalid exchange-rate response');
  return { rate: rate.rate, date: rate.date, source: 'Frankfurter reference rate', fetchedAt: new Date().toISOString() };
}
module.exports = { fetchCosts, fetchFx, scopeKey, getJson };
