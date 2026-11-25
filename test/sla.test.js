import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrder, STATUS, countryGroup } from '../src/sla.js';
import { config, calendar, ams, order, closedPicklist, openPicklist } from './helpers.js';

// Woensdag 2026-11-25, donderdag 26, vrijdag 27, maandag 30 november.
const now = ams('2026-12-05 09:00:00');
const ctx = (closingDays) => ({ config, calendar: calendar(closingDays), now });
const ev = (o, closingDays = []) => evaluateOrder(o, ctx(closingDays));

const cases = [
  // land, cut-off, vlak vóór, precies op (laatste seconde van de minuut), vlak na
  ['NL', '23:58:59', '23:59:59', '2026-11-26 00:00:00'],
  ['BE', '22:58:59', '22:59:59', '2026-11-25 23:00:00'],
  ['DE', '20:58:59', '20:59:59', '2026-11-25 21:00:00'],
];

for (const [country, before, at, after] of cases) {
  test(`${country}: order vlak vóór cut-off → deadline nacht na dezelfde dag`, () => {
    const r = ev(order({ country, created: `2026-11-25 ${before}`, status: 'completed', picklists: [closedPicklist('2026-11-25 23:30:00')] }));
    assert.equal(r.rule, 'voor-cutoff');
    assert.equal(r.deadline, '2026-11-26 00:59:59');
    assert.equal(r.status, STATUS.ON_TIME);
  });
  test(`${country}: order in de cut-offminuut telt nog mee`, () => {
    const r = ev(order({ country, created: `2026-11-25 ${at}` }));
    assert.equal(r.receivedBeforeCutoff, true);
    assert.equal(r.deadline, '2026-11-26 00:59:59');
  });
  test(`${country}: order vlak na cut-off → deadline nacht na volgende werkdag`, () => {
    const r = ev(order({ country, created: after, status: 'completed', picklists: [closedPicklist('2026-11-26 10:00:00')] }));
    assert.equal(r.rule, country === 'NL' ? 'voor-cutoff' : 'na-cutoff');
    assert.equal(r.deadline, '2026-11-27 00:59:59');
    assert.equal(r.status, STATUS.ON_TIME);
  });
}

test('landgroepen', () => {
  assert.equal(countryGroup('nl'), 'NL');
  assert.equal(countryGroup('BE'), 'BE');
  assert.equal(countryGroup('FR'), 'OVERIG');
  assert.equal(countryGroup(''), null);
});

test('vrijdag na cut-off → maandag', () => {
  const r = ev(order({ country: 'DE', created: '2026-11-27 21:15:00', status: 'completed', picklists: [closedPicklist('2026-11-30 12:00:00')] }));
  assert.equal(r.deadline, '2026-12-01 00:59:59');
  assert.equal(r.status, STATUS.ON_TIME);
});

test('weekendorder telt als maandag vóór cut-off', () => {
  const r = ev(order({ country: 'BE', created: '2026-11-28 23:30:00' }));
  assert.equal(r.rule, 'weekend-sluiting');
  assert.equal(r.deadline, '2026-12-01 00:59:59');
});

test('weekendorder verwerkt op dinsdag is te laat', () => {
  const r = ev(order({ country: 'NL', created: '2026-11-29 10:00:00', status: 'completed', picklists: [closedPicklist('2026-12-01 08:00:00')] }));
  assert.equal(r.status, STATUS.LATE);
});

test('sluitingsdag schuift de deadline door', () => {
  // Maandag 30 november gesloten.
  const r = ev(order({ country: 'NL', created: '2026-11-27 23:59:59' /* vrijdag in cut-offminuut */ }), ['2026-11-30']);
  assert.equal(r.deadline, '2026-11-28 00:59:59');
  const r2 = ev(order({ country: 'NL', created: '2026-11-28 12:00:00' }), ['2026-11-30']);
  assert.equal(r2.deadline, '2026-12-02 00:59:59');
  const r3 = ev(order({ country: 'NL', created: '2026-11-30 12:00:00' }), ['2026-11-30']);
  assert.equal(r3.rule, 'weekend-sluiting');
  assert.equal(r3.deadline, '2026-12-02 00:59:59');
});

test('na cut-off vóór een sluitingsdag → eerstvolgende open werkdag', () => {
  const r = ev(order({ country: 'OVERIG', created: '2026-11-27 22:00:00' }), ['2026-11-30']);
  assert.equal(r.deadline, '2026-12-02 00:59:59');
});

