// Tijdzone-hulpjes zonder externe bibliotheken (werkt in Cloudflare Workers en Node).

const dtfCache = new Map();
function dtf(timeZone) {
  if (!dtfCache.has(timeZone)) {
    dtfCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        weekday: 'short',
      }),
    );
  }
  return dtfCache.get(timeZone);
}

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Lokale onderdelen van een UTC-moment in de gegeven tijdzone. */
export function localParts(date, timeZone) {
  const parts = {};
  for (const p of dtf(timeZone).formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    isoWeekday: WEEKDAYS[parts.weekday],
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function offsetMs(utcMs, timeZone) {
  const p = localParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Zet een lokale wandkloktijd om naar een UTC Date.
 * Bij de dubbele uur bij overgang naar wintertijd kiezen we het eerste (zomertijd) moment.
 * Een niet-bestaande tijd (gat bij zomertijd) schuift een uur door.
 */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0, second = 0, ms = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const candidates = [];
  for (const shift of [-3, -2, -1, 0, 1, 2, 3]) {
    const off = offsetMs(guess + shift * 3600_000, timeZone);
    const utc = guess - off;
    const back = localParts(new Date(utc), timeZone);
    if (back.year === year && back.month === month && back.day === day &&
        back.hour === hour && back.minute === minute && back.second === second) {
      candidates.push(utc);
    }
  }
  if (candidates.length) return new Date(Math.min(...candidates));
  // Gat bij zomertijd: gebruik offset van vóór de overgang.
  return new Date(guess - offsetMs(guess - 6 * 3600_000, timeZone));
}

/** Parse Picqer-tijd "YYYY-MM-DD HH:MM:SS" (zonder zone) als lokale tijd in timeZone. */
export function parsePicqerDateTime(value, timeZone) {
  if (value == null || value === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value));
  if (!m) return null;
  return zonedToUtc({
    year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: +(m[6] ?? 0),
  }, timeZone);
}

/** Format een UTC-moment voor Picqer-filters ("YYYY-MM-DD HH:MM:SS" in timeZone). */
export function formatPicqerDateTime(date, timeZone) {
  const p = localParts(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.date} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Leesbare lokale tijd voor rapportage, bijv. "2026-11-25 07:32:10 (Europe/Amsterdam)". */
export function formatLocal(date, timeZone) {
  if (!date) return null;
  return formatPicqerDateTime(date, timeZone);
}

/** Tel n kalenderdagen op bij een datum "YYYY-MM-DD". */
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** ISO-weekdag (1=ma..7=zo) van "YYYY-MM-DD". */
export function isoWeekday(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}
