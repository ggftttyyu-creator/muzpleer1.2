// Тесты устойчивости серверной части: `npm test`
//
// Поводом стал реальный сбой: недоступный источник (таймаут до CDN, IPv6 без
// маршрута) выбрасывал исключение из прокси потока — и процесс сервера падал
// целиком, а плеер у пользователя «зависал». Такие ошибки обязаны быть
// локальными: пользователь видит сообщение, сервер продолжает работать.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { proxyStream, send, TTLCache } from '../src/util.js';

/**
 * Минимальный ответ сервера: настоящий поток (в коде идёт pipe), плюс
 * запоминаем код, заголовки и тело — как это делал бы http.ServerResponse.
 */
function fakeRes() {
  const res = new PassThrough();
  res.code = null;
  res.headers = null;
  res.body = '';
  res.headersSent = false;
  res.writeHead = function (code, headers) { this.code = code; this.headers = headers; this.headersSent = true; return this; };
  res.on('data', (c) => { res.body += c.toString(); });
  const streamEnd = res.end.bind(res);
  // Тело собираем только через событие 'data': запись в end() тоже приводит
  // к 'data', и учитывать её дважды нельзя.
  res.end = function (chunk, ...rest) {
    this.headersSent = true;
    return streamEnd(chunk, ...rest);
  };
  return res;
}
const fakeReq = (headers = {}) => ({ headers, method: 'GET', url: '/api/stream' });

test('прокси потока: недоступный источник → 504 и никаких исключений', async () => {
  const res = fakeRes();
  // 240.0.0.0/4 — зарезервированный диапазон, соединение не устанавливается
  await proxyStream(fakeReq(), res, 'https://240.0.0.1/nope.mp3', { timeout: 700 });
  assert.equal(res.code, 504, 'ожидался код 504, получен ' + res.code);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'источник не ответил');
  assert.ok(body.detail, 'в ответе должна быть причина — иначе нечего показывать');
});

test('прокси потока: несуществующий хост → тоже 504, а не падение', async () => {
  const res = fakeRes();
  await proxyStream(fakeReq(), res, 'https://this-host-does-not-exist-музплеер.invalid/x.mp3', { timeout: 700 });
  assert.equal(res.code, 504);
});

test('прокси потока: живой источник проксируется с телом и типом', async () => {
  const res = fakeRes();
  // локальный сервер отдаёт поток (картинку) — годится как проверка «поток дошёл»
  await proxyStream(
    fakeReq(),
    res,
    'http://127.0.0.1:4173/api/img?u=' + encodeURIComponent('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'),
    { timeout: 8000 },
  );
  if (res.code === 200) {
    assert.ok(res.headers['content-type'].startsWith('image/'), 'тип должен передаться как есть');
    await new Promise((r) => setTimeout(r, 300)); // ждём, пока поток допишется
    assert.ok(res.body.length > 0, 'тело потока не дошло до клиента');
  } else {
    // внешняя сеть могла быть недоступна — тогда обязан быть понятный код, не исключение
    assert.ok([502, 504].includes(res.code), 'неожиданный код: ' + res.code);
  }
});

test('send: JSON-ответ с нужным типом и без падения на спецсимволах', () => {
  const res = fakeRes();
  send(res, 400, { error: 'нужны параметры p и id «кавычки» \\ /' });
  assert.equal(res.code, 400);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(res.body).error.includes('кавычки'), true);
});

test('TTLCache: отдаёт кэш, истекает по TTL и не растёт бесконечно', async () => {
  const cache = new TTLCache(50, 3);
  let calls = 0;
  const load = () => Promise.resolve(++calls);
  assert.equal(await cache.wrap('k', load), 1);
  assert.equal(await cache.wrap('k', load), 1, 'второй вызов должен идти из кэша');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(await cache.wrap('k', load), 2, 'после TTL значение перезагружается');
  for (let i = 0; i < 10; i++) await cache.wrap('k' + i, () => Promise.resolve(i));
  assert.ok(cache.map.size <= 3, 'размер кэша ограничен, сейчас ' + cache.map.size);
});
