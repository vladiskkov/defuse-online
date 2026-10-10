// Симуляція матчів ботів: перевіряє, що рушій не падає і раунди закінчуються.
// Запуск: node test/sim.js [кількість матчів]
import assert from 'node:assert/strict';
import { Match } from '../server/game/engine.js';
import { botBuy, botAct } from '../server/game/bot.js';
import { ZONE } from '../shared/zones.js';
import * as R from '../shared/rules.js';

function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function playMatch(size, seed) {
  const players = [];
  for (let i = 0; i < size * 2; i++) players.push({ id: 'b' + i, name: 'Бот ' + i, isBot: true, squad: i % 2 });
  const m = new Match({ players, rng: mulberry(seed) });
  const st = { reasons: {}, turns: 0, fights: 0, rounds: 0, shots: 0, hits: 0, heads: 0, nades: 0, plants: 0, retreats: 0 };
  while (m.phase !== 'over') {
    m.startRound();
    for (const p of m.players) botBuy(m, p);
    for (const p of m.players) assert.ok(p.money >= 0, 'money negative');
    m.endBuy();
    let guard = 0;
    while (m.phase === 'move' || m.phase === 'duel') {
      const kind = m.phase;
      for (const p of m.players) if (p.alive) botAct(m, p);
      const { events } = kind === 'move' ? m.resolveMove() : m.resolveFight();
      if (kind === 'move') st.turns++; else st.fights++;
      for (const e of events) {
        if (e.type === 'shot' && e.vs !== 'retreat') { st.shots++; if (e.hit) st.hits++; if (e.head) st.heads++; }
        if (e.type === 'nade') st.nades++;
        if (e.type === 'planted') st.plants++;
        if (e.type === 'retreat') st.retreats++;
      }
      for (const p of m.players) {
        assert.ok(p.hp >= 0 && p.hp <= R.HP);
        if (p.alive) assert.ok(ZONE[p.zone], 'bad zone ' + p.zone);
        m.viewFor(p.id);
      }
      assert.ok(++guard < 80, 'round never ends');
    }
    st.rounds++;
    const r = m.roundResult;
    st.reasons[r.winner + ':' + r.reason] = (st.reasons[r.winner + ':' + r.reason] || 0) + 1;
  }
  assert.ok(m.matchResult);
  return { m, st };
}

const N = Number(process.argv[2] || 60);
const T = { reasons: {}, turns: 0, fights: 0, rounds: 0, shots: 0, hits: 0, heads: 0, nades: 0, plants: 0, retreats: 0, sq: [0, 0, 0] };
for (let i = 0; i < N; i++) {
  const { m, st } = playMatch(1 + (i % 3), i + 1);
  for (const k of ['turns', 'fights', 'rounds', 'shots', 'hits', 'heads', 'nades', 'plants', 'retreats']) T[k] += st[k];
  for (const [r, v] of Object.entries(st.reasons)) T.reasons[r] = (T.reasons[r] || 0) + v;
  T.sq[m.matchResult.winSquad === null ? 2 : m.matchResult.winSquad]++;
}
console.log(`матчів: ${N}, раундів: ${T.rounds}; на раунд: ходів ${(T.turns / T.rounds).toFixed(1)}, обмінів у перестрілках ${(T.fights / T.rounds).toFixed(1)}`);
console.log(`пострілів ${T.shots}: влучань ${(100 * T.hits / T.shots).toFixed(0)}%, хедшотів ${(100 * T.heads / Math.max(1, T.hits)).toFixed(0)}% від влучань; гранат ${T.nades}, закладок ${T.plants}, відступів ${T.retreats}`);
console.log('результати раундів:', T.reasons);
console.log(`перемоги: команда 1 — ${T.sq[0]}, команда 2 — ${T.sq[1]}, нічиї — ${T.sq[2]}`);
console.log('OK');
