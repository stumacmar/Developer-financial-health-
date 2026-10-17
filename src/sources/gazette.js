// The Gazette corporate-insolvency notices, via its public JSON feed (no key required).
// Feed: https://www.thegazette.co.uk/insolvency/notice/data.json?text=...&insolvency_corporate=G205010000
// The site throttles by requests per 5 minutes, so we go slowly and back off hard on 429.
import { createLimiter, fetchJson } from '../util/http.js';
import { config } from '../config.js';
import { sameCompanyName, normaliseName } from '../util/names.js';

const FEED = 'https://www.thegazette.co.uk/insolvency/notice/data.json';
const limiter = createLimiter({ maxRequests: 60, windowMs: 5 * 60 * 1000, minGapMs: 1500 });

/** Category codes from the Gazette corporate insolvency search form. */
export const CATEGORY = {
  CORPORATE_ALL: 'G205010000',
  PETITION_TO_WIND_UP: 'G405010307',
  WINDING_UP_ORDER: 'G405010311',
  DISMISSAL_OF_PETITION: 'G405010303',
  APPOINTMENT_OF_ADMINISTRATORS: 'G405010102',
  CVL_APPOINTMENT_OF_LIQUIDATORS: 'G405010202',
  CVL_RESOLUTION: 'G405010206',
  MVL_APPOINTMENT_OF_LIQUIDATORS: 'G405010402',
  MVL_RESOLUTION: 'G405010405',
  MORATORIA: 'G405010002',
  ADMINISTRATIVE_RECEIVERS: 'G405010501',
};

/**
 * Classify a notice by its category term (and content, to separate solvent MVLs from CVLs).
 * Returns { kind, severity: 'critical'|'high'|'medium'|'low'|'info', points }.
 */
export function classifyNotice({ category = '', snippet = '' }) {
  const t = category.toLowerCase();
  const c = snippet.toLowerCase();
  const solvent = /members'? voluntary|solvent|declaration of solvency/.test(c);
  if (t.includes('dismissal')) return { kind: 'petition-dismissed', severity: 'info', points: 0 };
  if (t.includes('petition')) return { kind: 'winding-up-petition', severity: 'critical', points: 70 };
  if (t.includes('winding-up order') || t.includes('winding up order')) return { kind: 'winding-up-order', severity: 'critical', points: 100 };
  if (t.includes('administrator')) return { kind: 'administration', severity: 'critical', points: 100 };
  if (t.includes('receiver')) return { kind: 'receivership', severity: 'critical', points: 100 };
  if (t.includes('moratori')) return { kind: 'moratorium', severity: 'critical', points: 70 };
  if (t.includes('liquidator') || t.includes('resolution')) {
    return solvent ? { kind: 'members-voluntary-liquidation', severity: 'high', points: 40 } : { kind: 'liquidation', severity: 'critical', points: 100 };
  }
  if (t.includes('meetings of creditors') || t.includes('meeting of creditors') || t.includes('decision procedure') || t.includes('deemed consent'))
    return { kind: 'creditors-meeting', severity: 'high', points: 60 };
  if (t.includes('notices to creditors') || t.includes('dividend') || t.includes('final meeting') || t.includes('release of liquidator'))
    return solvent ? { kind: 'members-voluntary-liquidation', severity: 'high', points: 40 } : { kind: 'liquidation-process', severity: 'critical', points: 100 };
  if (t.includes('prohibited name')) return { kind: 'reuse-of-prohibited-name', severity: 'medium', points: 25 };
  return { kind: 'other-corporate-insolvency', severity: 'medium', points: 30 };
}

/**
 * Search corporate insolvency notices that mention a company name, and keep only those that
 * are about that company (title match or company number in the text).
 */
export async function searchCompanyNotices({ name, companyNumber, sinceDate, pageSize = 50, maxPages = 3 }) {
  const out = [];
  const q = `"${name.replace(/"/g, '')}"`;
  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(FEED);
    url.searchParams.set('text', q);
    url.searchParams.set('insolvency_corporate', CATEGORY.CORPORATE_ALL);
    url.searchParams.set('results-page-size', String(pageSize));
    url.searchParams.set('results-page', String(page));
    url.searchParams.set('sort-by', 'latest-date');
    if (sinceDate) url.searchParams.set('start-publish-date', sinceDate);
    const json = await fetchJson(url.toString(), { limiter, label: `gazette:${name}`, headers: { 'User-Agent': config.userAgent } });
    const entries = toArray(json?.entry);
    for (const e of entries) {
      const n = parseEntry(e);
      n.matchStrength = matchStrength(n, name, companyNumber);
      if (n.matchStrength >= 0.6) out.push(n);
    }
    const total = Number(json?.['f:total'] || 0);
    if (page * pageSize >= total || !entries.length) break;
  }
  return out;
}

function matchStrength(n, name, companyNumber) {
  const text = `${n.title} ${n.snippet}`;
  if (companyNumber && new RegExp(`\\b0*${companyNumber.replace(/^0+/, '')}\\b`).test(text.replace(/[^A-Z0-9 ]/gi, ' '))) return 1;
  const byTitle = sameCompanyName(name, n.title);
  if (byTitle >= 0.9) return 0.9;
  // Petitions often carry the subject company inside "In the Matter of X".
  const m = /in the matter of ([^,]+?)(?: and in the matter|,|\.|$)/i.exec(n.snippet);
  if (m && sameCompanyName(name, m[1]) >= 0.9) return 0.85;
  // Name appears but only as the petitioner/creditor -> not about this company.
  if (/presented on .* by/i.test(n.snippet) && new RegExp(normaliseName(name).split(' ')[0], 'i').test(n.snippet.split(/presented on/i)[1] || '')) return 0.2;
  return byTitle;
}

function parseEntry(e) {
  const id = String(e.id || '').split('/').pop();
  const links = toArray(e.link);
  const page = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate' && l['@type']?.includes('html'))?.['@href'] || `https://www.thegazette.co.uk/notice/${id}`;
  return {
    noticeId: id,
    code: e['f:notice-code'] || null,
    category: e.category?.['@term'] || e.title || '',
    published: (e.published || e.updated || '').slice(0, 10),
    title: stripHtml(e.title || ''),
    url: page.replace('/id/notice/', '/notice/'),
    snippet: stripHtml(e.content || '').slice(0, 600),
  };
}

const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const stripHtml = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
