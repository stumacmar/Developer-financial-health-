// Diff two snapshots of a company and emit alerts for what changed.
import { classifyNotice } from './sources/gazette.js';

const SEVERITY_RANK = { info: 0, medium: 1, high: 2, critical: 3 };
export const severityAtLeast = (a, b) => (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0);

export function diffSnapshots(prev, curr, scored, prevScored) {
  const out = [];
  const n = curr.companyNumber;
  const now = curr.takenAt || new Date().toISOString();
  const push = (type, severity, title, detail, evidence, keyPart) => out.push({ company_number: n, created_at: now, type, severity, title, detail, evidence, dedupe_key: `${n}:${type}:${keyPart}` });
  const first = !prev;
  const p = prev?.data || {};

  // Insolvency / status
  if (!first && p.status !== curr.status) push('STATUS_CHANGED', ['liquidation', 'administration', 'receivership', 'insolvency-proceedings', 'dissolved', 'voluntary-arrangement'].includes(curr.status) ? 'critical' : 'medium', `Company status changed to "${curr.status}"`, `Was "${p.status}"`, { from: p.status, to: curr.status }, curr.status);

  const prevCases = new Set((p.insolvencyCases || []).map((c) => c.number));
  for (const c of curr.insolvencyCases || []) if (!prevCases.has(c.number)) push('INSOLVENCY_CASE', 'critical', `Insolvency case opened: ${c.type}`, (c.dates || []).map((d) => `${d.type} ${d.date}`).join(', '), c, c.number);

  const prevNotices = new Set((p.gazette || []).map((g) => g.noticeId));
  for (const g of curr.gazette || []) {
    if (prevNotices.has(g.noticeId)) continue;
    if (!first && (g.matchStrength ?? 1) < 0.6) continue;
    const cls = classifyNotice(g);
    if (first && cls.points < 60) continue; // on first sync only surface the serious historical ones
    push('GAZETTE_NOTICE', cls.severity, `Gazette: ${g.category}`, `${g.published}: ${g.title}`, g, g.noticeId);
  }

  // Filings of note
  const prevFilings = new Set((p.filings || []).map(filingKey));
  for (const f of curr.filings || []) {
    if (prevFilings.has(filingKey(f))) continue;
    if (f.category === 'insolvency') push('INSOLVENCY_FILING', 'critical', `Insolvency filing: ${f.description || f.type}`, f.date, f, filingKey(f));
    else if (f.type === 'GAZ1' || f.category === 'gazette') push('STRIKE_OFF_NOTICE', 'high', 'First Gazette notice for compulsory strike-off', f.date, f, filingKey(f));
    else if (f.type === 'DS01') push('STRIKE_OFF_APPLICATION', 'high', 'Application to strike off filed', f.date, f, filingKey(f));
    else if (!first && f.category === 'change-of-name') push('NAME_CHANGED', 'medium', 'Company name changed', `${f.date}: ${f.description || ''}`, f, filingKey(f));
    else if (!first && (f.type === 'AD01' || f.category === 'address')) push('OFFICE_MOVED', 'info', 'Registered office changed', f.date, f, filingKey(f));
  }

  // Accounts & confirmation statement
  if (curr.accounts?.overdue && (first || !p.accounts?.overdue)) push('ACCOUNTS_OVERDUE', 'high', 'Annual accounts are overdue', `Due ${curr.accounts.nextDue || ''}`, curr.accounts, curr.accounts.nextDue || 'x');
  if (curr.confirmationStatement?.overdue && (first || !p.confirmationStatement?.overdue)) push('CS_OVERDUE', 'medium', 'Confirmation statement is overdue', `Due ${curr.confirmationStatement.nextDue || ''}`, curr.confirmationStatement, curr.confirmationStatement.nextDue || 'x');
  if (!first && p.accounts?.overdue && !curr.accounts?.overdue) push('ACCOUNTS_FILED', 'info', 'Overdue accounts have now been filed', `Latest made up to ${curr.accounts.lastMadeUpTo || ''}`, curr.accounts, curr.accounts.lastMadeUpTo || 'x');

  // Charges
  const prevCharges = new Set((p.charges || []).map(chargeKey));
  for (const c of curr.charges || []) {
    if (prevCharges.has(chargeKey(c))) continue;
    if (first && c.createdOn && daysAgo(c.createdOn, now) > 90) continue;
    push('NEW_CHARGE', 'high', `New charge registered${c.personsEntitled?.length ? ` in favour of ${c.personsEntitled.join(', ')}` : ''}`, `${c.createdOn || ''} ${c.classification || ''}`.trim(), c, chargeKey(c));
  }
  const prevSatisfied = new Set((p.charges || []).filter((c) => c.satisfiedOn).map(chargeKey));
  for (const c of curr.charges || []) if (c.satisfiedOn && !first && !prevSatisfied.has(chargeKey(c))) push('CHARGE_SATISFIED', 'info', `Charge satisfied${c.personsEntitled?.length ? ` (${c.personsEntitled.join(', ')})` : ''}`, c.satisfiedOn, c, chargeKey(c));

  // Officers
  const prevResigned = new Set((p.officers || []).filter((o) => o.resignedOn).map(officerKey));
  const prevAll = new Set((p.officers || []).map(officerKey));
  for (const o of curr.officers || []) {
    const isDirector = /director|member/.test(o.role || '');
    if (o.resignedOn && !prevResigned.has(officerKey(o))) {
      if (first && daysAgo(o.resignedOn, now) > 90) continue;
      push('DIRECTOR_RESIGNED', isDirector ? 'high' : 'info', `${isDirector ? 'Director' : 'Officer'} resigned: ${o.name}`, `${o.role} resigned ${o.resignedOn}`, o, officerKey(o) + ':' + o.resignedOn);
    } else if (!o.resignedOn && !first && !prevAll.has(officerKey(o))) {
      push('DIRECTOR_APPOINTED', 'info', `${isDirector ? 'Director' : 'Officer'} appointed: ${o.name}`, `${o.role} appointed ${o.appointedOn || ''}`, o, officerKey(o));
    }
  }

  // NHQB
  if (!first && p.nhqb?.status !== curr.nhqb?.status && curr.nhqb?.status) push('NHQB_STATUS', curr.nhqb.status === 'insolvent' ? 'critical' : 'medium', `NHQB register status changed to "${curr.nhqb.status}"`, `Was "${p.nhqb?.status || 'unknown'}"`, curr.nhqb, curr.nhqb.status);

  // Score band
  if (!first && prevScored && prevScored.band !== scored.band) {
    const up = scored.score > prevScored.score;
    push('BAND_CHANGED', up ? (scored.band === 'Critical' ? 'critical' : 'high') : 'info', `Risk band ${up ? 'raised' : 'lowered'}: ${prevScored.band} -> ${scored.band}`, `Score ${prevScored.score} -> ${scored.score}`, { from: prevScored.score, to: scored.score }, `${prevScored.band}>${scored.band}:${now.slice(0, 10)}`);
  }
  if (first) push('WATCH_STARTED', 'info', `Now watching ${curr.name}`, `Initial score ${scored.score} (${scored.band})`, { score: scored.score }, 'init');
  return out;
}

const filingKey = (f) => `${f.date}|${f.type || ''}|${(f.description || '').slice(0, 60)}`;
const chargeKey = (c) => c.code || `${c.createdOn}|${(c.personsEntitled || []).join('/')}`;
const officerKey = (o) => `${(o.name || '').toUpperCase()}|${o.role}|${o.appointedOn || ''}`;
const daysAgo = (d, now) => Math.floor((new Date(now) - new Date(d)) / 86400000);
