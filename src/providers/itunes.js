// iTunes Search API (Apple) — официальное, бесплатное, без ключей.
// Плюс: лучшие в отрасли метаданные и обложки высокого разрешения.
import { fetchJson, cache, seconds } from '../util.js';

function mapTrack(t) {
  return {
    uid: `itunes:${t.trackId}`,
    provider: 'itunes',
    id: String(t.trackId),
    title: t.trackName,
    artist: t.artistName,
    album: t.collectionName || '',
    duration: seconds(t.trackTimeMillis),
    // апскейлим обложку: API отдаёт 100x100, подменяем размер в URL
    artwork: t.artworkUrl100 ? t.artworkUrl100.replace('100x100', '600x600') : null,
    playable: !!t.previewUrl,
    preview: true,
    externalUrl: t.trackViewUrl,
    extra: { genre: t.primaryGenreName, releaseDate: t.releaseDate },
  };
}

export default {
  id: 'itunes',
  name: 'iTunes',
  accent: '#ff5c8a',
  description: 'Метаданные и обложки Apple Music, 30-сек превью',
  requiresAuth: false,
  capabilities: { search: true, trending: false, radio: false, stream: 'preview', artwork: true },

  async search(q, { limit = 25 } = {}) {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=${limit}`;
    const data = await cache.wrap(`itunes:s:${q}:${limit}`, () => fetchJson(url));
    return (data.results || [])
      .filter((t) => t.kind === 'song' || t.wrapperType === 'track')
      .map(mapTrack);
  },

  async trending() {
    return [];
  },

  async resolveStream(id) {
    const data = await cache.wrap(`itunes:tr:${id}`, () =>
      fetchJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`),
    );
    const t = (data.results || [])[0];
    if (!t?.previewUrl) throw new Error('У этого трека нет превью');
    return t.previewUrl;
  },
};
