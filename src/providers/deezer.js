// Deezer — официальное API, без ключей. Полные треки отдавать нельзя,
// но 30-секундные превью доступны и CORS открыт.
import { fetchJson, cache, seconds } from '../util.js';

function mapTrack(t) {
  return {
    uid: `deezer:${t.id}`,
    provider: 'deezer',
    id: String(t.id),
    title: t.title_short || t.title,
    artist: t.artist?.name || '—',
    album: t.album?.title || '',
    duration: t.duration || undefined,
    artwork:
      t.album?.cover_xl || t.album?.cover_big || t.album?.cover_medium || t.album?.cover || null,
    playable: !!t.preview,
    preview: true,
    externalUrl: t.link,
    extra: { rank: t.rank, explicit: t.explicit_lyrics },
  };
}

export default {
  id: 'deezer',
  name: 'Deezer',
  accent: '#a238ff',
  description: 'Огромный каталог, метаданные + 30-сек превью',
  requiresAuth: false,
  capabilities: { search: true, trending: true, radio: false, stream: 'preview', artwork: true },

  async search(q, { limit = 25 } = {}) {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}`;
    const data = await cache.wrap(`deezer:s:${q}:${limit}`, () => fetchJson(url));
    if (data?.error) throw new Error(data.error.message || 'Deezer error');
    return (data.data || []).map(mapTrack);
  },

  async trending({ limit = 25 } = {}) {
    const url = `https://api.deezer.com/chart/0/tracks?limit=${limit}`;
    const data = await cache.wrap(`deezer:t:${limit}`, () => fetchJson(url), 600_000);
    if (data?.error) throw new Error(data.error.message || 'Deezer error');
    return (data.data || []).map(mapTrack);
  },

  async resolveStream(id) {
    const data = await cache.wrap(`deezer:tr:${id}`, () =>
      fetchJson(`https://api.deezer.com/track/${encodeURIComponent(id)}`),
    );
    if (!data?.preview) throw new Error('У этого трека нет превью');
    return data.preview;
  },
};
