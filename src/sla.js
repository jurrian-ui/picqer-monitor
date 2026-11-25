// Vaste rekenregels voor de cut-offbelofte per order.
import { localParts, zonedToUtc, parsePicqerDateTime, formatLocal } from './time.js';

export const STATUS = Object.freeze({
  ON_TIME: 'op tijd',
  LATE: 'te laat verwerkt',
  OPEN_OVERDUE: 'nog open na deadline',
  NOT_DUE: 'deadline nog niet verstreken',
  INSUFFICIENT: 'onvoldoende gegevens',
  OUT_OF_SCOPE: 'buiten scope',
});

export const ALL_STATUSES = Object.values(STATUS);

/** Statussen die meetellen in de noemer van "percentage op tijd". */
export const DENOMINATOR_STATUSES = [STATUS.ON_TIME, STATUS.LATE, STATUS.OPEN_OVERDUE];

export function countryGroup(country) {
  const c = String(country ?? '').trim().toUpperCase();
  if (!c) return null;
  if (c === 'NL') return 'NL';
  if (c === 'BE') return 'BE';
  return 'OVERIG';
}

function parseHm(hm) {
  const [h, m, s] = hm.split(':').map(Number);
  return { hour: h, minute: m, second: s ?? 0 };
}

/**
 * Bereken cut-off en deadline voor een ontvangstmoment.
 * @returns {{ receivedLocal, cutoffDay, cutoff, beforeCutoff, deadlineDay, deadline, rule }}
 */
export function computeDeadline(received, group, config, calendar) {
  const tz = config.timezone;
  const lp = localParts(received, tz);
  const cut = parseHm(config.cutoffs[group]);
  const cutoffEnd = config.cutoffMinuteInclusive
    ? { hour: cut.hour, minute: cut.minute, second: 59, ms: 999 }
    : { hour: cut.hour, minute: cut.minute, second: 0, ms: 0 };
  const dl = parseHm(config.deadlineTime);

  let deadlineDay;
  let rule;
  let beforeCutoff;
  let cutoffDay;

  if (calendar.isWorkingDay(lp.date)) {
    const cutoffMoment = zonedToUtc({ year: lp.year, month: lp.month, day: lp.day, ...cutoffEnd }, tz);
    beforeCutoff = config.cutoffMinuteInclusive
      ? received.getTime() <= cutoffMoment.getTime()
      : received.getTime() < cutoffMoment.getTime();
    if (beforeCutoff) {
      cutoffDay = lp.date;
      deadlineDay = lp.date;
      rule = 'voor-cutoff';
    } else {
      cutoffDay = calendar.nextWorkingDayAfter(lp.date);
      deadlineDay = cutoffDay;
      rule = 'na-cutoff';
    }
  } else {
    beforeCutoff = true;
    cutoffDay = calendar.firstWorkingDayOnOrAfter(lp.date);
    deadlineDay = cutoffDay;
    rule = 'weekend-sluiting';
  }

  const [y, m, d] = deadlineDay.split('-').map(Number);
  const deadline = zonedToUtc({ year: y, month: m, day: d, ...dl, ms: 999 }, tz);
  const [cy, cm, cd] = cutoffDay.split('-').map(Number);
  const cutoff = zonedToUtc({ year: cy, month: cm, day: cd, ...cutoffEnd }, tz);

  return { cutoffDay, cutoff, beforeCutoff, deadlineDay, deadline, rule };
}

/**
 * Bepaal het moment waarop de order 'verwerkt' is volgens Picqer-gegevens.
 * Geen deelzendingen: de order is pas verwerkt als alle niet-geannuleerde picklijsten gesloten zijn.
 */
export function measureProcessed(order, picqerTz) {
  const picklists = (order.picklists ?? []).filter((p) => p.status !== 'cancelled');
  const orderDone = order.status === 'completed' || order.status === 'complete';
  if (!orderDone) return { processed: false };
  if (!picklists.length) {
    return { processed: true, at: null, missing: 'Order is afgerond maar heeft geen (niet-geannuleerde) picklijst.' };
  }
  const notClosed = picklists.filter((p) => p.status !== 'closed');
  if (notClosed.length) {
    return { processed: true, at: null, missing: `Order is afgerond maar picklijst ${notClosed.map((p) => p.picklistid ?? p.idpicklist).join(', ')} is niet gesloten.` };
  }
  const times = picklists.map((p) => parsePicqerDateTime(p.closed_at, picqerTz));
  if (times.some((t) => !t)) {
    return { processed: true, at: null, missing: 'Order is afgerond maar closed_at ontbreekt bij een picklijst.' };
  }
  const at = new Date(Math.max(...times.map((t) => t.getTime())));
  return { processed: true, at, source: 'picklist.closed_at (laatste picklijst)' };
}

