// Lijst: orders die open staan na de deadline, geen backorder, en zonder comment op order of picklijst.
import { evaluateOrder, STATUS } from './sla.js';
import { WorkCalendar } from './calendar.js';
import { formatPicqerDateTime, parsePicqerDateTime } from './time.js';
import { attachComments, activePicklists } from './comments.js';

const DAY = 86400_000;

export async function listOpenWithoutComments({ client, config, closingDays, now, from, to }) {
  const startedAt = Date.now();
  const calendar = new WorkCalendar({ workingDays: config.workingDays, closingDays });
  const picqerTz = config.picqerTimezone?.value ?? config.timezone;
  const fromDate = from ? new Date(from) : new Date(now.getTime() - 7 * DAY);
  let toDate = to ? new Date(to) : now;
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { ok: false, error: 'Ongeldige datum bij "from" of "to". Gebruik bijv. 2026-11-23T00:00:00+01:00.' };
  }
  if (toDate > now) toDate = now;

  const backorderIds = await client.listBackorderOrderIds();
  const orders = await client.listOrdersSince(formatPicqerDateTime(new Date(fromDate.getTime() - config.lookbackDays * DAY), picqerTz));
  const byId = new Map(orders.map((o) => [String(o.idorder), o]));

  const candidates = [];
  for (const o of orders) {
    const open = backorderIds.has(o.idorder) || backorderIds.has(Number(o.idorder)) || backorderIds.has(String(o.idorder));
    const r = evaluateOrder(o, { config, calendar, now, backorder: { open, seenBefore: false } });
    if (r.status !== STATUS.OPEN_OVERDUE) continue;
    const deadline = new Date(r.deadlineUtc);
    if (deadline < fromDate || deadline > toDate) continue;
    candidates.push(r);
  }
  candidates.sort((a, b) => a.deadlineUtc.localeCompare(b.deadlineUtc));

  // Oudste deadlines eerst; wat niet binnen de tijd past, staat apart als "niet gecontroleerd".
  const cap = config.maxOpenListOrders ?? 300;
  const { errors } = await attachComments({
    client, orders: byId, always: [], optional: candidates,
    cap, deadlineMs: startedAt + (config.openListTimeBudgetSeconds ?? 45) * 1000,
  });

  const rows = [];
  const unknown = [];
  let withComments = 0;
  for (const r of candidates) {
    if (r.comments === null) { unknown.push(row(r, byId, now, picqerTz)); continue; }
    if (r.comments.length) { withComments++; continue; }
    rows.push(row(r, byId, now, picqerTz));
  }
  return {
    ok: true,
    period: { from: fromDate.toISOString(), to: toDate.toISOString() },
    openPastDeadline: candidates.length,
    withComments,
    withoutComments: rows.length,
    commentsUnknown: unknown.length,
    errors: errors.slice(0, 5),
    rows,
    unknown,
  };
}

function row(r, byId, now, picqerTz) {
  const order = byId.get(String(r.idorder)) ?? { picklists: [] };
  const received = parsePicqerDateTime(order.created, picqerTz);
  const picklists = activePicklists(order);
  const flags = new Set();
  for (const p of picklists) {
    if (p.status === 'paused') flags.add('picklijst gepauzeerd');
    if (p.status === 'snoozed') flags.add('picklijst gesnoozed');
    const created = parsePicqerDateTime(p.created, picqerTz);
    if (received && created && created.getTime() - received.getTime() > DAY) {
      flags.add('picklijst >24 uur na order aangemaakt (mogelijk ex-backorder)');
    }
  }
  if (!picklists.length) flags.add('geen picklijst');
  return {
    orderid: r.orderid, reference: r.reference, country: r.country,
    received: r.received, deadline: r.deadline,
    daysLate: Math.round(((now.getTime() - new Date(r.deadlineUtc).getTime()) / DAY) * 10) / 10,
    picklists: picklists.map((p) => p.picklistid ?? p.idpicklist),
    picklistStatus: picklists.map((p) => p.status),
    flags: [...flags],
  };
}

export function renderOpenList(res, tz) {
  if (!res.ok) return `**Lijst mislukt.** ${res.error}`;
  const fmt = (iso) => new Date(iso).toLocaleString('nl-NL', { timeZone: tz });
  const lines = [];
  lines.push('# Open na deadline, zonder comment');
  lines.push(`Deadlines van ${fmt(res.period.from)} t/m ${fmt(res.period.to)}. Alleen-lezen; niets opgeslagen.`);
  lines.push(`Open na deadline (geen backorder): ${res.openPastDeadline}. Met comment: ${res.withComments}. Zonder comment: ${res.withoutComments}. Comments niet opgehaald: ${res.commentsUnknown}.`);
  lines.push('');
  const table = (rows) => {
    lines.push('| Order | Referentie | Land | Ontvangen | Deadline | Dagen te laat | Picklijst(en) | Status picklijst | Vlaggen |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const x of rows) {
      lines.push(`| ${x.orderid ?? ''} | ${x.reference ?? ''} | ${x.country ?? ''} | ${x.received ?? ''} | ${x.deadline ?? ''} | ${String(x.daysLate).replace('.', ',')} | ${x.picklists.join(', ')} | ${x.picklistStatus.join(', ')} | ${x.flags.join('; ')} |`);
    }
  };
  if (res.rows.length) table(res.rows); else lines.push('Geen orders zonder comment gevonden.');
  if (res.unknown.length) {
    lines.push('');
    lines.push('## Comments niet opgehaald (onbekend of er een comment is)');
    table(res.unknown);
    if (res.errors.length) lines.push(`\nFouten: ${res.errors.join('; ')}`);
  }
  return lines.join('\n');
}
