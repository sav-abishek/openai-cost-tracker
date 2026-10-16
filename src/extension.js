'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { fetchCosts, fetchFx, scopeKey } = require('./billing');
const { format, convert } = require('./money');
const { dashboard } = require('./dashboard');
const { SharedState, usageCachePath, userDataDir } = require('./shared-state');
const KEY = 'openaiOrganizationAdminKey';
let stop;
async function activate(context) {
  const applicationSetting = (key, fallback) => {
    const inspected = vscode.workspace.getConfiguration('aiCostLedger').inspect(key);
    return inspected?.globalValue ?? inspected?.defaultValue ?? fallback;
  };
  const configuredDirectory = () => {
    const value = applicationSetting('dataDirectory', '');
    return typeof value === 'string' && value.trim() && path.isAbsolute(value.trim()) ? path.resolve(value.trim()) : userDataDir();
  };
  const initialDirectory = configuredDirectory();
  const testDirectory = context.extensionMode !== vscode.ExtensionMode.Production ? process.env.AI_COST_LEDGER_TEST_DATA_DIR : undefined;
  const shared = new SharedState(testDirectory || initialDirectory);
  const state = { summary: null, billing: null, billingHistory: {},
    fx: { rate: 94.97, date: '2026-10-16', source: 'Frankfurter reference rate (bundled)' },
    selectedMonth: context.globalState.get('selectedMonth') || new Date().toISOString().slice(0, 7),
    connected: false, billingError: '', indexError: '', fxError: '',
    globalScope: { allProjects: true, localHost: true, sharedAcrossWindows: true, billing: 'OpenAI API organization across apps and devices', storage: 'Global application data directory' } };
  let panel, worker, workerAlive = false, serial = 0, disposed = false, scanning = null, billingBusy = null, fxBusy = null;
  let watcher, sharedWatcher, debounce, sharedDebounce, cachePath, authRevision = null, revision = -1, directoryNotice = initialDirectory;
  const pending = new Map();
  const log = vscode.window.createOutputChannel('OpenAI Cost Tracker');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  status.name = 'OpenAI Cost Tracker'; status.command = 'aiCostLedger.open'; status.text = '$(pulse) AI: indexing…'; status.show();
  const treeChanged = new vscode.EventEmitter();
  function settings() {
    // Ignore folder/workspace and language overrides, including legacy settings.
    const read = applicationSetting;
    return { selectedMonth: state.selectedMonth, dataDirectory: shared.directory, codexHome: read('codexHome', '') || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
      assumedTier: read('assumedTier', 'standard'), usdInr: read('usdInr', 0), billingProjectIds: read('billingProjectIds', []),
      organizationId: read('organizationId', ''), billingRefreshMinutes: Math.min(1440, Math.max(5, read('billingRefreshMinutes', 15))), rateOverrides: read('rateOverrides', []) };
  }
  function view() {
    const config = settings(), month = state.selectedMonth;
    const billing = state.connected ? state.billingHistory[scopeKey(config) + '|' + month] || null : null;
    const billingHistory = state.connected ? Object.values(state.billingHistory).filter(b => b.scope === scopeKey(config)) : [];
    const fx = config.usdInr > 0 ? { rate: config.usdInr, date: null, source: 'Manual conversion rate' } : state.fx;
    return { ...state, settings: config, billing, billingHistory, fx };
  }
  function render() {
    if (disposed) return;
    const v = view(), total = v.billing?.amount, local = state.summary?.totals.month;
    if (total !== undefined) status.text = '$(credit-card) ' + state.selectedMonth + ' $' + format(BigInt(total)) + ' · ₹' + format(convert(BigInt(total), v.fx.rate));
    else if (local?.count === 0) status.text = '$(pulse) ' + state.selectedMonth + ' · No local records';
    else if (local) status.text = local.count && local.count === local.unpriced ? '$(warning) ' + state.selectedMonth + ' AI: unpriced' : '$(pulse) ' + state.selectedMonth + ' ≈$' + format(BigInt(local.amount)) + ' · ₹' + format(convert(BigInt(local.amount), v.fx.rate)) + (local.unpriced ? ' *' : '');
    else status.text = '$(pulse) AI: indexing…';
    status.backgroundColor = state.billingError || state.indexError ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = 'OpenAI Cost Tracker · All projects · ' + state.selectedMonth + ' (UTC)\n' + (v.billing ? 'OpenAI API costs across apps/devices. Last sync: ' + v.billing.fetchedAt : state.connected ? 'Local token estimate; selected month has not been fetched yet.' : 'Local token estimate on this computer; billing is not connected.') +
      '\nINR uses ' + v.fx.source + ' (' + (v.fx.date || 'manual') + ').' + (local?.unpriced ? '\n' + local.unpriced + ' records unpriced; displayed estimate is partial.' : '') +
      (state.billingError ? '\nBilling refresh failed: ' + state.billingError : '') + '\nClick to open accounting details.';
    if (panel) panel.webview.html = dashboard(v);
    treeChanged.fire();
  }
  async function adoptShared() {
    if (disposed) return;
    const snapshot = await shared.read(), key = await context.secrets.get(KEY);
    if (disposed || snapshot.revision < revision) return;
    const changedAuth = authRevision !== snapshot.auth?.revision;
    revision = snapshot.revision; authRevision = snapshot.auth?.revision || null;
    state.connected = !!key && !!snapshot.auth?.connected;
    state.billingHistory = state.connected ? snapshot.billingHistory : {};
    if (snapshot.fx) state.fx = snapshot.fx;
    if (changedAuth || !state.connected) state.billingError = '';
    render();
  }
  async function loadShared() { try { await adoptShared(); } catch { state.billingError = 'Shared accounting cache could not be read.'; render(); } }
  try {
    const initialKey = await context.secrets.get(KEY);
    await shared.update(current => {
      if (current.auth) return null;
      const legacy = context.globalState.get('billing');
      current.auth = { revision: randomUUID(), connected: !!initialKey };
      current.billingHistory = initialKey ? context.globalState.get('billingHistory') || (legacy ? { [legacy.scope + '|' + legacy.month]: legacy } : {}) : {};
      current.fx = context.globalState.get('fx') || null;
      return current;
    });
    await adoptShared();
    sharedWatcher = await shared.watch(() => { clearTimeout(sharedDebounce); sharedDebounce = setTimeout(() => { void loadShared(); }, 75); });
  } catch { state.billingError = 'Shared accounting cache is unavailable. Local token estimates remain available.'; }
  function failPending(message) { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } pending.clear(); }
  function startWorker() {
    cachePath = usageCachePath(settings().codexHome, shared.directory);
    const currentWorker = new Worker(path.join(__dirname, 'worker.js'), { workerData: { cachePath } });
    worker = currentWorker; workerAlive = true;
    currentWorker.on('message', message => { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(message.error)) : p.resolve(message.result); });
    const failed = () => {
      if (worker !== currentWorker) return;
      workerAlive = false; failPending('Usage worker stopped; reload VS Code to restart it.');
      if (!disposed) { state.indexError = 'Usage worker stopped; reload VS Code.'; render(); }
    };
    currentWorker.on('error', failed); currentWorker.on('exit', failed);
  }
  startWorker();
  function callWorker(action, config = settings()) {
    if (!workerAlive || disposed) return Promise.reject(new Error('Usage worker is unavailable; reload VS Code.'));
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Usage indexing timed out; retry or reload VS Code.')); }, 120000);
      pending.set(id, { resolve, reject, timer });
      try { worker.postMessage({ id, action, home: config.codexHome, settings: config }); }
      catch { pending.delete(id); clearTimeout(timer); reject(new Error('Usage worker request failed.')); }
    });
  }
  function scan() {
    if (scanning || disposed) return scanning;
    scanning = (async () => {
      // A settings change during indexing must not render an old result under a
      // new month heading. Re-run with the newest immutable settings snapshot.
      while (!disposed) {
        const config = settings(), signature = JSON.stringify(config);
        const nextPath = usageCachePath(config.codexHome, shared.directory);
        if (nextPath !== cachePath) { const old = worker; worker = null; workerAlive = false; failPending('Usage source changed.'); await old.terminate(); startWorker(); }
        const summary = await callWorker('scan', config);
        if (signature !== JSON.stringify(settings())) continue;
        state.summary = summary; state.indexError = ''; break;
      }
    })().catch(error => { if (!disposed) { state.indexError = error.message; log.appendLine(error.message); } }).finally(() => { scanning = null; render(); });
    return scanning;
  }
  function syncBilling(force = false) {
    if (billingBusy || disposed) return billingBusy;
    let requestGeneration;
    billingBusy = (async () => {
      await adoptShared();
      const generation = authRevision, config = settings();
      requestGeneration = generation;
      const key = await context.secrets.get(KEY);
      if (!key || !state.connected) return;
      const identity = scopeKey(config) + '|' + config.selectedMonth;
      const release = await shared.lock('billing', generation + '|' + identity);
      if (!release) return;
      try {
        const latest = await shared.read();
        if (!latest.auth?.connected || latest.auth.revision !== generation || disposed) return;
        const cached = latest.billingHistory[identity];
        if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < config.billingRefreshMinutes * 60000) { await adoptShared(); return; }
        const result = await fetchCosts(key, config);
        if (disposed) return;
        // Auth validation and write are atomic with respect to other windows.
        await shared.update(current => {
          if (!current.auth?.connected || current.auth.revision !== generation) return null;
          current.billingHistory[result.scope + '|' + result.month] = result; return current;
        });
        await adoptShared();
        if (generation === authRevision) state.billingError = '';
      } finally { await release(); }
    })().catch(async error => { await loadShared(); if (!disposed && state.connected && requestGeneration === authRevision) { state.billingError = error.message; log.appendLine('Billing sync failed: ' + error.message); } }).finally(() => { billingBusy = null; render(); });
    return billingBusy;
  }
  function syncFx(force = false) {
    if (fxBusy || disposed) return fxBusy;
    fxBusy = (async () => {
      const release = await shared.lock('fx', 'usd-inr');
      if (!release) return;
      try {
        const snapshot = await shared.read();
        if (!force && snapshot.fx?.fetchedAt && Date.now() - Date.parse(snapshot.fx.fetchedAt) < 86400000) { await adoptShared(); return; }
        const fx = await fetchFx();
        if (disposed) return;
        await shared.update(current => { current.fx = fx; return current; });
        await adoptShared(); state.fxError = '';
      } finally { await release(); }
    })().catch(error => { if (!disposed) state.fxError = error.message; }).finally(() => { fxBusy = null; render(); });
    return fxBusy;
  }
  async function connect() {
    const key = await vscode.window.showInputBox({ title: 'Connect OpenAI organization billing', password: true, ignoreFocusOut: true,
      prompt: 'Paste an OpenAI organization Admin key with Costs access. Stored only in VS Code SecretStorage; sent only to api.openai.com.',
      placeHolder: 'OpenAI Admin key', validateInput: value => /\s/.test(value.trim()) || value.trim().length < 10 ? 'Enter a valid Admin key without embedded whitespace.' : undefined });
    if (!key?.trim()) return;
    const generation = randomUUID();
    const release = await shared.lock('credentials', 'change', { waitMs: 10000 });
    if (!release) throw new Error('A billing connection is being changed in another window. Retry shortly.');
    try {
      await shared.update(current => { current.auth = { revision: generation, connected: false }; current.billingHistory = {}; return current; });
      await adoptShared();
      await context.secrets.store(KEY, key.trim());
      await shared.update(current => { if (current.auth.revision !== generation) return null; current.auth.connected = true; return current; });
    } finally { await release(); }
    await adoptShared();
    if (billingBusy) await billingBusy;
    await syncBilling(true); render();
    if (state.billingError) vscode.window.showWarningMessage('OpenAI Cost Tracker: ' + state.billingError);
    else if (state.connected) vscode.window.showInformationMessage('OpenAI Cost Tracker: OpenAI reported costs connected.');
  }
  async function disconnect() {
    const release = await shared.lock('credentials', 'change', { waitMs: 10000 });
    if (!release) throw new Error('A billing connection is being changed in another window. Retry shortly.');
    try {
      await shared.update(current => { current.auth = { revision: randomUUID(), connected: false }; current.billingHistory = {}; return current; });
      await context.secrets.delete(KEY);
    } finally { await release(); }
    await adoptShared();
    await Promise.all([context.globalState.update('billing', undefined), context.globalState.update('billingHistory', undefined)]);
  }
  async function selectMonth(requested) {
    const valid = value => /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value >= '2020-01' && value <= new Date().toISOString().slice(0, 7);
    const month = typeof requested === 'string' ? requested : await vscode.window.showInputBox({ title: 'Choose usage month (UTC)', value: state.selectedMonth, prompt: 'Enter YYYY-MM to view daily usage and fetch that month’s reported costs.', validateInput: value => valid(value) ? undefined : 'Use YYYY-MM from 2020-01 through the current month.' });
    if (!month || !valid(month) || month === state.selectedMonth) return;
    state.selectedMonth = month; state.summary = null; state.billingError = ''; render();
    await context.globalState.update('selectedMonth', month);
    if (billingBusy) await billingBusy;
    await Promise.allSettled([scan(), syncBilling()]);
  }
  async function exportData() {
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(os.homedir(), 'ai-cost-ledger-' + new Date().toISOString().slice(0, 10) + '.json')), filters: { JSON: ['json'] } });
    if (!target) return;
    await scan(); const current = view();
    const result = { version: 1, exportedAt: new Date().toISOString(), units: 'Integer picodollars (1 USD = 1000000000000); tokens are integers',
      selectedMonth: state.selectedMonth, fx: current.fx, reportedBilling: current.billing, reportedBillingHistory: current.billingHistory, localSummary: current.summary, localUsage: await callWorker('export'),
      assumptions: { tier: current.settings.assumedTier, scope: scopeKey(current.settings), localEstimatesExclude: 'tools, image/audio generation, regional surcharges and negotiated discounts' },
      note: 'Reported billing and estimates overlap. Do not add. INR conversion is not an invoice.' };
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(result, null, 2)));
    vscode.window.showInformationMessage('OpenAI Cost Tracker: accounting export saved.');
  }
  function open() {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('aiCostLedger', 'OpenAI Cost Tracker', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    panel.onDidDispose(() => { panel = null; });
    panel.webview.onDidReceiveMessage(async message => {
      const allowed = { connect, disconnect, refresh: () => Promise.allSettled([scan(), syncBilling(true)]), fx: () => syncFx(true), export: exportData,
        selectMonth, settings: () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:abishek-local.ai-cost-ledger') };
      if (Object.prototype.hasOwnProperty.call(allowed, message?.action)) try { await allowed[message.action](message.month); } catch { vscode.window.showErrorMessage('OpenAI Cost Tracker: action could not be completed.'); }
    }); render();
  }
  const treeProvider = {
    onDidChangeTreeData: treeChanged.event, getTreeItem: item => item,
    getChildren: element => {
      if (element) return [];
      const v = view(), local = v.summary?.totals.month, amount = v.billing?.amount ?? local?.amount;
      const item = (label, description, command) => ({ label, description, collapsibleState: vscode.TreeItemCollapsibleState.None,
        ...(command ? { command: { command: 'aiCostLedger.' + command, title: label } } : {}) });
      const total = amount === undefined ? 'Indexing usage…' : !v.billing && local?.count === 0 ? 'No local records' : !v.billing && local?.count && local.count === local.unpriced ? 'Usage is unpriced' : (v.billing ? '' : '≈') + '$' + format(BigInt(amount)) + ' · ₹' + format(convert(BigInt(amount), v.fx.rate));
      return [item(total, v.selectedMonth + ' UTC', 'open'), item(v.billing ? 'OpenAI reported costs' : 'Local token estimate', local?.unpriced && !v.billing ? 'Partial estimate' : ''),
        item('All projects', 'Global on this computer'), item('Open Dashboard', '', 'open'),
        item(v.connected ? 'Refresh Usage and Billing' : 'Connect OpenAI Billing', '', v.connected ? 'refresh' : 'connect')];
    }
  };
  context.subscriptions.push(treeChanged, vscode.window.registerTreeDataProvider('aiCostLedger.summary', treeProvider));
  function watch() {
    watcher?.close(); watcher = null;
    try {
      watcher = fs.watch(settings().codexHome, { recursive: true }, (_event, name) => {
        if (!name || !/\.jsonl$/i.test(String(name)) || !/^(sessions|archived_sessions)[\\/]/.test(String(name))) return;
        if (debounce) return;
        debounce = setTimeout(() => { debounce = null; void scan(); }, 1500);
      });
      watcher.on('error', () => { watcher?.close(); watcher = null; });
    } catch { /* The minute poll also discovers newly created log roots. */ }
  }
  watch();
  for (const [name, fn] of Object.entries({ open, selectMonth, connect, disconnect, refresh: () => Promise.allSettled([scan(), syncBilling(true)]), export: exportData, fx: () => syncFx(true) })) context.subscriptions.push(vscode.commands.registerCommand('aiCostLedger.' + name, fn));
  if (context.secrets.onDidChange) context.subscriptions.push(context.secrets.onDidChange(event => { if (event.key === KEY) void loadShared(); }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
    if (!event.affectsConfiguration('aiCostLedger')) return;
    const requestedDirectory = configuredDirectory();
    state.globalScope.reloadRequired = !testDirectory && requestedDirectory !== initialDirectory;
    if (state.globalScope.reloadRequired && requestedDirectory !== directoryNotice) {
      directoryNotice = requestedDirectory;
      const choice = await vscode.window.showInformationMessage('OpenAI Cost Tracker: reload all VS Code windows to use the new global data directory. This window will keep using its current directory until reload.', 'Reload Window');
      if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
    if (!state.globalScope.reloadRequired) directoryNotice = initialDirectory;
    watch(); await scan(); render();
    if (event.affectsConfiguration('aiCostLedger.billingProjectIds') || event.affectsConfiguration('aiCostLedger.organizationId')) { if (billingBusy) await billingBusy; await syncBilling(); }
  }));
  const timer = setInterval(() => { void loadShared(); void scan(); void syncBilling(); if (!settings().usdInr) void syncFx(); }, 60000);
  stop = () => {
    disposed = true; clearInterval(timer); clearTimeout(debounce); clearTimeout(sharedDebounce); watcher?.close(); sharedWatcher?.close();
    void worker?.terminate(); failPending('Extension stopped'); panel?.dispose();
  };
  context.subscriptions.push(status, log, { dispose: stop });
  async function ensureApplicationScope() {
    if (context.extensionMode !== vscode.ExtensionMode.Production || !context.extension?.extensionUri) return;
    let release;
    try {
      release = await shared.lock('profiles', 'abishek-local.ai-cost-ledger', { waitMs: 10000 });
      if (!release) { log.appendLine('All-profiles activation is being handled by another window.'); return; }
      const extensionDirectory = context.extension.extensionUri.fsPath;
      const inventoryPath = path.join(path.dirname(extensionDirectory), 'extensions.json');
      const relativeLocation = path.basename(extensionDirectory).toLowerCase();
      const installedEntry = async () => {
        const inventory = JSON.parse(await fs.promises.readFile(inventoryPath, 'utf8'));
        if (!Array.isArray(inventory)) return null;
        const matches = inventory.filter(entry => entry.identifier?.id?.toLowerCase() === 'abishek-local.ai-cost-ledger' &&
          typeof entry.relativeLocation === 'string' && entry.relativeLocation.toLowerCase() === relativeLocation);
        return matches.length === 1 ? matches[0] : null;
      };
      const installed = await installedEntry();
      if (!installed) { log.appendLine('This installation was not found in the VS Code extension inventory. Use Apply Extension to All Profiles from the Extensions view.'); return; }
      state.globalScope.allProfiles = installed.metadata?.isApplicationScoped === true;
      if (state.globalScope.allProfiles) return;
      await vscode.commands.executeCommand('workbench.extensions.action.toggleApplyToAllProfiles', 'abishek-local.ai-cost-ledger', { location: context.extension.extensionUri });
      const confirmed = await installedEntry();
      state.globalScope.allProfiles = confirmed?.metadata?.isApplicationScoped === true;
      if (!state.globalScope.allProfiles) log.appendLine('All-profiles activation could not be verified. Use Apply Extension to All Profiles from the Extensions view.');
    } catch { log.appendLine('All-profiles activation could not be applied automatically. Use Apply Extension to All Profiles from the Extensions view.'); }
    finally { if (release) await release(); }
  }
  const ready = Promise.allSettled([scan(), syncBilling(), settings().usdInr ? Promise.resolve() : syncFx(), ensureApplicationScope()]);
  render();
  return { ready, getSnapshot: () => view(), refresh: scan, openDashboard: open,
    getGlobalRuntimeInfo: () => ({ storagePath: shared.directory, cachePath, workspaceScoped: false, sharedRevision: revision, sidebarRegistered: true }) };
}
function deactivate() { stop?.(); }
module.exports = { activate, deactivate };