/**
 * Beoordeel één order. Pure functie: dezelfde invoer geeft altijd dezelfde uitkomst.
 * @param order minimale Picqer-order (idorder, orderid, reference, status, created, deliverycountry, picklists)
 * @param ctx { config, calendar, now: Date, backorder: { open: boolean, seenBefore: boolean } }
 */
export function evaluateOrder(order, ctx) {
  const { config, calendar, now } = ctx;
  const tz = config.timezone;
  const picqerTz = config.picqerTimezone?.value ?? tz;
  const backorder = ctx.backorder ?? { open: false, seenBefore: false };

  const base = {
    idorder: order.idorder,
    orderid: order.orderid ?? null,
    reference: order.reference ?? null,
    country: order.deliverycountry ? String(order.deliverycountry).toUpperCase() : null,
    group: countryGroup(order.deliverycountry),
    picqerStatus: order.status ?? null,
    timestamps: {
      created: order.created ?? null,
      picklists: (order.picklists ?? []).map((p) => ({
        picklistid: p.picklistid ?? null,
        status: p.status ?? null,
        created: p.created ?? null,
        closed_at: p.closed_at ?? null,
      })),
    },
    timezoneAssumed: picqerTz,
  };
  const result = (status, reason, extra = {}) => ({ ...base, status, reason, ...extra });

  if (order.status === 'cancelled') return result(STATUS.OUT_OF_SCOPE, 'Order is geannuleerd.', { rule: 'annulering' });
  if (order.status === 'concept') return result(STATUS.OUT_OF_SCOPE, 'Conceptorder, nog niet ingediend.', { rule: 'concept' });
  if (backorder.open && order.status !== 'completed' && order.status !== 'complete') {
    return result(STATUS.OUT_OF_SCOPE, 'Order wacht op voorraad (backorder); de klok is nog niet gestart.', { rule: 'backorder' });
  }
  if (order.status === 'expected') {
    return result(STATUS.OUT_OF_SCOPE, "Picqer-status 'expected': order is nog niet vrijgegeven voor verwerking (te bevestigen in steekproef).", { rule: 'expected' });
  }
  if (backorder.seenBefore) {
    return result(STATUS.INSUFFICIENT, 'Order stond in backorder; het moment waarop de voorraad binnenkwam is niet zichtbaar in de API.', { rule: 'backorder' });
  }
  if (!base.group) return result(STATUS.INSUFFICIENT, 'Bestemmingsland ontbreekt.');
  const received = parsePicqerDateTime(order.created, picqerTz);
  if (!received) return result(STATUS.INSUFFICIENT, 'Ontvangstmoment (created) ontbreekt of is onleesbaar.');

  const dl = computeDeadline(received, base.group, config, calendar);
  const window = {
    rule: dl.rule,
    received: formatLocal(received, tz),
    cutoffApplied: `${config.cutoffs[base.group]} op ${dl.cutoffDay}`,
    receivedBeforeCutoff: dl.beforeCutoff,
    deadline: formatLocal(dl.deadline, tz),
    deadlineUtc: dl.deadline.toISOString(),
  };

  const m = measureProcessed(order, picqerTz);
  if (m.processed && !m.at) return result(STATUS.INSUFFICIENT, m.missing, window);
  if (m.processed) {
    const measured = { measured: formatLocal(m.at, tz), measuredUtc: m.at.toISOString(), measuredSource: m.source, measuredLabel: 'geregistreerd in Picqer' };
    if (m.at.getTime() <= dl.deadline.getTime()) {
      return result(STATUS.ON_TIME, `Verwerkt op ${measured.measured}, vóór deadline ${window.deadline}.`, { ...window, ...measured });
    }
    return result(STATUS.LATE, `Verwerkt op ${measured.measured}, na deadline ${window.deadline}.`, { ...window, ...measured });
  }
  if (now.getTime() > dl.deadline.getTime()) {
    return result(STATUS.OPEN_OVERDUE, `Nog niet verwerkt (Picqer-status '${order.status}'), deadline ${window.deadline} is verstreken.`, window);
  }
  return result(STATUS.NOT_DUE, `Nog niet verwerkt, deadline ${window.deadline} nog niet verstreken.`, window);
}
