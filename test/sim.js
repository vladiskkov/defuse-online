// Симуляція матчів ботів: перевіряє, що рушій не падає і раунди закінчуються.
// Запуск: node test/sim.js [кількість матчів]
import assert from 'node:assert/strict';
import { Match } from '../server/game/engine.js';
import { botBuy, botStep } from '../server/game/bot.js';
import * as X from '../shared/hex.js';
import * as R from '../shared/rules.js';

function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function playMatch(size, seed) {
  const players = [];
  for (let i = 0; i < size * 2; i++) players.push({ id: 'b' + i, name: 'Бот ' + i, isBot: true, squad: i % 2 });
  const m = new Match({ players, rng: mulberry(seed) });
  const st = { reasons: {}, turns: 0, rounds: 0, attacks: 0, dmg: 0, kills: 0, nades: 0, plants: 0, snaps: 0 };
  while (m.phase !== 'over') {
    m.startRound();
    for (const p of m.players) botBuy(m, p);
    m.endBuy();
    let guard = 0;
    while (m.phase === 'play') {
      assert.ok(botStep(m), 'nobody to act');
      for (const p of m.players) {
        assert.ok(p.hp >= 0 && p.hp <= R.HP);
        if (p.alive) assert.ok(X.walkable(X.HEXES.get(p.hex)), 'bad hex ' + p.hex);
      }
      const hexes = m.players.filter((p) => p.alive).map((p) => p.hex);
      assert.equal(new Set(hexes).size, hexes.length, 'two units in one hex');
      if (guard % 7 === 0) for (const p of m.players) m.viewFor(p.id);
      assert.ok(++guard < 600, 'round never ends');
    }
    for (const e of m.events) {
      if (e.type === 'result') { st.attacks++; st.dmg += e.damage; }
      if (e.type === 'kill') st.kills++;
      if (e.type === 'nade') st.nades++;
      if (e.type === 'planted') st.plants++;
      if (e.type === 'snap') st.snaps++;
    }
    st.turns += m.turn; st.rounds++;
    const r = m.roundResult;
    st.reasons[r.winner + ':' + r.reason] = (st.reasons[r.winner + ':' + r.reason] || 0) + 1;
  }
  assert.ok(m.matchResult);
  return { m, st };
}

const N = Number(process.argv[2] || 60);
const T = { reasons: {}, turns: 0, rounds: 0, attacks: 0, dmg: 0, kills: 0, nades: 0, plants: 0, snaps: 0, sq: [0, 0, 0] };
for (let i = 0; i < N; i++) {
  const { m, st } = playMatch(1 + (i % 3), i + 1);
  for (const k of ['turns', 'rounds', 'attacks', 'dmg', 'kills', 'nades', 'plants', 'snaps']) T[k] += st[k];
  for (const [r, v] of Object.entries(st.reasons)) T.reasons[r] = (T.reasons[r] || 0) + v;
  T.sq[m.matchResult.winSquad === null ? 2 : m.matchResult.winSquad]++;
}
console.log(`матчів: ${N}, раундів: ${T.rounds}; ходів на раунд ${(T.turns / T.rounds).toFixed(1)}`);
console.log(`пострілів ${T.attacks} (з кута ${T.snaps}), середня шкода ${(T.dmg / T.attacks).toFixed(1)}, вбивств ${T.kills}, гранат ${T.nades}, закладок ${T.plants}`);
console.log('результати раундів:', T.reasons);
console.log(`перемоги: команда 1 — ${T.sq[0]}, команда 2 — ${T.sq[1]}, нічиї — ${T.sq[2]}`);
console.log('OK');
