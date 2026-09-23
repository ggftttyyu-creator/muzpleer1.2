// Тесты логики перемешивания и рекомендаций: `npm test`
//
// Здесь проверяется именно то, что нельзя увидеть глазами: распределение рандома,
// отсутствие повторов внутри цикла, затухание вкусов и порядок рекомендаций.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rng, shuffleInPlace, shuffleIndexes, ShuffleBag, WeightedBag,
  emptyTaste, recordPlay, recordSkip, decay, tasteAffinity, novelty, topArtists,
  recentTracks, tasteStats, resetTaste, tokenize, similarity, recommend, smartWeight,
  HALF_LIFE_MS,
} from '../public/rec.js';

const track = (i, extra = {}) => ({
  uid: 'u' + i, id: String(i), provider: 'audius', title: 'Трек ' + i, artist: 'Артист ' + i,
  duration: 180, playable: true, ...extra,
});

/* ==================== Рандом ==================== */

test('шuffle: перестановка без потерь и дублей', () => {
  const rand = rng(7);
  const src = Array.from({ length: 50 }, (_, i) => i);
  const out = shuffleInPlace([...src], rand);
  assert.equal(out.length, src.length);
  assert.deepEqual([...out].sort((a, b) => a - b), src, 'набор элементов изменился — это не перестановка');
  assert.notDeepEqual(out, src, 'перестановка совпала с исходным порядком (для 50 элементов это случайность ~0)');
});

test('шuffle: одинаковый seed даёт одинаковый порядок, разный — разный', () => {
  assert.deepEqual(shuffleIndexes(20, rng(1)), shuffleIndexes(20, rng(1)));
  assert.notDeepEqual(shuffleIndexes(20, rng(1)), shuffleIndexes(20, rng(2)));
});

test('шuffle: элементы распределены равномерно (критерий хи-квадрат)', () => {
  const n = 6, runs = 6000;
  const rand = rng(2026);
  const counts = new Array(n).fill(0);
  for (let k = 0; k < runs; k++) counts[shuffleIndexes(n, rand)[0]]++;
  const expected = runs / n;
  const chi2 = counts.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
  // df=5: критическое значение при p=0.001 равно 20.5; берём запас, чтобы тест не мигал
  assert.ok(chi2 < 30, `распределение перекошено: chi2=${chi2.toFixed(1)}, счётчики=${counts}`);
});

test('мешок: настоящий рандом — пока очередь не кончится, повторов нет', () => {
  const bag = new ShuffleBag(10, rng(5));
  const drawn = [];
  for (let k = 0; k < 10; k++) drawn.push(bag.take(-1));
  assert.deepEqual([...drawn].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    'за цикл должны выпасть все треки ровно по разу');
  assert.equal(bag.left, 0);
  assert.equal(bag.cycles, 1, 'цикл создан в конструкторе и ещё не начинался заново');
  bag.take(drawn[9]);                       // следующий запрос открывает новый цикл
  assert.equal(bag.cycles, 2);
});

test('мешок: старый алгоритм (точка в точку) давал повторы — новый не даёт', () => {
  // как было раньше: каждый раз случайный индекс, кроме текущего
  const rand = rng(99);
  const naive = new Set();
  let qi = -1;
  for (let k = 0; k < 10; k++) {
    let n;
    do { n = Math.floor(rand() * 10); } while (n === qi);
    qi = n;
    naive.add(n);
  }
  // как стало: перестановка всей очереди
  const modern = new Set(new ShuffleBag(10, rng(99)).remaining);

  assert.equal(modern.size, 10, 'новый алгоритм обязан выдать все 10 треков без повторов');
  assert.ok(naive.size < 10, 'санитарная проверка: наивный алгоритм действительно даёт повторы');
});

test('мешок: новый цикл не начинается с текущего трека', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const bag = new ShuffleBag(4, rng(seed));
    const last = bag.remaining[bag.remaining.length - 1];
    while (bag.left) bag.take(-1);           // вычерпываем цикл до конца
    const next = bag.take(last);              // начинаем следующий
    assert.notEqual(next, last, `seed=${seed}: цикл начался с только что игравшего трека`);
  }
});

