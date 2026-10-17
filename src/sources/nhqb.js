// New Homes Quality Board register of developers.
// The public register page (https://www.nhqb.org.uk/register-of-developers/) is a search box backed by a
// WordPress proxy that returns at most 50 matches per query. We enumerate the register by recursively
// refining any query that hits the cap, which converges because every child query is strictly longer.
import { createLimiter, fetchJson } from '../util/http.js';
import { config } from '../config.js';

const ENDPOINT = 'https://www.nhqb.org.uk/wp-admin/admin-ajax.php';
const PAGE_CAP = 50;
const MIN_LEN = 3;
const limiter = createLimiter({ maxRequests: 4, windowMs: 1000, minGapMs: 250 });

export const SEED_TERMS = [
  'limited', 'ltd', 'plc', 'llp', 'homes', 'home', 'house', 'housing', 'living', 'group', 'developments',
  'development', 'construction', 'build', 'properties', 'property', 'estates', 'land', 'partnership', 'association',
  'residential', 'society', 'trust', 'cic', 'community', 'new', 'the ', 'ies', 'ing', 'ion', 'ers',
];
const REFINE_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789 &'.split('');

export async function searchRegister(term) {
  const url = `${ENDPOINT}?action=get_developer_search&search=${encodeURIComponent(term)}`;
  const json = await fetchJson(url, { limiter, label: `nhqb:${term}`, headers: { 'User-Agent': config.userAgent } });
  if (!json || json.success === false || typeof json.success !== 'object') return [];
  const rows = json.success?.data?.result;
  return Array.isArray(rows) ? rows.map(normaliseRow) : [];
}

function normaliseRow(r) {
  return {
    id: String(r.id),
    company_name: (r.company_name || '').trim(),
    legal_name: (r.legal_name || '').trim(),
    holding_company_id: r.holding_company_id || null,
    registered_dev_date: r.registered_dev_date || null,
    deactivated_dev_date: r.deactivated_dev_date || null,
    insolvent_dev_date: r.insolvent_dev_date || null,
    status: (r.status || '').toLowerCase() || 'unknown',
  };
}

/**
 * Enumerate the whole register. Returns { rows: Map<id,row>, requests, capped: string[] }.
 * `maxRequests` bounds how hard we hit the site; capped queries that could not be refined are reported.
 */
export async function enumerateRegister({ seeds = SEED_TERMS, maxRequests = 2500, onProgress = () => {} } = {}) {
  const rows = new Map();
  const seen = new Set();
  const queue = seeds.map((s) => s.toLowerCase());
  const unresolved = [];
  let requests = 0;
  while (queue.length) {
    const term = queue.shift();
    if (term.length < MIN_LEN || seen.has(term)) continue;
    seen.add(term);
    if (requests >= maxRequests) { unresolved.push(term); continue; }
    requests++;
    let result;
    try { result = await searchRegister(term); } catch (err) { console.warn(`[nhqb] "${term}" failed: ${err.message}`); unresolved.push(term); continue; }
    for (const r of result) rows.set(r.id, r);
    onProgress({ term, got: result.length, total: rows.size, requests });
    if (result.length >= PAGE_CAP) {
      for (const c of REFINE_CHARS) { queue.push(term + c); queue.push(c + term); }
    }
  }
  return { rows: [...rows.values()], requests, unresolved };
}
