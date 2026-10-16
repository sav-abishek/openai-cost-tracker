'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function userDataDir(home = os.homedir()) { return path.join(home, '.ai-cost-ledger'); }
function digest(value) { return createHash('sha256').update(value).digest('hex').slice(0, 20); }
function usageCachePath(codexHome, directory = userDataDir()) {
  let normalized = path.resolve(codexHome);
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return path.join(directory, 'usage-' + digest(normalized) + '.json');
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function acquireReaper(file, staleMs) {
  let candidate = file;
  // Abandoned guards are followed, never blindly deleted. All contenders use
  // the same successor name, so recovering a guard cannot evict its successor.
  // An empty marker gets a grace period for a live writer to add its owner.
  for (let depth = 0; depth < 16; depth++) {
    const token = randomUUID();
    try {
      const handle = await fs.promises.open(candidate, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })); }
      finally { await handle.close(); }
      const owned = candidate;
      return async () => {
        try {
          const owner = JSON.parse(await fs.promises.readFile(owned, 'utf8'));
          if (owner.token === token) await fs.promises.unlink(owned);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        let owner;
        try { owner = JSON.parse(await fs.promises.readFile(candidate, 'utf8')); } catch { /* An interrupted writer can leave an empty guard. */ }
        const stat = await fs.promises.stat(candidate);
        if (owner ? alive(owner.pid) : Date.now() - stat.mtimeMs <= Math.max(staleMs, 30000)) return null;
        const identity = owner?.token || [stat.dev, stat.ino, stat.birthtimeMs].join(':');
        candidate = file + '.recovery-' + digest(candidate + '|' + identity);
      } catch (error) { if (error.code === 'ENOENT') { candidate = file; continue; } throw error; }
    }
  }
  return null;
}
// Locks are local to the user's machine. A live owner is never evicted just because
// a slow API request exceeds the nominal stale interval.
async function acquireLock(file, { waitMs = 0, staleMs = 600000 } = {}) {
  const directory = file + '.lock', token = randomUUID(), started = Date.now();
  await fs.promises.mkdir(path.dirname(directory), { recursive: true });
  while (true) {
    try {
      await fs.promises.mkdir(directory);
      try { await fs.promises.writeFile(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), { mode: 0o600 }); }
      catch (error) { await fs.promises.rmdir(directory).catch(() => {}); throw error; }
      return async () => {
        try {
          const owner = JSON.parse(await fs.promises.readFile(path.join(directory, 'owner.json'), 'utf8'));
          if (owner.token !== token) return;
          await fs.promises.unlink(path.join(directory, 'owner.json'));
          await fs.promises.rmdir(directory);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        let owner;
        try { owner = JSON.parse(await fs.promises.readFile(path.join(directory, 'owner.json'), 'utf8')); } catch { /* An owner may still be writing its marker. */ }
        const stat = await fs.promises.stat(directory);
        const abandoned = owner ? !alive(owner.pid) : Date.now() - stat.mtimeMs > Math.max(staleMs, 30000);
        if (abandoned) {
          // Recheck under an independent cleanup guard. Otherwise two stale
          // contenders could delete the marker belonging to a new lock owner.
          const reapFile = directory + '.reap';
          let releaseReaper, reclaimed = false;
          try {
            releaseReaper = await acquireReaper(reapFile, staleMs);
            if (!releaseReaper) {
              if (Date.now() - started >= waitMs) return null;
              await delay(20);
              continue;
            }
            let current;
            try { current = JSON.parse(await fs.promises.readFile(path.join(directory, 'owner.json'), 'utf8')); } catch { /* Check its directory age below. */ }
            const currentStat = await fs.promises.stat(directory);
            const stillAbandoned = current ? !alive(current.pid) : Date.now() - currentStat.mtimeMs > Math.max(staleMs, 30000);
            if (stillAbandoned) {
              await fs.promises.unlink(path.join(directory, 'owner.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
              await fs.promises.rmdir(directory);
              reclaimed = true;
            }
          } catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
          finally { if (releaseReaper) await releaseReaper(); }
          if (reclaimed) continue;
        }
      } catch (error) { if (error.code === 'ENOENT') continue; }
      if (Date.now() - started >= waitMs) return null;
      await delay(Math.min(40, Math.max(1, waitMs - (Date.now() - started))));
    }
  }
}
async function atomicJson(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.promises.rename(temporary, file); break; }
      catch (error) { if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; await delay(20 * (attempt + 1)); }
    }
  } finally { await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
function emptyState() { return { version: 1, revision: 0, auth: null, billingHistory: {}, fx: null }; }
class SharedState {
  constructor(directory = userDataDir()) { this.directory = directory; this.file = path.join(directory, 'shared-state.json'); }
  async read() {
    try {
      const value = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !value.billingHistory || typeof value.billingHistory !== 'object' || Array.isArray(value.billingHistory)) throw new Error('Unrecognized shared accounting cache');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return emptyState(); throw error; }
  }
  async update(change) {
    const release = await acquireLock(this.file, { waitMs: 10000 });
    if (!release) throw new Error('Shared accounting cache is busy; retry shortly.');
    try {
      const current = await this.read(), next = await change(current);
      if (!next) return current;
      next.version = 1; next.revision = current.revision + 1;
      await atomicJson(this.file, next);
      return next;
    } finally { await release(); }
  }
  async lock(kind, identity, options) { return acquireLock(path.join(this.directory, kind + '-' + digest(identity)), options); }
  async watch(onChange) {
    await fs.promises.mkdir(this.directory, { recursive: true });
    const watcher = fs.watch(this.directory, (_event, name) => { if (!name || String(name) === path.basename(this.file)) onChange(); });
    watcher.on('error', () => watcher.close());
    return watcher;
  }
}
module.exports = { SharedState, userDataDir, usageCachePath, acquireLock, atomicJson };
