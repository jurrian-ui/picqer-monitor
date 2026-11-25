// Dagelijkse controle: haalt gegevens op, beoordeelt orders en houdt het controletijdstip bij.
import { evaluateOrder, STATUS, ALL_STATUSES, DENOMINATOR_STATUSES } from './sla.js';
import { formatPicqerDateTime, formatLocal, parsePicqerDateTime } from './time.js';
import { WorkCalendar } from './calendar.js';

const STATE_KEY = 'state:v1';
const GROUPS = ['NL', 'BE', 'OVERIG', 'ONBEKEND'];

export async function loadState(store) {
  const raw = await store.get(STATE_KEY);
  const s = raw ? JSON.parse(raw) : {};
  return {
    lastSuccessfulCheck: s.lastSuccessfulCheck ?? null,
    openOrders: s.openOrders ?? {},
    backorderSeen: s.backorderSeen ?? {},
    lastRun: s.lastRun ?? null,
    pendingShipments: s.pendingShipments ?? [],
  };
}

async function saveState(store, state) {
  await store.put(STATE_KEY, JSON.stringify(state));
}

/**
 * Voer de controle uit.
 * @param {object} p
 * @param {PicqerClient} p.client
 * @param {{get, put}} p.store sleutel-waardeopslag (Cloudflare KV of in-memory)
 * @param {object} p.config sla.json
 * @param {string[]} p.closingDays
 * @param {Date} p.now
 * @param {string} [p.from] ISO-tijdstip; overschrijft het opgeslagen controletijdstip
 * @param {boolean} [p.dryRun] true = niets opslaan (proefrun)
 */
