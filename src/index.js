// Cloudflare Worker: alleen-lezen remote MCP-connector voor de cut-offmonitor.
import slaConfig from '../config/sla.json' with { type: 'json' };
import closingDaysFile from '../config/closing-days.json' with { type: 'json' };
import { handleRpc } from './mcp.js';
import { PicqerClient } from './picqer.js';

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('picqer-cutoff-monitor ok', { status: 200 });
    }

    const m = /^\/mcp\/([^/]+)\/?$/.exec(url.pathname);
    if (!m || !env.MCP_PATH_TOKEN || env.MCP_PATH_TOKEN.length < 32 || !timingSafeEqual(m[1], env.MCP_PATH_TOKEN)) {
      return new Response('Not found', { status: 404 });
    }
    if (request.method === 'GET' || request.method === 'DELETE') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }

    const deps = async () => ({
      client: new PicqerClient({
        baseUrl: env.PICQER_BASE_URL,
        apiKey: env.PICQER_API_KEY,
        userAgent: env.PICQER_USER_AGENT || 'PackFeedCutoffMonitor (picqer-monitor)',
        maxRequests: Number(env.MAX_API_REQUESTS || 400),
      }),
      store: env.STATE,
      config: slaConfig,
      closingDays: closingDaysFile.closingDays ?? [],
      now: new Date(),
    });

    const messages = Array.isArray(body) ? body : [body];
    const responses = (await Promise.all(messages.map((msg) => handleRpc(msg, deps)))).filter(Boolean);
    if (!responses.length) return new Response(null, { status: 202 });
    return json(Array.isArray(body) ? responses : responses[0]);
  },
};
