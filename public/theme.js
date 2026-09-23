// Темы оформления: чистые данные и маленькие функции — без DOM и без сети.
//
// Почему темы живут отдельным модулем, а не разметкой в app.js:
//  1) список тем можно проверить автотестом (см. tests/theme.test.mjs), в том
//     числе сверить с CSS: у каждой темы из этого файла обязан быть блок
//     :root[data-theme="…"] с полным набором переменных;
//  2) app.js остаётся про плеер, а не про палитры.
//
// Цвета здесь — только для образцов в интерфейсе. Источник правды для
// отрисовки — public/styles.css.

export const THEMES = [
  {
    id: 'aurora',
    name: 'Аврора',
    hint: 'глубокая ночь, фиолет и циан',
    dark: true,
    // [акцент, второй акцент, фон] — используются в образцах выбора темы
    swatch: ['#7c5cff', '#22d3ee', '#080a12'],
  },
  {
    id: 'neon',
    name: 'Неон',
    hint: 'циберпанк, максимальный контраст',
    dark: true,
    swatch: ['#ff2d95', '#00e5c0', '#04060a'],
  },
  {
    id: 'sunset',
    name: 'Закат',
    hint: 'тёплая ночь, янтарь и роза',
    dark: true,
    swatch: ['#ff8a4c', '#ff4d8d', '#120b12'],
  },
  {
    id: 'graphite',
    name: 'Графит',
    hint: 'монохром, ничего лишнего',
    dark: true,
    swatch: ['#e6e9ee', '#9aa3b2', '#0a0b0d'],
  },
  {
    id: 'day',
    name: 'День',
    hint: 'светлая, нейтральная',
    dark: false,
    swatch: ['#5b4bff', '#0e8fa8', '#f3f5fa'],
  },
  {
    id: 'paper',
    name: 'Бумага',
    hint: 'светлая, тёплая',
    dark: false,
    swatch: ['#0f766e', '#b45309', '#f7f2e9'],
  },
];

export const DEFAULT_THEME = 'aurora';
export const THEME_IDS = THEMES.map((t) => t.id);

/** Есть ли такая тема (защита от мусора в localStorage). */
export const isTheme = (id) => THEME_IDS.includes(id);

/** Привести любое значение к существующей теме. */
export const normalizeTheme = (id) => (isTheme(id) ? id : DEFAULT_THEME);

/** Описание темы по id — с безопасным запасным вариантом. */
export function themeById(id) {
  return THEMES.find((t) => t.id === normalizeTheme(id)) || THEMES[0];
}

/** Следующая тема по кругу: так работает переключение клавишей T. */
export function nextTheme(id, dir = 1) {
  const i = THEME_IDS.indexOf(normalizeTheme(id));
  return THEME_IDS[(i + dir + THEME_IDS.length) % THEME_IDS.length];
}

/**
 * Применить тему к корню документа. Возвращает фактически применённый id,
 * поэтому вызывающий код всегда знает, что показывать пользователю.
 */
export function applyThemeTo(root, id) {
  const safe = normalizeTheme(id);
  if (root && typeof root.setAttribute === 'function') {
    root.setAttribute('data-theme', safe);
  }
  return safe;
}

/** Строка для образца темы: акцент → второй акцент → фон. */
export function swatchGradient(theme) {
  const t = themeById(theme?.id);
  return `linear-gradient(135deg, ${t.swatch[1]} 0%, ${t.swatch[0]} 60%, ${t.swatch[2]} 100%)`;
}
