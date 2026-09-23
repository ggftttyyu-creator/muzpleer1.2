// Логика перемешивания и рекомендаций.
//
// Модуль намеренно чистый: никакого DOM, localStorage и сети. Благодаря этому
// его гоняют и браузер, и обычные тесты в Node (`npm test`) — статистику
// рандома иначе проверить нечем.
//
// Что здесь есть:
//   • ShuffleBag  — настоящий рандом: перестановка без повторов, пока очередь не кончится;
//   • WeightedBag — «умный» порядок: сначала то, что вам заходит, но без зацикливания;
//   • вкусы       — профиль прослушиваний с временным затуханием;
//   • similarity  — насколько треки похожи (артист, альбом, слова, длительность);
//   • recommend   — сборка рекомендаций из семян, вкусов и штрафов за повторы.

/** Детерминированный ГПСЧ. Нужен тестам: с ним перестановки воспроизводимы. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Тасование Фишера—Йетса на месте. Каждая перестановка равновероятна. */
export function shuffleInPlace(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Индексы 0..n-1 в случайном порядке. */
export function shuffleIndexes(n, rand = Math.random) {
  return shuffleInPlace(Array.from({ length: n }, (_, i) => i), rand);
}

/* ==================== Мешок перемешивания ==================== */

/**
 * Настоящий рандом для очереди.
 *
 * Прошлая реализация брала `Math.floor(Math.random() * length)` на каждый «дальше»:
 * трек мог выпасть второй раз подряд, а половина очереди — не выпасть никогда.
 * Здесь вместо этого тасуется весь набор: пока все треки не сыграют, повторов нет.
 * Когда мешок опустел — начинается новый цикл, и он не начинается с того трека,
 * который играет сейчас (иначе слышно «щелчок» на стыке циклов).
 */
export class ShuffleBag {
  constructor(n = 0, rand = Math.random) {
    this.rand = rand;
    this.total = n;
    this.remaining = [];
    this.cycles = 0;
    this.reset();
  }

  /** Начать новый цикл. `avoid` — индекс, которым цикл начинаться не должен. */
  reset(avoid = -1) {
    let order = shuffleIndexes(this.total, this.rand);
    if (this.total > 1 && order[0] === avoid) {
      // первый и последний меняем местами — порядок остальных не трогаем
      [order[0], order[order.length - 1]] = [order[order.length - 1], order[0]];
    }
    this.remaining = order;
    this.cycles++;
    return this;
  }

  get left() {
    return this.remaining.length;
  }

  /** Забыть индекс (трек удалили из очереди). */
  forget(index) {
    const i = this.remaining.indexOf(index);
    if (i >= 0) this.remaining.splice(i, 1);
    return this;
  }

  /** Следующий индекс. Если мешок пуст — новый цикл (не с текущего трека). */
  take(current = -1) {
    if (this.total <= 1) return this.total === 1 ? 0 : null;
    if (!this.remaining.length) this.reset(current);
    return this.remaining.shift();
  }
}

/**
 * «Умный» шаффл: вес задаёт внешняя функция (вкус + новизна).
 * Внутри — тот же принцип «без повторов», но выбор взвешенный.
 */
export class WeightedBag extends ShuffleBag {
  /** @param {(index:number)=>number} weightFn вес ≥ 0 */
  constructor(n, weightFn, rand = Math.random) {
    super(n, rand);
    this.weightFn = weightFn;
  }

  take(current = -1) {
    if (this.total <= 1) return this.total === 1 ? 0 : null;
    if (!this.remaining.length) this.reset(current);
    const weights = this.remaining.map((i) => Math.max(0, Number(this.weightFn(i)) || 0));
    const sum = weights.reduce((a, b) => a + b, 0);
    // все веса нулевые — честный случайный выбор, чтобы очередь не встала
    if (sum <= 0) return this.remaining.shift();
    let r = this.rand() * sum;
    let pick = this.remaining.length - 1;
    for (let k = 0; k < this.remaining.length; k++) {
      r -= weights[k];
      if (r <= 0) { pick = k; break; }
    }
    return this.remaining.splice(pick, 1)[0];
  }
}

/* ==================== Вкусы ==================== */

export const HALF_LIFE_MS = 14 * 24 * 3600 * 1000; // две недели

export function emptyTaste() {
  return { artists: {}, tracks: {}, totalPlays: 0, totalSkips: 0, updated: 0 };
}

/** Затухание: свежее весит больше. Через полпериода — вдвое меньше. */
export function decay(weight, ageMs) {
  if (!(weight > 0)) return 0;
  if (!(ageMs > 0)) return weight;
  return weight * Math.pow(0.5, ageMs / HALF_LIFE_MS);
}

const now = (t) => (typeof t === 'number' && Number.isFinite(t) ? t : Date.now());
const key = (s) => String(s || '').trim().toLowerCase();

const slim = (t) => ({
  uid: t.uid, id: t.id, provider: t.provider, title: t.title, artist: t.artist,
  album: t.album || '', duration: t.duration || 0, artwork: t.artwork || '', playable: t.playable !== false,
});

/** Отметить прослушивание (вызывается, когда трек реально поиграл). */
export function recordPlay(taste, track, t) {
  const ts = now(t);
  if (!track?.uid) return taste;
  const a = key(track.artist);
  const rec = taste.tracks[track.uid] || { plays: 0, skips: 0, last: 0 };
  rec.plays += 1;
  rec.last = ts;
  taste.tracks[track.uid] = { ...slim(track), ...rec };
  if (a) {
    const ar = taste.artists[a] || { plays: 0, skips: 0, last: 0, name: track.artist };
    ar.plays += 1;
    ar.last = ts;
    ar.name = track.artist;
    taste.artists[a] = ar;
  }
  taste.totalPlays += 1;
  taste.updated = ts;
  trim(taste);
  return taste;
}

/** Отметить пропуск: пользователь переключил трек задолго до конца. */
export function recordSkip(taste, track, t) {
  const ts = now(t);
  if (!track?.uid) return taste;
  const a = key(track.artist);
  const rec = taste.tracks[track.uid] || { plays: 0, skips: 0, last: 0 };
  rec.skips += 1;
  rec.last = ts;
  taste.tracks[track.uid] = { ...slim(track), ...rec };
  if (a) {
    const ar = taste.artists[a] || { plays: 0, skips: 0, last: 0, name: track.artist };
    ar.skips += 1;
    ar.last = ts;
    taste.artists[a] = ar;
  }
  taste.totalSkips += 1;
  taste.updated = ts;
  trim(taste);
  return taste;
}

/** Профиль не должен пухнуть: держим 400 последних треков. */
function trim(taste) {
  const uids = Object.keys(taste.tracks);
  if (uids.length <= 400) return;
  uids
    .sort((a, b) => (taste.tracks[b].last || 0) - (taste.tracks[a].last || 0))
    .slice(400)
    .forEach((u) => delete taste.tracks[u]);
}

export function artistWeight(taste, artist, t) {
  const ts = now(t);
  const ar = taste.artists?.[key(artist)];
  if (!ar) return 0;
  return decay(ar.plays, ts - (ar.last || 0)) - 0.8 * decay(ar.skips, ts - (ar.last || 0));
}

/**
 * Насколько профиль благосклонен к треку, 0..1.
 * Здесь же — штрафы: недавно игравшее и недавно пропущенное ценится ниже.
 */
export function tasteAffinity(taste, track, t) {
  const ts = now(t);
  let score = 0;
  const ar = artistWeight(taste, track.artist, ts);
  if (ar > 0) score += Math.min(0.6, ar * 0.12);
  const rec = taste.tracks?.[track.uid];
  if (rec) {
    const age = ts - (rec.last || 0);
    score += Math.min(0.5, decay(rec.plays, age) * 0.12);
    score -= Math.min(0.6, decay(rec.skips, age) * 0.25);
    // совсем недавно играло/пропускалось — держим подальше
    if (age < 3 * 3600 * 1000) score -= 0.35;
    else if (age < 24 * 3600 * 1000) score -= 0.15;
  }
  return Math.max(0, Math.min(1, score));
}

/** Новизна: давно не слышанное — интереснее. Возвращает 0..1. */
export function novelty(taste, track, t) {
  const ts = now(t);
  const rec = taste.tracks?.[track.uid];
  if (!rec) return 1;
  const age = ts - (rec.last || 0);
  return Math.max(0, Math.min(1, 1 - Math.pow(0.5, age / (7 * 24 * 3600 * 1000))));
}

export function topArtists(taste, limit = 6, t) {
  const ts = now(t);
  return Object.entries(taste.artists || {})
    .map(([k, v]) => ({ key: k, name: v.name || k, weight: decay(v.plays, ts - (v.last || 0)) - 0.8 * decay(v.skips, ts - (v.last || 0)), plays: v.plays, skips: v.skips }))
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

export function recentTracks(taste, limit = 8) {
  return Object.values(taste.tracks || {})
    .filter((x) => (x.plays || 0) > 0)
    .sort((a, b) => (b.last || 0) - (a.last || 0))
    .slice(0, limit);
}

export function tasteStats(taste) {
  const tracks = Object.values(taste.tracks || {});
  return {
    plays: taste.totalPlays || 0,
    skips: taste.totalSkips || 0,
    tracks: tracks.length,
    artists: Object.keys(taste.artists || {}).length,
    known: tracks.filter((x) => (x.plays || 0) > 0).length,
  };
}

export function resetTaste(taste) {
  taste.artists = {};
  taste.tracks = {};
  taste.totalPlays = 0;
  taste.totalSkips = 0;
  taste.updated = Date.now();
  return taste;
}

/* ==================== Похожесть и рекомендации ==================== */

// Слова, которые не помогают понять, о чём песня
const STOP = new Set([
  'feat', 'ft', 'featuring', 'prod', 'remix', 'radio', 'edit', 'version', 'mix', 'the', 'a', 'an',
  'official', 'audio', 'video', 'lyrics', 'lyric', 'music', 'х', 'и', 'в', 'на', 'с', 'не',
]);

/** Разбор строки на значимые слова: латиница и кириллица, цифры. */
export function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/(ов|ев|ый|ая|ое|ые|ий|ый)$/u, ''))
    .filter((w) => w.length > 2 && !STOP.has(w));
}

