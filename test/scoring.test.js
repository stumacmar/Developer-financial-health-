import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreSnapshot, bandFor } from '../src/scoring.js';
import { classifyNotice } from '../src/sources/gazette.js';
import { diffSnapshots } from '../src/alerts.js';
import { demoCompanies } from '../src/demo.js';
import { sameCompanyName, normaliseName } from '../src/util/names.js';

const byName = (name) => demoCompanies().find((x) => x.curr.name === name);

test('bands', () => {
  assert.equal(bandFor(0).name, 'Low');
  assert.equal(bandFor(14).name, 'Low');
  assert.equal(bandFor(15).name, 'Watch');
  assert.equal(bandFor(35).name, 'Elevated');
  assert.equal(bandFor(60).name, 'Critical');
  assert.equal(bandFor(100).name, 'Critical');
});

test('healthy company scores Low with no positive factors', () => {
  const { curr } = byName('Northgate Homes Limited');
  const s = scoreSnapshot(curr);
  assert.equal(s.band, 'Low');
  assert.ok(s.factors.every((f) => f.points <= 0), JSON.stringify(s.factors));
});

test('new charge plus director resignation lands in Watch', () => {
  const { curr } = byName('Ridgeway Developments Limited');
  const s = scoreSnapshot(curr);
  assert.equal(s.band, 'Watch');
  assert.ok(s.factors.some((f) => f.id === 'charges-new-90d'));
  assert.ok(s.factors.some((f) => f.id === 'directors-resigned-90d'));
});

test('overdue accounts + CS + churn is Elevated', () => {
  const { curr } = byName('Meadowcroft Living Limited');
  const s = scoreSnapshot(curr);
  assert.equal(s.band, 'Elevated');
  for (const id of ['accounts-overdue', 'cs-overdue', 'filing-blackout', 'directors-resigned-90d']) assert.ok(s.factors.some((f) => f.id === id), id);
});

test('winding-up petition is Critical but not a hard stop', () => {
  const { curr } = byName('Larkspur Homes (Southern) Limited');
  const s = scoreSnapshot(curr);
  assert.equal(s.band, 'Critical');
  assert.equal(s.hardStop, null);
  assert.ok(s.factors.find((f) => f.id === 'gazette').points === 70);
});

test('administration pins score at 100 via hard stop', () => {
  const { curr } = byName('Silverbirch Residential Limited');
  const s = scoreSnapshot(curr);
  assert.equal(s.score, 100);
  assert.ok(s.hardStop);
});

test('dismissed petition does not count', () => {
  const { curr } = byName('Kingsmere Partnership Homes Limited');
  const s = scoreSnapshot(curr);
  assert.ok(!s.factors.some((f) => f.id === 'gazette'));
  assert.equal(s.band, 'Low');
});

test('accounts downgrade is detected against previous snapshot', () => {
  const { prev, curr } = byName('Fernhill Developments Limited');
  const s = scoreSnapshot(curr, { previous: { data: prev } });
  assert.ok(s.factors.some((f) => f.id === 'accounts-downgraded'));
  assert.ok(s.factors.some((f) => f.id === 'office-moved'));
});

test('positive offsets reduce the score but never below zero', () => {
  const { curr } = byName('Harbourside Homes Limited');
  const s = scoreSnapshot(curr);
  assert.equal(s.score, 0);
  assert.ok(s.rawTotal < 0);
});

test('gazette classification', () => {
  assert.equal(classifyNotice({ category: 'Petitions to Wind Up (Companies)' }).points, 70);
  assert.equal(classifyNotice({ category: 'Appointment of Liquidators', snippet: "Members' voluntary liquidation" }).kind, 'members-voluntary-liquidation');
  assert.equal(classifyNotice({ category: 'Appointment of Liquidators', snippet: 'Creditors voluntary' }).points, 100);
  assert.equal(classifyNotice({ category: 'Dismissal of Winding-up Petition' }).points, 0);
});

test('diff produces the expected alert types', () => {
  const { prev, curr } = byName('Ridgeway Developments Limited');
  prev.takenAt = new Date(Date.now() - 7 * 86400000).toISOString(); curr.takenAt = new Date().toISOString();
  const s0 = scoreSnapshot(prev), s1 = scoreSnapshot(curr);
  const alerts = diffSnapshots({ data: prev }, curr, s1, s0);
  const types = alerts.map((a) => a.type);
  assert.ok(types.includes('NEW_CHARGE'));
  assert.ok(types.includes('DIRECTOR_RESIGNED'));
  assert.ok(types.includes('BAND_CHANGED'));
  assert.ok(new Set(alerts.map((a) => a.dedupe_key)).size === alerts.length, 'dedupe keys unique');
});

test('first sync only surfaces recent/serious items', () => {
  const { curr } = byName('Northgate Homes Limited');
  const alerts = diffSnapshots(null, curr, scoreSnapshot(curr), null);
  assert.deepEqual(alerts.map((a) => a.type), ['WATCH_STARTED']);
});

test('name matching', () => {
  assert.equal(normaliseName('Barratt Homes Ltd.'), 'BARRATT HOMES LIMITED');
  assert.equal(sameCompanyName('BARRATT HOMES LIMITED', 'Barratt Homes Ltd'), 1);
  assert.equal(sameCompanyName('Barratt Homes', 'BARRATT HOMES LIMITED'), 0.9);
  assert.equal(sameCompanyName('Barratt Homes', 'Persimmon Homes Limited'), 0);
});
