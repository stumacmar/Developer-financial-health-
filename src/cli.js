#!/usr/bin/env node
import fs from 'node:fs';
import { config } from './config.js';
import * as db from './db.js';
import { runSync, refreshRegister, matchRegisterToCompaniesHouse, rescoreAll } from './sync.js';
import { startServer } from './server.js';
import { seedDemo } from './demo.js';
import { CompaniesHouseClient } from './sources/companiesHouse.js';

const [, , cmd = 'help', ...rest] = process.argv;
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { const k = rest[i].slice(2); const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; flags[k] = v; }
  else positional.push(rest[i]);
}

const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

async function main() {
  switch (cmd) {
    case 'sync': {
      const { results } = await runSync({ refreshNhqb: Boolean(flags.nhqb), limit: flags.limit ? Number(flags.limit) : Infinity, only: flags.company || null, gazette: !flags['no-gazette'] });
      printTable(results.filter((r) => !r.error).sort((a, b) => b.score - a.score));
      const failed = results.filter((r) => r.error);
      if (failed.length) console.log(`\n${failed.length} failed:\n` + failed.map((f) => `  ${f.name} (${f.number}): ${f.error}`).join('\n'));
      break;
    }
    case 'nhqb': {
      db.openDb();
      const r = await refreshRegister({ maxRequests: flags['max-requests'] ? Number(flags['max-requests']) : undefined });
      console.log(`Register: ${r.count} developers`);
      if (config.companiesHouseApiKey && !flags['no-match']) await matchRegisterToCompaniesHouse(new CompaniesHouseClient());
      else console.log('Skipping Companies House matching (no COMPANIES_HOUSE_API_KEY).');
      break;
    }
    case 'score': {
      printTable(rescoreAll());
      break;
    }
    case 'alerts': {
      db.openDb();
      const since = flags.since ? new Date(flags.since).toISOString() : null;
      for (const a of db.listAlerts({ since, limit: Number(flags.limit || 100) }).reverse()) console.log(`${a.created_at.slice(0, 16)}  ${pad(a.severity.toUpperCase(), 8)} ${pad(a.company_name || a.company_number, 36)} ${a.title}${a.detail ? ` — ${a.detail}` : ''}`);
      break;
    }
    case 'watch': {
      // watch add <companyNumber> [name] | watch import <file.csv> (columns: company_number,name) | watch list
      db.openDb();
      const [sub, arg, ...nameParts] = positional;
      if (sub === 'add') {
        let name = nameParts.join(' ');
        if (!name && config.companiesHouseApiKey) name = (await new CompaniesHouseClient().profile(arg)).company_name;
        db.upsertCompany({ company_number: arg, name: name || arg, match_confidence: 1, match_method: 'manual', watch: 1 });
        console.log(`Watching ${name || arg} (${arg})`);
      } else if (sub === 'remove') { db.upsertCompany({ company_number: arg, name: db.getCompany(arg)?.name || arg, watch: 0 }); console.log(`Stopped watching ${arg}`); }
      else if (sub === 'import') {
        const lines = fs.readFileSync(arg, 'utf8').split(/\r?\n/).filter(Boolean);
        let n = 0;
        for (const line of lines) { const [number, ...name] = line.split(','); if (!/^[A-Z0-9]{6,8}$/i.test(number.trim())) continue; db.upsertCompany({ company_number: number.trim().toUpperCase().padStart(8, '0'), name: name.join(',').trim() || number.trim(), match_confidence: 1, match_method: 'import', watch: 1 }); n++; }
        console.log(`Imported ${n} companies`);
      } else for (const c of db.listCompanies({ watchedOnly: false })) console.log(`${pad(c.company_number, 10)} ${pad(c.name, 40)} watch=${c.watch} conf=${c.match_confidence ?? '-'} ${c.notes || ''}`);
      break;
    }
    case 'serve': {
      if (flags.demo) { process.env.RADAR_DB = process.env.RADAR_DB || './data/demo.sqlite'; config.dbPath = process.env.RADAR_DB; db.openDb(config.dbPath); seedDemo(); }
      startServer({ port: Number(flags.port || config.port), demo: Boolean(flags.demo) });
      break;
    }
    default:
      console.log(`developer-radar — early-warning radar for NHQB-registered housebuilders

  radar sync [--nhqb] [--limit N] [--company <number|name>] [--no-gazette]   collect, score, alert
  radar nhqb [--max-requests N] [--no-match]                                  refresh the NHQB register and match to Companies House
  radar score                                                                 re-score stored snapshots (no network)
  radar alerts [--since YYYY-MM-DD] [--limit N]                               print alerts
  radar watch add <number> [name] | remove <number> | import <csv> | list     manage the watchlist
  radar serve [--port 8787] [--demo]                                          dashboard + JSON API`);
  }
}

function printTable(rows) {
  console.log(`\n${pad('Score', 6)} ${pad('Band', 9)} ${pad('Number', 10)} Name`);
  for (const r of rows) console.log(`${pad(r.score, 6)} ${pad(r.band, 9)} ${pad(r.number, 10)} ${r.name}`);
}

main().catch((err) => { console.error(flags.debug ? err : `Error: ${err.message}`); process.exit(1); });