const baseName = (s) =>
  key(s).replace(/\s*[([].*$/, '').replace(/\s*(feat|ft|prod)\.?.*$/u, '').trim();

/** Похожесть двух треков, 0..1. Симметрична. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.uid && a.uid === b.uid) return 1;
  let s = 0;
  const artistA = baseName(a.artist);
  const artistB = baseName(b.artist);
  if (artistA && artistA === artistB) s += 0.45;
  else {
    // частичное совпадение («Юпи» и «Юпи, boogshi») — половина веса
    const ta = new Set(tokenize(a.artist));
    const tb = new Set(tokenize(b.artist));
    if (ta.size && tb.size && [...ta].some((w) => tb.has(w))) s += 0.22;
  }
  if (a.album && b.album && key(a.album) === key(b.album)) s += 0.18;
  const ta = new Set(tokenize(a.title));
  const tb = new Set(tokenize(b.title));
  if (ta.size && tb.size) {
    const common = [...ta].filter((w) => tb.has(w)).length;
    s += 0.22 * (common / (ta.size + tb.size - common)); // Жаккар
  }
  if (a.duration > 0 && b.duration > 0) {
    const d = Math.abs(a.duration - b.duration) / Math.max(a.duration, b.duration);
    if (d < 0.15) s += 0.1;
    else if (d > 0.6) s -= 0.05;
  }
  if (a.provider && a.provider === b.provider) s += 0.05;
  return Math.max(0, Math.min(1, s));
}

/**
 * Оценка кандидата: похожесть на семена + вкус + новизна − штрафы за повторы.
 * Возвращает число; больше — лучше.
 */
export function scoreCandidate(track, { seeds = [], taste, nowMs, excludeUids = new Set() } = {}) {
  if (!track?.uid || excludeUids.has(track.uid)) return -Infinity;
  const sim = seeds.length ? Math.max(...seeds.map((s) => similarity(s, track))) : 0;
  const affinity = tasteAffinity(taste, track, nowMs);
  const fresh = novelty(taste, track, nowMs);
  return 0.5 * sim + 0.34 * affinity + 0.16 * fresh;
}

/**
 * Собрать рекомендации.
 *
 * seeds     — треки-ориентиры (что играет сейчас + недавнее + избранное)
 * candidates— пул кандидатов (результаты поиска по артистам, чарты)
 * taste     — профиль вкусов
 * excludeUids — не предлагать повторно (очередь, только что игравшее)
 * jitter    — маленькая случайность, чтобы список не был всегда одинаковым
 */
export function recommend({
  seeds = [],
  candidates = [],
  taste = emptyTaste(),
  limit = 12,
  excludeUids = new Set(),
  nowMs,
  rand = Math.random,
  perArtist = 2,
  jitter = 0.06,
} = {}) {
  const scored = [];
  const seen = new Set(excludeUids);
  const pool = Array.isArray(candidates) ? candidates : [];
  for (const c of pool) {
    if (!c?.uid || seen.has(c.uid)) continue;
    seen.add(c.uid);
    const base = scoreCandidate(c, { seeds, taste, nowMs, excludeUids });
    if (!Number.isFinite(base)) continue;
    scored.push({ track: c, score: base + (jitter ? rand() * jitter : 0) });
  }
  scored.sort((a, b) => b.score - a.score);

  // Разнообразие набираем ступенями: сначала не больше `perArtist` треков одного
  // исполнителя, если не хватило — поднимаем планку на один и идём снова.
  // Так список всегда заполняется, но остаётся по возможности разнообразным.
  const out = [];
  const perArtistCount = new Map();
  const keyOf = (t) => String(t.artist || '').trim().toLowerCase();
  for (let cap = Math.max(1, perArtist); out.length < limit && cap <= scored.length; cap++) {
    for (const { track: t } of scored) {
      if (out.length >= limit) break;
      if (out.includes(t)) continue;
      const a = keyOf(t);
      const n = perArtistCount.get(a) || 0;
      if (n >= cap) continue;
      perArtistCount.set(a, n + 1);
      out.push(t);
    }
  }
  return out;
}

/** Вес для «умного» шаффла: вкус важнее новизны, но без повторов. */
export function smartWeight(taste, track, t) {
  return 0.25 + 1.6 * tasteAffinity(taste, track, t) + 0.9 * novelty(taste, track, t);
}
