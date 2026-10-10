// Симуляція матчів ботів: перевіряє, що рушій не падає і раунди закінчуються.
// Запуск: node test/sim.js [кількість матчів]
import assert from 'node:assert/strict';
import { Match } from '../server/game/engine.js';
import { botBuy, botPlan } from '../server/game/bot.js';
import * as R from '../shared/rules.js';

function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function playMatch(size, seed) {
  const players = [];
  for (let i = 0; i < size * 2; i++) players.push({ id: 'b' + i, name: 'Бот ' + i, isBot: true, squad: i % 2 });
  const m = new Match({ players, rng: mulberry(seed) });
  const stats = { reasons: {}, turns: 0, rounds: 0, shots: 0, hits: 0, heads: 0, nades: 0, plants: 0 };
  while (m.phase !== 'over') {
    m.startRound();
    for (const p of m.players) botBuy(m, p);
    for (const p of m.players) assert.ok(p.money >= 0, 'money negative');
    m.endBuy();
    let guard = 0;
    while (m.phase === 'plan') {
      for (const p of m.players) if (p.alive) m.setPlan(p.id, { ...botPlan(m, p), ready: true });
      const { events } = m.resolveTurn();
      stats.turns++;
      for (const e of events) {
        if (e.type === 'shot') { stats.shots++; if (e.hit) stats.hits++; if (e.head) stats.heads++; }
        if (e.type === 'nade') stats.nades++;
        if (e.type === 'planted') stats.plants++;
        if (e.type === 'move') assert.ok(m.grid.walkable(e.x, e.y), 'walked into wall');
      }
      for (const p of m.players) {
        assert.ok(p.hp >= 0 && p.hp <= R.HP);
        // віди для кожного гравця мають будуватися без помилок
        m.viewFor(p.id);
      }
      assert.ok(++guard < 40, 'round never ends');
    }
    stats.rounds++;
    const r = m.roundResult;
    stats.reasons[r.winner + ':' + r.reason] = (stats.reasons[r.winner + ':' + r.reason] || 0) + 1;
  }
  assert.ok(m.matchResult);
  return { m, stats };
}

const N = Number(process.argv[2] || 60);
const total = { reasons: {}, turns: 0, rounds: 0, shots: 0, hits: 0, heads: 0, nades: 0, plants: 0, sq0: 0, sq1: 0, tie: 0 };
for (let i = 0; i < N; i++) {
  const size = 1 + (i % 3);
  const { m, stats } = playMatch(size, i + 1);
  for (const k of Object.keys(stats)) {
    if (k === 'reasons') for (const [r, v] of Object.entries(stats.reasons)) total.reasons[r] = (total.reasons[r] || 0) + v;
    else total[k] += stats[k];
  }
  if (m.matchResult.winSquad === 0) total.sq0++; else if (m.matchResult.winSquad === 1) total.sq1++; else total.tie++;
}
console.log(`матчів: ${N}, раундів: ${total.rounds}, ходів на раунд: ${(total.turns / total.rounds).toFixed(1)}`);
console.log(`влучань: ${(100 * total.hits / total.shots).toFixed(0)}%, хедшотів: ${(100 * total.heads / Math.max(1, total.hits)).toFixed(0)}% від влучань, гранат: ${total.nades}, закладок: ${total.plants}`);
console.log('результати раундів:', total.reasons);
console.log(`перемоги: команда 1 — ${total.sq0}, команда 2 — ${total.sq1}, нічиї — ${total.tie}`);
console.log('OK');