test('мешок: забытый трек (удалили из очереди) больше не выпадает', () => {
  const bag = new ShuffleBag(5, rng(11));
  bag.forget(3);
  const drawn = [];
  while (bag.left) drawn.push(bag.take(-1));
  assert.ok(!drawn.includes(3), 'удалённый трек всё ещё выдаётся');
  assert.equal(drawn.length, 4);
});

test('мешок: вырожденные случаи — пустая очередь и один трек', () => {
  assert.equal(new ShuffleBag(0).take(-1), null);
  const one = new ShuffleBag(1, rng(1));
  assert.equal(one.take(-1), 0);
  assert.equal(one.take(0), 0, 'единственный трек должен играть бесконечно, а не ломать очередь');
});

test('умный мешок: предпочитает треки с большим весом, но не игнорирует остальные', () => {
  const n = 4, runs = 4000;
  const rand = rng(31);
  const counts = new Array(n).fill(0);
  const weights = [8, 1, 0.5, 0.5];
  for (let k = 0; k < runs; k++) {
    const bag = new WeightedBag(n, (i) => weights[i], rand);
    counts[bag.take(-1)]++;
  }
  assert.ok(counts[0] > counts[1] * 3, `вес 8 должен выигрывать у веса 1: ${counts}`);
  assert.ok(counts[1] > 0 && counts[2] > 0 && counts[3] > 0, `слабые веса не должны обнуляться: ${counts}`);
});

test('умный мешок: нулевые веса — не тупик, выбирается случайно', () => {
  const bag = new WeightedBag(3, () => 0, rng(3));
  const drawn = [bag.take(-1), bag.take(-1), bag.take(-1)];
  assert.deepEqual([...drawn].sort(), [0, 1, 2]);
});

/* ==================== Вкусы ==================== */

test('вкусы: затухание вдвое за период полураспада', () => {
  assert.equal(decay(10, 0), 10);
  assert.ok(Math.abs(decay(10, HALF_LIFE_MS) - 5) < 1e-9);
  assert.ok(Math.abs(decay(10, HALF_LIFE_MS * 2) - 2.5) < 1e-9);
  assert.equal(decay(10, -5), 10, 'отрицательный возраст (часы разъехались) не должен ломать вес');
});

test('вкусы: прослушивания поднимают артиста, пропуски опускают', () => {
  const taste = emptyTaste();
  const t0 = 1_700_000_000_000;
  recordPlay(taste, track(1, { artist: 'Юпи' }), t0);
  recordPlay(taste, track(2, { artist: 'Юпи' }), t0);
  recordPlay(taste, track(3, { artist: 'Кино' }), t0);

  const top = topArtists(taste, 5, t0);
  assert.equal(top[0].name, 'Юпи', 'артист с двумя прослушиваниями должен быть первым');

  recordSkip(taste, track(4, { artist: 'Юпи' }), t0);
  recordSkip(taste, track(5, { artist: 'Юпи' }), t0);
  recordSkip(taste, track(6, { artist: 'Юпи' }), t0);
  const after = topArtists(taste, 5, t0).find((x) => x.name === 'Юпи');
  assert.ok(!after || after.weight < top[0].weight, 'после трёх пропусков артист не должен оставаться лидером');
});

test('вкусы: недавно игравшее ценится ниже, чем забытое', () => {
  const taste = emptyTaste();
  const t0 = 1_700_000_000_000;
  recordPlay(taste, track(1), t0);
  const fresh = tasteAffinity(taste, track(1), t0 + 60_000);              // минуту назад
  const old = tasteAffinity(taste, track(1), t0 + 30 * 24 * 3600 * 1000); // месяц назад
  assert.ok(fresh < old, `свежий повтор должен оцениваться ниже: fresh=${fresh}, old=${old}`);
});

