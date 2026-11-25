import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const TOKEN = 'x'.repeat(40);
const env = { MCP_PATH_TOKEN: TOKEN, PICQER_BASE_URL: 'https://example.picqer.com/api/v1', PICQER_API_KEY: 'test', STATE: { get: async () => null, put: async () => {} } };
const post = (path, body) => worker.fetch(new Request(`https://w.example${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env);

test('zonder geldig token: 404', async () => {
  assert.equal((await post('/mcp/wrong', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
  assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404);
});

test('initialize en tools/list', async () => {
  const init = await (await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  const notif = await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notif.status, 202);
  const list = await (await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ['get_monitor_status', 'inspect_order', 'list_open_without_comments', 'run_cutoff_check', 'sample_orders']);
});

test('get_monitor_status werkt zonder Picqer-verzoek', async () => {
  const res = await (await post(`/mcp/${TOKEN}`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_monitor_status', arguments: {} } })).json();
  const body = JSON.parse(res.result.content[0].text);
  assert.equal(body.lastSuccessfulCheck, null);
  assert.equal(body.cutoffs.BE, '22:59');
});

test('Picqer-client doet alleen GET met Basic-auth en User-Agent', async () => {
  const { PicqerClient } = await import('../src/picqer.js');
  const calls = [];
  const c = new PicqerClient({ baseUrl: 'https://example.picqer.com/api/v1/', apiKey: 'KEY', userAgent: 'UA', fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(calls.length === 1 ? Array(100).fill({ idorder: 1, firstname: 'X', deliveryname: 'Geheim' }) : [{ idorder: 2 }]), { status: 200 }); } });
  const orders = await c.listOrdersSince('2026-11-01 00:00:00');
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /offset=100/);
  assert.ok(calls.every((x) => x.init.method === 'GET'));
  assert.equal(calls[0].init.headers.Authorization, 'Basic ' + btoa('KEY:'));
  assert.equal(calls[0].init.headers['User-Agent'], 'UA');
  assert.equal(orders.length, 2);
  assert.equal(orders[0].deliveryname, undefined, 'persoonsgegevens worden weggelaten');
});

test('Picqer-client: herhaalt bij 429 en geeft fout bij blijvende 500', async () => {
  const { PicqerClient } = await import('../src/picqer.js');
  let n = 0;
  const c = new PicqerClient({ baseUrl: 'https://e/api/v1', apiKey: 'K', userAgent: 'UA', sleep: async () => {}, fetch: async () => { n++; return n === 1 ? new Response('', { status: 429 }) : new Response('[]', { status: 200 }); } });
  assert.deepEqual(await c.get('/orders'), []);
  const c2 = new PicqerClient({ baseUrl: 'https://e/api/v1', apiKey: 'K', userAgent: 'UA', sleep: async () => {}, fetch: async () => new Response('', { status: 500 }) });
  await assert.rejects(c2.get('/orders'), /HTTP 500/);
});

test('tracking-URL zonder postcode', async () => {
  const { stripTrackingUrl } = await import('../src/picqer.js');
  assert.equal(stripTrackingUrl('https://www.dhlparcel.nl/nl/volg-uw-zending-0?tt=JV123&pc=1234%20AB&lc=NL'), 'https://www.dhlparcel.nl/nl/volg-uw-zending-0?tt=JV123');
  assert.equal(stripTrackingUrl(null), null);
});
