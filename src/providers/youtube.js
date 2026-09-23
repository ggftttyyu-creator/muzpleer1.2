// YouTube — официальное YouTube Data API v3.
//
// ВАЖНО, что нужно понимать про этот источник:
//  1. API НЕ отдаёт аудиопоток. Воспроизведение возможно только через встроенный
//     IFrame Player — видео со рекламой внутри страницы. Это ограничение Google.
//  2. Квота: 10 000 units/день на проект. search.list = 100 units, videos.list = 1.
//     То есть ~100 поисков в сутки. Поэтому: агрессивный кэш и счётчик квоты.
//  3. Отдельного публичного API у YouTube Music нет — ищем по категории «Music» (10).
import { fetchJson, cache } from '../util.js';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY_FILE = path.join(process.cwd(), '.youtube-key.json');
const QUOTA_FILE = path.join(process.cwd(), '.youtube-quota.json');

const CATEGORY_MUSIC = '10';
const DAILY_LIMIT = 10_000;

let apiKey = process.env.YOUTUBE_API_KEY || null;

// Квота Google сбрасывается в полночь по Тихоокеанскому времени
let quota = { date: '', units: 0 };

async function boot() {
  try {
    if (!apiKey) apiKey = JSON.parse(await readFile(KEY_FILE, 'utf8')).key || null;
  } catch { /* ключа нет */ }
  try {
    const q = JSON.parse(await readFile(QUOTA_FILE, 'utf8'));
    if (q?.date) quota = q;
  } catch { /* счётчика нет */ }
}
await boot();

const todayPT = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

async function spend(units) {
  const t = todayPT();
  if (quota.date !== t) quota = { date: t, units: 0 };
  quota.units += units;
  writeFile(QUOTA_FILE, JSON.stringify(quota)).catch(() => {});
}

function requireKey() {
  if (!apiKey) {
    throw new Error(
      'Не задан API-ключ YouTube. Получите его в Google Cloud Console (включите YouTube Data API v3) и вставьте в панели YouTube слева.',
    );
  }
}

async function yt(endpoint, params, cost) {
  requireKey();
  const u = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', apiKey);
  const data = await fetchJson(u.toString());
  await spend(cost);
  if (data?.error) {
    const msg = data.error.message || 'ошибка YouTube API';
    if (/quota/i.test(msg)) {
      throw new Error(`Квота YouTube исчерпана (${quota.units}/${DAILY_LIMIT} units). Сброс в полночь по Тихоокеанскому времени.`);
    }
    if (/API key not valid|API_KEY_INVALID|badRequest/i.test(msg)) {
      throw new Error('API-ключ YouTube недействителен. Проверьте, что включён YouTube Data API v3.');
    }
    throw new Error(msg);
  }
  return data;
}

/** ISO 8601 ("PT3M45S") → секунды. */
function parseDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return undefined;
  const [, d, h, mi, s] = m;
  const total = (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0);
  return total || undefined;
}

/** Чистим выдачу: у Topic-каналов артист лежит в названии видео. */
function cleanMeta(snippet) {
  const channel = snippet.channelTitle || '';
  let artist = channel.replace(/\s*-\s*Topic$/i, '');
  let title = snippet.title || '';

  const inTitle = title.match(/^(.{2,60}?)\s+[-–—]\s+(.+)$/);
  if (inTitle && (/- Topic$/i.test(channel) || /VEVO$/i.test(channel))) {
    artist = inTitle[1].trim();
    title = inTitle[2].trim();
  }
  title = title
    .replace(/\s*[([][^)\]]*(official\s*(music\s*)?(video|audio)|lyric[s]?\s*(video)?|visualizer|audio|hd|hq|4k|remaster(ed)?)[^)\]]*[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return { title: title || snippet.title, artist };
}