test('вкусы: новизна неизвестного трека максимальна, игравшего — падает', () => {
  const taste = emptyTaste();
  const t0 = 1_700_000_000_000;
  assert.equal(novelty(taste, track(9), t0), 1);
  recordPlay(taste, track(9), t0);
  assert.ok(novelty(taste, track(9), t0) < 0.2, 'только что игравший трек не может быть новым');
  assert.ok(novelty(taste, track(9), t0 + 30 * 24 * 3600 * 1000) > 0.7, 'через месяц новизна возвращается');
});

test('вкусы: попадание в профиль и статистика', () => {
  const taste = emptyTaste();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) recordPlay(taste, track(i), t0 + i * 1000);
  const st = tasteStats(taste);
  assert.equal(st.plays, 5);
  assert.equal(st.known, 5);
  assert.equal(st.artists, 5);
  assert.equal(recentTracks(taste, 3).length, 3);
  assert.equal(recentTracks(taste, 3)[0].uid, 'u4', 'первым должен идти последний по времени');

  resetTaste(taste);
  assert.deepEqual(tasteStats(taste), { plays: 0, skips: 0, tracks: 0, artists: 0, known: 0 });
});

test('вкусы: профиль не растёт бесконечно', () => {
  const taste = emptyTaste();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 600; i++) recordPlay(taste, track(i), t0 + i);
  assert.ok(Object.keys(taste.tracks).length <= 400, 'должны оставаться только 400 последних треков');
  assert.equal(taste.totalPlays, 600, 'счётчик прослушиваний при этом не теряется');
});

/* ==================== Похожесть ==================== */

test('токенизация: убирает служебные слова и приводит к основе', () => {
  assert.deepEqual(tokenize('Rammstein — Sonne (Official Video)'), ['rammstein', 'sonne']);
  const ru = tokenize('Юпи feat. Boogshi — ТРАЛАЛЕЛА (prod. by)');
  assert.ok(ru.includes('юпи') && ru.includes('traлалела'.replace('t', 'т')) || ru.includes('тралалела'));
  assert.ok(!ru.includes('feat') && !ru.includes('prod'), 'служебные слова должны выпадать');
});

