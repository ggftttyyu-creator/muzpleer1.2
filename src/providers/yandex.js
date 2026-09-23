// Яндекс.Музыка — ОФИЦИАЛЬНОГО API НЕТ. Здесь используется неофициальный
// реверс-инжинирный API (тот же, что у библиотеки MarshalX/yandex-music-api).
// Авторизация — OAuth Device Flow: пользователь подтверждает вход на ya.ru/device.
//
// Статус воспроизведения: в этой сборке НЕ реализовано — Яндекс отдаёт mp3
// в AES-зашифрованном виде, нужна отдельная расшифровка потока. Поиск,
// библиотека и плейлисты работают.
import { fetchJson, cache, send } from '../util.js';
import { readFile, writeFile, rm } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

const MUSIC_API = 'https://api.music.yandex.net';
const OAUTH = 'https://oauth.yandex.ru';

/**
 * ВАЖНО про транспорт.
 * Край Яндекса блокирует «нечеловеческие» фингерпринты: на запросы из
 * Node-fetch (undici) и на нативный HTTP/2 прилетает 403 с HTML-страницей,
 * хотя curl с теми же заголовками отвечает 200. Обычный `node:https`
 * (HTTP/1.1 без ALPN h2) проходит. Поэтому все вызовы music-api идут здесь
 * через него, а не через fetch. Не «упрощайте» это обратно на fetch.
 */
function httpsRequest(url, headers = {}, { timeout = 12_000, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        host: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, text: data }));
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('Таймаут запроса к Яндексу')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function httpsJson(url, headers = {}, opts) {
  const { status, text } = await httpsRequest(url, headers, opts);
  try {
    return { status, json: JSON.parse(text) };
  } catch {
    const err = new Error(`Яндекс вернул не-JSON (${status})`);
    err.status = status;
    err.body = text.slice(0, 200);
    throw err;
  }
}
// Публичные креды официального Android-приложения (из yandex-music-api)
const CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
const CLIENT_SECRET = '53bc75238f0c4d08a118e51fe9203300';

const TOKEN_FILE = path.join(process.cwd(), '.yandex-auth.json');

let token = null;
let account = null;
let refreshToken = null;

async function loadToken() {
  try {
    const raw = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    token = raw.access_token || null;
    refreshToken = raw.refresh_token || null;
    account = raw.account || null;
  } catch {
    /* нет сохранённой сессии */
  }
}
const tokenLoaded = loadToken();

/** Аккаунт нужен для «Мне нравится»: догружаем лениво, если при входе не получилось. */
async function ensureAccount() {
  if (account?.uid) return account;
  const status = await musicApi('/account/status');
  account = {
    uid: status?.account?.uid,
    login: status?.account?.login,
    name: status?.account?.displayName,
  };
  try {
    await saveToken({ access_token: token, refresh_token: refreshToken, account, savedAt: Date.now() });
  } catch { /* не критично */ }
  return account;
}

async function saveToken(payload) {
  await writeFile(TOKEN_FILE, JSON.stringify(payload, null, 2), 'utf8');
}

function apiHeaders() {
  return {
    Authorization: `OAuth ${token}`,
    'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
    'X-Yandex-Music-Device-type': 'android',
    'Accept-Language': 'ru',
    'User-Agent': 'Yandex-Music-API',
  };
}

async function musicApi(pathname) {
  let res;
  try {
    res = await httpsJson(MUSIC_API + pathname, apiHeaders());
  } catch (e) {
    if (e.status === 451) {
      throw new Error('HTTP 451 — Яндекс отказывает в доступе к контенту (гео/юридические ограничения).');
    }
    throw e;
  }
  const { status, json: data } = res;

  if (status === 401) {
    token = null;
    throw new Error('Токен недействителен, авторизуйтесь заново');
  }
  if (status === 403) {
    throw new Error('Яндекс ответил 403 (антибот-защита). Попробуйте позже.');
  }
  if (data?.error) throw new Error(data.error.message || data.error.name || 'Ошибка Яндекса');
  return data?.result ?? data;
}

function cover(url, size = '600x600') {
  if (!url) return null;
  // API отдаёт URI без схемы: "avatars.yandex.net/get-music-content/…/%%"
  // Если не доставить https://, прокси картинок справедливо отвергнет URL.
  let u = url;
  if (u.startsWith('//')) u = 'https:' + u;
  else if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace('%%', size);
}

/**
 * Резолв прямого аудио.
 *
 * Проверено вживую: Яндекс отдаёт ОБЫЧНЫЙ mp3 без всякого шифрования.
 * Цепочка: /tracks/{id}/download-info → подписанный URL → XML (host/path/ts/s)
 * → https://{host}/get-mp3/{s}/{ts}{path}. Подписанная ссылка работает без
 * токена и поддерживает Range. AES-расшифровка, о которой пишут в старых
 * гайдах, больше не нужна — поля `key` в ответе нет.
 */
