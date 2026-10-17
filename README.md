# Developer Radar

An early-warning radar for the housebuilders on the **New Homes Quality Board (NHQB) register**. It pulls the free
**Companies House** API and **The Gazette** corporate-insolvency notices, builds a **composite risk score (0–100)** for
every developer, and raises alerts when something changes: late accounts, new charges, director resignations,
winding-up petitions, strike-off notices, administration.

No paid data, no framework, no npm dependencies. Node 22+ and a free Companies House API key.

```
npm run demo            # explore the dashboard with synthetic data (no key needed) -> http://localhost:8787
cp .env.example .env    # add COMPANIES_HOUSE_API_KEY
npm run nhqb            # pull the NHQB register and match every developer to a company number
npm run sync            # collect Companies House + Gazette data, score, diff, alert
npm run serve           # dashboard + JSON API on http://localhost:8787
npm test
```

## What it watches

| Source | What we take from it | Cost |
|---|---|---|
| **NHQB register** (`nhqb.org.uk/register-of-developers`) | Every registered developer, its status (`active` / `pending` / `deactivated`) and the register's own insolvency date. The public page is a search box capped at 50 hits, so `radar nhqb` enumerates it by recursively refining any query that hits the cap. | free, no key |
| **Companies House Public Data API** | Profile (status, accounts/confirmation-statement due dates and overdue flags), officers, charges, filing history, insolvency cases. | free key, 600 requests / 5 min |
| **The Gazette** JSON feed (`/insolvency/notice/data.json`) | Corporate insolvency notices: petitions to wind up, winding-up orders, appointment of administrators/liquidators/receivers, moratoria, creditors' meetings, dismissals. Searched by exact company name and kept only when the notice is *about* that company (name in the title or "In the Matter of", or the company number in the text) so a developer that petitions against a subcontractor is not flagged. | free, no key, throttled per 5 minutes |

