// Правила гри «Дефуз». Спільні для сервера і браузера.

export const HP = 100;
export const MAX_STEPS = 4;          // максимум клітинок за хід (біг)
export const ROUND_TURNS = 15;       // ходів на раунд до закладки бомби
export const BOMB_TURNS = 7;         // ходів до вибуху після закладки
export const ROUNDS_TOTAL = 12;      // зміна сторін після 6-го раунду
export const ROUNDS_TO_WIN = 7;
export const THROW_RANGE = 8;
export const PLAN_SECONDS = 40;
export const BUY_SECONDS = 25;

// Режими руху на хід
export const MODES = {
  run:   { steps: 4, acc: -2, evade: 1, noisy: true,  label: 'Біг',         hint: 'До 4 клітинок. Гучно, стріляєш гірше' },
  walk:  { steps: 2, acc: 0,  evade: 0, noisy: false, label: 'Крок',        hint: 'До 2 клітинок тихо' },
  hold:  { steps: 0, acc: 2,  evade: 0, noisy: false, label: 'Тримати кут', hint: 'Стоїш на місці і стріляєш першим' },
  dodge: { steps: 2, acc: -3, evade: 4, noisy: false, label: 'Ухилятися',   hint: 'Не зупиняєшся при контакті, в тебе важче влучити' },
};

// Зброя. dice: [кількість, грані, бонус]; acc — бонус до кидка d20;
// range — дистанція без штрафу; pen — частка шкоди крізь броню;
// head — множник хедшота; shots — пострілів за хід; kill — нагорода.
export const WEAPONS = {
  glock:  { name: 'Glock-18',  slot: 'pistol',  side: 'T',  price: 200,  dice: [2, 10, 8],  acc: 1, range: 6,  pen: 0.47,  head: 3,   shots: 2, kill: 300 },
  usp:    { name: 'USP-S',     slot: 'pistol',  side: 'CT', price: 200,  dice: [2, 10, 12], acc: 2, range: 7,  pen: 0.5,   head: 3,   shots: 2, kill: 300 },
  ak47:   { name: 'AK-47',     slot: 'primary', side: 'T',  price: 2700, dice: [4, 8, 18],  acc: 2, range: 11, pen: 0.775, head: 4,   shots: 3, kill: 300 },
  m4a1s:  { name: 'M4A1-S',    slot: 'primary', side: 'CT', price: 2900, dice: [4, 8, 20],  acc: 3, range: 11, pen: 0.7,   head: 4,   shots: 3, kill: 300 },
};

export const GRENADES = {
  he:    { name: 'Осколкова', short: 'HE',    price: 300, side: null, radius: 2 },
  flash: { name: 'Флешка',    short: 'Флеш',  price: 200, side: null, radius: 4 },
  smoke: { name: 'Димова',    short: 'Дим',   price: 300, side: null, radius: 2, turns: 3 },
  molly: { name: 'Коктейль',  short: 'Моло',  price: 400, side: null, radius: 1, turns: 2 },
};
export const MAX_GRENADES = 3;

export const GEAR = {
  vest:   { name: 'Бронежилет',         price: 650 },
  helmet: { name: 'Бронежилет і шолом', price: 1000 },
  kit:    { name: 'Набір сапера',       price: 400, side: 'CT' },
};

export const ECONOMY = {
  start: 800, max: 16000,
  winElim: 3250, winBomb: 3500, winDefuse: 3500, winTime: 3250,
  lossBase: 1400, lossStep: 500, lossMax: 3400, plantBonus: 800,
};

export const FIRE_DAMAGE = 7;   // за кожен такт у вогні
export const FLASH_PENALTY = 8;
export const COVER_BONUS = 3;
export const BASE_NEED = 11;

export function lossBonus(streak) {
  return Math.min(ECONOMY.lossMax, ECONOMY.lossBase + ECONOMY.lossStep * Math.max(0, streak - 1));
}

export function sideCanBuy(itemSide, side) {
  return !itemSide || itemSide === side;
}
