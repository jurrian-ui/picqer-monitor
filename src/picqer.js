// Minimale alleen-lezen client voor de beperkte Picqer Fulfilment API.
// Doet uitsluitend GET-verzoeken.

export class PicqerError extends Error {
  constructor(message, { status, path } = {}) {
    super(message);
    this.name = 'PicqerError';
    this.status = status;
    this.path = path;
  }
}

const ORDER_FIELDS = ['idorder', 'orderid', 'reference', 'status', 'created', 'updated', 'deliverycountry', 'idfulfilment_customer'];
const PICKLIST_FIELDS = ['idpicklist', 'picklistid', 'status', 'created', 'updated', 'closed_at'];

/** Houd alleen velden over die nodig zijn voor de SLA-controle (geen namen of adressen). */
export function minimizeOrder(o) {
  const out = {};
  for (const f of ORDER_FIELDS) out[f] = o[f] ?? null;
  out.picklists = (o.picklists ?? []).map((p) => {
    const q = {};
    for (const f of PICKLIST_FIELDS) q[f] = p[f] ?? null;
    return q;
  });
  return out;
}

/** Verwijder persoonsgegevens (zoals postcode) uit een tracking-URL. */
export function stripTrackingUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(pc|postcode|postal_?code|zip|zipcode|plz|lc|country)$/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function minimizeShipment(s) {
  return {
    idshipment: s.idshipment ?? null,
    idpicklist: s.idpicklist ?? null,
    idorder: s.idorder ?? null,
    provider: s.public_providername ?? s.providername ?? s.provider ?? null,
    carrier_key: s.carrier_key ?? null,
    created: s.created ?? null,
    cancelled: Boolean(s.cancelled),
    parcels: (s.parcels ?? []).map((p) => ({
      tracking_code: p.tracking_code ?? null,
      tracking_url: stripTrackingUrl(p.tracking_url),
    })),
  };
}

/** Houd van een comment alleen de tekst en het tijdstip over (geen auteur). */
export function minimizeComment(c) {
  const body = String(c.body ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return { body: body.length > 300 ? body.slice(0, 297) + '...' : body, created: c.created ?? null };
}

export class PicqerClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl bijv. https://partner.picqer.com/api/v1
   * @param {string} opts.apiKey
   * @param {string} opts.userAgent
   * @param {typeof fetch} [opts.fetch]
   * @param {number} [opts.maxRequests] veiligheidsgrens voor het aantal verzoeken per run
   */
  constructor({ baseUrl, apiKey, userAgent, fetch: fetchImpl, maxRequests = 400, retries = 3, sleep, minIntervalMs = 150 }) {
    if (!baseUrl || !apiKey) throw new PicqerError('Picqer-configuratie ontbreekt (PICQER_BASE_URL of PICQER_API_KEY).');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.auth = 'Basic ' + btoa(`${apiKey}:`);
    this.userAgent = userAgent;
    this.fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.maxRequests = maxRequests;
    this.retries = retries;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.requestCount = 0;
    // Picqer staat ~500 verzoeken per minuut toe; we blijven daar ruim onder.
    this.minIntervalMs = minIntervalMs;
    this.nextSlot = 0;
  }

  async throttle() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await this.sleep(slot - now);
  }

  async get(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      if (this.requestCount >= this.maxRequests) {
        throw new PicqerError(`Maximaal aantal API-verzoeken per run (${this.maxRequests}) bereikt; gegevens onvolledig.`, { path });
      }
      this.requestCount++;
      await this.throttle();
      let res;
      try {
        res = await this.fetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: this.auth, 'User-Agent': this.userAgent, Accept: 'application/json' },
        });
      } catch (e) {
        if (attempt < this.retries) { await this.sleep(1000 * 2 ** attempt); continue; }
        throw new PicqerError(`Netwerkfout bij ${path}: ${e.message}`, { path });
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.retries) { await this.sleep(res.status === 429 ? 5000 : 1000 * 2 ** attempt); continue; }
      }
      if (!res.ok) throw new PicqerError(`Picqer gaf HTTP ${res.status} bij ${path}.`, { status: res.status, path });
      return res.json();
    }
  }

  /** Alle orders aangemaakt vanaf sincedate (Picqer-tijd), met offset-paginering. */
  async listOrdersSince(sincedate, { pageSize = 100, maxPages = 200 } = {}) {
    const all = [];
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.get('/orders', { sincedate, offset: page * pageSize });
      if (!Array.isArray(rows)) throw new PicqerError('Onverwacht antwoord op GET /orders.', { path: '/orders' });
      all.push(...rows.map(minimizeOrder));
      if (rows.length < pageSize) return dedupe(all);
    }
    throw new PicqerError(`Meer dan ${maxPages} pagina's orders; periode te groot.`, { path: '/orders' });
  }

  async getOrder(idorder) {
    return minimizeOrder(await this.get(`/orders/${encodeURIComponent(idorder)}`));
  }

  async findOrder({ orderid, reference }) {
    const rows = await this.get('/orders', orderid ? { orderid } : { reference });
    return (Array.isArray(rows) ? rows : []).map(minimizeOrder);
  }

  /** Alle huidige backorders; geeft de set idorder terug. */
  async listBackorderOrderIds({ pageSize = 100, maxPages = 100 } = {}) {
    const ids = new Set();
    for (let page = 0; page < maxPages; page++) {
      const rows = await this.get('/backorders', { offset: page * pageSize });
      if (!Array.isArray(rows)) throw new PicqerError('Onverwacht antwoord op GET /backorders.', { path: '/backorders' });
      for (const r of rows) if (r.idorder != null) ids.add(r.idorder);
      if (rows.length < pageSize) return ids;
    }
    throw new PicqerError('Te veel backorders om op te halen.', { path: '/backorders' });
  }

  /** Comments bij een order (alleen tekst en tijdstip), oudste eerst. */
  async getOrderComments(idorder) {
    const rows = await this.get(`/orders/${encodeURIComponent(idorder)}/comments`);
    return (Array.isArray(rows) ? rows : [])
      .map(minimizeComment)
      .filter((c) => c.body)
      .sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? '')));
  }

  async getPicklistShipments(idpicklist) {
    const rows = await this.get(`/picklists/${encodeURIComponent(idpicklist)}/shipments`);
    return (Array.isArray(rows) ? rows : []).map(minimizeShipment);
  }
}

function dedupe(orders) {
  const seen = new Map();
  for (const o of orders) seen.set(o.idorder, o);
  return [...seen.values()];
}
