// Synthetic demo data so the dashboard can be explored without API keys.
// Every company, person and lender here is fictional.
import * as db from './db.js';
import { scoreSnapshot } from './scoring.js';
import { diffSnapshots } from './alerts.js';

const d = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

function base(number, name, { incorporatedDaysAgo = 4000, status = 'active' } = {}) {
  return {
    companyNumber: number, name, status, statusDetail: null, type: 'ltd', incorporatedOn: d(incorporatedDaysAgo), sicCodes: ['41100'], isHousebuilder: true,
    registeredOffice: '1 Example Way, Reading, RG1 1AA', hasInsolvencyHistory: false, hasCharges: true,
    accounts: { overdue: false, nextDue: d(-200), lastMadeUpTo: d(300), lastType: 'full' },
    confirmationStatement: { overdue: false, nextDue: d(-100), lastMadeUpTo: d(260) },
    officers: [
      { name: 'ASHWORTH, Priya', role: 'director', appointedOn: d(2500), resignedOn: null },
      { name: 'OKAFOR, Daniel', role: 'director', appointedOn: d(1800), resignedOn: null },
      { name: 'MCLEAN, Fiona', role: 'secretary', appointedOn: d(1800), resignedOn: null },
    ],
    charges: [{ code: `${number}0001`, status: 'outstanding', createdOn: d(900), satisfiedOn: null, personsEntitled: ['Example Bank PLC'], classification: 'A registered charge' }],
    filings: [
      { date: d(300), type: 'AA', category: 'accounts', description: 'accounts-with-accounts-type-full' },
      { date: d(260), type: 'CS01', category: 'confirmation-statement', description: 'confirmation-statement-with-no-updates' },
    ],
    insolvencyCases: [], gazette: [],
    nhqb: { id: null, name, status: 'active', registeredOn: '2023-03-07', deactivatedOn: null, insolventOn: null },
  };
}

