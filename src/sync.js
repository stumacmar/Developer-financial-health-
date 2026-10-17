// Orchestrates: NHQB register -> Companies House match -> CH + Gazette collection -> score -> diff -> alerts.
import { config } from './config.js';
import * as db from './db.js';
import { enumerateRegister } from './sources/nhqb.js';
import { CompaniesHouseClient } from './sources/companiesHouse.js';
import { searchCompanyNotices } from './sources/gazette.js';
import { scoreSnapshot } from './scoring.js';
import { diffSnapshots } from './alerts.js';
import { deliverPendingAlerts } from './notify.js';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Step 1: refresh the NHQB register into the DB. */
export async function refreshRegister({ maxRequests } = {}) {
  log('[nhqb] enumerating register…');
  const { rows, requests, unresolved } = await enumerateRegister({
    maxRequests,
    onProgress: ({ term, got, total, requests }) => { if (requests % 25 === 0) log(`[nhqb] ${requests} requests, ${total} developers so far (last: "${term}" -> ${got})`); },
  });
  db.upsertRegisterRows(rows);
  db.setMeta('nhqb_last_refresh', db.nowIso());
  log(`[nhqb] done: ${rows.length} developers from ${requests} requests${unresolved.length ? `; ${unresolved.length} queries left unrefined` : ''}`);
  return { count: rows.length, requests, unresolved };
}

/** Step 2: make sure every register entry has a Companies House number (via name search). */
export async function matchRegisterToCompaniesHouse(ch, { onlyUnmatched = true, minConfidence = 0.6 } = {}) {
  const rows = db.listRegister();
  let matched = 0, lowConfidence = 0, skipped = 0;
  for (const r of rows) {
    if (onlyUnmatched && db.companyForRegisterId(r.id)) { skipped++; continue; }
    const name = r.company_name || r.legal_name;
    if (!name) continue;
    const hit = await ch.resolveByName(name);
    if (!hit) { log(`[match] no Companies House hit for "${name}"`); continue; }
    const ok = hit.confidence >= minConfidence;
    db.upsertCompany({ company_number: hit.number, name: hit.name, nhqb_id: r.id, match_confidence: hit.confidence, match_method: hit.method, watch: ok ? 1 : 0,
      notes: ok ? null : `Low-confidence match for NHQB "${name}" — candidates: ${hit.candidates.map((c) => `${c.name} (${c.number})`).join('; ')}` });
    if (ok) matched++; else lowConfidence++;
  }
  log(`[match] matched ${matched}, low-confidence ${lowConfidence}, already matched ${skipped}`);
  return { matched, lowConfidence, skipped };
}

/** Step 3: collect, score and diff one company. */
export async function syncCompany(ch, company, { gazette = true } = {}) {
  const number = company.company_number;
  const snap = await ch.collect(number);
  snap.takenAt = db.nowIso();
  snap.nhqb = company.nhqb_id ? {
    id: company.nhqb_id,
    name: company.nhqb_name,
    status: company.insolvent_dev_date ? 'insolvent' : company.nhqb_status,
    registeredOn: company.registered_dev_date,
    deactivatedOn: company.deactivated_dev_date,
    insolventOn: company.insolvent_dev_date,
  } : null;

  if (gazette) {
    const since = new Date(); since.setMonth(since.getMonth() - config.gazetteLookbackMonths);
    try {
      const notices = await searchCompanyNotices({ name: snap.name, companyNumber: number, sinceDate: since.toISOString().slice(0, 10) });
      db.upsertGazetteNotices(number, notices);
    } catch (err) { log(`[gazette] ${snap.name}: ${err.message} (using cached notices)`); }
  }
  snap.gazette = db.listGazetteNotices(number).map((n) => ({ noticeId: n.notice_id, code: n.code, category: n.category, published: n.published, title: n.title, url: n.url, snippet: n.snippet, matchStrength: n.match_strength }));

  const previous = db.latestSnapshot(number);
  const scored = scoreSnapshot(snap, { previous });
  const prevScored = previous ? { score: previous.score, band: previous.band } : null;
  const alerts = diffSnapshots(previous, snap, scored, prevScored);
  db.insertSnapshot(number, snap, scored);
  const inserted = db.insertAlerts(alerts);
  // Keep the watchlist name in step with the register.
  if (snap.name && snap.name !== company.name) db.upsertCompany({ company_number: number, name: snap.name, watch: company.watch });
  return { number, name: snap.name, score: scored.score, band: scored.band, alerts: inserted };
}

/** Full run. */
export async function runSync({ refreshNhqb = false, limit = Infinity, only = null, gazette = true, apiKey } = {}) {
  db.openDb();
  const ch = new CompaniesHouseClient(apiKey);
  if (refreshNhqb || !db.getMeta('nhqb_last_refresh')) {
    if (db.listRegister().length === 0 || refreshNhqb) await refreshRegister();
  }
  await matchRegisterToCompaniesHouse(ch);
  let companies = db.listCompanies({ watchedOnly: true });
  if (only) companies = companies.filter((c) => c.company_number === only || c.name.toLowerCase().includes(String(only).toLowerCase()));
  companies = companies.slice(0, limit);
  log(`[sync] ${companies.length} companies to sync`);
  const results = [];
  for (const c of companies) {
    try {
      const r = await syncCompany(ch, c, { gazette });
      results.push(r);
      log(`[sync] ${r.name} (${r.number}) -> ${r.score} ${r.band}${r.alerts ? `, ${r.alerts} new alert(s)` : ''}`);
    } catch (err) {
      log(`[sync] ${c.name} (${c.company_number}) FAILED: ${err.message}`);
      results.push({ number: c.company_number, name: c.name, error: err.message });
    }
  }
  db.setMeta('last_sync', db.nowIso());
  let delivery = null;
  try { delivery = await deliverPendingAlerts(); } catch (err) { log(`[notify] ${err.message}`); }
  return { results, delivery };
}

/** Re-score the latest snapshot of every company without hitting the network (after model changes). */
export function rescoreAll() {
  db.openDb();
  const snaps = db.latestSnapshotsForAll();
  const out = [];
  for (const s of snaps) {
    const previous = db.previousSnapshot(s.company_number, s.id);
    const scored = scoreSnapshot(s.data, { previous, asOf: s.taken_at.slice(0, 10) });
    db.updateSnapshotScore(s.id, scored);
    out.push({ number: s.company_number, name: s.data.name, score: scored.score, band: scored.band });
  }
  return out.sort((a, b) => b.score - a.score);
}
