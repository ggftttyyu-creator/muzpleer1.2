// MuzPlayer — HTTP-сервер: статика + прокси к музыкальным API.
// Зачем сервер, а не чистый фронтенд: единый origin (CORS), скрытые токены,
// кэш ответов, проксирование аудио с поддержкой Range (перемотка) и картинок.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { list, searchAll, trending, resolveStream } from './src/providers/index.js';
import { send, sendPreflight, proxyStream, proxyImage, cache } from './src/util.js';
import { GENRES } from './src/providers/radio.js';
import { getLyrics } from './src/lyrics.js';
import yandex from './src/providers/yandex.js';
import youtube from './src/providers/youtube.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const body = await readFile(file);
    // HTML/JS/CSS — никогда из кэша: иначе браузер после правок подсовывает
    // старый app.js, и интерфейс выглядит «пустым», хотя сервер отдаёт новый файл.
    // Картинкам и прочему — обычное кэширование.
    const noStore = pathname === '/' || /\.(html|js|css)$/i.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': noStore ? 'no-store, must-revalidate' : 'public, max-age=3600',
      // ES-модули грузятся в CORS-режиме: без этого script type=module
      // не загрузится из iframe с opaque origin
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found', path: pathname });
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const server = http.createServer((req, res) => {
  // Любая ошибка внутри обработчика не должна убивать процесс: ловим и
  // отвечаем 502. Именно незалогированный сбой одного запроса однажды
  // уронил сервер целиком — вместе с плеером у пользователя.
  handle(req, res).catch((err) => {
    console.error(`[${req.method} ${req.url}] ошибка обработки:`, err && err.message ? err.message : err);
    if (!res.headersSent) {
      try { send(res, 502, { error: 'ошибка обработки запроса', detail: String((err && err.message) || err) }); } catch {}
    } else {
      res.destroy();
    }
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.searchParams;
  const route = url.pathname;

  if (req.method === 'OPTIONS') return sendPreflight(res);

  try {
    // ---------- API ----------
    if (route === '/api/health') {
      return send(res, 200, { ok: true, uptime: process.uptime(), providers: list().length });
    }

    if (route === '/api/providers') {
      return send(res, 200, { providers: list(), genres: GENRES });
    }

    if (route === '/api/search') {
      const q = (p.get('q') || '').trim();
      if (!q) return send(res, 200, { tracks: [], errors: [] });
      const providerIds = (p.get('provider') || 'all') === 'all' ? undefined : [p.get('provider')];
      const limit = Math.min(Number(p.get('limit') || 20), 50);
      const data = await searchAll(q, { providerIds, limit });
      return send(res, 200, data);
    }

    if (route === '/api/trending') {
      const provider = p.get('provider') || 'audius';
      const limit = Math.min(Number(p.get('limit') || 20), 50);
      const tag = p.get('tag') || undefined;
      const tracks = await trending(provider, { limit, tag });
      return send(res, 200, { tracks });
    }

    if (route === '/api/radio/genres') {
      return send(res, 200, { genres: GENRES });
    }

    if (route === '/api/lyrics') {
      const title = p.get('title') || '';
      const artist = p.get('artist') || '';
      if (!title) return send(res, 400, { error: 'нужен параметр title' });
      const data = await getLyrics({
        title,
        artist,
        album: p.get('album') || '',
        duration: Number(p.get('duration')) || 0,
      });
      return send(res, 200, data);
    }

    if (route === '/api/stream') {
      const provider = p.get('p');
      const id = p.get('id');
      if (!provider || !id) return send(res, 400, { error: 'нужны параметры p и id' });
      const target = await resolveStream(provider, id);
      return proxyStream(req, res, target);
    }

    if (route === '/api/img') {
      const u = p.get('u');
      if (!u) return send(res, 400, { error: 'нужен параметр u' });
      return proxyImage(res, u);
    }

    // ---------- Яндекс.Музыка (OAuth Device Flow) ----------
    if (route === '/api/yandex/status') {
      return send(res, 200, await yandex.refresh());
    }
    if (route === '/api/yandex/device/start' && req.method === 'POST') {
      return send(res, 200, await yandex.deviceStart());
    }
    if (route === '/api/yandex/device/poll' && req.method === 'POST') {
      const { device_code } = await readBody(req);
      if (!device_code) return send(res, 400, { error: 'нужен device_code' });
      return send(res, 200, await yandex.devicePoll(device_code));
    }
    if (route === '/api/yandex/logout' && req.method === 'POST') {
      await yandex.logout();
      return send(res, 200, { ok: true });
    }

    // ---------- YouTube (Data API v3: ключ + квота) ----------
    if (route === '/api/youtube/status') {
      return send(res, 200, youtube.status());
    }
    if (route === '/api/youtube/key' && req.method === 'POST') {
      const { key } = await readBody(req);
      return send(res, 200, await youtube.setKey(key));
    }
    if (route === '/api/youtube/key/clear' && req.method === 'POST') {
      return send(res, 200, await youtube.clearKey());
    }
    if (route === '/api/youtube/link' && req.method === 'POST') {
      const { url } = await readBody(req);
      return send(res, 200, { track: await youtube.byLink(url) });
    }

    // ---------- Статика ----------
    if (req.method === 'GET') return serveStatic(req, res, route);
    return send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    const message = String(err?.message || err);
    if (route === '/api/stream') {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: message }));
    }
    send(res, 500, { error: message, route });
  }
}

// Последний рубеж: одиночная сетевая осечка не должна завершать процесс.
// Такие сбои логируем громко, но сервер продолжает обслуживать запросы.
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', (e && e.stack) || e));

server.listen(PORT, HOST, () => {
  console.log(`MuzPlayer → http://${HOST}:${PORT}`);
  console.log(`Провайдеры: ${list().map((x) => x.id).join(', ')}`);
});
