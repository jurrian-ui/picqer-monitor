import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, loadState, renderMarkdown } from '../src/check.js';
import { STATUS } from '../src/sla.js';
import { config, ams, order, closedPicklist, openPicklist, MemoryStore, FakeClient } from './helpers.js';

const base = { config, closingDays: [] };

test('eerste run zonder startdatum geeft een duidelijke melding', async () => {
  const r = await runCheck({ ...base, client: new FakeClient(), store: new MemoryStore(), now: ams('2026-11-30 09:00:00') });
  assert.equal(r.ok, false);
  assert.match(r.error, /startdatum/);
});

test('maandagrun neemt vrijdagmiddag mee en telt per landgroep', async () => {
  const store = new MemoryStore();
  await store.put('state:v1', JSON.stringify({ lastSuccessfulCheck: ams('2026-11-27 09:00:00').toISOString() }));
  const client = new FakeClient({
    orders: [
      order({ idorder: 1, country: 'NL', created: '2026-11-27 14:00:00', status: 'completed', picklists: [closedPicklist('2026-11-27 18:00:00', 101)] }),
      order({ idorder: 2, country: 'BE', created: '2026-11-27 23:10:00', status: 'completed', picklists: [closedPicklist('2026-12-01 08:00:00', 102)] }), // deadline ma 30-11, te laat
      order({ idorder: 3, country: 'FR', created: '2026-11-27 12:00:00', status: 'processing', picklists: [openPicklist(103)] }), // open na deadline
      order({ idorder: 4, country: 'NL', created: '2026-11-26 10:00:00', status: 'completed', picklists: [closedPicklist('2026-11-26 12:00:00', 104)] }), // deadline vóór periode
    ],
    shipments: { 101: [{ idshipment: 9, provider: 'PostNL', carrier_key: 'postnl', created: '2026-11-27 18:00:00', cancelled: false, parcels: [{ tracking_code: '3SABC', tracking_url: 'https://t' }] }] },
  });
  const r = await runCheck({ ...base, client, store, now: ams('2026-12-01 09:00:00') });
  assert.equal(r.ok, true);
  const g = r.report.groups;
  assert.equal(g.NL.counts[STATUS.ON_TIME], 1);
  assert.equal(g.BE.counts[STATUS.LATE], 1);
  assert.equal(g.OVERIG.counts[STATUS.OPEN_OVERDUE], 1);
  assert.equal(g.NL.percentOnTime, 100);
  assert.equal(g.BE.percentOnTime, 0);
  assert.equal(g.BE.deviations[0].orderid, 'O2');
  assert.equal(Object.values(g.NL.counts).reduce((a, b) => a + b, 0), 1, 'order 4 is al eerder beoordeeld');
  assert.equal(r.parcelLinks.find((l) => l.idorder === 1).tracking_code, '3SABC');

  const s = await loadState(store);
  assert.equal(s.lastSuccessfulCheck, ams('2026-12-01 09:00:00').toISOString());
  assert.ok(s.openOrders['3']);
  assert.match(renderMarkdown(r), /## BE/);
});

test('eerder gemelde open order: wijziging bij nieuwe zending', async () => {
  const store = new MemoryStore();
  await store.put('state:v1', JSON.stringify({
    lastSuccessfulCheck: ams('2026-12-01 09:00:00').toISOString(),
    openOrders: { 3: { status: STATUS.OPEN_OVERDUE, orderid: 'O3', reported: true } },
  }));
  const client = new FakeClient({ orders: [
    order({ idorder: 3, country: 'FR', created: '2026-11-27 12:00:00', status: 'completed', picklists: [closedPicklist('2026-12-01 15:00:00', 103)] }),
  ] });
  const r = await runCheck({ ...base, client, store, now: ams('2026-12-02 09:00:00') });
  assert.equal(r.report.changesSinceEarlierReports.length, 1);
  assert.equal(r.report.changesSinceEarlierReports[0].status, STATUS.LATE);
  assert.equal(r.report.changesSinceEarlierReports[0].previousStatus, STATUS.OPEN_OVERDUE);
  assert.equal(r.report.groups.OVERIG.counts[STATUS.LATE], 0, 'niet dubbel geteld');
  assert.deepEqual((await loadState(store)).openOrders, {});
});

test('eerder gemelde open order die nog open is blijft gevolgd', async () => {
  const store = new MemoryStore();
  await store.put('state:v1', JSON.stringify({
    lastSuccessfulCheck: ams('2026-12-01 09:00:00').toISOString(),
    openOrders: { 3: { status: STATUS.OPEN_OVERDUE, orderid: 'O3', reported: true } },
  }));
  const client = new FakeClient({ orders: [order({ idorder: 3, country: 'FR', created: '2026-11-27 12:00:00', picklists: [openPicklist(103)] })] });
  const r = await runCheck({ ...base, client, store, now: ams('2026-12-02 09:00:00') });
  assert.equal(r.report.stillOpenFromEarlierReports.length, 1);
  assert.ok((await loadState(store)).openOrders['3']);
});

test('mislukte API-run verschuift het controletijdstip niet en wordt ingehaald', async () => {
  const store = new MemoryStore();
  const start = ams('2026-11-30 09:00:00').toISOString();
  await store.put('state:v1', JSON.stringify({ lastSuccessfulCheck: start }));
  const orders = [order({ idorder: 7, country: 'NL', created: '2026-11-30 11:00:00', status: 'completed', picklists: [closedPicklist('2026-11-30 16:00:00', 107)] })];

  const failed = await runCheck({ ...base, client: new FakeClient({ orders, failOn: 'orders' }), store, now: ams('2026-12-01 09:00:00') });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /mislukt/);
  let s = await loadState(store);
  assert.equal(s.lastSuccessfulCheck, start);
  assert.equal(s.lastRun.ok, false);

  // Ook een fout bij de backorders telt als mislukt.
  const failed2 = await runCheck({ ...base, client: new FakeClient({ orders, failOn: 'backorders' }), store, now: ams('2026-12-01 10:00:00') });
  assert.equal(failed2.ok, false);
  assert.equal((await loadState(store)).lastSuccessfulCheck, start);

  const ok = await runCheck({ ...base, client: new FakeClient({ orders }), store, now: ams('2026-12-02 09:00:00') });
  assert.equal(ok.ok, true);
  assert.equal(ok.report.groups.NL.counts[STATUS.ON_TIME], 1, 'order uit de gemiste periode is ingehaald');
  s = await loadState(store);
  assert.equal(s.lastSuccessfulCheck, ams('2026-12-02 09:00:00').toISOString());
});

