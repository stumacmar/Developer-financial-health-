// Optional outbound notifications: POST new alerts to a webhook (Slack/Teams/Zapier/anything that takes JSON).
import { config } from './config.js';
import { listAlerts, markAlertsDelivered } from './db.js';
import { severityAtLeast } from './alerts.js';

export async function deliverPendingAlerts({ url = config.alertWebhookUrl, minSeverity = config.alertWebhookMinSeverity } = {}) {
  if (!url) return { sent: 0, skipped: 'no webhook configured' };
  const pending = listAlerts({ undeliveredOnly: true, limit: 500 }).filter((a) => severityAtLeast(a.severity, minSeverity));
  if (!pending.length) return { sent: 0 };
  const lines = pending.map((a) => `• [${a.severity.toUpperCase()}] ${a.company_name || a.company_number}: ${a.title}${a.detail ? ` — ${a.detail}` : ''}`);
  const body = { text: `Developer radar: ${pending.length} new alert${pending.length > 1 ? 's' : ''}\n${lines.join('\n')}`, alerts: pending };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Webhook responded ${res.status}`);
  markAlertsDelivered(pending.map((a) => a.id));
  return { sent: pending.length };
}