function thumb(snippet) {
  const t = snippet.thumbnails || {};
  return (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || null;
}

function mapVideo(v) {
  const { title, artist } = cleanMeta(v.snippet);
  return {
    uid: `youtube:${v.id}`,
    provider: 'youtube',
    id: typeof v.id === 'string' ? v.id : v.id.videoId,
    title,
    artist,
    album: 'YouTube',
    duration: parseDuration(v.contentDetails?.duration),
    artwork: thumb(v.snippet),
    playable: true,
    preview: false,
    embed: true, // играет во встроенном IFrame-плеере, а не через <audio>
    externalUrl: `https://youtu.be/${typeof v.id === 'string' ? v.id : v.id.videoId}`,
    extra: { channel: v.snippet.channelTitle, published: v.snippet.publishedAt },
  };
}

/** Достаём videoId из любого вида ссылки. */
export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m =
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/youtube\.com\/embed\/([\w-]{11})/) ||
    s.match(/youtube\.com\/shorts\/([\w-]{11})/) ||
    s.match(/youtube\.com\/live\/([\w-]{11})/);
  return m ? m[1] : null;
}

export default {
  id: 'youtube',
  name: 'YouTube',
  accent: '#ff3d3d',
  description: 'Официальный Data API v3. Играет через встроенный плеер (есть реклама)',
  requiresAuth: false,
  capabilities: { search: true, trending: true, radio: false, stream: 'embed', artwork: true },

  get hasKey() {
    return !!apiKey;
  },

  async search(q, { limit = 20 } = {}) {
    if (!apiKey) return [];
    const data = await cache.wrap(
      `yt:s:${q}:${limit}`,
      async () => {
        const found = await yt(
          'search',
          {
            part: 'snippet',
            type: 'video',
            videoCategoryId: CATEGORY_MUSIC,
            maxResults: String(Math.min(limit, 50)),
            q,
            safeSearch: 'none',
          },
          100,
        );
        const ids = (found.items || []).map((i) => i.id.videoId).filter(Boolean);
        if (!ids.length) return { items: [] };
        // +1 unit: search не отдаёт длительность, добираем её видео-эндпоинтом
        const details = await yt('videos', { part: 'contentDetails,snippet', id: ids.join(',') }, 1);
        return details;
      },
      600_000, // 10 минут: квота дороже свежести
    );
    return (data.items || []).map(mapVideo).slice(0, limit);
  },

  /** Чарт музыки — стоит всего 1 unit вместо 100. */
  async trending({ limit = 20 } = {}) {
    if (!apiKey) return [];
    const data = await cache.wrap(
      `yt:trend:${limit}`,
      () =>
        yt(
          'videos',
          {
            part: 'snippet,contentDetails',
            chart: 'mostPopular',
            videoCategoryId: CATEGORY_MUSIC,
            maxResults: String(Math.min(limit, 50)),
            regionCode: 'RU',
          },
          1,
        ),
      1_800_000,
    );
    return (data.items || []).map(mapVideo);
  },

  /** Ручное добавление по ссылке — работает и без поиска (1 unit). */
  async byLink(url) {
    const id = parseVideoId(url);
    if (!id) throw new Error('Не похоже на ссылку YouTube');
    const data = await cache.wrap(`yt:byid:${id}`, () =>
      yt('videos', { part: 'snippet,contentDetails', id }), 3_600_000,
    );
    const items = data.items || [];
    if (!items.length) throw new Error('Видео не найдено или оно приватное');
    return mapVideo(items[0]);
  },

  async resolveStream() {
    // Аудиопотока нет и быть не может: играем через IFrame Player на клиенте
    throw new Error('YouTube играет через встроенный плеер, а не через аудиопоток');
  },

  /** --- Ключ и квота --- */
  async setKey(key) {
    key = String(key || '').trim();
    if (!key) throw new Error('Пустой ключ');
    const prev = apiKey;
    apiKey = key;
    try {
      // дешёвая проверка ключа: 1 unit
      await yt('videos', { part: 'id', id: 'dQw4w9WgXcQ' }, 1);
    } catch (e) {
      apiKey = prev;
      throw e;
    }
    await writeFile(KEY_FILE, JSON.stringify({ key, savedAt: Date.now() }), 'utf8');
    return this.status();
  },

  async clearKey() {
    apiKey = null;
    await rm(KEY_FILE, { force: true });
    return this.status();
  },

  status() {
    const t = todayPT();
    const used = quota.date === t ? quota.units : 0;
    return {
      hasKey: !!apiKey,
      quota: {
        date: t,
        used,
        limit: DAILY_LIMIT,
        searchesLeft: Math.max(0, Math.floor((DAILY_LIMIT - used) / 101)),
      },
    };
  },
};