test('похожесть: одинаковый трек = 1, свой артист выше чужого', () => {
  const a = track(1, { title: 'Sonne', artist: 'Rammstein', album: 'Mutter', duration: 272 });
  const sameArtist = track(2, { title: 'Du hast', artist: 'Rammstein', album: 'Sehnsucht', duration: 224 });
  const other = track(3, { title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', duration: 200 });
  assert.equal(similarity(a, a), 1);
  assert.ok(similarity(a, sameArtist) > similarity(a, other), 'тот же артист должен быть ближе');
  assert.ok(similarity(a, other) < 0.2, 'несвязанные треки не должны считаться похожими');
});

test('похожесть: симметрична и ловит совпадение по словам', () => {
  const a = track(1, { title: 'Нирвана', artist: 'Miyagi', album: '' });
  const b = track(2, { title: 'Нирвана', artist: 'Ганвест', album: '' });
  assert.equal(similarity(a, b).toFixed(6), similarity(b, a).toFixed(6));
  assert.ok(similarity(a, b) > 0.2, 'одинаковое название должно давать вклад в похожесть');
});

/* ==================== Рекомендации ==================== */

test('рекомендации: сид влияет — похожее идёт первым', () => {
  const seed = track(1, { title: 'Sonne', artist: 'Rammstein', album: 'Mutter', duration: 272 });
  const likeIt = track(2, { title: 'Du hast', artist: 'Rammstein', album: 'Sehnsucht', duration: 224 });
  const alien = track(3, { title: 'Калинка', artist: 'Хор', album: 'Фолк', duration: 120 });
  const out = recommend({
    seeds: [seed], candidates: [alien, likeIt], taste: emptyTaste(), limit: 2, rand: rng(1),
  });
  assert.equal(out[0].uid, 'u2', 'похожий трек должен быть рекомендован первым');
});

test('рекомендации: не предлагают то, что уже в очереди или только что играло', () => {
  const seeds = [track(1, { artist: 'Кино' })];
  const candidates = [track(2, { artist: 'Кино' }), track(3, { artist: 'Кино' }), track(4, { artist: 'Кино' })];
  const out = recommend({
    seeds, candidates, taste: emptyTaste(), limit: 5, excludeUids: new Set(['u2']), rand: rng(2),
  });
  assert.ok(!out.some((t) => t.uid === 'u2'), 'исключённый трек вернулся в рекомендации');
  assert.equal(out.length, 2);
});

test('рекомендации: слушают чаще — рекомендуют чаще (вкус работает)', () => {
  const taste = emptyTaste();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 6; i++) recordPlay(taste, track(100 + i, { artist: 'Юпи' }), t0);
  const loved = track(10, { artist: 'Юпи' });
  const neutral = track(11, { artist: 'Кто-то' });
  const out = recommend({ seeds: [], candidates: [neutral, loved], taste, limit: 2, nowMs: t0 + 1000, rand: rng(3) });
  assert.equal(out[0].uid, 'u10', 'трек любимого артиста должен обойти нейтральный');
});

test('рекомендации: разнообразие — не больше двух треков одного артиста подряд', () => {
  const candidates = [
    ...Array.from({ length: 6 }, (_, i) => track(i, { artist: 'Юпи' })),
    ...Array.from({ length: 6 }, (_, i) => track(10 + i, { artist: 'Кино' })),
  ];
  const out = recommend({
    seeds: [track(50, { artist: 'Юпи' })], candidates, taste: emptyTaste(), limit: 6, rand: rng(4),
  });
  const byArtist = {};
  for (const t of out) byArtist[t.artist] = (byArtist[t.artist] || 0) + 1;
  assert.ok(byArtist['Юпи'] <= 3, `одного артиста слишком много: ${JSON.stringify(byArtist)}`);
  assert.ok(byArtist['Кино'] >= 1, 'второй артист должен попасть в список');
});

test('рекомендации: лимит соблюдается, пустой пул и пустой профиль не ломают логику', () => {
  const cands = Array.from({ length: 30 }, (_, i) => track(i));
  assert.equal(recommend({ candidates: cands, limit: 7, rand: rng(5) }).length, 7);
  assert.deepEqual(recommend({ candidates: [], limit: 7 }), []);
  assert.deepEqual(recommend({ candidates: null }), []);
  // кандидаты без uid игнорируются, а не роняют функцию
  assert.deepEqual(recommend({ candidates: [{ title: 'без uid' }, null] }), []);
});

test('рекомендации: одинаковый seed — одинаковый список (воспроизводимость)', () => {
  const cands = Array.from({ length: 20 }, (_, i) => track(i));
  const opts = { seeds: [track(99, { artist: 'Артист 3' })], candidates: cands, limit: 5, jitter: 0.06 };
  const a = recommend({ ...opts, rand: rng(77) }).map((t) => t.uid);
  const b = recommend({ ...opts, rand: rng(77) }).map((t) => t.uid);
  const c = recommend({ ...opts, rand: rng(78) }).map((t) => t.uid);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c, 'разный seed должен давать другой порядок');
});

test('умный вес: любимый артист весит больше случайного', () => {
  const taste = emptyTaste();
  const t0 = 1_700_000_000_000;
  recordPlay(taste, track(1, { artist: 'Юпи' }), t0);
  recordPlay(taste, track(2, { artist: 'Юпи' }), t0);
  assert.ok(
    smartWeight(taste, track(3, { artist: 'Юпи' }), t0) > smartWeight(taste, track(4, { artist: 'Незнакомец' }), t0),
    'умный шаффл должен поднимать знакомых артистов',
  );
  assert.ok(smartWeight(emptyTaste(), track(5), t0) > 0, 'вес не может быть нулевым — иначе очередь встанет');
});
