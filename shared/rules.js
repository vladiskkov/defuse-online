// Правила «Дефузу» — тактична настолка в стилі CS2 на гекс-полі.
// Механіки: черговість активацій і атака/захист (Kill Team), очки дій і overwatch (Space Hulk),
// укриття з флангами (XCOM), гекси для рівної відстані в усіх напрямках.

export const HP = 100;
export const AP = 2;                 // дій за активацію
export const MOVE = 4;               // гексів за дію «Рух»
export const TURNS = 8;              // ходів (turning points) у раунді
export const TURN_SECONDS = 15;      // «ігрові секунди» на хід: 8 × 15 ≈ 1:55
export const ROUND_TIME = 115;
export const BOMB_TURNS = 3;         // бомба вибухає в кінці 3-го ходу після закладки
export const ROUNDS_TOTAL = 12;
export const ROUNDS_TO_WIN = 7;
export const BUY_SECONDS = 20;
export const ACT_SECONDS = 30;       // на активацію
export const ROLL_SECONDS = 10;      // на кидок
export const VIEW_RANGE = 12;        // далі не видно
export const NOISE_RANGE = 6;        // кроки ворога чути в межах 6 гексів
export const THROW_RANGE = 6;

// Захист: 3 кубики. Без броні блок на 5+, у бронежилеті на 4+. Шестірка — критичний блок.
export const DEF_DICE = 3;
export const SAVE = 5;
export const SAVE_VEST = 4;

// Зброя: atk — кубиків атаки, hit — влучання на N+ (6 — завжди хедшот),
// dmg — шкода за влучання, crit — за хедшот, critHelmet — хедшот у шолом, range — дальність без штрафу (гекси)
export const WEAPONS = {
  glock: { name: 'Glock-18', slot: 'pistol', side: 'T', price: 0, atk: 3, hit: 4, dmg: 14, crit: 30, critHelmet: 15, range: 5, kill: 300 },
  usp:   { name: 'USP-S', slot: 'pistol', side: 'CT', price: 0, atk: 3, hit: 4, dmg: 17, crit: 35, critHelmet: 18, range: 6, kill: 300 },
  ak47:  { name: 'AK-47', slot: 'primary', side: 'T', price: 2700, atk: 4, hit: 4, dmg: 27, crit: 50, critHelmet: 50, range: 9, kill: 300 },
  m4a1s: { name: 'M4A1-S', slot: 'primary', side: 'CT', price: 2900, atk: 4, hit: 3, dmg: 23, crit: 40, critHelmet: 28, range: 9, kill: 300 },
};

export const GRENADES = {
  flash: { name: 'Флешка',    icon: '✷', price: 200, desc: 'Вороги поруч (2 гекси) засліплені: влучають на 2 гірше до кінця своєї активації' },
  smoke: { name: 'Дим',       icon: '☁', price: 300, desc: 'Закриває огляд у радіусі 1 гекса на 2 ходи' },
  he:    { name: 'Осколкова', icon: '💥', price: 300, desc: '25 шкоди всім у радіусі 1 гекса (броня — 15)' },
  molly: { name: 'Коктейль',  icon: '🔥', price: 400, desc: 'Гекси поруч горять до кінця наступного ходу: 20 шкоди тим, хто там стоїть' },
};
export const MAX_GRENADES = 2;
export const HE_DMG = 25, HE_DMG_VEST = 15, FIRE_DMG = 20;

export const GEAR = {
  vest:   { name: 'Бронежилет', price: 650, desc: 'Захист блокує на 4+ замість 5+' },
  helmet: { name: 'Бронежилет і шолом', price: 1000, desc: 'Ще й зменшує шкоду хедшотів (крім AK)' },
  kit:    { name: 'Набір сапера', price: 400, side: 'CT', desc: 'Розмінування за 1 дію замість 2' },
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

// Скільки треба викинути для влучання і чому
export function attackNeed({ weapon, dist, moved, flashed, overwatch }) {
  const w = WEAPONS[weapon];
  const mods = [];
  if (dist > w.range) mods.push(['Далеко', 1]);
  if (moved) mods.push(['Стріляв після руху', 1]);
  if (overwatch) mods.push(['Постріл з кута', 1]);
  if (flashed) mods.push(['Засліплений', 2]);
  const need = Math.min(6, w.hit + mods.reduce((a, m) => a + m[1], 0));
  return { need, mods, atk: w.atk };
}

export function defenseNeed({ armor }) { return armor >= 1 ? SAVE_VEST : SAVE; }

// Підрахунок результату атаки за правилами Kill Team
// atkDice, defDice — масиви d6; cover — один автоматичний звичайний блок
export function resolveAttack({ weapon, need, atkDice, defDice, save, cover, armor }) {
  const w = WEAPONS[weapon];
  let crits = atkDice.filter((d) => d === 6).length;
  let hits = atkDice.filter((d) => d !== 6 && d >= need && d !== 1).length;
  let cSaves = defDice.filter((d) => d === 6).length;
  let nSaves = defDice.filter((d) => d !== 6 && d >= save && d !== 1).length + (cover ? 1 : 0);
  const blocked = { crits: 0, hits: 0 };
  // критичний блок: спершу проти хедшота
  while (cSaves > 0 && crits > 0) { cSaves--; crits--; blocked.crits++; }
  // два звичайні блоки зупиняють хедшот, якщо звичайних влучань немає
  while (nSaves >= 2 && crits > 0 && hits === 0) { nSaves -= 2; crits--; blocked.crits++; }
  while (cSaves > 0 && hits > 0) { cSaves--; hits--; blocked.hits++; }
  while (nSaves > 0 && hits > 0) { nSaves--; hits--; blocked.hits++; }
  const critDmg = armor >= 2 ? w.critHelmet : w.crit;
  return { hits, crits, blocked, damage: hits * w.dmg + crits * critDmg, critDmg };
}

// Очікувана шкода (для підказки «шанс»): Монте-Карло, детерміновано
export function expected({ weapon, need, save, cover, armor, hp }) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return 1 + (seed % 6); };
  const w = WEAPONS[weapon];
  let dmg = 0, kills = 0, anyHit = 0;
  const N = 600;
  for (let i = 0; i < N; i++) {
    const a = Array.from({ length: w.atk }, rnd), d = Array.from({ length: DEF_DICE }, rnd);
    const r = resolveAttack({ weapon, need, atkDice: a, defDice: d, save, cover, armor });
    dmg += r.damage; if (r.damage) anyHit++; if (r.damage >= hp) kills++;
  }
  return { dmg: Math.round(dmg / N), hit: anyHit / N, kill: kills / N };
}
