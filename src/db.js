import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS nhqb_register (
  id TEXT PRIMARY KEY,
  company_name TEXT, legal_name TEXT, holding_company_id TEXT,
  registered_dev_date TEXT, deactivated_dev_date TEXT, insolvent_dev_date TEXT,
  status TEXT, fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS companies (
  company_number TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nhqb_id TEXT,
  match_confidence REAL,
  match_method TEXT,
  watch INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_number TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  data TEXT NOT NULL,
  score INTEGER, band TEXT, factors TEXT,
  FOREIGN KEY(company_number) REFERENCES companies(company_number)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_company ON snapshots(company_number, taken_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_number TEXT NOT NULL,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL, severity TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, evidence TEXT,
  dedupe_key TEXT UNIQUE,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);

CREATE TABLE IF NOT EXISTS gazette_notices (
  notice_id TEXT PRIMARY KEY,
  company_number TEXT NOT NULL,
  code TEXT, category TEXT, published TEXT, title TEXT, url TEXT, snippet TEXT,
  match_strength REAL, fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gazette_company ON gazette_notices(company_number, published DESC);
`;

let db;
export function openDb(file = config.dbPath) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function closeDb() { if (db) { db.close(); db = undefined; } }

export const nowIso = () => new Date().toISOString();

// ---- meta
export function getMeta(key) { return openDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
export function setMeta(key, value) { openDb().prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }

// ---- NHQB register
export function upsertRegisterRows(rows) {
  const d = openDb();
  const stmt = d.prepare(`INSERT INTO nhqb_register(id,company_name,legal_name,holding_company_id,registered_dev_date,deactivated_dev_date,insolvent_dev_date,status,fetched_at)
    VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET company_name=excluded.company_name, legal_name=excluded.legal_name, holding_company_id=excluded.holding_company_id,
      registered_dev_date=excluded.registered_dev_date, deactivated_dev_date=excluded.deactivated_dev_date, insolvent_dev_date=excluded.insolvent_dev_date,
      status=excluded.status, fetched_at=excluded.fetched_at`);
  const ts = nowIso();
  d.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(r.id, r.company_name, r.legal_name, r.holding_company_id, r.registered_dev_date, r.deactivated_dev_date, r.insolvent_dev_date, r.status, ts);
    d.exec('COMMIT');
  } catch (e) { d.exec('ROLLBACK'); throw e; }
}
export function listRegister() { return openDb().prepare('SELECT * FROM nhqb_register ORDER BY company_name').all(); }
export function getRegisterRow(id) { return openDb().prepare('SELECT * FROM nhqb_register WHERE id = ?').get(id) ?? null; }

// ---- companies (watchlist)
export function upsertCompany({ company_number, name, nhqb_id = null, match_confidence = null, match_method = null, watch = 1, notes = null }) {
  openDb().prepare(`INSERT INTO companies(company_number,name,nhqb_id,match_confidence,match_method,watch,notes,added_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(company_number) DO UPDATE SET name=excluded.name,
      nhqb_id=COALESCE(excluded.nhqb_id, companies.nhqb_id),
      match_confidence=COALESCE(excluded.match_confidence, companies.match_confidence),
      match_method=COALESCE(excluded.match_method, companies.match_method),
      watch=excluded.watch, notes=COALESCE(excluded.notes, companies.notes)`)
    .run(company_number, name, nhqb_id, match_confidence, match_method, watch ? 1 : 0, notes, nowIso());
}
export function listCompanies({ watchedOnly = true } = {}) {
  return openDb().prepare(`SELECT c.*, r.company_name AS nhqb_name, r.status AS nhqb_status, r.registered_dev_date, r.deactivated_dev_date, r.insolvent_dev_date
    FROM companies c LEFT JOIN nhqb_register r ON r.id = c.nhqb_id ${watchedOnly ? 'WHERE c.watch = 1' : ''} ORDER BY c.name`).all();
}
export function getCompany(number) {
  return openDb().prepare(`SELECT c.*, r.company_name AS nhqb_name, r.status AS nhqb_status, r.registered_dev_date, r.deactivated_dev_date, r.insolvent_dev_date
    FROM companies c LEFT JOIN nhqb_register r ON r.id = c.nhqb_id WHERE c.company_number = ?`).get(number) ?? null;
}
export function companyForRegisterId(id) { return openDb().prepare('SELECT * FROM companies WHERE nhqb_id = ?').get(id) ?? null; }

// ---- snapshots
export function insertSnapshot(company_number, data, scored) {
  const r = openDb().prepare('INSERT INTO snapshots(company_number,taken_at,data,score,band,factors) VALUES(?,?,?,?,?,?)')
    .run(company_number, data.takenAt || nowIso(), JSON.stringify(data), scored.score, scored.band, JSON.stringify(scored.factors));
  return Number(r.lastInsertRowid);
}
export function latestSnapshot(company_number) {
  const row = openDb().prepare('SELECT * FROM snapshots WHERE company_number = ? ORDER BY taken_at DESC, id DESC LIMIT 1').get(company_number);
  return row ? hydrateSnapshot(row) : null;
}
export function previousSnapshot(company_number, beforeId) {
  const row = openDb().prepare('SELECT * FROM snapshots WHERE company_number = ? AND id < ? ORDER BY id DESC LIMIT 1').get(company_number, beforeId);
  return row ? hydrateSnapshot(row) : null;
}
export function snapshotHistory(company_number, limit = 30) {
  return openDb().prepare('SELECT id, taken_at, score, band FROM snapshots WHERE company_number = ? ORDER BY taken_at DESC LIMIT ?').all(company_number, limit);
}
export function latestSnapshotsForAll() {
  return openDb().prepare(`SELECT s.* FROM snapshots s JOIN (SELECT company_number, MAX(id) AS id FROM snapshots GROUP BY company_number) m ON m.id = s.id`).all().map(hydrateSnapshot);
}
export function updateSnapshotScore(id, scored) {
  openDb().prepare('UPDATE snapshots SET score=?, band=?, factors=? WHERE id=?').run(scored.score, scored.band, JSON.stringify(scored.factors), id);
}
function hydrateSnapshot(row) {
  return { ...row, data: JSON.parse(row.data), factors: row.factors ? JSON.parse(row.factors) : [] };
}

// ---- alerts
export function insertAlerts(alerts) {
  const d = openDb();
  const stmt = d.prepare(`INSERT OR IGNORE INTO alerts(company_number,created_at,type,severity,title,detail,evidence,dedupe_key) VALUES(?,?,?,?,?,?,?,?)`);
  let inserted = 0;
  for (const a of alerts) {
    const r = stmt.run(a.company_number, a.created_at || nowIso(), a.type, a.severity, a.title, a.detail ?? null, a.evidence ? JSON.stringify(a.evidence) : null, a.dedupe_key);
    inserted += Number(r.changes);
  }
  return inserted;
}
export function listAlerts({ since = null, company = null, limit = 200, undeliveredOnly = false } = {}) {
  const where = [];
  const args = [];
  if (since) { where.push('a.created_at >= ?'); args.push(since); }
  if (company) { where.push('a.company_number = ?'); args.push(company); }
  if (undeliveredOnly) where.push('a.delivered = 0');
  args.push(limit);
  return openDb().prepare(`SELECT a.*, c.name AS company_name FROM alerts a LEFT JOIN companies c ON c.company_number = a.company_number
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(...args)
    .map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null }));
}
export function markAlertsDelivered(ids) {
  if (!ids.length) return;
  openDb().prepare(`UPDATE alerts SET delivered = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}
export function acknowledgeAlert(id, ack = true) { openDb().prepare('UPDATE alerts SET acknowledged = ? WHERE id = ?').run(ack ? 1 : 0, id); }

// ---- gazette
export function upsertGazetteNotices(company_number, notices) {
  const d = openDb();
  const stmt = d.prepare(`INSERT INTO gazette_notices(notice_id,company_number,code,category,published,title,url,snippet,match_strength,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(notice_id) DO UPDATE SET match_strength=MAX(gazette_notices.match_strength, excluded.match_strength), fetched_at=excluded.fetched_at`);
  const ts = nowIso();
  for (const n of notices) stmt.run(n.noticeId, company_number, n.code, n.category, n.published, n.title, n.url, n.snippet, n.matchStrength, ts);
}
export function listGazetteNotices(company_number) {
  return openDb().prepare('SELECT * FROM gazette_notices WHERE company_number = ? ORDER BY published DESC').all(company_number);
}
