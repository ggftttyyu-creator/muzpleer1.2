// Реестр провайдеров и унифицированный поиск.
// Единый интерфейс провайдера:
//   { id, name, accent, description, requiresAuth, capabilities,
//     search(q, opts) -> Track[], trending(opts) -> Track[], resolveStream(id) -> url }
// Track: { uid, provider, id, title, artist, album, duration, artwork, playable, preview, externalUrl }

import audius from './audius.js';
import deezer from './deezer.js';
import itunes from './itunes.js';
import radio from './radio.js';
import yandex from './yandex.js';
import youtube from './youtube.js';
import { cache } from '../util.js';

export const providers = { audius, deezer, itunes, radio, yandex, youtube };
export const order = ['audius', 'deezer', 'itunes', 'radio', 'yandex', 'youtube'];

export function list() {
  return order.map((id) => {
    const p = providers[id];
    return {
      id,
      name: p.name,
      accent: p.accent,
      description: p.description,
      requiresAuth: p.requiresAuth,
      capabilities: p.capabilities,
      ...(p.status ? { status: p.status() } : {}),
    };
  });
}

/** Круговая «перетасовка» результатов нескольких провайдеров. */
function interleave(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out;
}

/**
 * Поиск по одному или сразу нескольким провайдерам.
 * Ошибки отдельных источников не ломают общий поиск.
 */
export async function searchAll(q, { providerIds = order, limit = 20 } = {}) {
  const targets = providerIds.filter((id) => providers[id]);
  const settled = await Promise.allSettled(
    targets.map(async (id) => {
      // Источники, не умеющие искать без авторизации, молча пропускаем
      if (id === 'yandex' && !(await providers.yandex.ready())) return [];
      if (id === 'youtube' && !providers.youtube.hasKey) return [];
      const key = `search:${id}:${q}:${limit}`;
      return cache.wrap(key, () => providers[id].search(q, { limit }), 120_000);
    }),
  );

  const lists = [];
  const errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') lists.push(r.value || []);
    else errors.push({ provider: targets[i], error: String(r.reason?.message || r.reason) });
  });

  const tracks = targets.length > 1 ? interleave(lists) : lists[0] || [];
  return { tracks, errors, providers: targets };
}

export async function trending(id, opts = {}) {
  const p = providers[id];
  if (!p?.trending) return [];
  // У Яндекса роль «трендов» играет «Мне нравится»: нет токена — просто пусто
  if (id === 'yandex') {
    try {
      return await p.likes(opts);
    } catch {
      return [];
    }
  }
  if (id === 'youtube' && !p.hasKey) return [];
  return cache.wrap(`trend:${id}:${JSON.stringify(opts)}`, () => p.trending(opts), 600_000).then((r) => r || []);
}

export async function resolveStream(id, trackId) {
  const p = providers[id];
  if (!p) throw new Error(`Неизвестный провайдер: ${id}`);
  return p.resolveStream(trackId);
}
