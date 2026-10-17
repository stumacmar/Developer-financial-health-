// Companies House Public Data API client. Docs: https://developer-specs.company-information.service.gov.uk/
// Auth: HTTP basic with the API key as username. Limit: 600 requests per 5 minutes per key.
import { createLimiter, fetchJson } from '../util/http.js';
import { config } from '../config.js';
import { sameCompanyName, normaliseName } from '../util/names.js';

const BASE = 'https://api.company-information.service.gov.uk';
const HOUSEBUILDING_SIC = new Set(['41100', '41201', '41202', '41200', '43990', '68100', '68209', '68320', '70100']);

export class CompaniesHouseClient {
  constructor(apiKey = config.companiesHouseApiKey) {
    if (!apiKey) throw new Error('COMPANIES_HOUSE_API_KEY is not set (get a free key at developer.company-information.service.gov.uk)');
    this.headers = { Authorization: 'Basic ' + Buffer.from(apiKey + ':').toString('base64'), 'User-Agent': config.userAgent };
    this.limiter = createLimiter({ maxRequests: 560, windowMs: 5 * 60 * 1000, minGapMs: 120 });
  }

  get(pathname, params = {}, opts = {}) {
    const url = new URL(BASE + pathname);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return fetchJson(url.toString(), { headers: this.headers, limiter: this.limiter, label: pathname, ...opts });
  }

  searchCompanies(q, itemsPerPage = 20) { return this.get('/search/companies', { q, items_per_page: itemsPerPage }); }
  profile(number) { return this.get(`/company/${number}`); }
  officers(number) { return this.getAll(`/company/${number}/officers`, 100, 3); }
  charges(number) { return this.get(`/company/${number}/charges`, { items_per_page: 100 }, { allow404: true }); }
  filingHistory(number, { pages = 2 } = {}) { return this.getAll(`/company/${number}/filing-history`, 100, pages); }
  insolvency(number) { return this.get(`/company/${number}/insolvency`, {}, { allow404: true }); }

  async getAll(pathname, perPage, maxPages) {
    const items = [];
    let total = Infinity;
    for (let page = 0; page < maxPages && items.length < total; page++) {
      const json = await this.get(pathname, { items_per_page: perPage, start_index: page * perPage }, { allow404: true });
      if (!json) break;
      items.push(...(json.items || []));
      total = Number(json.total_count ?? json.total_results ?? items.length);
      if (!json.items?.length) break;
    }
    return items;
  }

  /**
   * Resolve a developer name to a company number. Returns { number, name, confidence, method, candidates } or null.
   */
  async resolveByName(name) {
    const res = await this.searchCompanies(name, 20);
    const candidates = (res?.items || []).map((it) => ({
      number: it.company_number,
      name: it.title,
      status: it.company_status,
      incorporated: it.date_of_creation,
      type: it.company_type,
      nameScore: sameCompanyName(name, it.title),
    }));
    if (!candidates.length) return null;
    const ranked = candidates
      .map((c) => ({ ...c, score: c.nameScore + (c.status === 'active' ? 0.05 : -0.2) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best.nameScore === 0) return { ...best, confidence: 0.25, method: 'search-top-hit', candidates: ranked.slice(0, 5) };
    // Tie-break: exact normalised name among several hits -> prefer active; still ambiguous if two actives share a name.
    const exact = ranked.filter((c) => c.nameScore >= 0.9 && c.status === 'active');
    const confidence = exact.length === 1 ? Math.min(0.98, best.nameScore + 0.05) : exact.length > 1 ? 0.6 : best.nameScore;
    return { ...best, confidence, method: exact.length === 1 ? 'exact-name' : 'fuzzy-name', candidates: ranked.slice(0, 5) };
  }

  /** Pull everything the scorer needs for one company. */
  async collect(number) {
    const profile = await this.profile(number);
    const [officers, charges, filings, insolvency] = await Promise.all([
      this.officers(number),
      this.charges(number),
      this.filingHistory(number),
      this.insolvency(number),
    ]);
    return normaliseCompaniesHouse({ profile, officers, charges, filings, insolvency });
  }
}

/** Shape raw API payloads into the neutral snapshot structure used by the scorer. */
export function normaliseCompaniesHouse({ profile, officers = [], charges, filings = [], insolvency }) {
  const acc = profile.accounts || {};
  const cs = profile.confirmation_statement || {};
  return {
    companyNumber: profile.company_number,
    name: profile.company_name,
    status: profile.company_status || 'unknown',
    statusDetail: profile.company_status_detail || null,
    type: profile.type || null,
    incorporatedOn: profile.date_of_creation || null,
    cessationDate: profile.date_of_cessation || null,
    sicCodes: profile.sic_codes || [],
    isHousebuilder: (profile.sic_codes || []).some((c) => HOUSEBUILDING_SIC.has(c)),
    registeredOffice: formatAddress(profile.registered_office_address),
    hasInsolvencyHistory: Boolean(profile.has_insolvency_history),
    hasCharges: Boolean(profile.has_charges),
    accounts: {
      overdue: Boolean(acc.overdue),
      nextDue: acc.next_due || null,
      nextMadeUpTo: acc.next_made_up_to || null,
      lastMadeUpTo: acc.last_accounts?.made_up_to || null,
      lastType: acc.last_accounts?.type || null,
      referenceDate: acc.accounting_reference_date ? `${acc.accounting_reference_date.day}/${acc.accounting_reference_date.month}` : null,
    },
    confirmationStatement: { overdue: Boolean(cs.overdue), nextDue: cs.next_due || null, lastMadeUpTo: cs.last_made_up_to || null },
    officers: officers.map((o) => ({
      name: o.name,
      role: o.officer_role,
      appointedOn: o.appointed_on || null,
      resignedOn: o.resigned_on || null,
      nationality: o.nationality || null,
    })),
    charges: (charges?.items || []).map((c) => ({
      code: c.charge_code || c.charge_number || null,
      status: c.status || null,
      createdOn: c.created_on || c.delivered_on || null,
      satisfiedOn: c.satisfied_on || null,
      personsEntitled: (c.persons_entitled || []).map((p) => p.name),
      classification: c.classification?.description || null,
    })),
    chargeTotals: {
      total: charges?.total_count ?? (charges?.items || []).length,
      satisfied: charges?.satisfied_count ?? null,
      partSatisfied: charges?.part_satisfied_count ?? null,
    },
    filings: filings.map((f) => ({
      date: f.date,
      type: f.type || null,
      category: f.category || null,
      subcategory: f.subcategory || null,
      description: f.description || null,
      descriptionValues: f.description_values || null,
    })),
    insolvencyCases: (insolvency?.cases || []).map((c) => ({
      number: c.number,
      type: c.type,
      dates: (c.dates || []).map((d) => ({ type: d.type, date: d.date })),
      practitioners: (c.practitioners || []).map((p) => p.name),
    })),
  };
}

function formatAddress(a) {
  if (!a) return null;
  return [a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code].filter(Boolean).join(', ');
}

export { normaliseName };