test('proefrun slaat niets op', async () => {
  const store = new MemoryStore();
  const r = await runCheck({ ...base, client: new FakeClient(), store, now: ams('2026-12-01 09:00:00'), from: ams('2026-11-30 00:00:00').toISOString(), dryRun: true });
  assert.equal(r.ok, true);
  assert.equal((await loadState(store)).lastSuccessfulCheck, null);
});

test('backorder: wacht op voorraad, daarna onvoldoende gegevens', async () => {
  const store = new MemoryStore();
  await store.put('state:v1', JSON.stringify({ lastSuccessfulCheck: ams('2026-11-30 09:00:00').toISOString() }));
  const o = order({ idorder: 8, country: 'NL', created: '2026-11-30 10:00:00', status: 'processing', picklists: [] });
  const r1 = await runCheck({ ...base, client: new FakeClient({ orders: [o], backorders: [8] }), store, now: ams('2026-12-01 09:00:00') });
  assert.equal(r1.report.groups.NL.counts[STATUS.OUT_OF_SCOPE], 1);
  const done = { ...o, status: 'completed', picklists: [closedPicklist('2026-12-02 10:00:00', 108)] };
  const r2 = await runCheck({ ...base, client: new FakeClient({ orders: [done] }), store, now: ams('2026-12-03 09:00:00') });
  assert.equal(r2.report.groups.NL.counts[STATUS.INSUFFICIENT], 1, 'na backorder één keer gemeld');
  assert.equal((await loadState(store)).backorderSeen['8'], undefined, 'daarna niet meer gevolgd');
  const r3 = await runCheck({ ...base, client: new FakeClient({ orders: [done] }), store, now: ams('2026-12-04 09:00:00') });
  assert.equal(r3.report.groups.NL.counts[STATUS.INSUFFICIENT], 0, 'niet dubbel geteld');
});

test('zendinggegevens: fout of limiet → wachtrij voor de volgende run, SLA-controle slaagt', async () => {
  const store = new MemoryStore();
  await store.put('state:v1', JSON.stringify({ lastSuccessfulCheck: ams('2026-11-30 09:00:00').toISOString() }));
  const orders = [1, 2, 3].map((i) => order({ idorder: i, country: 'NL', created: '2026-11-30 11:00:00', status: 'completed', picklists: [closedPicklist('2026-11-30 16:00:00', 100 + i)] }));
  const r1 = await runCheck({ ...base, config: { ...config, maxShipmentFetchesPerRun: 2 }, client: new FakeClient({ orders, failOn: 'shipments' }), store, now: ams('2026-12-01 09:00:00') });
  assert.equal(r1.ok, true);
  assert.equal(r1.report.groups.NL.counts[STATUS.ON_TIME], 3);
  assert.ok(r1.report.missingData.some((m) => /Fout bij ophalen zendinggegevens/.test(m)));
  assert.equal((await loadState(store)).pendingShipments.length, 3);
  const shipments = Object.fromEntries([101, 102, 103].map((id) => [id, [{ idshipment: id, provider: 'DHL', carrier_key: 'dhl', created: 'x', cancelled: false, parcels: [{ tracking_code: `T${id}`, tracking_url: null }] }]]));
  const r2 = await runCheck({ ...base, config: { ...config, maxShipmentFetchesPerRun: 2 }, client: new FakeClient({ orders, shipments }), store, now: ams('2026-12-02 09:00:00') });
  assert.equal(r2.parcelLinks.length, 2);
  assert.equal((await loadState(store)).pendingShipments.length, 1);
  const r3 = await runCheck({ ...base, config: { ...config, maxShipmentFetchesPerRun: 2 }, client: new FakeClient({ orders, shipments }), store, now: ams('2026-12-03 09:00:00') });
  assert.equal(r3.parcelLinks.length, 1);
  assert.equal((await loadState(store)).pendingShipments.length, 0);
});

test('Picqer-client houdt minimaal interval tussen verzoeken aan', async () => {
  const { PicqerClient } = await import('../src/picqer.js');
  const waits = [];
  const c = new PicqerClient({ baseUrl: 'https://e/api/v1', apiKey: 'K', userAgent: 'UA', minIntervalMs: 150, sleep: async (ms) => { waits.push(ms); }, fetch: async () => new Response('[]', { status: 200 }) });
  await Promise.all([c.get('/a'), c.get('/b'), c.get('/c')]);
  assert.equal(waits.length, 2);
  assert.ok(waits[1] >= 290);
});