test('meerdere picklijsten: laatste gesloten picklijst bepaalt het gemeten moment', () => {
  const r = ev(order({ country: 'NL', created: '2026-11-25 10:00:00', status: 'completed', picklists: [
    closedPicklist('2026-11-25 15:00:00', 1), closedPicklist('2026-11-26 09:00:00', 2),
  ] }));
  assert.equal(r.measured, '2026-11-26 09:00:00');
  assert.equal(r.status, STATUS.LATE);
});

test('geannuleerde picklijst telt niet mee', () => {
  const r = ev(order({ country: 'NL', created: '2026-11-25 10:00:00', status: 'completed', picklists: [
    closedPicklist('2026-11-25 15:00:00', 1), { ...openPicklist(2), status: 'cancelled' },
  ] }));
  assert.equal(r.status, STATUS.ON_TIME);
});

test('order nog open na deadline', () => {
  const r = ev(order({ country: 'NL', created: '2026-11-25 10:00:00', status: 'processing', picklists: [openPicklist()] }));
  assert.equal(r.status, STATUS.OPEN_OVERDUE);
});

test('deadline nog niet verstreken', () => {
  const r = evaluateOrder(order({ country: 'NL', created: '2026-11-25 10:00:00' }), { config, calendar: calendar(), now: ams('2026-11-25 12:00:00') });
  assert.equal(r.status, STATUS.NOT_DUE);
});

test('buiten scope: geannuleerd, concept, wacht op voorraad', () => {
  assert.equal(ev(order({ created: '2026-11-25 10:00:00', status: 'cancelled' })).status, STATUS.OUT_OF_SCOPE);
  assert.equal(ev(order({ created: '2026-11-25 10:00:00', status: 'concept' })).status, STATUS.OUT_OF_SCOPE);
  const r = evaluateOrder(order({ created: '2026-11-25 10:00:00' }), { ...ctx(), backorder: { open: true, seenBefore: false } });
  assert.equal(r.status, STATUS.OUT_OF_SCOPE);
});

test('backorder die eerder gezien is → onvoldoende gegevens', () => {
  const r = evaluateOrder(order({ created: '2026-11-20 10:00:00', status: 'completed', picklists: [closedPicklist('2026-11-26 10:00:00')] }), { ...ctx(), backorder: { open: false, seenBefore: true } });
  assert.equal(r.status, STATUS.INSUFFICIENT);
});

test('onvoldoende gegevens: geen land, geen created, afgerond zonder closed_at', () => {
  assert.equal(ev(order({ country: null, created: '2026-11-25 10:00:00' })).status, STATUS.INSUFFICIENT);
  assert.equal(ev(order({ created: null })).status, STATUS.INSUFFICIENT);
  const r = ev(order({ created: '2026-11-25 10:00:00', status: 'completed', picklists: [{ ...closedPicklist(null) }] }));
  assert.equal(r.status, STATUS.INSUFFICIENT);
});

test('zomertijd: cut-off volgt Europe/Amsterdam (CEST)', () => {
  // 3 juni 2026 (woensdag), UTC+2.
  const r = ev(order({ country: 'OVERIG', created: '2026-06-03 20:59:30' }));
  assert.equal(r.receivedBeforeCutoff, true);
  assert.equal(r.deadlineUtc, '2026-06-03T22:59:59.999Z');
  const r2 = ev(order({ country: 'OVERIG', created: '2026-06-03 21:00:00' }));
  assert.equal(r2.deadline, '2026-06-05 00:59:59');
});

test('elke uitkomst bewaart regel, tijdstempels en reden', () => {
  const r = ev(order({ country: 'NL', created: '2026-11-25 10:00:00', status: 'completed', picklists: [closedPicklist('2026-11-25 15:00:00')] }));
  assert.ok(r.rule && r.reason && r.timestamps.created && r.measuredSource && r.measuredLabel === 'geregistreerd in Picqer');
});

test('marge tot 00:59:59 in de nacht na de werkdag', () => {
  const at = (closed) => ev(order({ country: 'NL', created: '2026-11-24 23:13:41', status: 'completed', picklists: [closedPicklist(closed)] })).status;
  assert.equal(at('2026-11-25 00:32:39'), STATUS.ON_TIME, 'voorbeeldorder O2026-532645');
  assert.equal(at('2026-11-25 00:59:59'), STATUS.ON_TIME);
  assert.equal(at('2026-11-25 01:00:00'), STATUS.LATE);
});

test('minimizeComment: alleen tekst en tijdstip, HTML weg', async () => {
  const { minimizeComment } = await import('../src/picqer.js');
  const c = minimizeComment({ idcomment: 1, author: { full_name: 'Piet' }, body: '<p>Huisnummer&nbsp;mist<br>bel klant</p>', created: '2026-11-30 21:40:12' });
  assert.deepEqual(c, { body: 'Huisnummer mist bel klant', created: '2026-11-30 21:40:12' });
});
