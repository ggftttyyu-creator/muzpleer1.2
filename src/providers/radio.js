// Radio-Browser — открытая база интернет-радиостанций (50k+), без ключей.
// Полноценные живые потоки: можно слушать реально, а не 30 секунд.
import { fetchJson, cache } from '../util.js';

const MIRRORS = ['https://de1.api.radio-browser.info', 'https://at1.api.radio-browser.info', 'https://nl1.api.radio-browser.info'];

async function rb(path) {
  let lastErr;
  for (const m of MIRRORS) {
    try {
      return await fetchJson(m + path);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('radio-browser недоступен');
}

function mapStation(s) {
  const tags = (s.tags || '').split(',').filter(Boolean).slice(0, 3).join(', ');
  return {
    uid: `radio:${s.stationuuid}`,
    provider: 'radio',
    id: s.stationuuid,
    title: (s.name || '').trim() || 'Без названия',
    artist: s.country || tags || 'Интернет-радио',
    album: [tags, s.codec, s.bitrate ? `${s.bitrate} kbps` : ''].filter(Boolean).join(' · '),
    duration: undefined,
    artwork: s.favicon || null,
    playable: !!s.url_resolved,
    preview: false,
    live: true,
    externalUrl: s.homepage || '',
    extra: { tags, codec: s.codec, bitrate: s.bitrate, votes: s.votes, country: s.country },
  };
}

export const GENRES = [
  { tag: 'pop', label: 'Pop' },
  { tag: 'rock', label: 'Rock' },
  { tag: 'electronic', label: 'Electronic' },
  { tag: 'jazz', label: 'Jazz' },
  { tag: 'hip hop', label: 'Hip-Hop' },
  { tag: 'classical', label: 'Classical' },
  { tag: 'ambient', label: 'Ambient' },
  { tag: 'metal', label: 'Metal' },
  { tag: 'reggae', label: 'Reggae' },
  { tag: 'chillout', label: 'Chillout' },
  { tag: 'news', label: 'Новости' },
  { tag: 'russian', label: 'Русское' },
];

export default {
  id: 'radio',
  name: 'Радио',
  accent: '#22d3a8',
  description: '50 000+ живых радиостанций со всего мира',
  requiresAuth: false,
  capabilities: { search: true, trending: true, radio: true, stream: 'full', artwork: true },

  async search(q, { limit = 25 } = {}) {
    const path = `/json/stations/search?name=${encodeURIComponent(q)}&limit=${limit}&hidebroken=true&order=votes&reverse=true`;
    const data = await cache.wrap(`radio:s:${q}:${limit}`, () => rb(path));
    return (data || []).map(mapStation);
  },

  /** Топ станций; если передан tag — по жанру. */
  async trending({ limit = 30, tag } = {}) {
    const path = tag
      ? `/json/stations/search?tag=${encodeURIComponent(tag)}&limit=${limit}&hidebroken=true&order=votes&reverse=true`
      : `/json/stations/topvote/${limit}`;
    const data = await cache.wrap(`radio:t:${tag || 'top'}:${limit}`, () => rb(path), 600_000);
    return (data || []).map(mapStation);
  },

  async resolveStream(uuid) {
    const data = await cache.wrap(`radio:u:${uuid}`, () =>
      rb(`/json/stations/byuuid/${encodeURIComponent(uuid)}`),
    );
    const s = Array.isArray(data) ? data[0] : data;
    if (!s?.url_resolved) throw new Error('Станция недоступна');
    return s.url_resolved;
  },
};