export async function runCheck({ client, store, config, closingDays, now, from, dryRun = false }) {
  const startedAt = Date.now();
  const state = await loadState(store);
  const calendar = new WorkCalendar({ workingDays: config.workingDays, closingDays });
  const tz = config.timezone;
  const picqerTz = config.picqerTimezone?.value ?? tz;

  const periodStartIso = from ?? state.lastSuccessfulCheck;
  if (!periodStartIso) {
    return {
      ok: false,
      error: 'Er is nog geen succesvolle controle en geen startdatum opgegeven. Geef "from" mee (bijv. de gekozen startdatum).',
    };
  }
  const periodStart = new Date(periodStartIso);
  const fetchSince = new Date(periodStart.getTime() - config.lookbackDays * 86400_000);

  try {
    const backorderIds = await client.listBackorderOrderIds();
    const orders = await client.listOrdersSince(formatPicqerDateTime(fetchSince, picqerTz));
    const byId = new Map(orders.map((o) => [String(o.idorder), o]));

    // Eerder gemelde open orders opnieuw ophalen als ze buiten het venster vallen.
    const refetch = Object.keys(state.openOrders).filter((id) => !byId.has(id));
    const refetched = await mapLimit(refetch, 5, (id) => client.getOrder(id));
    refetched.forEach((o, i) => byId.set(refetch[i], o));

    const results = [];
    for (const order of byId.values()) {
      const id = String(order.idorder);
      const open = backorderIds.has(order.idorder) || backorderIds.has(Number(order.idorder)) || backorderIds.has(id);
      const seenBefore = Boolean(state.backorderSeen[id]) && !open;
      results.push(evaluateOrder(order, { config, calendar, now, backorder: { open, seenBefore } }));
    }

    // Indelen: elke order telt één keer, in de run waarin de deadline verstrijkt.
    const inPeriod = [];
    const notDue = [];
    const changes = [];
    const stillOpen = [];
    for (const r of results) {
      const id = String(r.idorder);
      const prev = state.openOrders[id];
      const deadline = r.deadlineUtc ? new Date(r.deadlineUtc) : null;
      const created = parsePicqerDateTime(r.timestamps.created, picqerTz);

      if (prev && prev.reported) {
        if (prev.status !== r.status) changes.push({ ...r, previousStatus: prev.status });
        else stillOpen.push(r);
        continue;
      }
      if (r.rule === 'backorder' && r.status === STATUS.INSUFFICIENT) {
        // Was backorder, nu niet meer: één keer melden als onvoldoende gegevens.
        inPeriod.push(r);
      } else if (deadline) {
        if (deadline > periodStart && deadline <= now) inPeriod.push(r);
        else if (deadline > now) notDue.push(r);
        // Deadline vóór de periode en niet eerder gemeld: al in een eerdere run beoordeeld.
      } else if (created && created > periodStart && created <= now) {
        inPeriod.push(r);
      }
    }

    // Koppeling order - zending - vervoerder - trackingcode (voorbereiding vervoerdersperformance).
    // Werkt met een wachtrij: wat niet binnen deze run past, wordt de volgende run opgehaald.
    // Een fout bij zendinggegevens laat de SLA-controle niet mislukken; de picklijst blijft in de wachtrij.
    const queue = new Map();
    for (const item of state.pendingShipments) queue.set(String(item.idpicklist), item);
    const processed = [...inPeriod, ...changes].filter((r) => r.status === STATUS.ON_TIME || r.status === STATUS.LATE);
    for (const r of processed) {
      for (const p of byId.get(String(r.idorder))?.picklists ?? []) {
        if (p.status === 'cancelled') continue;
        queue.set(String(p.idpicklist), { idorder: r.idorder, orderid: r.orderid, reference: r.reference, idpicklist: p.idpicklist });
      }
    }
    const cap = dryRun ? Math.min(20, config.maxShipmentFetchesPerRun) : config.maxShipmentFetchesPerRun;
    const deadlineMs = startedAt + (config.shipmentTimeBudgetSeconds ?? 35) * 1000;
    const items = [...queue.values()];
    const todo = items.slice(0, cap);
    const parcelLinks = [];
    const done = new Set();
    const shipmentErrors = [];
    await mapLimit(todo, 5, async (item) => {
      if (Date.now() > deadlineMs) return;
      try {
        const shipments = await client.getPicklistShipments(item.idpicklist);
        const active = shipments.filter((s) => !s.cancelled);
        if (!active.length) parcelLinks.push({ ...item, note: 'Geen actieve zending gevonden.' });
        for (const sh of active) {
          for (const parcel of sh.parcels.length ? sh.parcels : [{ tracking_code: null, tracking_url: null }]) {
            parcelLinks.push({
              ...item, idshipment: sh.idshipment,
              carrier: sh.provider, carrier_key: sh.carrier_key,
              tracking_code: parcel.tracking_code, tracking_url: parcel.tracking_url,
              shipment_created: sh.created,
            });
          }
        }
        done.add(String(item.idpicklist));
      } catch (e) {
        shipmentErrors.push(`${item.orderid ?? item.idorder}: ${e.message}`);
      }
    });
    const pendingShipments = items.filter((i) => !done.has(String(i.idpicklist)));
    const missingShipments = pendingShipments.map((i) => i.orderid ?? i.idorder);

    const report = buildReport({
      config, closingDays, tz, now, periodStart, lastSuccessfulCheck: state.lastSuccessfulCheck,
      inPeriod, notDue, changes, stillOpen, missingShipments, shipmentErrors, requestCount: client.requestCount, dryRun,
    });

    if (!dryRun) {
      const openOrders = {};
      for (const r of [...inPeriod, ...changes, ...stillOpen]) {
        if (r.status === STATUS.OPEN_OVERDUE) {
          openOrders[String(r.idorder)] = { status: r.status, orderid: r.orderid, deadline: r.deadline, reported: true };
        }
      }
      const backorderSeen = {};
      const nowDate = now.toISOString().slice(0, 10);
      for (const id of backorderIds) backorderSeen[String(id)] = state.backorderSeen[String(id)] ?? nowDate;
      // Bewaar eerder geziene backorders tot de order is beoordeeld (max. 90 dagen).
      const cutoff = new Date(now.getTime() - 90 * 86400_000).toISOString().slice(0, 10);
      const judged = new Set(inPeriod.map((r) => String(r.idorder)));
      for (const [id, since] of Object.entries(state.backorderSeen)) {
        if (!backorderSeen[id] && !judged.has(id) && since >= cutoff) backorderSeen[id] = since;
      }
      await saveState(store, {
        lastSuccessfulCheck: now.toISOString(),
        openOrders,
        backorderSeen,
        pendingShipments,
        lastRun: { at: now.toISOString(), ok: true },
      });
      for (const link of parcelLinks) {
        await store.put(`parcels:${link.idorder}:${link.idshipment ?? 'none'}:${link.tracking_code ?? ''}`, JSON.stringify(link));
      }
    }

    return { ok: true, report, parcelLinks };
  } catch (e) {
    if (!dryRun) {
      await saveState(store, { ...state, lastRun: { at: now.toISOString(), ok: false, error: e.message } });
    }
    return {
      ok: false,
      error: `Run mislukt: ${e.message}`,
      note: `Het controletijdstip is niet verschoven. De volgende succesvolle run haalt de periode vanaf ${formatLocal(periodStart, tz)} in.`,
      lastSuccessfulCheck: state.lastSuccessfulCheck,
    };
  }
}

function deviation(r) {
  return {
    orderid: r.orderid, reference: r.reference, country: r.country,
    received: r.received ?? r.timestamps.created, deadline: r.deadline ?? null,
    measuredOrStatus: r.measured ? `${r.measured} (geregistreerd in Picqer)` : `Picqer-status: ${r.picqerStatus}`,
    status: r.status, reason: r.reason, rule: r.rule ?? null,
    ...(r.previousStatus ? { previousStatus: r.previousStatus } : {}),
  };
}

