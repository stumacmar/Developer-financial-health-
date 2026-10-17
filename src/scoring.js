// Composite risk score (0-100) with a fully itemised factor list, so every point is explainable.
//
// Model shape:
//   * "Hard stops" are events that mean the company is already in (or formally entering) an insolvency
//     process. Any one of them pins the score at 100.
//   * Graded factors add points for the leading indicators the brief cares about: late accounts, new
//     charges, director churn, Gazette petitions, strike-off notices, plus a few structural ones (age,
//     thin board, filing blackout).
//   * Small offsets reward recent positive signals (charges satisfied, fresh accounts).
//   * Bands: 0-14 Low, 15-34 Watch, 35-59 Elevated, 60-100 Critical.
import { classifyNotice } from './sources/gazette.js';

export const BANDS = [
  { name: 'Low', min: 0, status: 'good' },
  { name: 'Watch', min: 15, status: 'warning' },
  { name: 'Elevated', min: 35, status: 'serious' },
  { name: 'Critical', min: 60, status: 'critical' },
];
export function bandFor(score) { return [...BANDS].reverse().find((b) => score >= b.min); }

const INSOLVENT_STATUSES = new Set(['liquidation', 'administration', 'receivership', 'insolvency-proceedings', 'dissolved', 'converted-closed', 'closed', 'removed']);
const ACCOUNT_TYPE_RANK = { group: 6, full: 5, 'medium': 4, small: 3, 'total-exemption-full': 3, 'total-exemption-small': 2, 'micro-entity': 1, 'unaudited-abridged': 2, dormant: 0, 'no-accounts-type-available': 0 };
const DIRECTOR_ROLES = new Set(['director', 'llp-member', 'llp-designated-member', 'corporate-director', 'corporate-llp-member', 'corporate-llp-designated-member']);

const DAY = 86400000;
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY);

/**
 * @param {object} snap normalised snapshot (see sources/companiesHouse.js + gazette + nhqb fields)
 * @param {object} [opts]
 * @param {string} [opts.asOf] ISO date to evaluate against (defaults to snap.takenAt or today)
 * @param {object} [opts.previous] previous snapshot for trend-style factors
 */
