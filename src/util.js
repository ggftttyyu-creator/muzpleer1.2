// Общие утилиты: кэш, fetch с таймаутом, прокси, ответы.

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** Простой TTL-кэш в памяти. */
export class TTLCache {
  constructor(ttlMs = 300_000, max = 500) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.exp) {
      this.map.delete(key);
      return undefined;
    }
    // продлеваем «свежесть» в порядке LRU
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  set(key, value, ttl = this.ttl) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + ttl });
    return value;
  }
  async wrap(key, fn, ttl) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    if (value !== undefined) this.set(key, value, ttl);
    return value;
  }
}

export const cache = new TTLCache(300_000, 600);

/** fetch JSON с таймаутом и вменяемой ошибкой. */
export async function fetchJson(url, { headers = {}, timeout = 12_000, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Upstream ${res.status}: ${text.slice(0, 180)}`);
  }
  if (!res.ok && !data?.error) throw new Error(`Upstream ${res.status}`);
  return data;
}

export function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    // CORS на все ответы: превью может рендериться в iframe с opaque origin
    // (sandbox без allow-same-origin), откуда запросы уходят как Origin: null.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

/** Преflight-запрос CORS. */
export function sendPreflight(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

export function seconds(ms) {
  return ms ? Math.round(ms / 1000) : undefined;
}

/**
 * Транспорт до апстрима.
 *
 * Нюанс: край Яндекс.Музыки блокирует Node-fetch (undici) — его TLS/HTTP
 * фингерпринт отдаёт 403 с HTML-страницей, хотя тот же запрос через обычный
 * node:https или curl проходит. Поэтому для яндексовых хостов (и аудио, и
 * обложки) ходим нативным https. Аналог в yandex.js — не «оптимизируйте».
 */
const needsNativeTransport = (host) => /(^|\.)yandex\.(net|ru)$/.test(host);

function nativeRequest(url, headers, { timeout = 20_000, method = 'GET', maxRedirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (target, left) => {
      const u = new URL(target);
      const mod = u.protocol === 'http:' ? http : https;
      const req = mod.request(
        { host: u.hostname, path: u.pathname + u.search, method, headers },
        (up) => {
          if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location && left > 0) {
            up.resume();
            return go(new URL(up.headers.location, target).toString(), left - 1);
          }
          resolve({
            status: up.statusCode,
            headers: { get: (k) => up.headers[String(k).toLowerCase()] ?? null },
            stream: up,
            text: () =>
              new Promise((done) => {
                let s = '';
                up.setEncoding('utf8');
                up.on('data', (c) => (s += c));
                up.on('end', () => done(s));
              }),
          });
        },
      );
      req.setTimeout(timeout, () => req.destroy(new Error('upstream timeout')));
      req.on('error', reject);
      req.end();
    };
    go(url, maxRedirects);
  });
}

async function openUpstream(targetUrl, headers, timeout) {
  if (needsNativeTransport(new URL(targetUrl).hostname)) {
    return nativeRequest(targetUrl, headers, { timeout });
  }
  const r = await fetch(targetUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  return {
    status: r.status,
    headers: r.headers,
    stream: r.body ? Readable.fromWeb(r.body) : null,
    text: () => r.text(),
  };
}

/** Аккуратно сообщить клиенту о недоступном источнике, не роняя сервер. */
function failStream(res, targetUrl, err) {
  const msg = String((err && err.message) || err);
  if (!res.headersSent) {
    res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'источник не ответил', detail: msg, targetUrl }));
  } else {
    res.destroy();
  }
}

/**
 * Проксирует удалённый поток (аудио) в ответ клиенту.
 * Поддерживает Range-запросы — иначе не будет перемотки.
 */
export async function proxyStream(req, res, targetUrl, { timeout = 20_000 } = {}) {
  const headers = { 'User-Agent': UA };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers['if-none-match']) headers['If-None-Match'] = req.headers['if-none-match'];

  // Ошибка сети на одном треке не должна ронять сервер: отвечаем понятной
  // ошибкой клиенту, а процесс продолжает работать.
  let upstream;
  try {
    upstream = await openUpstream(targetUrl, headers, timeout);
  } catch (e) {
    // Одна повторная попытка: сеть в локальных сетях/эмуляторах мигает
    // заметно чаще, чем хотелось бы (IPv6 без маршрута, таймауты до CDN).
    try {
      await new Promise((r) => setTimeout(r, 400));
      upstream = await openUpstream(targetUrl, headers, timeout);
    } catch (e2) {
      return failStream(res, targetUrl, e2);
    }
    if (!upstream) return failStream(res, targetUrl, e);
  }

  if (upstream.status >= 400) {
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'источник не ответил', detail: msg, targetUrl }));
    } else {
      res.destroy();
    }
    return;
  }

  if (upstream.status >= 400) {
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `upstream ${upstream.status}`, targetUrl }));
    return;
  }

  // Ответы с JSON/HTML вместо аудио — значит поток недоступен (geo/подписка/трек удалён)
  const ctype = upstream.headers.get('content-type') || '';
  if (ctype.includes('json') || ctype.includes('html')) {
    const peek = (await upstream.text()).slice(0, 300);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'upstream вернул не аудио', contentType: ctype, body: peek }));
    return;
  }

  const pass = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
  const out = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  for (const h of pass) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  // iTunes отдаёт превью как audio/x-m4p (лейбл DRM-формата), хотя внутри обычный
  // AAC в MP4. Браузеры на такой MIME могут отказаться играть — приводим к audio/mp4.
  if (out['content-type'] && /m4p|m4a|x-mpegurl/i.test(out['content-type'])) {
    out['content-type'] = 'audio/mp4';
  }
  // Яндекс.Музыка отдаёт mp3 как application/octet-stream: <audio> такое обычно
  // играет, но Safari/MSE капризничают — сообщаем настоящий тип явно.
  if (out['content-type'] && /application\/octet-stream/i.test(out['content-type'])) {
    out['content-type'] = 'audio/mpeg';
  }
  res.writeHead(upstream.status, out);

  if (!upstream.stream) return res.end();
  upstream.stream.on('error', () => res.destroy());
  res.on('close', () => upstream.stream.destroy?.());
  upstream.stream.pipe(res);
}

/** Хосты, картинки с которых нам разрешено проксировать (защита от SSRF). */
const IMG_ALLOW = [
  'dzcdn.net',
  'mzstatic.com',
  'audius.co',
  'audiuscontent.com',
  'creatornode',
  'yandex.net',
  'scdn.co',
  'radio-browser.info',
  'ytimg.com',
  'googleusercontent.com',
];

export function imgHostAllowed(url) {
  try {
    const h = new URL(url).hostname;
    return IMG_ALLOW.some((s) => h === s || h.endsWith('.' + s) || h.includes(s));
  } catch {
    return false;
  }
}

export async function proxyImage(res, url) {
  if (!imgHostAllowed(url)) return send(res, 403, { error: 'host not allowed' });
  try {
    let up;
    if (needsNativeTransport(new URL(url).hostname)) {
      up = await nativeRequest(url, { 'User-Agent': UA }, { timeout: 10_000 });
    } else {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
      up = {
        status: r.status,
        headers: r.headers,
        buffer: async () => Buffer.from(await r.arrayBuffer()),
      };
    }
    if (up.status >= 400) return send(res, up.status, { error: 'upstream ' + up.status });
    const buf = up.buffer ? await up.buffer() : await new Promise((done, fail) => {
      const chunks = [];
      up.stream.on('data', (c) => chunks.push(c));
      up.stream.on('end', () => done(Buffer.concat(chunks)));
      up.stream.on('error', fail);
    });
    res.writeHead(200, {
      'Content-Type': up.headers.get('content-type') || 'image/jpeg',
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) });
  }
}