export function demoCompanies() {
  const list = [];
  // 1. Healthy
  list.push({ prev: base('09000001', 'Northgate Homes Limited'), curr: base('09000001', 'Northgate Homes Limited') });

  // 2. Watch: new charge this quarter + director resignation
  { const p = base('09000002', 'Ridgeway Developments Limited'); const c = structuredClone(p);
    c.charges.push({ code: '090000020002', status: 'outstanding', createdOn: d(20), satisfiedOn: null, personsEntitled: ['Example Bridging Finance Limited'], classification: 'A registered charge' });
    c.officers[1].resignedOn = d(12);
    c.filings.unshift({ date: d(20), type: 'MR01', category: 'mortgage', description: 'mortgage-create-with-deed' }, { date: d(12), type: 'TM01', category: 'officers', description: 'termination-director-company-with-name-termination-date' });
    list.push({ prev: p, curr: c }); }

  // 3. Elevated: accounts overdue + CS overdue + board churn
  { const p = base('09000003', 'Meadowcroft Living Limited'); const c = structuredClone(p);
    p.accounts.lastType = 'small';
    c.accounts = { overdue: true, nextDue: d(45), lastMadeUpTo: d(760), lastType: 'small' };
    c.confirmationStatement = { overdue: true, nextDue: d(30), lastMadeUpTo: d(500) };
    c.officers[0].resignedOn = d(70);
    c.officers.push({ name: 'HARRIS, Tom', role: 'director', appointedOn: d(60), resignedOn: null });
    list.push({ prev: p, curr: c }); }

  // 4. Critical: winding-up petition in the Gazette
  { const p = base('09000004', 'Larkspur Homes (Southern) Limited'); const c = structuredClone(p);
    c.gazette.push({ noticeId: '4900001', code: '2450', category: 'Petitions to Wind Up (Companies)', published: d(9), title: 'LARKSPUR HOMES (SOUTHERN) LIMITED', url: 'https://www.thegazette.co.uk/notice/4900001', snippet: 'In the High Court of Justice… In the Matter of LARKSPUR HOMES (SOUTHERN) LIMITED (Company Number 09000004) … a Petition to wind up the above-named Company … presented on ' + d(30) + ' by EXAMPLE TIMBER SUPPLIES LIMITED claiming to be a Creditor', matchStrength: 1 });
    c.charges.push({ code: '090000040002', status: 'outstanding', createdOn: d(120), satisfiedOn: null, personsEntitled: ['Example Capital Partners LLP'], classification: 'A registered charge' });
    list.push({ prev: p, curr: c }); }

  // 5. Critical hard stop: administrators appointed
  { const p = base('09000005', 'Silverbirch Residential Limited'); const c = structuredClone(p);
    c.status = 'administration';
    c.insolvencyCases.push({ number: 1, type: 'in-administration', dates: [{ type: 'administration-started-on', date: d(5) }], practitioners: ['Example Restructuring LLP'] });
    c.filings.unshift({ date: d(5), type: 'AM01', category: 'insolvency', description: 'appointment-of-an-administrator' });
    c.gazette.push({ noticeId: '4900002', code: '2432', category: 'Appointment of Administrators', published: d(4), title: 'SILVERBIRCH RESIDENTIAL LIMITED', url: 'https://www.thegazette.co.uk/notice/4900002', snippet: 'Name of Company: SILVERBIRCH RESIDENTIAL LIMITED Company Number: 09000005 … Administrators appointed', matchStrength: 1 });
    c.nhqb.status = 'insolvent'; c.nhqb.insolventOn = d(3);
    list.push({ prev: p, curr: c }); }

  // 6. Young company with thin board
  { const p = base('09000006', 'Oakfield Build Limited', { incorporatedDaysAgo: 500 }); const c = structuredClone(p);
    c.officers = [{ name: 'PATEL, Rohan', role: 'director', appointedOn: d(500), resignedOn: null }];
    c.accounts = { overdue: false, nextDue: d(-20), lastMadeUpTo: null, lastType: null };
    c.filings = [];
    c.charges = [];
    list.push({ prev: p, curr: c }); }

  // 7. Strike-off notice
  { const p = base('09000007', 'Westbrook Estates Limited'); const c = structuredClone(p);
    c.filings.unshift({ date: d(15), type: 'GAZ1', category: 'gazette', description: 'gazette-notice-compulsory' });
    c.accounts = { overdue: true, nextDue: d(140), lastMadeUpTo: d(800), lastType: 'micro-entity' };
    c.nhqb.status = 'deactivated'; c.nhqb.deactivatedOn = d(40);
    list.push({ prev: p, curr: c }); }

  // 8. Improving: charge satisfied + fresh accounts
  { const p = base('09000008', 'Harbourside Homes Limited'); p.accounts.overdue = true; p.accounts.nextDue = d(100);
    const c = base('09000008', 'Harbourside Homes Limited');
    c.charges[0].status = 'fully-satisfied'; c.charges[0].satisfiedOn = d(30);
    c.filings.unshift({ date: d(10), type: 'AA', category: 'accounts', description: 'accounts-with-accounts-type-full' }, { date: d(30), type: 'MR04', category: 'mortgage', description: 'mortgage-satisfy-charge-full' });
    c.accounts.lastMadeUpTo = d(100);
    list.push({ prev: p, curr: c }); }

  // 9. Petition dismissed (should not count)
  { const p = base('09000009', 'Kingsmere Partnership Homes Limited'); const c = structuredClone(p);
    c.gazette.push(
      { noticeId: '4900003', code: '2450', category: 'Petitions to Wind Up (Companies)', published: d(80), title: 'KINGSMERE PARTNERSHIP HOMES LIMITED', url: 'https://www.thegazette.co.uk/notice/4900003', snippet: 'In the Matter of KINGSMERE PARTNERSHIP HOMES LIMITED (Company Number 09000009) a petition to wind up', matchStrength: 1 },
      { noticeId: '4900004', code: '2451', category: 'Dismissal of Winding-up Petition', published: d(40), title: 'KINGSMERE PARTNERSHIP HOMES LIMITED', url: 'https://www.thegazette.co.uk/notice/4900004', snippet: 'Company Number 09000009 … the petition was dismissed', matchStrength: 1 });
    list.push({ prev: p, curr: c }); }

  // 10. Accounts downgraded + registered office moved
  { const p = base('09000010', 'Fernhill Developments Limited'); const c = structuredClone(p);
    c.accounts.lastType = 'micro-entity';
    c.filings.unshift({ date: d(25), type: 'AD01', category: 'address', description: 'change-registered-office-address-company-with-date-old-address-new-address' });
    c.charges.push({ code: '090000100002', status: 'outstanding', createdOn: d(200), satisfiedOn: null, personsEntitled: ['Example Development Finance Limited'], classification: 'A registered charge' });
    list.push({ prev: p, curr: c }); }

  return list;
}

export function seedDemo() {
  db.openDb();
  if (db.getMeta('demo_seeded')) return { seeded: false };
  for (const { prev, curr } of demoCompanies()) {
    db.upsertCompany({ company_number: curr.companyNumber, name: curr.name, nhqb_id: null, match_confidence: 1, match_method: 'demo', watch: 1 });
    prev.takenAt = new Date(Date.now() - 7 * 86400000).toISOString();
    const s0 = scoreSnapshot(prev, { asOf: prev.takenAt.slice(0, 10) });
    db.insertAlerts(diffSnapshots(null, prev, s0, null));
    db.insertSnapshot(curr.companyNumber, prev, s0);
    curr.takenAt = db.nowIso();
    const previous = db.latestSnapshot(curr.companyNumber);
    const s1 = scoreSnapshot(curr, { previous });
    db.insertAlerts(diffSnapshots(previous, curr, s1, { score: s0.score, band: s0.band }));
    db.insertSnapshot(curr.companyNumber, curr, s1);
  }
  db.setMeta('demo_seeded', db.nowIso());
  db.setMeta('last_sync', db.nowIso());
  return { seeded: true };
}
