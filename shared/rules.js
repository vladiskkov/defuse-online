// Правила гри «Дефуз». Спільні для сервера і браузера.
//
// Раунд складається з ходів руху (10 с ігрового часу) і дуелей (5 с).
// Хід руху: усі одночасно прокладають маршрут; хто побачив ворога — зупиняється.
// Дуель: кожен учасник контакту обирає дію і САМ кидає кубики:
//   стріляти — d20 за кожну кулю черги, ховатися — d20 на ухилення, граната — d20 на точність.

export const HP = 100;
export const MOVE_FAST = 6;          // клітинок за хід бігом
export const MOVE_QUIET = 3;         // клітинок за хід тихо (без шуму)
export const NADE_MOVE_COST = 2;     // кидок гранати під час руху забирає 2 клітинки
export const HIDE_STEPS = 2;         // на скільки клітинок можна відскочити в дуелі
export const ROUND_TIME = 115;       // 1:55 як у CS2
export const MOVE_TIME = 10;
export const DUEL_TIME = 5;
export const BOMB_TIME = 40;
export const DEFUSE_TIME = 10;
export const KIT_DEFUSE_TIME = 5;
export const ROUNDS_TOTAL = 12;      // зміна сторін після 6-го раунду
export const ROUNDS_TO_WIN = 7;
export const THROW_RANGE = 9;
export const BUY_SECONDS = 20;
export const PLAN_SECONDS = 25;
export const DUEL_SECONDS = 20;

// Зброя як у CS2: шкода за кулю, пробиття броні, множник у голову.
// bullets — кулі в черзі (кожна = свій кидок d20), aim — бонус до кидка, range — дистанція без штрафу.
export const WEAPONS = {
  glock: { name: 'Glock-18',  slot: 'pistol',  side: 'T',  price: 200,  bullets: 2, dmg: 30, aim: 0, range: 7,  pen: 0.47,  head: 4, kill: 300 },
  usp:   { name: 'USP-S',     slot: 'pistol',  side: 'CT', price: 200,  bullets: 2, dmg: 35, aim: 1, range: 8,  pen: 0.505, head: 4, kill: 300 },
  ak47:  { name: 'AK-47',     slot: 'primary', side: 'T',  price: 2700, bullets: 3, dmg: 36, aim: 1, range: 14, pen: 0.775, head: 4, kill: 300 },
  m4a1s: { name: 'M4A1-S',    slot: 'primary', side: 'CT', price: 2900, bullets: 3, dmg: 38, aim: 2, range: 14, pen: 0.7,   head: 4, kill: 300 },
};

export const GRENADES = {
  he:    { name: 'Осколкова', short: 'HE',   price: 300, radius: 2, desc: 'До 57 шкоди поруч' },
  flash: { name: 'Флешка',    short: 'Флеш', price: 200, radius: 4, desc: 'Сліпить: −8 до кидків' },
  smoke: { name: 'Димова',    short: 'Дим',  price: 300, radius: 2, desc: 'Закриває огляд на 30 с' },
  molly: { name: 'Коктейль',  short: 'Моло', price: 400, radius: 1, desc: 'Вогонь на 20 с, −8 HP за 5 с' },
};
export const SMOKE_TIME = 30;
export const FIRE_TIME = 20;
export const FIRE_DAMAGE = 8;        // за кожні 5 с у вогні
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

// Модифікатори кидка
export const BASE_NEED = 10;   // скільки треба викинути (d20 + бонуси) для влучання
export const SPRAY = 2;        // кожна наступна куля черги −2
export const COVER = 4;        // ціль за ящиком
export const HELD = 2;         // тримав кут (не рухався в цей хід) — перший обмін
export const RAN = 2;          // вибіг на контакт бігом — перший обмін
export const FLASHED = 8;
export const HEAD_MARGIN = 10; // хедшот: натуральна 20 або результат ≥ потрібного + 10
export const HIDE_GOOD = 8;    // вдале ухилення (d20 ≥ 8): по тобі −8
export const HIDE_BAD = 3;     // невдале: −3, але все одно відходиш
export const HIDE_ROLL = 8;
export const NADE_ROLL = 8;    // граната лягає точно, якщо d20 ≥ 8

export function lossBonus(streak) {
  return Math.min(ECONOMY.lossMax, ECONOMY.lossBase + ECONOMY.lossStep * Math.max(0, streak - 1));
}

export function sideCanBuy(itemSide, side) { return !itemSide || itemSide === side; }

// Розрахунок пострілу: модифікатори і потрібне значення для кожної кулі.
// o: { weapon, dist, cover, held, ran, flashed, hiding: 0|HIDE_BAD|HIDE_GOOD }
export function shotSetup(o) {
  const w = WEAPONS[o.weapon];
  const mods = [[w.name, w.aim]];
  if (o.held) mods.push(['Тримав кут', HELD]);
  if (o.ran) mods.push(['Вибіг на бігу', -RAN]);
  if (o.flashed) mods.push(['Осліплений', -FLASHED]);
  const far = Math.max(0, Math.ceil((o.dist - w.range) / 2));
  if (far) mods.push(['Далеко', -far]);
  if (o.cover) mods.push(['Ціль за ящиком', -COVER]);
  if (o.hiding) mods.push([o.hiding === HIDE_GOOD ? 'Ціль ухилилась' : 'Ціль відходить', -o.hiding]);
  const bonus = mods.reduce((a, m) => a + m[1], 0);
  return { mods, bonus, need: BASE_NEED, bullets: w.bullets };
}

// Результат однієї кулі
export function bulletResult(roll, bonus, need, k) {
  const total = roll + bonus - SPRAY * k;
  const hit = roll === 20 || (roll !== 1 && total >= need);
  const head = hit && (roll === 20 || total >= need + HEAD_MARGIN);
  return { roll, total, hit, head };
}

// Шкода кулі з урахуванням броні
export function bulletDamage(weapon, head, armor) {
  const w = WEAPONS[weapon];
  let d = w.dmg * (head ? w.head : 1);
  if (head ? armor >= 2 : armor >= 1) d *= w.pen;
  return Math.round(d);
}

// Шанс влучити хоча б одною кулею і шанс хедшота (для підказки в інтерфейсі)
export function shotChance(setup) {
  let missAll = 1, noHead = 1, perBullet = [];
  for (let k = 0; k < setup.bullets; k++) {
    let hit = 0, head = 0;
    for (let r = 1; r <= 20; r++) {
      const b = bulletResult(r, setup.bonus, setup.need, k);
      if (b.hit) hit++;
      if (b.head) head++;
    }
    perBullet.push(hit / 20);
    missAll *= 1 - hit / 20;
    noHead *= 1 - head / 20;
  }
  return { any: 1 - missAll, head: 1 - noHead, perBullet };
}
