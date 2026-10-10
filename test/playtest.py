import asyncio, sys, time
from playwright.async_api import async_playwright
SP = sys.argv[1]; W = int(sys.argv[2]); H = int(sys.argv[3]); MAXT = int(sys.argv[4])
PREFIX = 'm' if W < 600 else 'd'
PICK = """async () => {
  const g = window.dfz; const X = await import('/shared/hex.js');
  const reach = g.reachable(); if (!reach) return null;
  const me = g.me; const goal = [...X.HEXES.values()].filter(h => h.site === 'B');
  const gx = goal.reduce((a,h)=>a+h.x,0)/goal.length, gy = goal.reduce((a,h)=>a+h.y,0)/goal.length;
  let best=null, bd=1e9;
  for (const k of reach.dist.keys()) { const h = X.HEXES.get(k); const d = Math.hypot(h.x-gx,h.y-gy); if (d<bd){bd=d;best=h;} }
  if (!best || X.key(best.c,best.r)===me.hex) return null;
  const p = g.world.project(best.x, 0, best.y);
  const r = g.labels.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y, k: X.key(best.c,best.r) };
}"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        mob = W < 600
        ctx = await b.new_context(viewport={'width': W, 'height': H}, device_scale_factor=2 if mob else 1, is_mobile=mob, has_touch=mob)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERR ' + str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'ERR_TUNNEL' not in m.text else None)
        await pg.goto('http://localhost:3011/')
        await pg.fill('#guestName', 'Влад'); await pg.click('#guestForm button'); await pg.wait_for_timeout(600)
        await pg.click('#soloBtn'); await pg.wait_for_timeout(2500)
        await pg.screenshot(path=f'{SP}/shots/{PREFIX}_buy.png')
        t0 = time.time(); n = {'act': 0, 'atk': 0, 'wait': 0, 'misstap': 0}; rounds = set()
        while time.time() - t0 < MAXT:
            if await pg.locator('#tip button').is_visible():
                if n.get('tip',0) < 2: n['tip']=n.get('tip',0)+1; await pg.screenshot(path=f'{SP}/shots/{PREFIX}_tip{n["tip"]}.png')
                await pg.click('#tip button')
            st = await pg.evaluate("() => { const g = window.dfz; if (!g || !g.view) return null; const v = g.view; return { phase: v.phase, my: g.myTurn(), pend: v.pending ? {from: v.pending.from, to: v.pending.to, stage: v.pending.stage} : null, me: v.me, alive: g.me && g.me.alive, round: v.round, buy: !document.getElementById('buySheet').hidden, ap: g.ap(), walking: g.world.anyWalking() } }")
            if not st: await pg.wait_for_timeout(500); continue
            if st['phase'] == 'buy':
                if st['buy']: await pg.click('#buySheet .buyfoot .btn.primary')
                else: await pg.evaluate("() => dfz.emit('game:buyReady', {ready:true})")
            elif st['phase'] == 'play' and await pg.locator('#panel .btn.roll').count() and not await pg.locator('#panel .btn.roll').first.is_disabled() and 'Стріляти' not in (await pg.locator('#panel .btn.roll').first.inner_text()):
                n['atk'] += 1
                if n['atk'] <= 4: await pg.screenshot(path=f'{SP}/shots/{PREFIX}_atk{n["atk"]}.png')
                await pg.click('#panel .btn.roll'); await pg.wait_for_timeout(1500)
                if n['atk'] <= 4: await pg.screenshot(path=f'{SP}/shots/{PREFIX}_atk{n["atk"]}b.png')
            elif st['my'] and not st['walking']:
                await pg.wait_for_timeout(400)
                n['act'] += 1
                if n['act'] <= 4: await pg.screenshot(path=f'{SP}/shots/{PREFIX}_act{n["act"]}.png')
                if await pg.locator('#panel .btn.big.plant, #panel .btn.big.defuse').count() and not await pg.locator('#panel .btn.big.plant, #panel .btn.big.defuse').first.is_disabled():
                    await pg.click('#panel .btn.big.plant, #panel .btn.big.defuse')
                elif await pg.locator('#panel .act2.shoot').count():
                    await pg.click('#panel .act2.shoot'); await pg.wait_for_timeout(300)
                    if n['act'] <= 8: await pg.screenshot(path=f'{SP}/shots/{PREFIX}_aim{n["act"]}.png')
                    btn = pg.locator('#panel .target .btn.roll')
                    if await btn.is_disabled(): await pg.click('#panel .act2.end')
                    else: await btn.click()
                else:
                    pick = await pg.evaluate(PICK)
                    if pick:
                        if mob: await pg.touchscreen.tap(pick['x'], pick['y'])
                        else: await pg.mouse.click(pick['x'], pick['y'])
                        await pg.wait_for_timeout(300)
                        if n['act'] <= 4: await pg.screenshot(path=f'{SP}/shots/{PREFIX}_sel{n["act"]}.png')
                        if await pg.locator('#panel .btn.big.primary', has_text='Йти').count(): await pg.click('#panel .btn.big.primary >> text=Йти')
                        else: n['misstap'] += 1; await pg.click('#panel .act2.end')
                    else: await pg.click('#panel .act2.end')
                await pg.wait_for_timeout(500)
            elif st['phase'] in ('roundOver', 'over') and st['round'] not in rounds:
                rounds.add(st['round']); await pg.wait_for_timeout(3000)
                await pg.screenshot(path=f'{SP}/shots/{PREFIX}_round{st["round"]}.png')
                if len(rounds) >= 2 or st['phase'] == 'over': break
            else:
                n['wait'] += 1
                if n['wait'] in (5, 40): await pg.screenshot(path=f'{SP}/shots/{PREFIX}_wait{n["wait"]}.png')
            await pg.wait_for_timeout(400)
        print('n', n, 'rounds', rounds, 'errors', errs[:8])
        await b.close()
asyncio.run(main())
