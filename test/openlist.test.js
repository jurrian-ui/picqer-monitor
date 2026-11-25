import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOpenWithoutComments, renderOpenList } from '../src/openlist.js';
import { config, ams, order, openPicklist, closedPicklist, FakeClient } from './helpers.js';

const pl = (id, status, created) => ({ ...openPicklist(id), status, created });

test('lijst: alleen open na deadline, geen backorder, zonder comment; vlaggen en sortering', async () => {
  const client = new FakeClient({
    orders: [
      order({ idorder: 1, country: 'NL', created: '2026-11-24 10:00:00', status: 'processing', picklists: [pl(101, 'new', '2026-11-24 10:00:05')] }),
      order({ idorder: 2, country: 'NL', created: '2026-11-23 10:00:00', status: 'processing', picklists: [pl(102, 'paused', '2026-11-23 10:00:05')] }),
      order({ idorder: 3, country: 'NL', created: '2026-11-23 11:00:00', status: 'processing', picklists: [pl(103, 'new', '2026-11-26 09:00:00')] }),
      order({ idorder: 4, country: 'NL', created: '2026-11-23 12:00:00', status: 'processing', picklists: [pl(104, 'new', null)] }), // order-comment
      order({ idorder: 5, country: 'NL', created: '2026-11-23 13:00:00', status: 'processing', picklists: [pl(105, 'paused', null)] }), // picklijst-comment
      order({ idorder: 6, country: 'NL', created: '2026-11-23 14:00:00', status: 'processing', picklists: [pl(106, 'new', null)] }), // backorder
      order({ idorder: 7, country: 'NL', created: '2026-11-23 15:00:00', status: 'completed', picklists: [closedPicklist('2026-11-25 10:00:00', 107)] }), // verwerkt
    ],
    backorders: [6],
    comments: { 4: [{ body: 'straatnaam mist', created: '2026-11-23 12:30:00' }] },
    picklistComments: { 105: [{ body: 'wacht op klant', created: '2026-11-24 08:00:00' }] },
  });
  const res = await listOpenWithoutComments({ client, config, closingDays: [], now: ams('2026-11-27 09:00:00'), from: ams('2026-11-20 00:00:00').toISOString() });
  assert.equal(res.ok, true);
  assert.deepEqual(res.rows.map((r) => r.orderid), ['O2', 'O3', 'O1']);
  assert.equal(res.withComments, 2);
  assert.ok(res.rows[0].flags.includes('picklijst gepauzeerd'));
  assert.ok(res.rows[1].flags.some((f) => f.startsWith('picklijst >24 uur')));
  assert.deepEqual(res.rows[2].flags, []);
  assert.equal(res.rows[0].daysLate, 3.3);
  assert.match(renderOpenList(res, config.timezone), /\| O2 \| REF-2 \| NL \|/);
});

test('lijst: mislukte comments nooit als "zonder comment"', async () => {
  const client = new FakeClient({ failOn: 'comments', orders: [
    order({ idorder: 1, country: 'NL', created: '2026-11-24 10:00:00', status: 'processing', picklists: [pl(101, 'new', null)] }),
  ] });
  const res = await listOpenWithoutComments({ client, config, closingDays: [], now: ams('2026-11-27 09:00:00') });
  assert.equal(res.rows.length, 0);
  assert.equal(res.unknown.length, 1);
  assert.match(renderOpenList(res, config.timezone), /Comments niet opgehaald/);
});