export function buildReport({ config, closingDays, tz, now, periodStart, lastSuccessfulCheck, inPeriod, notDue, changes, stillOpen = [], missingShipments, shipmentErrors = [], requestCount, dryRun }) {
  const groups = {};
  for (const g of GROUPS) {
    groups[g] = { counts: Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])), deviations: [] };
  }
  for (const r of [...inPeriod, ...notDue]) {
    const g = groups[r.group ?? 'ONBEKEND'];
    g.counts[r.status]++;
    if ([STATUS.LATE, STATUS.OPEN_OVERDUE, STATUS.INSUFFICIENT].includes(r.status)) g.deviations.push(deviation(r));
  }
  for (const g of Object.values(groups)) {
    const denom = DENOMINATOR_STATUSES.reduce((a, s) => a + g.counts[s], 0);
    g.denominator = denom;
    g.denominatorDefinition = `${DENOMINATOR_STATUSES.join(' + ')}`;
    g.percentOnTime = denom ? Math.round((g.counts[STATUS.ON_TIME] / denom) * 1000) / 10 : null;
  }
  if (!Object.values(groups.ONBEKEND.counts).some(Boolean)) delete groups.ONBEKEND;

  const missingData = [];
  if (!closingDays.length) missingData.push('Er zijn nog geen sluitingsdagen ingesteld; alleen weekenden tellen als niet-werkdag.');
  for (const r of config.rules.filter((x) => !x.confirmed)) missingData.push(`Onbevestigde regel '${r.id}': ${r.text}`);
  if (config.picqerTimezone && !config.picqerTimezone.confirmed) missingData.push(`Tijdzone van Picqer-tijden aangenomen als ${config.picqerTimezone.value} (onbevestigd).`);
  if (missingShipments.length) missingData.push(`Zendinggegevens (vervoerder/tracking) nog niet opgehaald voor ${missingShipments.length} order(s); die volgen in een volgende run.`);
  if (shipmentErrors.length) missingData.push(`Fout bij ophalen zendinggegevens (${shipmentErrors.length}x), blijft in de wachtrij: ${shipmentErrors.slice(0, 5).join('; ')}.`);

  return {
    mode: dryRun ? 'proefrun (niets opgeslagen)' : 'definitieve run',
    period: { from: formatLocal(periodStart, tz), to: formatLocal(now, tz), timezone: tz },
    lastSuccessfulCheckBefore: lastSuccessfulCheck ? formatLocal(new Date(lastSuccessfulCheck), tz) : null,
    countingRule: 'Elke order telt in de run waarin de deadline verstrijkt. "Deadline nog niet verstreken" is een momentopname van nog openstaande orders.',
    groups,
    changesSinceEarlierReports: changes.map(deviation),
    stillOpenFromEarlierReports: stillOpen.map(deviation),
    missingData,
    apiRequests: requestCount,
  };
}

/** Maak een leesbare Markdown-versie van het rapport. */
export function renderMarkdown(result) {
  if (!result.ok) return `**Controle mislukt.** ${result.error}\n\n${result.note ?? ''}`.trim();
  const r = result.report;
  const lines = [];
  lines.push(`# Cut-offcontrole (${r.mode})`);
  lines.push(`Periode: ${r.period.from} t/m ${r.period.to} (${r.period.timezone}). Laatste succesvolle controle hiervoor: ${r.lastSuccessfulCheckBefore ?? 'geen'}.`);
  lines.push('');
  for (const [g, d] of Object.entries(r.groups)) {
    lines.push(`## ${g}`);
    const pct = d.percentOnTime == null ? 'n.v.t.' : `${String(d.percentOnTime).replace('.', ',')}%`;
    lines.push(`Op tijd: ${pct} (noemer ${d.denominator} = ${d.denominatorDefinition}).`);
    lines.push('');
    lines.push('| Status | Aantal |');
    lines.push('|---|---|');
    for (const [s, n] of Object.entries(d.counts)) lines.push(`| ${s} | ${n} |`);
    if (d.deviations.length) {
      lines.push('');
      lines.push('| Order | Referentie | Ontvangen | Deadline | Gemeten / status | Uitkomst | Reden |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const x of d.deviations) {
        lines.push(`| ${x.orderid ?? ''} | ${x.reference ?? ''} | ${x.received ?? ''} | ${x.deadline ?? ''} | ${x.measuredOrStatus} | ${x.status} | ${x.reason} |`);
      }
    }
    lines.push('');
  }
  if (r.changesSinceEarlierReports.length) {
    lines.push('## Wijzigingen bij eerder gemelde open orders');
    for (const x of r.changesSinceEarlierReports) lines.push(`- ${x.orderid} (${x.reference ?? '-'}): ${x.previousStatus} → ${x.status}. ${x.reason}`);
    lines.push('');
  }
  if (r.stillOpenFromEarlierReports.length) {
    lines.push('## Eerder gemeld en nog steeds open');
    for (const x of r.stillOpenFromEarlierReports) lines.push(`- ${x.orderid} (${x.reference ?? '-'}): deadline ${x.deadline}, ${x.measuredOrStatus}.`);
    lines.push('');
  }
  if (r.missingData.length) {
    lines.push('## Ontbrekende of onbevestigde gegevens');
    for (const m of r.missingData) lines.push(`- ${m}`);
  }
  return lines.join('\n');
}

/** Voer fn uit over items met maximaal `limit` tegelijk; behoudt de volgorde van de resultaten. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