async function directUrl(trackId) {
  const info = await musicApi(`/tracks/${trackId}/download-info?can_use_download_info=1`);
  const items = Array.isArray(info) ? info : info?.result || [];
  if (!items.length) throw new Error('Яндекс не предложил ни одного варианта качества');

  const best =
    items
      .filter((i) => i.codec === 'mp3' && !i.preview)
      .sort((a, b) => (b.bitrateInKbps || 0) - (a.bitrateInKbps || 0))[0] || items[0];

  const { text: xml } = await httpsRequest(best.downloadInfoUrl, apiHeaders());
  const tags = Object.fromEntries([...xml.matchAll(/<(\w+)>(.*?)<\/\1>/g)].map((m) => [m[1], m[2]]));
  if (!tags.host || !tags.path) throw new Error('Не удалось разобрать download-info XML');

  return `https://${tags.host}/get-mp3/${tags.s}/${tags.ts}${tags.path}`;
}

function mapTrack(t) {
  const album = t.albums?.[0];
  const albumId = album?.id;
  return {
    uid: `yandex:${t.id}${albumId ? ':' + albumId : ''}`,
    provider: 'yandex',
    id: `${t.id}${albumId ? ':' + albumId : ''}`,
    title: t.title,
    artist: (t.artists || []).map((a) => a.name).join(', ') || '—',
    album: album?.title || '',
    duration: t.durationMs ? Math.round(t.durationMs / 1000) : undefined,
    artwork: cover(album?.coverUri || t.coverUri),
    playable: true,
    preview: false,
    externalUrl: `https://music.yandex.ru/track/${t.id}`,
    extra: { explicit: t.explicit, likesCount: t.likesCount },
  };
}

export default {
  id: 'yandex',
  name: 'Яндекс.Музыка',
  accent: '#ffcc00',
  description: 'Неофициальный API: поиск и библиотека (нужен ваш токен)',
  requiresAuth: true,
  capabilities: { search: true, trending: true, radio: false, stream: 'full', artwork: true },

  get authorized() {
    return !!token;
  },

  async search(q, { limit = 25 } = {}) {
    await tokenLoaded;
    if (!token) throw new Error('Не авторизовано в Яндекс.Музыке');
    const data = await cache.wrap(`yandex:s:${q}:${limit}`, () =>
      musicApi(`/search?text=${encodeURIComponent(q)}&type=track&page=0&nocorrect=false`),
    );
    const tracks = data?.tracks?.results || [];
    return tracks.slice(0, limit).map(mapTrack);
  },

  /** Треки из «Мне нравится». */
  async likes({ limit = 50 } = {}) {
    await tokenLoaded;
    if (!token) throw new Error('Не авторизовано в Яндекс.Музыке');
    await ensureAccount();
    const uid = account?.uid;
    if (!uid) throw new Error('Не удалось определить аккаунт Яндекса');
    const data = await musicApi(`/users/${uid}/likes/tracks`);
    const ids = (data?.library?.tracks || [])
      .map((l) => l.id)
      .slice(0, limit)
      .join(',');
    if (!ids) return [];
    const full = await musicApi(`/tracks?track-ids=${ids}`);
    return (full || []).map(mapTrack);
  },

  /** Роль «трендов» для Яндекса играет «Мне нравится». */
  async trending(opts = {}) {
    return this.likes(opts);
  },

  async resolveStream(id) {
    // id приходит как "trackId:albumId" — для download-info нужен только trackId
    const trackId = String(id).split(':')[0];
    return cache.wrap(`yandex:url:${trackId}`, () => directUrl(trackId), 120_000);
  },

  /** --- OAuth Device Flow --- */
  async deviceStart() {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      device_id: 'muzplayer-' + Math.random().toString(36).slice(2, 12),
      device_name: 'MuzPlayer',
    });
    const res = await fetch(`${OAUTH}/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    const data = await res.json();
    return {
      device_code: data.device_code,
      user_code: data.user_code,
      verification_url: data.verification_url || 'https://ya.ru/device',
      interval: data.interval || 5,
      expires_in: data.expires_in || 300,
    };
  },

  async devicePoll(deviceCode) {
    const body = new URLSearchParams({
      grant_type: 'device_code',
      code: deviceCode,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    const res = await fetch(`${OAUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(12_000),
    });
    const data = await res.json();

    if (data.error === 'authorization_pending') return { status: 'pending' };
    if (data.error) return { status: 'error', error: data.error, description: data.error_description };

    token = data.access_token;
    refreshToken = data.refresh_token || null;
    try {
      await ensureAccount();
    } catch {
      account = null;
    }
    await saveToken({ access_token: token, refresh_token: refreshToken, account, savedAt: Date.now() });
    return { status: 'ok', account };
  },

  async logout() {
    token = null;
    account = null;
    await rm(TOKEN_FILE, { force: true });
  },

  status() {
    return { authorized: !!token, account };
  },

  /** Дождаться чтения токена с диска — иначе первые запросы после старта увидят пустой токен. */
  async ready() {
    await tokenLoaded;
    return !!token;
  },

  /** Догружает аккаунт (если токен есть, а данных о нём нет) перед отдачей статуса. */
  async refresh() {
    await tokenLoaded;
    if (token && !account?.uid) {
      try {
        await ensureAccount();
      } catch { /* останемся без логина, но токен рабочий */ }
    }
    return this.status();
  },
};
