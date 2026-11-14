'use strict';
/*
 * Tiny JSON-file store, same discipline as SameTree's: the webhook
 * server and the cron-run sweep/digest CLIs share this file and each
 * holds data in memory, so every mutation runs inside a lockfile-held
 * transaction that RELOADS from disk first, applies the change, then
 * writes back atomically (tmp file + rename). Reads reload first; the
 * atomic rename means a reader never sees a partial file.
 */
const fs = require('fs');
const path = require('path');

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.lockPath = filePath + '.lock';
    this.data = Store.emptyData();
    this.load();
  }

  static emptyData() {
    return {
      installations: {}, // id -> { id, accountLogin, suspended, seenAt }
      repos: {},         // repoId -> { id, owner, name, fullName, installationId, digestEnabled }
      prs: {},           // `${repoId}:${number}` -> bot-PR record (see logic.js header)
      digests: {},       // `${repoId}:${isoWeek}` -> { issueNumber, updatedAt }
      events: [],        // append-only action log { at, repoId, number, action }
    };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...Store.emptyData(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = Store.emptyData();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.filePath);
  }

  acquireLock() {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        return fs.openSync(this.lockPath, 'wx');
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        try {
          const st = fs.statSync(this.lockPath);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(this.lockPath); continue; }
        } catch (_) { continue; }
        if (Date.now() > deadline) throw new Error(`store lock timeout: ${this.lockPath}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      }
    }
  }

  transact(mutate) {
    const fd = this.acquireLock();
    try {
      this.load();
      const result = mutate(this.data);
      this.save();
      return result;
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
      try { fs.unlinkSync(this.lockPath); } catch (_) {}
    }
  }

  static prKey(repoId, number) {
    return `${repoId}:${number}`;
  }

  recordInstallation(inst) {
    this.transact((data) => {
      data.installations[inst.id] = {
        id: inst.id,
        accountLogin: inst.account && inst.account.login,
        suspended: false,
        seenAt: new Date().toISOString(),
      };
    });
  }

  suspendInstallation(id) {
    this.transact((data) => {
      if (data.installations[id]) data.installations[id].suspended = true;
    });
  }

  recordRepo(repo, installationId) {
    this.transact((data) => {
      const existing = data.repos[repo.id];
      data.repos[repo.id] = {
        id: repo.id,
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name,
        installationId,
        digestEnabled: existing ? existing.digestEnabled !== false : true,
      };
    });
  }

  getRepo(repoId) {
    this.load();
    return this.data.repos[repoId] || null;
  }

  listRepos() {
    this.load();
    return Object.values(this.data.repos);
  }

  // Insert or merge a PR record. Fields in `record` win except that a
  // null/undefined value never erases a known one — webhook payloads
  // are partial by nature (e.g. check_suite carries no title).
  upsertPr(record) {
    return this.transact((data) => {
      const key = Store.prKey(record.repoId, record.number);
      const existing = data.prs[key] || {};
      const merged = { ...existing };
      for (const [k, v] of Object.entries(record)) {
        if (v !== undefined && v !== null) merged[k] = v;
      }
      if (!existing.createdAt && !merged.createdAt) merged.createdAt = new Date().toISOString();
      if (merged.escalationLevel === undefined) merged.escalationLevel = 0;
      if (!merged.labelsApplied) merged.labelsApplied = [];
      data.prs[key] = merged;
      return merged;
    });
  }

  updatePr(repoId, number, patch) {
    return this.transact((data) => {
      const key = Store.prKey(repoId, number);
      if (!data.prs[key]) return null;
      Object.assign(data.prs[key], patch);
      return data.prs[key];
    });
  }

  getPr(repoId, number) {
    this.load();
    return this.data.prs[Store.prKey(repoId, number)] || null;
  }

  listPrsForRepo(repoId) {
    this.load();
    return Object.values(this.data.prs).filter((p) => p.repoId === repoId);
  }

  listOpenPrs() {
    this.load();
    return Object.values(this.data.prs).filter((p) => p.state === 'open');
  }

  // Newest open PR (highest number) for the same package in a repo,
  // excluding `exceptNumber`; null when none. The supersede oracle.
  findNewerPrForPackage(repoId, packageName, exceptNumber) {
    if (!packageName) return null;
    this.load();
    let best = null;
    for (const pr of Object.values(this.data.prs)) {
      if (pr.repoId !== repoId || pr.state !== 'open') continue;
      if (pr.number === exceptNumber) continue;
      if (pr.packageName !== packageName) continue;
      if (!best || pr.number > best.number) best = pr;
    }
    return best && best.number > exceptNumber ? best : null;
  }

  // Older open PRs for the same package that `number` supersedes.
  findOlderPrsForPackage(repoId, packageName, number) {
    if (!packageName) return [];
    this.load();
    return Object.values(this.data.prs)
      .filter((p) => p.repoId === repoId && p.state === 'open' && p.packageName === packageName && p.number < number)
      .sort((a, b) => a.number - b.number);
  }

  setDigest(repoId, weekKey, issueNumber) {
    this.transact((data) => {
      data.digests[`${repoId}:${weekKey}`] = { issueNumber, updatedAt: new Date().toISOString() };
    });
  }

  getDigest(repoId, weekKey) {
    this.load();
    return this.data.digests[`${repoId}:${weekKey}`] || null;
  }

  appendEvent(entry) {
    this.transact((data) => {
      data.events.push({ at: new Date().toISOString(), ...entry });
      if (data.events.length > 5000) data.events = data.events.slice(-5000);
    });
  }
}

module.exports = { Store };
