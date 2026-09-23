// Общее для браузерных проверок: поиск Chrome, запуск с гарантированной уборкой.
//
// Важный урок: раньше инструменты запускали Chrome и иногда не дожидались его
// завершения. За несколько прогонов в системе накопилось 50+ процессов Chrome,
// они съели всю память, и следующие запуски «зависали» без внятной причины.
// Поэтому теперь браузер стартует отдельной группой процессов, а по окончании
// проверки группа убивается целиком (и временный профиль удаляется).

import { access, rm, readdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const BASE = process.env.MUZ_BASE || 'http://127.0.0.1:4173';

const CANDIDATES = [
  process.env.MUZ_CHROME,
  `${os.homedir()}/.local/share/choreographer/deps/chrome-linux64/chrome`,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export async function findChrome() {
  for (const c of CANDIDATES) {
    try { await access(c, constants.X_OK); return c; } catch {}
  }
  return null;
}

/**
 * Убрать «наши» зависшие браузеры (их выдаёт временный профиль muz-* в /tmp).
 * Свой браузер пользователя не трогаем: отбираем только процессы с этим признаком.
 */
export async function reapStaleChrome() {
  let killed = 0;
  try {
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid) || pid === String(process.pid)) continue;
      try {
        const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes('chrome') && cmd.includes('/tmp/muz-')) {
          process.kill(Number(pid), 'SIGKILL');
          killed++;
        }
      } catch {}
    }
  } catch {}
  if (killed) console.log(`Подчищено зависших браузеров: ${killed}`);
  return killed;
}

/** Сервер должен быть запущен — иначе проверять нечего. */
export async function ensureServer() {
  await reapStaleChrome();
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    console.log(`Сервер ${BASE} не отвечает. Сначала запустите: npm start`);
    return false;
  }
}

/** Флаги, с которыми браузер не мешает проверке и не плодит лишние процессы. */
const FLAGS = [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=1400,900', '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--metrics-recording-only',
];

/** Убить группу процессов и снести временный профиль. */
function cleanup(child, profile) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch {} // detached → своя группа
  try { child.kill('SIGKILL'); } catch {}
  rm(profile, { recursive: true, force: true }).catch(() => {});
}

/**
 * Запустить браузер и по завершении вернуть его stdout (для --dump-dom).
 * Всегда убивает группу процессов — даже если браузер завис.
 */
export function runChrome(chromePath, { url, extraFlags = [], budgetMs = 20_000, timeout = 120_000, tag = 'check', dumpDom = true, profileDir = null } = {}) {
  // profileDir нужен, когда два запуска подряд должны делить localStorage:
  // так проверяется, что выбранная тема переживает перезагрузку страницы.
  const profile = profileDir || path.join(os.tmpdir(), `muz-${tag}-${Date.now()}`);
  const args = [
    ...FLAGS,
    ...(dumpDom ? ['--dump-dom'] : []),
    ...(budgetMs ? [`--virtual-time-budget=${budgetMs}`] : []),
    ...extraFlags,
    `--user-data-dir=${profile}`,
    url,
  ];
  return new Promise((resolve) => {
    const child = spawn(chromePath, args, { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    // Ждём 'close' (потоки закрыты), а не 'exit': иначе последний кусок вывода
    // может не успеть прийти из pipe, и --dump-dom вернёт пустоту.
    const done = () => {
      clearTimeout(timer);
      if (profileDir) { try { child.kill('SIGKILL'); } catch {} } // общий профиль не удаляем
      else cleanup(child, profile);
      resolve(out);
    };
    const timer = setTimeout(done, timeout);
    child.on('close', done);
    child.on('error', done);
  });
}

/** Открыть страницу и не ждать вывода: используется, когда отчёт приходит по сети. */
export function openPage(chromePath, { url, tag = 'page', timeout = 120_000 } = {}) {
  const profile = path.join(os.tmpdir(), `muz-${tag}-${Date.now()}`);
  const child = spawn(chromePath, [...FLAGS, `--user-data-dir=${profile}`, url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const timer = setTimeout(() => cleanup(child, profile), timeout);
  timer.unref?.();
  return {
    kill() { clearTimeout(timer); cleanup(child, profile); },
  };
}