export function scoreSnapshot(snap, { asOf, previous } = {}) {
  const today = asOf || snap.takenAt || new Date().toISOString().slice(0, 10);
  const factors = [];
  const add = (id, label, points, detail, evidence) => { if (points) factors.push({ id, label, points, detail, evidence: evidence ?? null }); };
  const age = (d) => (d ? daysBetween(d, today) : null);
  let hardStop = null;

  // ---------- Hard stops ----------
  if (INSOLVENT_STATUSES.has(snap.status)) {
    hardStop = `Companies House status is "${snap.status}"${snap.statusDetail ? ` (${snap.statusDetail})` : ''}`;
    add('ch-status', 'Company status', 100, hardStop, { status: snap.status });
  } else if (snap.status === 'voluntary-arrangement') {
    add('ch-cva', 'Company voluntary arrangement', 80, 'Companies House status is "voluntary-arrangement"', { status: snap.status });
  }

  if (snap.nhqb?.insolventOn) {
    hardStop ||= `NHQB marks developer insolvent from ${snap.nhqb.insolventOn}`;
    add('nhqb-insolvent', 'NHQB insolvency flag', 100, `NHQB register records insolvency on ${snap.nhqb.insolventOn}`, { date: snap.nhqb.insolventOn });
  }

  const recentCases = (snap.insolvencyCases || []).filter((c) => (c.dates || []).some((d) => age(d.date) != null && age(d.date) <= 730));
  if (recentCases.length) {
    const c = recentCases[0];
    hardStop ||= `Companies House insolvency case: ${c.type}`;
    add('ch-insolvency-case', 'Insolvency case on register', 100, `${c.type} (case ${c.number})`, c);
  }

  // Filing-history insolvency / strike-off events in the last 24 months.
  const filings = (snap.filings || []).filter((f) => f.date && age(f.date) <= 730);
  const insolvencyFilings = filings.filter((f) => f.category === 'insolvency' || /^(AM0|LIQ|600|LQ0|COCOMP|4\.|RM0)/.test(f.type || ''));
  if (insolvencyFilings.length) {
    const f = insolvencyFilings[0];
    hardStop ||= `Insolvency filing: ${describe(f)}`;
    add('ch-insolvency-filing', 'Insolvency filing', 100, `${f.date}: ${describe(f)}`, f);
  }
  const gaz1 = filings.find((f) => f.type === 'GAZ1' || /gazette-notice-compulsory|gazette-notice-voluntary|first-gazette/.test(f.description || ''));
  const gazDiscontinued = filings.find((f) => f.type === 'DISS40' || f.type === 'DISS16(SOAS)' || /gazette-filings-brought-up-to-date|discontinued|strike-off-action-discontinued/.test(f.description || ''));
  const ds01 = filings.find((f) => f.type === 'DS01' || /application-to-strike-off|dissolution-application/.test(f.description || ''));
  if (gaz1 && !(gazDiscontinued && gazDiscontinued.date >= gaz1.date)) add('strike-off-notice', 'Strike-off notice in Gazette', 60, `${gaz1.date}: ${describe(gaz1)}`, gaz1);
  if (ds01 && !(gazDiscontinued && gazDiscontinued.date >= ds01.date)) add('strike-off-application', 'Application to strike off (DS01)', 60, `${ds01.date}: ${describe(ds01)}`, ds01);

  // ---------- Gazette corporate insolvency notices ----------
  const notices = (snap.gazette || []).filter((n) => n.published && age(n.published) <= 730 && (n.matchStrength ?? 1) >= 0.6);
  const dismissedAfter = notices.filter((n) => classifyNotice(n).kind === 'petition-dismissed').map((n) => n.published).reduce((a, b) => (b > a ? b : a), '');
  let gazettePoints = 0;
  const gazetteHits = [];
  for (const n of notices) {
    const cls = classifyNotice(n);
    if (cls.kind === 'winding-up-petition' && dismissedAfter && dismissedAfter >= n.published) continue;
    if (cls.points > gazettePoints) { gazettePoints = cls.points; }
    if (cls.points > 0) gazetteHits.push({ ...n, kind: cls.kind, points: cls.points });
  }
  if (gazettePoints) {
    const top = gazetteHits.sort((a, b) => b.points - a.points || (b.published > a.published ? 1 : -1))[0];
    if (gazettePoints >= 100) hardStop ||= `Gazette: ${top.category}`;
    add('gazette', `Gazette: ${top.category}`, gazettePoints, `${top.published}: ${top.title}${gazetteHits.length > 1 ? ` (+${gazetteHits.length - 1} more notices)` : ''}`, gazetteHits.slice(0, 5));
  }

  // ---------- Filing compliance ----------
  const acc = snap.accounts || {};
  const cs = snap.confirmationStatement || {};
  if (acc.overdue) {
    const late = acc.nextDue ? age(acc.nextDue) : null;
    add('accounts-overdue', 'Annual accounts overdue', late != null && late > 90 ? 35 : 25, `Accounts were due ${acc.nextDue || '(date unknown)'}${late != null ? `, ${late} days ago` : ''}`, { nextDue: acc.nextDue });
  } else if (acc.nextDue && age(acc.nextDue) >= -30 && age(acc.nextDue) <= 0) {
    add('accounts-due-soon', 'Accounts due within 30 days', 5, `Accounts due ${acc.nextDue}`, { nextDue: acc.nextDue });
  }
  if (acc.lastMadeUpTo && age(acc.lastMadeUpTo) > 640 && !acc.overdue) {
    add('accounts-stale', 'Latest accounts are stale', 10, `Last accounts made up to ${acc.lastMadeUpTo} (${Math.round(age(acc.lastMadeUpTo) / 30)} months ago)`, { lastMadeUpTo: acc.lastMadeUpTo });
  }
  if (cs.overdue) add('cs-overdue', 'Confirmation statement overdue', 10, `Confirmation statement was due ${cs.nextDue || '(date unknown)'}`, { nextDue: cs.nextDue });
  if (acc.overdue && cs.overdue) add('filing-blackout', 'Filing blackout (accounts and confirmation statement both overdue)', 10, 'Both statutory filings are late at once', null);
  if (previous?.data?.accounts?.lastType && acc.lastType && previous.data.accounts.lastType !== acc.lastType) {
    const before = ACCOUNT_TYPE_RANK[previous.data.accounts.lastType] ?? 3, after = ACCOUNT_TYPE_RANK[acc.lastType] ?? 3;
    if (after < before) add('accounts-downgraded', 'Accounts type downgraded', 10, `Moved from ${previous.data.accounts.lastType} to ${acc.lastType} accounts`, { from: previous.data.accounts.lastType, to: acc.lastType });
  }

  // ---------- Charges ----------
  const charges = snap.charges || [];
  const outstanding = charges.filter((c) => c.status === 'outstanding' || c.status === 'part-satisfied');
  const new90 = charges.filter((c) => c.createdOn && age(c.createdOn) <= 90 && age(c.createdOn) >= 0);
  const new365 = charges.filter((c) => c.createdOn && age(c.createdOn) > 90 && age(c.createdOn) <= 365);
  if (new90.length) add('charges-new-90d', `New charge${new90.length > 1 ? 's' : ''} registered in last 90 days`, Math.min(30, 10 * new90.length), new90.map((c) => `${c.createdOn}: ${c.personsEntitled?.join(', ') || c.classification || 'charge'}`).join('; '), new90);
  if (new365.length) add('charges-new-12m', `Charge${new365.length > 1 ? 's' : ''} registered 3-12 months ago`, Math.min(12, 4 * new365.length), new365.map((c) => `${c.createdOn}: ${c.personsEntitled?.join(', ') || 'charge'}`).join('; '), new365);
  if (outstanding.length >= 5) add('charges-many', 'Five or more outstanding charges', 5, `${outstanding.length} charges outstanding`, { outstanding: outstanding.length });
  const satisfied12 = charges.filter((c) => c.satisfiedOn && age(c.satisfiedOn) <= 365 && age(c.satisfiedOn) >= 0);
  if (satisfied12.length) add('charges-satisfied', 'Charges satisfied in last 12 months', -Math.min(6, 3 * satisfied12.length), satisfied12.map((c) => `${c.satisfiedOn}: ${c.personsEntitled?.join(', ') || 'charge'}`).join('; '), satisfied12);

  // ---------- Governance ----------
  const officers = snap.officers || [];
  const directors = officers.filter((o) => DIRECTOR_ROLES.has(o.role));
  const activeDirectors = directors.filter((o) => !o.resignedOn);
  const resigned90 = directors.filter((o) => o.resignedOn && age(o.resignedOn) <= 90 && age(o.resignedOn) >= 0);
  const resigned180 = directors.filter((o) => o.resignedOn && age(o.resignedOn) > 90 && age(o.resignedOn) <= 180);
  const resigned365 = directors.filter((o) => o.resignedOn && age(o.resignedOn) <= 365 && age(o.resignedOn) >= 0);
  if (resigned90.length) add('directors-resigned-90d', `Director resignation${resigned90.length > 1 ? 's' : ''} in last 90 days`, Math.min(24, 8 * resigned90.length), resigned90.map((o) => `${o.name} (${o.resignedOn})`).join('; '), resigned90);
  if (resigned180.length) add('directors-resigned-180d', `Director resignation${resigned180.length > 1 ? 's' : ''} 3-6 months ago`, Math.min(8, 4 * resigned180.length), resigned180.map((o) => `${o.name} (${o.resignedOn})`).join('; '), resigned180);
  const boardBefore = activeDirectors.length + resigned365.length;
  if (resigned365.length >= 2 && resigned365.length / boardBefore >= 0.5) add('board-churn', 'Half or more of the board left in 12 months', 10, `${resigned365.length} of ${boardBefore} directors resigned`, { resigned: resigned365.length, board: boardBefore });
  if (snap.status === 'active' && activeDirectors.length < 2 && officers.length) add('thin-board', 'Fewer than two active directors', 10, `${activeDirectors.length} active director(s)`, { active: activeDirectors.length });

  const addrChange = filings.find((f) => f.type === 'AD01' || f.category === 'address');
  if (addrChange && age(addrChange.date) <= 90) add('office-moved', 'Registered office changed in last 90 days', 5, `${addrChange.date}: ${describe(addrChange)}`, addrChange);
  const nameChange = filings.find((f) => f.category === 'change-of-name' || /^(CERTNM|NM0)/.test(f.type || ''));
  if (nameChange && age(nameChange.date) <= 180) add('name-changed', 'Company name changed in last 6 months', 5, `${nameChange.date}: ${describe(nameChange)}`, nameChange);

  // ---------- Structure ----------
  const ageDays = snap.incorporatedOn ? age(snap.incorporatedOn) : null;
  if (ageDays != null && ageDays < 730) add('young-company', 'Incorporated less than 2 years ago', 15, `Incorporated ${snap.incorporatedOn}`, { incorporatedOn: snap.incorporatedOn });
  else if (ageDays != null && ageDays < 1460) add('young-company', 'Incorporated 2-4 years ago', 8, `Incorporated ${snap.incorporatedOn}`, { incorporatedOn: snap.incorporatedOn });

  if (snap.nhqb?.status === 'deactivated') add('nhqb-deactivated', 'Deactivated on NHQB register', 15, `Deactivated ${snap.nhqb.deactivatedOn || ''}`.trim(), { deactivatedOn: snap.nhqb.deactivatedOn });

  // ---------- Positive offsets ----------
  const recentAccounts = filings.find((f) => f.category === 'accounts' && age(f.date) <= 90);
  if (recentAccounts && !acc.overdue) add('accounts-fresh', 'Accounts filed in last 90 days', -5, `${recentAccounts.date}: ${describe(recentAccounts)}`, recentAccounts);

  // ---------- Total ----------
  const raw = factors.reduce((s, f) => s + f.points, 0);
  const score = hardStop ? 100 : Math.max(0, Math.min(100, raw));
  const band = bandFor(score);
  factors.sort((a, b) => b.points - a.points);
  return { score, band: band.name, bandStatus: band.status, hardStop, factors, rawTotal: raw };
}

function describe(f) {
  if (!f) return '';
  const d = f.description || f.type || '';
  const v = f.descriptionValues || {};
  return d.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim() || f.type || 'filing';
}
