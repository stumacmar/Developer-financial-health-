// Tiny HTTP server: dashboard (public/index.html) + JSON API. No framework.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { config } from './config.js';
import { BANDS } from './scoring.js';
import { timingSafeEqual } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
let syncInFlight = null;

export function startServer({ port = config.port, demo = false } = {}) {
  db.openDb();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (!authorised(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Developer Radar"', 'Content-Type': 'text/plain' }); return res.end('Authentication required'); }
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, { demo });
      return serveStatic(url.pathname, res);
    } catch (err) {
      console.error(err);
      json(res, 500, { error: err.message });
    }
  });
  server.listen(port, () => console.log(`Developer radar dashboard: http://localhost:${port}${demo ? '  (demo data)' : ''}${config.dashboardPassword ? '  (basic auth on)' : ''}`));
  if (!demo) startScheduler();
  return server;
}

function authorised(req) {
  if (!config.dashboardPassword) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const given = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(given), b = Buffer.from(config.dashboardPassword);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hosted mode: sync every SYNC_INTERVAL_HOURS, refreshing the NHQB register when it is missing or over a week old. */
function startScheduler() {
  if (!config.syncIntervalHours || !config.companiesHouseApiKey) {
    if (config.syncIntervalHours && !config.companiesHouseApiKey) console.warn('[scheduler] SYNC_INTERVAL_HOURS set but COMPANIES_HOUSE_API_KEY missing; scheduler disabled');
    return;
  }
  const every = config.syncIntervalHours * 3600 * 1000;
  const tick = async () => {
    if (syncInFlight) return;
    const { runSync } = await import('./sync.js');
    const last = db.getMeta('nhqb_last_refresh');
    const refreshNhqb = !last || Date.now() - new Date(last).getTime() > 7 * 86400000;
    console.log(`[scheduler] starting sync${refreshNhqb ? ' (with NHQB register refresh)' : ''}`);
    syncInFlight = runSync({ refreshNhqb }).then((r) => console.log(`[scheduler] sync done: ${r.results.length} companies`)).catch((e) => console.error('[scheduler]', e)).finally(() => { syncInFlight = null; });
  };
  const lastSync = db.getMeta('last_sync');
  const due = lastSync ? Math.max(60000, new Date(lastSync).getTime() + every - Date.now()) : 60000;
  console.log(`[scheduler] syncing every ${config.syncIntervalHours}h; next run in ${Math.round(due / 60000)} min`);
  setTimeout(() => { tick(); setInterval(tick, every); }, due).unref();
}

async function api(req, res, url, { demo }) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/overview') {
    const snaps = db.latestSnapshotsForAll();
    const companies = Object.fromEntries(db.listCompanies({ watchedOnly: false }).map((c) => [c.company_number, c]));
    const rows = snaps.map((s) => summarise(s, companies[s.company_number])).filter((r) => r.watch).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const bandCounts = Object.fromEntries(BANDS.map((b) => [b.name, rows.filter((r) => r.band === b.name).length]));
    return json(res, 200, { demo, lastSync: db.getMeta('last_sync'), nhqbLastRefresh: db.getMeta('nhqb_last_refresh'), registerSize: db.listRegister().length, bands: BANDS, bandCounts, companies: rows,
      unmatched: Object.values(companies).filter((c) => !c.watch && c.notes).map((c) => ({ company_number: c.company_number, name: c.name, notes: c.notes, nhqb_name: c.nhqb_name })) });
  }
  const m = /^\/api\/companies\/([A-Z0-9]+)$/i.exec(p);
  if (req.method === 'GET' && m) {
    const number = m[1].toUpperCase();
    const snap = db.latestSnapshot(number);
    if (!snap) return json(res, 404, { error: 'No snapshot for that company' });
    const company = db.getCompany(number);
    return json(res, 200, { ...summarise(snap, company), factors: snap.factors, snapshot: snap.data, history: db.snapshotHistory(number).reverse(), alerts: db.listAlerts({ company: number, limit: 100 }), gazette: db.listGazetteNotices(number) });
  }
  if (req.method === 'GET' && p === '/api/alerts') {
    const since = url.searchParams.get('since');
    return json(res, 200, { alerts: db.listAlerts({ since: since ? new Date(since).toISOString() : null, limit: Number(url.searchParams.get('limit') || 200) }) });
  }
  const ack = /^\/api\/alerts\/(\d+)\/ack$/.exec(p);
  if (req.method === 'POST' && ack) { db.acknowledgeAlert(Number(ack[1]), true); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/api/sync') {
    if (demo) return json(res, 400, { error: 'Sync is disabled in demo mode. Set COMPANIES_HOUSE_API_KEY and run without --demo.' });
    if (syncInFlight) return json(res, 202, { status: 'already running' });
    const { runSync } = await import('./sync.js');
    syncInFlight = runSync({ limit: Number(url.searchParams.get('limit') || Infinity) }).catch((e) => console.error(e)).finally(() => { syncInFlight = null; });
    return json(res, 202, { status: 'started' });
  }
  if (req.method === 'GET' && p === '/api/register') return json(res, 200, { register: db.listRegister() });
  json(res, 404, { error: 'Not found' });
}

function summarise(s, company) {
  const d = s.data;
  const prev = db.previousSnapshot(s.company_number, s.id);
  return {
    company_number: s.company_number,
    name: d.name || company?.name || s.company_number,
    watch: company ? Boolean(company.watch) : true,
    score: s.score, band: s.band, previousScore: prev?.score ?? null, previousBand: prev?.band ?? null,
    takenAt: s.taken_at,
    status: d.status, incorporatedOn: d.incorporatedOn, isHousebuilder: d.isHousebuilder,
    accountsOverdue: Boolean(d.accounts?.overdue), accountsNextDue: d.accounts?.nextDue || null, csOverdue: Boolean(d.confirmationStatement?.overdue),
    outstandingCharges: (d.charges || []).filter((c) => c.status === 'outstanding' || c.status === 'part-satisfied').length,
    activeDirectors: (d.officers || []).filter((o) => /director|member/.test(o.role || '') && !o.resignedOn).length,
    gazetteNotices: (d.gazette || []).length,
    nhqb: d.nhqb || null,
    matchConfidence: company?.match_confidence ?? null,
    topFactors: (s.factors || []).filter((f) => f.points > 0).slice(0, 3).map((f) => f.label),
    openAlerts: db.listAlerts({ company: s.company_number, limit: 50 }).filter((a) => !a.acknowledged && a.severity !== 'info').length,
  };
}

function serveStatic(pathname, res) {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(publicDir, file);
  if (!full.startsWith(publicDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
  res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
