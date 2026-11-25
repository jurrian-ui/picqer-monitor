// Minimale MCP-server (Streamable HTTP, stateless, JSON-antwoorden) zonder externe afhankelijkheden.
import { runCheck, renderMarkdown, loadState } from './check.js';
import { evaluateOrder } from './sla.js';
import { WorkCalendar } from './calendar.js';
import { formatPicqerDateTime } from './time.js';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const TOOLS = [
  {
    name: 'run_cutoff_check',
    description: 'Voer de cut-offcontrole uit over alle deadlines die sinds de laatste succesvolle controle zijn verstreken. Standaard een proefrun (dry_run=true) die niets opslaat. De dagelijkse taak gebruikt dry_run=false; dan wordt het controletijdstip bijgewerkt. Leest alleen uit Picqer.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: { type: 'boolean', description: 'true = proefrun zonder opslaan (standaard). false = definitieve run.' },
        from: { type: 'string', description: 'Optioneel startmoment (ISO 8601, bijv. 2026-12-01T00:00:00+01:00). Alleen nodig bij de eerste run of om een periode opnieuw te beoordelen.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Cut-offcontrole uitvoeren', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'inspect_order',
    description: 'Toon voor één order (Picqer-ordernummer of referentie) de gebruikte tijdstempels, de berekende deadline, de uitkomst en de zendingen (vervoerder, trackingcode). Bedoeld om tijdstempels te valideren met een bekende voorbeeldorder.',
    inputSchema: {
      type: 'object',
      properties: {
        orderid: { type: 'string', description: 'Picqer-ordernummer (orderid).' },
        reference: { type: 'string', description: 'Orderreferentie.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Order bekijken', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'sample_orders',
    description: 'Kleine steekproef: haal orders op die sinds een datum zijn aangemaakt en toon per order de minimale velden en de beoordeling. Slaat niets op.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Datum/tijd in Picqer-formaat "YYYY-MM-DD HH:MM:SS" of "YYYY-MM-DD". Standaard: 2 dagen geleden.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximaal aantal orders in het antwoord (standaard 10).' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Steekproef orders', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'get_monitor_status',
    description: 'Toon het laatste succesvolle controletijdstip, de laatste run, eerder gemelde open orders, de ingestelde sluitingsdagen en de SLA-regels (met bevestigd/onbevestigd).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Status monitor', readOnlyHint: true, openWorldHint: false },
  },
];

function text(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] };
}

export async function callTool(name, args, deps) {
  const { client, store, config, closingDays, now } = deps;
  const calendar = new WorkCalendar({ workingDays: config.workingDays, closingDays });
  const picqerTz = config.picqerTimezone?.value ?? config.timezone;

  switch (name) {
    case 'run_cutoff_check': {
      const result = await runCheck({ client, store, config, closingDays, now, from: args.from, dryRun: args.dry_run !== false });
      return { ...text(renderMarkdown(result) + '\n\n---\nVolledige gegevens (JSON):\n' + JSON.stringify(result, null, 2)), isError: !result.ok };
    }
    case 'inspect_order': {
      if (!args.orderid && !args.reference) return { ...text('Geef orderid of reference op.'), isError: true };
      const orders = await client.findOrder(args);
      if (!orders.length) return text('Geen order gevonden.');
      const backorders = await client.listBackorderOrderIds();
      const state = await loadState(store);
      const out = [];
      for (const o of orders.slice(0, 5)) {
        const open = backorders.has(o.idorder);
        const evaluation = evaluateOrder(o, { config, calendar, now, backorder: { open, seenBefore: Boolean(state.backorderSeen[String(o.idorder)]) && !open } });
        const shipments = [];
        for (const p of o.picklists) shipments.push(...await client.getPicklistShipments(p.idpicklist));
        out.push({ rawTimestamps: { order_created: o.created, order_updated: o.updated, picklists: o.picklists }, evaluation, shipments });
      }
      return text(out);
    }
    case 'sample_orders': {
      const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
      let since = args.since;
      if (!since) since = formatPicqerDateTime(new Date(now.getTime() - 2 * 86400_000), picqerTz);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) since += ' 00:00:00';
      const rows = await client.get('/orders', { sincedate: since });
      const { minimizeOrder } = await import('./picqer.js');
      const orders = (Array.isArray(rows) ? rows : []).slice(0, limit).map(minimizeOrder);
      const out = orders.map((o) => ({ order: o, evaluation: evaluateOrder(o, { config, calendar, now }) }));
      return text({ since, returned: out.length, note: 'Backorderstatus is in de steekproef niet meegenomen.', orders: out });
    }
    case 'get_monitor_status': {
      const state = await loadState(store);
      return text({
        lastSuccessfulCheck: state.lastSuccessfulCheck,
        lastRun: state.lastRun,
        openOrdersFromEarlierReports: state.openOrders,
        backordersBeingTracked: Object.keys(state.backorderSeen).length,
        closingDays,
        cutoffs: config.cutoffs,
        timezone: config.timezone,
        picqerTimezone: config.picqerTimezone,
        rules: config.rules,
      });
    }
    default:
      throw Object.assign(new Error(`Onbekende tool: ${name}`), { code: -32602 });
  }
}

/** Verwerk één JSON-RPC-bericht. Geeft null terug voor notificaties. */
export async function handleRpc(msg, deps) {
  const { id, method, params } = msg ?? {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'Invalid Request');
  if (isNotification) return null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return ok({
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'picqer-cutoff-monitor', version: '0.1.0' },
          instructions: 'Alleen-lezen cut-offmonitor voor de Picqer Fulfilment API. Gebruik run_cutoff_check voor de dagelijkse controle.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        if (!TOOLS.some((t) => t.name === name)) return err(-32602, `Onbekende tool: ${name}`);
        try {
          return ok(await callTool(name, params?.arguments ?? {}, await deps()));
        } catch (e) {
          return ok({ ...text(`Fout: ${e.message}`), isError: true });
        }
      }
      default:
        return err(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return err(-32603, e.message);
  }
}
