// Loads .env (if present) without a dependency, then exposes typed config.
import fs from 'node:fs';
import path from 'node:path';

function loadDotEnv(file = '.env') {
  try {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* no .env is fine */ }
}
loadDotEnv();

export const config = {
  companiesHouseApiKey: process.env.COMPANIES_HOUSE_API_KEY || '',
  dbPath: process.env.RADAR_DB || './data/radar.sqlite',
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
  alertWebhookMinSeverity: (process.env.ALERT_WEBHOOK_MIN_SEVERITY || 'high').toLowerCase(),
  port: Number(process.env.PORT || 8787),
  gazetteLookbackMonths: Number(process.env.GAZETTE_LOOKBACK_MONTHS || 24),
  // Hosted mode: the server runs a sync itself every N hours (0 = never; use cron instead).
  syncIntervalHours: Number(process.env.SYNC_INTERVAL_HOURS || 0),
  // Hosted mode: protect the dashboard with HTTP basic auth (any username, this password).
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  userAgent: 'developer-radar/0.1 (+https://github.com/stumacmar/developer-financial-health-)',
};
