// Тексты песен с таймингами для караоке.
//
// Почему именно LRCLIB:
//   • открытый API без ключа и регистрации (https://lrclib.net/docs);
//   • отдаёт синхронизированный LRC с таймкодами — это и есть караоке;
//   • неплохо покрывает неанглоязычные треки.
//
// Альтернативы и почему они не основные:
//   • Musixmatch — есть word-level richsync, но API платный и только по одобрению заявки;
//   • Genius — официальный API отдаёт лишь метаданные, текста в нём нет,
//     а страницы закрыты Cloudflare (проверено: 403 из серверной сети);
//   • lyrics.ovh — простой текст без таймингов, поэтому только фолбэк.
import { fetchJson, cache } from './util.js';

const UA_LRCLIB = 'MuzPlayer/0.1 (local music player)';
const UA_PLAIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

/** Чистим название от «(Official Video)», «[Remastered]», «feat.» и прочего мусора. */
function cleanTitle(t) {
  return String(t || '')
    .replace(/[([][^)\]]*\b(feat|ft|prod|official|lyric|lyrics|video|audio|visualizer|remaster|remix|live|hd|hq|4k|m\/v)\b[^)\]]*[)\]]/gi, ' ')
    .replace(/\s*[-–—]\s*(official|lyric[s]?|audio|video|visuali[sz]er|remaster(ed)?|live)\b.*$/i, '')
    .replace(/\s*["'«»]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanArtist(a) {
  return String(a || '')
    .replace(/\s*[-–—]\s*(topic|vevo)\s*$/i, '')
    .split(/\s*,\s*|\s+feat\.?\s+|\s+&\s+|\s+x\s+/i)[0]
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Парсим LRC: "[00:12.34] текст" (может быть несколько таймкодов на строку). */
function parseLRC(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/);
    if (!m) continue;
    const line = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    for (const tag of m[1].matchAll(/\[(\d{1,3}):(\d{2}(?:[.:]\d{1,3})?)\]/g)) {
      const seconds = Number(tag[1]) * 60 + parseFloat(tag[2].replace(':', '.'));
      out.push({ t: Math.round(seconds * 100) / 100, text: line });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function result({ synced, lines, plain, source, meta }) {
  return {
    found: true,
    synced,
    lines: lines || [],
    plain: plain || (lines || []).map((l) => l.text).join('\n'),
    source,
    meta: meta || {},
  };
}

/** Основной источник: LRCLIB. Собираем кандидатов из точного запроса и поиска. */
async function fromLrclib({ title, artist, album, duration }) {
  const headers = { 'User-Agent': UA_LRCLIB, Accept: 'application/json' };
  const albumParam = /^youtube$/i.test(album || '') ? '' : album || '';
  const candidates = [];

  // 1) точный запрос — если попадёт в ту же версию трека, ответ самый надёжный
  try {
    const u = new URL('https://lrclib.net/api/get');
    u.searchParams.set('artist_name', artist);
    u.searchParams.set('track_name', title);
    if (albumParam) u.searchParams.set('album_name', albumParam);
    if (duration) u.searchParams.set('duration', String(Math.round(duration)));
    const d = await fetchJson(u.toString(), { headers });
    if (d && (d.syncedLyrics || d.plainLyrics)) candidates.push(d);
  } catch { /* промах — не страшно */ }

  // 2) нечёткий поиск — часто приносит версию с таймкодами, когда точный ответ был без них
  try {
    const u = new URL('https://lrclib.net/api/search');
    u.searchParams.set('track_name', title);
    u.searchParams.set('artist_name', artist);
    const list = await fetchJson(u.toString(), { headers });
    if (Array.isArray(list)) candidates.push(...list.slice(0, 25));
  } catch { /* идём к фолбэку */ }

  if (!candidates.length) return null;

  // Ранжируем: синхрон > обычный текст, инструментал штрафуем, длительность — тайбрейкер
  const score = (x) => {
    let s = 0;
    if (x.syncedLyrics) s += 10;
    if (x.plainLyrics) s += 2;
    if (x.instrumental) s -= 8;
    if (duration && x.duration) s -= Math.min(4, Math.abs(x.duration - duration) / 4);
    return s;
  };
  const seen = new Set();
  const best = candidates
    .filter((x) => (seen.has(x.id) ? false : seen.add(x.id)))
    .sort((a, b) => score(b) - score(a))[0];

  const lines = best.syncedLyrics ? parseLRC(best.syncedLyrics) : [];
  if (!lines.length && !best.plainLyrics) return null;

  return result({
    synced: lines.length > 1,
    lines,
    plain: best.plainLyrics || '',
    source: 'lrclib',
    meta: {
      matched: `${best.trackName} — ${best.artistName}`,
      album: best.albumName,
      instrumental: best.instrumental,
      exactDuration: best.duration,
    },
  });
}

/** Фолбэк: простой текст без таймингов. */
async function fromLyricsOvh({ title, artist }) {
  try {
    const d = await fetchJson(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
      { headers: { 'User-Agent': UA_PLAIN } },
    );
    const plain = (d?.lyrics || '').replace(/\r/g, '').trim();
    if (!plain) return null;
    return result({ synced: false, lines: [], plain, source: 'lyrics.ovh' });
  } catch {
    return null;
  }
}

/**
 * Пытаемся достать текст: сначала синхрон, потом простой.
 * Результат кэшируется на сутки — тексты не меняются.
 */
export async function getLyrics({ title, artist, album, duration }) {
  const t = cleanTitle(title);
  const a = cleanArtist(artist);
  if (!t) return { found: false, reason: 'Нечего искать' };

  const key = `lyrics:${a}|${t}|${Math.round(duration || 0)}`;
  return cache.wrap(
    key,
    async () => {
      const lrclib = await fromLrclib({ title: t, artist: a, album, duration });
      if (lrclib) return lrclib;
      const ovh = await fromLyricsOvh({ title: t, artist: a });
      if (ovh) return ovh;
      return { found: false, reason: `Текст не найден в LRCLIB и lyrics.ovh (искали «${t}» — «${a}»)`, query: { title: t, artist: a } };
    },
    86_400_000,
  );
}