Everything is stored in SQLite (`data/radar.sqlite`, via Node's built-in `node:sqlite`): the register, the watchlist, a
snapshot per company per sync, Gazette notices and alerts.

## The composite score

Each sync takes a fresh snapshot per company and runs it through an itemised rule set (`src/scoring.js`). Points are
summed, clipped to 0–100, and every point is kept as a *factor* with its evidence, so the dashboard can show exactly why a
developer scored what it did.

**Hard stops — score pinned at 100.** Any of: Companies House status is liquidation / administration / receivership /
insolvency-proceedings / dissolved; an insolvency case on the register; an insolvency-category filing in 24 months; a
Gazette notice of administrators, creditors' liquidators, winding-up order or receivers; the NHQB register's insolvency
date is set.

| Signal | Points |
|---|---|
| Gazette: petition to wind up (unless dismissed later) | +70 |
| Gazette: moratorium / meeting of creditors / notice to creditors | +50 to +70 |
| Gazette: members' voluntary (solvent) liquidation | +40 |
| Strike-off: first Gazette notice (GAZ1) or DS01, not discontinued | +60 |
| Company voluntary arrangement | +80 |
| Annual accounts overdue (more than 90 days late) | +25 (+35) |
| Confirmation statement overdue · both filings overdue at once | +10 · +10 |
| Accounts type downgraded since the last snapshot (e.g. full → micro-entity) | +10 |
| Latest accounts older than 21 months · accounts due in the next 30 days | +10 · +5 |
| New charge in last 90 days (each, max 30) · charge 3–12 months old (each, max 12) | +10 · +4 |
| Five or more outstanding charges | +5 |
| Director resigned in last 90 days (each, max 24) · 3–6 months ago (each, max 8) | +8 · +4 |
| Half or more of the board (at least two) left in 12 months | +10 |
| Fewer than two active directors | +10 |
| Registered office moved in 90 days · name changed in 6 months | +5 · +5 |
| Incorporated under 2 years ago · 2–4 years ago | +15 · +8 |
| Deactivated on the NHQB register | +15 |
| Charge satisfied in last 12 months (each, max −6) · accounts filed in last 90 days | −3 · −5 |

**Bands:** ✓ Low 0–14 · ! Watch 15–34 · ▲ Elevated 35–59 · ✖ Critical 60–100.

The weights are deliberately simple and editable. They encode the ordering most credit teams use for construction:
formal insolvency events > petitions and strike-off > filing non-compliance > secured borrowing and board churn >
structural fragility. `npm run score` re-scores every stored snapshot without touching the network, so you can tune
`src/scoring.js` and see the effect immediately.

## Alerts

Consecutive snapshots are diffed (`src/alerts.js`). Alert types: `NEW_CHARGE`, `CHARGE_SATISFIED`, `DIRECTOR_RESIGNED`,
`DIRECTOR_APPOINTED`, `ACCOUNTS_OVERDUE`, `ACCOUNTS_FILED`, `CS_OVERDUE`, `GAZETTE_NOTICE`, `INSOLVENCY_FILING`,
`INSOLVENCY_CASE`, `STRIKE_OFF_NOTICE`, `STRIKE_OFF_APPLICATION`, `STATUS_CHANGED`, `NAME_CHANGED`, `OFFICE_MOVED`,
`NHQB_STATUS`, `BAND_CHANGED`, `WATCH_STARTED`. Severities are `critical` / `high` / `medium` / `info`. Each alert has a
dedupe key so repeated syncs never raise the same event twice. The first snapshot of a company only raises alerts for
items from the last 90 days plus serious historical ones.

Set `ALERT_WEBHOOK_URL` to have every new alert at or above `ALERT_WEBHOOK_MIN_SEVERITY` POSTed as JSON (with a ready-made
`text` field, so a Slack or Teams incoming webhook works as-is).

## Running it on a schedule

The radar is only an early warning if it runs regularly. A daily cron entry is enough:

```
15 6 * * * cd /opt/developer-radar && npm run sync >> data/sync.log 2>&1
0  3 * * 1 cd /opt/developer-radar && npm run nhqb >> data/sync.log 2>&1     # weekly register refresh
```

A full sync of ~250 developers makes ~1,250 Companies House calls (about 12 minutes under the 600 / 5 min limit) and ~250
Gazette calls (about 7 minutes at the pace we use to stay under its throttle). `--limit N` and `--company <number|name>`
narrow a run; `--no-gazette` skips the Gazette pass.

## Going live

The app is one long-running Node process plus a SQLite file, so it needs a host with a **persistent disk**, not a
serverless/static host. The repo ships a `Dockerfile` and a `fly.toml`; the server syncs itself on a timer when
`SYNC_INTERVAL_HOURS` is set and password-protects the dashboard when `DASHBOARD_PASSWORD` is set.

**Fly.io (about $2–3/month, free allowance usually covers it)**

```
fly auth signup                                    # or fly auth login
fly launch --no-deploy --copy-config               # accepts the bundled fly.toml; pick a unique app name if asked
fly volumes create radar_data --size 1 --region lhr
fly secrets set COMPANIES_HOUSE_API_KEY=xxxx DASHBOARD_PASSWORD='a-strong-password'
fly secrets set ALERT_WEBHOOK_URL=https://hooks.slack.com/...        # optional
fly deploy
fly ssh console -C "node --no-warnings src/cli.js nhqb"              # first-time register pull + matching (10–15 min)
fly ssh console -C "node --no-warnings src/cli.js sync"              # first full sync, or wait for the scheduler
fly open                                                             # https://<app>.fly.dev, any username + your password
```

**Railway / Render / any Docker host.** Deploy the repo with the Dockerfile, attach a volume at `/data`, and set the
same four environment variables (`COMPANIES_HOUSE_API_KEY`, `DASHBOARD_PASSWORD`, optionally `ALERT_WEBHOOK_URL`,
`SYNC_INTERVAL_HOURS=24`). Run the two one-off commands above from the host's shell.

**A VPS or office box.** `git clone`, `npm run nhqb`, then either set `SYNC_INTERVAL_HOURS=24` in `.env` and keep
`npm run serve` running under systemd or pm2, or leave the interval at 0 and use the cron lines above. Put nginx or
Caddy in front for HTTPS.

Operational notes: the Companies House key is tied to your account, keep it in a secret not in the repo; the first sync
after a register refresh is the slow one, later ones only fetch what the API allows per 5 minutes; back up
`/data/radar.sqlite` occasionally (it holds every snapshot and alert).

## Dashboard and API

`npm run serve` (or `npm run demo`) starts a dependency-free HTTP server:

| Route | Purpose |
|---|---|
| `GET /` | Dashboard: band tiles, sortable/filterable company table, per-company drawer with score breakdown, history sparkline, charges, officers, Gazette notices and alerts; an alerts feed; the method page. |
| `GET /api/overview` | All watched companies with score, band, change since last sync, top factors, and counts. |
| `GET /api/companies/:number` | Full snapshot, factors, score history, alerts, Gazette notices. |
| `GET /api/alerts?since=YYYY-MM-DD&limit=200` | Alert feed. |
| `POST /api/alerts/:id/ack` | Acknowledge an alert. |
| `POST /api/sync` | Kick off a sync in the background (disabled in demo mode). |
| `GET /api/register` | The cached NHQB register. |
| `GET /healthz` | Liveness check (unauthenticated). |

## Watchlist management

NHQB entries are matched to Companies House by name search. Exact normalised-name matches on an active company are
auto-watched; ambiguous ones are stored with `watch = 0` and listed on the dashboard and in `radar watch list` with the
candidate numbers. Confirm with `radar watch add <number>`. You can also watch companies that are not on the register
(`radar watch add 01234567`) or import a CSV of `company_number,name` (`radar watch import file.csv`).

## How this compares with commercial tools

Researched while scoping this (October 2026):

* **Red Flag Alert** — subscription credit-risk monitoring with a construction-specific offer; markets a proprietary
  financial health score built from "over 100 data points" and real-time alerts, and cites early warnings on Buckingham
  Group, PDR Construction and Carillion. Claims are vendor-reported.
  ([construction page](https://www.redflagalert.com/solutions/industry/construction),
  [Buckingham Group case](https://www.redflagalert.com/articles/the-early-warning-signs-that-predicted-the-issues-at-buckingham-group),
  [score methodology piece](https://redflagalert.com/articles/risk/how-rfas-company-financial-risk-score-challenges-the-status-quo))
* **Constructionline Risk Radar** — supplier/subcontractor risk monitoring for main contractors, daily refresh,
  exception-only alerts; cites 4,378 construction administrations in 2023.
  ([Risk Radar](https://www.constructionline.co.uk/insights/blog/risk-radar-revolutionising-supplier-risk-management-in-construction/))
* **Company Watch H-Score** — 0–100 insolvency-risk score built mainly from filed accounts, with a published
  back-tested hit rate for public-company failures. ([comparison page](https://www.companywatch.net/compare/),
  [vs Creditsafe](https://www.companywatch.net/company-watch-vs-creditsafe/))
* **Creditsafe / Experian** — broad credit-reference scores and monitoring, less construction-specific.
* **PageCrawl Companies House filing alerts** — a hosted change-monitor for individual companies (new charge, director
  resignation, overdue accounts); alert-only, no score. ([tool](https://pagecrawl.io/tools/uk-companies-house-filing-monitoring.html))
* **Companies House "Follow"** — free email per accepted filing for any company you follow; no filtering, no change
  summary, no scoring. ([gov.uk](https://gov.uk/government/news/follow-companies-for-free))
* **Gazette data** — third-party Apify scrapers wrap the same public feed this app reads directly.
  ([example](https://apify.com/tagadanar/uk-gazette-insolvency))

Where this app sits: it does the same *event-driven* watching the paid tools do (filings, charges, officers, Gazette),
for the specific population you care about (the NHQB register), with a transparent score and no licence. What it does
**not** do, and what the paid tools add, is financial-statement analysis (ratios from filed accounts, payment-performance
data, county court judgments, trade-credit experience). Those are the main upgrades if you want to go further; the
Companies House `document` API and the open CCJ register are the obvious free inputs.

## Limitations to keep in mind

* Companies House lags reality: a charge can take weeks to appear; accounts are up to nine months old when filed. "Low"
  means *nothing visible yet*, not *safe*.
* Gazette matching is by exact company name. A developer trading under a very different name from its registered one
  will still be found via its registered name (which is what the register holds), but typos in notices can be missed.
* The NHQB register exposes no company numbers, so matching is by name; check the low-confidence list after `radar nhqb`.
* Group risk is not modelled: a subsidiary can be fine on paper while the parent is in trouble. The register carries a
  `holding_company_id` that could be used to roll scores up to the group.

## Layout

```
src/cli.js                  command line entry point
src/sync.js                 orchestration: register -> match -> collect -> score -> diff -> notify
src/scoring.js              composite score (pure function, unit-tested)
src/alerts.js               snapshot diffing -> alerts (pure function, unit-tested)
src/sources/nhqb.js         NHQB register enumeration
src/sources/companiesHouse.js  API client + snapshot normalisation
src/sources/gazette.js      Gazette feed search, matching and notice classification
src/db.js                   SQLite schema and queries (node:sqlite)
src/server.js               HTTP server + JSON API
src/notify.js               webhook delivery
src/demo.js                 synthetic fixtures (all fictional) for the demo and tests
public/index.html           dashboard (vanilla JS, light/dark)
test/scoring.test.js        node:test suite
```
