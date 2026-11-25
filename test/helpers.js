import slaConfig from '../config/sla.json' with { type: 'json' };
import { WorkCalendar } from '../src/calendar.js';

export const config = slaConfig;
export const calendar = (closingDays = []) => new WorkCalendar({ workingDays: config.workingDays, closingDays });

/** Amsterdamse wandklok → Date (alleen voor tests in november/december: UTC+1). */
export const ams = (s) => new Date(s.replace(' ', 'T') + '+01:00');

export function order({ idorder = 1, country = 'NL', created, status = 'processing', picklists = [] }) {
  return { idorder, orderid: `O${idorder}`, reference: `REF-${idorder}`, status, created, deliverycountry: country, picklists };
}
export const closedPicklist = (closed_at, id = 10) => ({ idpicklist: id, picklistid: `P${id}`, status: 'closed', created: null, closed_at });
export const openPicklist = (id = 11) => ({ idpicklist: id, picklistid: `P${id}`, status: 'new', created: null, closed_at: null });

export class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
}

/** Nep-Picqer-client met vaste gegevens. */
export class FakeClient {
  constructor({ orders = [], backorders = [], shipments = {}, comments = {}, failOn = null } = {}) {
    this.comments = comments;
    this.orders = orders; this.backorders = backorders; this.shipments = shipments; this.failOn = failOn;
    this.requestCount = 0;
  }
  async listBackorderOrderIds() { this.requestCount++; if (this.failOn === 'backorders') throw new Error('HTTP 500'); return new Set(this.backorders); }
  async listOrdersSince() { this.requestCount++; if (this.failOn === 'orders') throw new Error('HTTP 503 bij /orders'); return this.orders; }
  async getOrder(id) { this.requestCount++; return this.orders.find((o) => String(o.idorder) === String(id)); }
  async getOrderComments(id) { this.requestCount++; if (this.failOn === 'comments') throw new Error('HTTP 404'); return this.comments[id] ?? []; }
  async getPicklistShipments(id) { this.requestCount++; if (this.failOn === 'shipments') throw new Error('HTTP 500'); return this.shipments[id] ?? []; }
}
