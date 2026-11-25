// Comments uit Picqer bij een order: op de order zelf en op elke niet-geannuleerde picklijst.
import { mapLimit } from './util.js';

/**
 * Haal alle comments op voor één order. Gooit een fout als één van de verzoeken mislukt,
 * zodat een order nooit onterecht als "zonder comment" wordt gezien.
 * @returns {Promise<Array<{where: string, body: string, created: string|null, author?: string|null}>>}
 */
export async function fetchOrderAndPicklistComments(client, order, { withAuthor = false } = {}) {
  const out = [];
  for (const c of await client.getOrderComments(order.idorder, { withAuthor })) out.push({ where: 'Order', ...c });
  for (const p of activePicklists(order)) {
    for (const c of await client.getPicklistComments(p.idpicklist, { withAuthor })) {
      out.push({ where: `Picklijst ${p.picklistid ?? p.idpicklist}`, ...c });
    }
  }
  return out;
}

export function activePicklists(order) {
  return (order.picklists ?? []).filter((p) => p.status !== 'cancelled');
}

/**
 * Vul r.comments voor een lijst beoordeelde orders.
 * - `always`: altijd ophalen (open na deadline), ongeacht tijd- of aantalgrens.
 * - `optional`: alleen zolang de grens niet bereikt is.
 * Resultaat per order: array (leeg = geen comments) of null (niet opgehaald).
 */
export async function attachComments({ client, orders, always, optional, cap, deadlineMs }) {
  const errors = [];
  const skipped = [];
  const run = async (r) => {
    try {
      r.comments = await fetchOrderAndPicklistComments(client, orders.get(String(r.idorder)) ?? { idorder: r.idorder });
    } catch (e) {
      r.comments = null;
      errors.push(`${r.orderid ?? r.idorder}: ${e.message}`);
    }
  };
  await mapLimit(always, 5, run);
  let used = always.length;
  await mapLimit(optional, 5, async (r) => {
    if (used >= cap || Date.now() > deadlineMs) {
      r.comments = null;
      skipped.push(r.orderid ?? r.idorder);
      return;
    }
    used++;
    await run(r);
  });
  return { errors, skipped };
}

/** Comments als één tabelcel. Leeg als er geen comments zijn; "(niet opgehaald)" als ophalen niet lukte. */
export function formatComments(comments) {
  if (comments === undefined) return '';
  if (comments === null) return '(niet opgehaald)';
  return comments.map((c) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(c.created ?? '');
    const when = m ? ` (geplaatst ${m[3]}-${m[2]} ${m[4]}:${m[5]})` : '';
    return `${c.where ? c.where + ': ' : ''}${c.body.replace(/\|/g, '/')}${when}`;
  }).join(' / ');
}
