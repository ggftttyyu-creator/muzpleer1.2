// Audius — официальное публичное API, полные треки, без ключей и регистрации.
// Док: https://docs.audius.org/api/
import { fetchJson, cache, seconds } from '../util.js';

const APP = 'MuzPlayer';

/** Discovery-нода: список живых API-хостов (кэш 10 минут). */
async function apiHost() {
  return cache.wrap('audius:host', async () => {
    const { data } = await fetchJson('https://api.audius.co');
    return Array.isArray(data) && data.length ? data[0] : 'https://api.audius.co';
  }, 600_000);
}

function mapTrack(t, host) {
  const art = t.artwork || {};
  return {
    uid: `audius:${t.id}`,
    provider: 'audius',
    id: t.id,
    title: t.title,
    artist: t.user?.name || t.user?.handle || 'Audius',
    artistId: t.user?.id,
    album: t.genre || t.mood || 'Audius',
    duration: t.duration || undefined,
    artwork: art['480x480'] || art['150x150'] || art['1000x1000'] || null,
    // is_streamable=false отдаёт 404 на /stream — такие треки в плеере бесполезны
    playable: t.is_streamable !== false && !t.is_stream_gated,
    preview: false,
    externalUrl: `https://audius.co${t.permalink || ''}`,
    extra: { plays: t.play_count, likes: t.favorite_count, genre: t.genre, mood: t.mood },
  };
}

export default {
  id: 'audius',
  name: 'Audius',
  accent: '#7c5cff',
  description: 'Полные треки без ключей и регистрации (Web3-каталог)',
  requiresAuth: false,
  capabilities: { search: true, trending: true, radio: false, stream: 'full', artwork: true },

  async search(q, { limit = 25 } = {}) {
    const host = await apiHost();
    const url = `${host}/v1/tracks/search?query=${encodeURIComponent(q)}&limit=${limit}&app_name=${APP}`;
    const { data } = await cache.wrap(`audius:s:${q}:${limit}`, () => fetchJson(url));
    return (data || []).map((t) => mapTrack(t, host)).filter((t) => t.playable);
  },

  async trending({ limit = 25, genre } = {}) {
    const host = await apiHost();
    const g = genre ? `&genre=${encodeURIComponent(genre)}` : '';
    const url = `${host}/v1/tracks/trending?limit=${limit}&app_name=${APP}${g}`;
    const { data } = await cache.wrap(`audius:t:${genre || 'all'}:${limit}`, () => fetchJson(url), 600_000);
    return (data || []).map((t) => mapTrack(t, host)).filter((t) => t.playable);
  },

  /** Возвращает прямую ссылку на mp3 (после резолва редиректа). */
  async resolveStream(id) {
    const host = await apiHost();
    const url = `${host}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${APP}`;
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc) return loc;
    }
    if (res.ok) return url;
    if (res.status === 404) throw new Error('Audius: трек помечен как нестримабельный (is_streamable=false)');
    throw new Error(`Audius stream ${res.status}`);
  },
};
