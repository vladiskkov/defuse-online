// Правила настільного «Дефузу». Спільні для сервера і браузера.
//
// Хід: усі одночасно обирають дію — перейти в сусідню зону, тримати позицію,
// кинути гранату, закласти чи розмінувати бомбу.
// Якщо вороги опинились в одній зоні — перестрілка: кожен кидає кубики d6,
// у кого більше, той влучає (нічия — обидва). У кожного 3 ❤.

export const HP = 3;
export const TURNS = 12;             // ходів у раунді (1:55)
export const TURN_SECONDS = 10;      // скільки «ігрових секунд» триває хід
export const ROUND_TIME = 115;
export const BOMB_TURNS = 4;         // бомба вибухає через 4 ходи (0:40)
export const ROUNDS_TOTAL = 12;      // зміна сторін після 6-го раунду
export const ROUNDS_TO_WIN = 7;
export const BUY_SECONDS = 20;
export const PLAN_SECONDS = 25;
export const DUEL_SECONDS = 15;
export const HOLD_BONUS = 1;         // тримав позицію, ворог зайшов до тебе
export const FLASH_PENALTY = 2;      // осліплений: −2 до суми
export const RETREAT_SAFE = 4;       // відступ: 4–6 — чисто, 1–3 — мінус 1 ❤

// Зброя: dice — скільки кубиків d6 кидаєш, bonus — до суми,
// head — коли хедшот: 'double' (дубль), 'six' (шістка); helmetStops — шолом рятує від хедшота
export const WEAPONS = {
  glock: { name: 'Glock-18', slot: 'pistol', side: 'T', price: 0, dice: 1, bonus: 0, head: 'six', helmetStops: true, kill: 300,
    desc: '1 кубик. Шістка — хедшот, якщо в цілі немає шолома' },
  usp: { name: 'USP-S', slot: 'pistol', side: 'CT', price: 0, dice: 1, bonus: 0, head: 'six', helmetStops: true, kill: 300,
    desc: '1 кубик. Шістка — хедшот, якщо в цілі немає шолома' },
  ak47: { name: 'AK-47', slot: 'primary', side: 'T', price: 2700, dice: 2, bonus: 0, head: 'double', helmetStops: false, kill: 300,
    desc: '2 кубики. Дубль — хедшот навіть крізь шолом' },
  m4a1s: { name: 'M4A1-S', slot: 'primary', side: 'CT', price: 2900, dice: 2, bonus: 1, head: 'double', helmetStops: true, kill: 300,
    desc: '2 кубики +1 до суми. Дубль — хедшот, але шолом рятує' },
};

export const GRENADES = {
  flash: { name: 'Флешка',    icon: '✷', price: 200, desc: 'Вороги в зоні цей хід кидають з −2' },
  smoke: { name: 'Дим',       icon: '☁', price: 300, desc: 'У зоні 2 ходи ніхто не стріляє — можна пройти' },
  he:    { name: 'Осколкова', icon: '💥', price: 300, desc: 'Усім ворогам у зоні −1 ❤' },
  molly: { name: 'Коктейль',  icon: '🔥', price: 400, desc: 'Зона горить 2 ходи: хто в ній — −1 ❤' },
};
export const MAX_GRENADES = 2;
export const SMOKE_TURNS = 2;
export const FIRE_TURNS = 2;

export const GEAR = {
  vest:   { name: 'Бронежилет',         price: 650,  desc: 'Забирає перше влучання в раунді' },
  helmet: { name: 'Бронежилет і шолом', price: 1000, desc: 'Ще й рятує від хедшота з пістолета і M4' },
  kit:    { name: 'Набір сапера',       price: 400,  side: 'CT', desc: 'Розміновуєш одразу, як зайшов у зону з бомбою' },
};

export const ECONOMY = {
  start: 800, max: 16000,
  winElim: 3250, winBomb: 3500, winDefuse: 3500, winTime: 3250,
  lossBase: 1400, lossStep: 500, lossMax: 3400, plantBonus: 800,
};

export function lossBonus(streak) {
  return Math.min(ECONOMY.lossMax, ECONOMY.lossBase + ECONOMY.lossStep * Math.max(0, streak - 1));
}
export function sideCanBuy(itemSide, side) { return !itemSide || itemSide === side; }

// Бонуси до кидка пострілу
export function shotBonus({ weapon, held, flashed }) {
  const w = WEAPONS[weapon];
  const mods = [];
  if (w.bonus) mods.push([w.name, w.bonus]);
  if (held) mods.push(['Тримав позицію', HOLD_BONUS]);
  if (flashed) mods.push(['Осліплений', -FLASH_PENALTY]);
  return { mods, bonus: mods.reduce((a, m) => a + m[1], 0), dice: w.dice };
}

// Чи це хедшот
export function isHeadshot(weapon, dice, targetArmor) {
  const w = WEAPONS[weapon];
  const head = w.head === 'double' ? dice.length >= 2 && dice[0] === dice[1] : dice.some((d) => d === 6);
  if (!head) return false;
  return !(w.helmetStops && targetArmor >= 2);
}

// Шанс перекинути суперника (для підказки): ймовірність, що моя сума ≥ його
export function winChance(myDice, myBonus, theirDice, theirBonus) {
  const dist = (n) => { let d = { 0: 1 }; for (let i = 0; i < n; i++) { const nd = {}; for (const [s, p] of Object.entries(d)) for (let f = 1; f <= 6; f++) nd[+s + f] = (nd[+s + f] || 0) + p / 6; d = nd; } return d; };
  const a = dist(myDice), b = dist(theirDice);
  let p = 0;
  for (const [x, px] of Object.entries(a)) for (const [y, py] of Object.entries(b)) if (+x + myBonus >= +y + theirBonus) p += px * py;
  return p;
}
