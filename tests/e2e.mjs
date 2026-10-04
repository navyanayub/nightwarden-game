#!/usr/bin/env node
/**
 * End-to-end smoke test + screenshot capture.
 *  - serves the built /docs folder with `vite preview` (base /nightwarden-game/)
 *  - loads the game headlessly in Chromium using SwiftShader (software WebGL2)
 *  - waits for loading to finish, fails on any console error / page error
 *  - with --screenshots: captures street, skyline, harbour and driving views to /screenshots
 * Usage: npm run build && npm run test:e2e   |   npm run screenshots
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const SHOTS = args.includes('--screenshots');
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7);
const PRESET = args.find((a) => a.startsWith('--preset='))?.slice(9) ?? 'high';
const EXTRA = args.find((a) => a.startsWith('--query='))?.slice(8) ?? '';
const W = Number(args.find((a) => a.startsWith('--width='))?.slice(8) ?? 1280);
const H = Number(args.find((a) => a.startsWith('--height='))?.slice(9) ?? 720);
const PORT = 4173;
const SUFFIX = args.find((a) => a.startsWith('--suffix='))?.slice(9) ?? '';
const URL_BASE = `http://localhost:${PORT}/nightwarden-game/`;

function startServer() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server timeout')), 30000);
    const onData = (d) => {
      if (String(d).includes(String(PORT))) {
        clearTimeout(t);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
  });
}

const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  const warnings = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    else if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  const t0 = Date.now();
  await page.goto(`${URL_BASE}?auto&capture&preset=${PRESET}${EXTRA ? '&' + EXTRA : ''}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__NW && (window.__NW.ready || window.__NW.error), null, { timeout: 600000, polling: 1000 });
  const state = await page.evaluate(() => ({ ready: window.__NW.ready, error: window.__NW.error, gl: (() => { const c = document.createElement('canvas').getContext('webgl2'); return c ? c.getParameter(c.VERSION) : 'none'; })() }));
  console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`, state);
  // Let a few frames render.
  await page.waitForTimeout(3000);
  const info = await page.evaluate(() => {
    const g = window.__NW.game;
    return { fps: g.loop.fps, calls: g.renderer.renderer.info.render.calls, tris: g.renderer.renderer.info.render.triangles, buildings: g.world.stats.buildings, chunks: g.world.stats.chunks };
  });
  console.log('render info', info);

  // Functional checks (deterministic: steps the simulation directly, independent of frame rate).
  const func = await page.evaluate(() => {
    const g = window.__NW.game;
    g.loop.paused = true;
    const p0 = g.player.position.clone();
    g.input.forced = { moveY: 1, moveX: 0 };
    g.simulate(2);
    const walked = g.player.position.distanceTo(p0);
    g.input.forced = { moveY: 1, moveX: 0, sprint: true };
    const p1 = g.player.position.clone();
    g.simulate(2);
    const sprinted = g.player.position.distanceTo(p1);
    g.input.forced = { moveY: 0, moveX: 0 };
    g.simulate(0.5);
    const y0 = g.player.position.y;
    g.input.trigger('jump');
    g.simulate(0.3);
    const jumpH = g.player.position.y - y0;
    g.simulate(1.5);
    const landed = Math.abs(g.player.position.y - y0) < 0.3;
    g.input.forced = null;
    // Drive.
    const v = g.vehicles[0];
    g.teleportPlayer(v.position.x + 2.5, v.position.z, 0);
    g.enterVehicle(0);
    const mode = g.mode;
    const c0 = v.sim.curPos.clone();
    g.autoDrive = { throttle: 1, steer: 0, brake: 0, handbrake: false };
    g.simulate(4);
    const kmh = Math.abs(v.sim.speed * 3.6);
    const drove = v.sim.curPos.distanceTo(c0);
    g.autoDrive = { throttle: 0, steer: 0, brake: 1, handbrake: false };
    g.simulate(2.6);
    const stopped = Math.abs(v.sim.speed * 3.6);
    g.autoDrive = null;
    g.exitVehicle();
    const exited = g.mode === 'foot';
    g.loop.paused = false;
    return { walked: +walked.toFixed(2), sprinted: +sprinted.toFixed(2), jumpH: +jumpH.toFixed(2), landed, mode, drove: +drove.toFixed(1), kmh: +kmh.toFixed(1), stopped: +stopped.toFixed(1), exited };
  });
  console.log('functional', func);
  const funcOk = func.walked > 3 && func.sprinted > func.walked && func.jumpH > 0.4 && func.landed && func.mode === 'drive' && func.drove > 15 && func.kmh > 40 && func.stopped < func.kmh * 0.2 && func.exited;
  if (!funcOk) errors.push(`functional check failed: ${JSON.stringify(func)}`);

  // Stage 2: living city (traffic, signals, hijacking, crowds, time, weather).
  const living = await page.evaluate(() => {
    const g = window.__NW.game;
    g.loop.paused = true;
    const s = g.world.city.spawn;
    g.teleportPlayer(s.x, s.z, Math.PI);
    g.setTime(12);
    g.setWeather('partly');
    g.warmAI(60);
    const t = g.traffic;
    const cars = t.cars.length;
    const moving = t.cars.filter((c) => c.speed > 1).length;
    // Nobody inside a junction on a red light that they entered long ago (signal discipline).
    let redRunners = 0;
    for (const c of t.cars) {
      const p = c.path;
      if (p.node && p.node.signal && c.s > 6 && c.speed > 3) {
        const phase = g.__signalState(p.node, p.axis, t.time);
        if (phase === 0 && p.length - c.s > p.length * 0.6) redRunners++;
      }
    }
    // Hijack the nearest traffic car.
    const near = t.cars.filter((c) => !c.bus && c.state === 'drive').sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0];
    const pedsBefore = g.crowd.peds.length;
    g.teleportPlayer(near.x + Math.cos(near.yaw) * 2.2, near.z - Math.sin(near.yaw) * 2.2, 0);
    near.speed = 0;
    const kind = near.spec.kind;
    g.takeNearestTraffic();
    const hijacked = g.mode === 'drive' && g.current && g.current.spec.kind === kind;
    const fled = g.crowd.peds.filter((p) => p.state === 'flee').length;
    g.exitVehicle();
    // Crowd reacts to a gunshot.
    g.warmAI(5);
    const peds = g.crowd.peds.length;
    const states = Object.keys(g.crowd.stateCounts).length;
    g.gunshot();
    g.warmAI(0.5);
    const fleeing = g.crowd.peds.filter((p) => p.state === 'flee' || p.state === 'cower').length;
    // Time of day + weather.
    g.setTime(23);
    const night = { lamps: g.world.nightLights.lights.filter((l) => l.intensity > 1).length, exposure: g.renderer.atmosphere.exposure };
    g.setTime(12);
    g.setWeather('heavyrain');
    g.env.update(0.1, g.player.position, false, false);
    const rain = { drops: g.env.fx.rainCount, wet: +g.env.wetness.toFixed(2) };
    g.setWeather('partly');
    g.loop.paused = false;
    return { cars, moving, redRunners, buses: t.cars.filter((c) => c.bus).length, busStops: t.busStops.length, hijacked, kind, fled, pedsBefore, peds, states, fleeing, night, rain };
  });
  console.log('living city', living);
  const livingOk = living.cars > 30 && living.moving > living.cars * 0.3 && living.redRunners <= 2 && living.buses >= 2 && living.hijacked && living.fled >= 1 && living.peds > 30 && living.states >= 3 && living.fleeing > 5 && living.rain.drops > 1000 && living.rain.wet > 0.5;
  if (!livingOk) errors.push(`living-city check failed: ${JSON.stringify(living)}`);

  // Performance log (High preset, busy Midtown, 60+ cars / 150+ pedestrians around).
  const perf = await page.evaluate(async () => {
    const g = window.__NW.game;
    const s = g.world.city.spawn;
    g.clearDebugCamera();
    g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
    g.crowd.maxPeds = Math.max(g.crowd.maxPeds, 170);
    g.traffic.maxCars = Math.max(g.traffic.maxCars, 90);
    g.setTime(13);
    g.warmAI(40);
    const frames0 = g.loop.frames;
    const t0 = performance.now();
    while (performance.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 500));
    const wall = (performance.now() - t0) / 1000;
    const cam = g.renderer.camera;
    const fr = new g.__THREE.Frustum().setFromProjectionMatrix(new g.__THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const carsOnScreen = g.traffic.cars.filter((c) => fr.containsPoint(new g.__THREE.Vector3(c.x, c.y + 1, c.z))).length;
    const info = g.renderer.renderer.info.render;
    return {
      preset: 'high',
      avgFps: +((g.loop.frames - frames0) / wall).toFixed(3),
      frames: g.loop.frames - frames0,
      seconds: +wall.toFixed(1),
      trianglesPerCar: [0, 2, 4, 8].map((k) => g.traffic.render.triangles(k)),
      cpuUpdateMs: +g.perf.update.toFixed(2),
      trafficMs: +g.perf.traffic.toFixed(2),
      crowdMs: +g.perf.crowd.toFixed(2),
      renderSubmitMs: +g.perf.render.toFixed(1),
      cars: g.traffic.cars.length,
      carsOnScreen,
      peds: g.crowd.peds.length,
      pedsDrawn: g.crowd.render.stats.drawn + 0,
      drawCalls: info.calls,
      triangles: info.triangles,
    };
  });
  console.log('PERF', JSON.stringify(perf));
  fs.writeFileSync(path.join(ROOT, 'screenshots', 'perf-high.json'), JSON.stringify(perf, null, 2));

  if (SHOTS) {
    const dir = path.join(ROOT, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const settle = async (ms = 2500) => {
      await page.evaluate(() => window.__NW.game.primeWorld());
      await page.waitForTimeout(ms);
    };
    const shot = async (name, fn, ms) => {
      if (ONLY && !name.includes(ONLY)) return;
      await page.evaluate(fn);
      await settle(ms);
      await page.screenshot({ path: path.join(dir, `${name}${SUFFIX}.png`) });
      console.log('screenshot', name);
    };
    await shot('01-street-day', () => {
      const g = window.__NW.game;
      g.clearDebugCamera();
      const s = g.world.city.spawn;
      g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
      g.rig.pitch = -0.08;
    }, 6000);
    await shot('02-skyline', () => window.__NW.game.setDebugCamera(760, 70, 420, 60, 70, -120));
    await shot('03-harbour', () => window.__NW.game.setDebugCamera(470, 30, 600, 200, 8, 760));
    await shot('04-oldtown-clocktower', () => {
      const g = window.__NW.game;
      const ct = g.world.city.features.find((f) => f.type === 'clocktower');
      g.setDebugCamera(ct.x + 45, ct.y + 14, ct.z + 55, ct.x, ct.y + 28, ct.z);
    });
    await shot('07-overhead-square', () => {
      const g = window.__NW.game;
      const ct = g.world.city.features.find((f) => f.type === 'clocktower');
      g.setDebugCamera(ct.x + 25, ct.y + 110, ct.z + 60, ct.x, ct.y, ct.z);
    });
    await shot('09-square-street', () => {
      const g = window.__NW.game;
      g.clearDebugCamera();
      const ct = g.world.city.features.find((f) => f.type === 'clocktower');
      g.teleportPlayer(ct.x + 14, ct.z + 22, Math.PI * 0.8, Math.PI * 0.15);
      g.rig.pitch = -0.18;
    }, 5000);
    await shot('10-park-lake', () => window.__NW.game.setDebugCamera(380, 30, -380, 520, 2, -520));
    await shot('11-hills', () => window.__NW.game.setDebugCamera(-200, 45, -360, -420, 20, -620));
    await shot('12-airfield', () => window.__NW.game.setDebugCamera(1700, 45, 820, 1800, 3, 200));
    await shot('13-character', () => {
      const g = window.__NW.game;
      const ct = g.world.city.features.find((f) => f.type === 'clocktower');
      g.clearDebugCamera();
      g.teleportPlayer(ct.x + 14, ct.z + 22, 0);
      const p = g.player.position;
      g.setDebugCamera(p.x + 1.6, p.y + 1.55, p.z + 3.2, p.x, p.y + 1.0, p.z);
    });
    await shot('14-sedan', () => {
      const g = window.__NW.game;
      const v = g.vehicles[1];
      const p = v.position;
      const yaw = v.sim.yaw;
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      g.setDebugCamera(p.x + fx * 4.2 + fz * 3.4, p.y + 1.4, p.z + fz * 4.2 - fx * 3.4, p.x, p.y + 0.6, p.z);
    });
    await shot('05-bridge', () => window.__NW.game.setDebugCamera(820, 40, 80, 1000, 40, -85));
    await shot('06-driving', () => {
      const g = window.__NW.game;
      g.clearDebugCamera();
      const v = g.vehicles[0];
      g.teleportPlayer(v.position.x + 2, v.position.z, 0);
      g.enterVehicle(0);
      g.autoDrive = { throttle: 0.7, steer: 0, brake: 0, handbrake: false };
    }, 5000);
    await page.evaluate(() => {
      const g = window.__NW.game;
      g.autoDrive = null;
      g.exitVehicle();
    });
    // Stage 2 views.
    await shot('15-busy-intersection-day', () => {
      const g = window.__NW.game;
      g.setTime(12.5);
      g.setWeather('partly');
      const n = g.gotoJunction();
      g.warmAI(45);
      g.setDebugCamera(n.x + 34, 15, n.z + 30, n.x - 4, 1, n.z - 4);
    }, 9000);
    await shot('16-night-skyline', () => {
      const g = window.__NW.game;
      g.setWeather('clear');
      g.setTime(22.4);
      g.setDebugCamera(760, 70, 420, 60, 70, -120);
    }, 9000);
    await shot('17-rain-night-street', () => {
      const g = window.__NW.game;
      g.setWeather('heavyrain');
      g.setTime(22);
      const n = g.gotoJunction();
      g.warmAI(30);
      g.setDebugCamera(n.x + 16, 3.2, n.z + 20, n.x - 10, 2.2, n.z - 12);
    }, 9000);
    await shot('18-sunset-harbour', () => {
      const g = window.__NW.game;
      g.setWeather('partly');
      g.setTime(18.35);
      g.setDebugCamera(620, 22, 690, 250, 8, 820);
    }, 9000);
    await shot('19-dawn-fog-harbour', () => {
      const g = window.__NW.game;
      g.setWeather('clear');
      g.setTime(6.4);
      g.env.forceFogBank(1);
      g.setDebugCamera(520, 26, 600, 260, 4, 900);
    }, 9000);
    await shot('20-storm-lightning', () => {
      const g = window.__NW.game;
      g.setWeather('storm');
      g.setTime(16.5);
      g.setDebugCamera(640, 26, 520, 120, 70, -60);
      g.lightning(true);
    }, 6000);
    await page.evaluate(() => window.__NW.game.lightning(false));
    await shot('21-vehicle-lineup', () => {
      const g = window.__NW.game;
      g.setWeather('clear');
      g.setTime(11);
      const ct = g.world.city.features.find((f) => f.type === 'clocktower');
      const sq = g.world.city.blocks.find((b) => b.kind === 'square');
      const x = sq.minX + sq.sidewalk + 6;
      const z = sq.minZ + sq.sidewalk + 8;
      g.traffic.parkShowcase(x, z, Math.PI / 2, ct.y + 0.15);
      g.teleportPlayer(x + 30, z + 14, 0);
      g.setDebugCamera(x + 28, ct.y + 7, z + 27, x + 27, ct.y + 0.8, z);
    }, 6000);
    await shot('22-crowd', () => {
      const g = window.__NW.game;
      g.setWeather('partly');
      g.setTime(13);
      const n = g.gotoJunction();
      g.warmAI(30);
      const p = g.player.position;
      g.setDebugCamera(p.x + 9, p.y + 3.2, p.z + 9, p.x - 6, p.y + 1, p.z - 6);
    }, 8000);
    await shot('23-rain-umbrellas', () => {
      const g = window.__NW.game;
      g.setWeather('lightrain');
      g.setTime(14);
      g.warmAI(20);
      const p = g.player.position;
      g.setDebugCamera(p.x + 10, p.y + 3.5, p.z + 10, p.x - 6, p.y + 1, p.z - 6);
    }, 8000);
    await page.evaluate(() => {
      const g = window.__NW.game;
      g.setWeather('partly');
      g.setTime(12);
      g.clearDebugCamera();
    });
    if (!ONLY || 'ui'.includes(ONLY) || ONLY.startsWith('ui')) {
      // UI flow on a fresh, non-automated page: loading screen, click to play, H, Esc, F3.
      await page.close();
      const ui = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      ui.on('console', (m) => m.type() === 'error' && errors.push(`[ui] ${m.text()}`));
      ui.on('pageerror', (e) => errors.push(`[ui] pageerror: ${e.message}`));
      await ui.goto(`${URL_BASE}?capture&preset=${PRESET}`, { waitUntil: 'load', timeout: 180000 });
      await ui.waitForFunction(() => window.__NW && window.__NW.ready, null, { timeout: 600000, polling: 1000 });
      await ui.waitForTimeout(1500);
      await ui.screenshot({ path: path.join(dir, 'ui-01-loading.png') });
      await ui.click('.start', { timeout: 120000 });
      await ui.waitForTimeout(2500);
      await ui.keyboard.press('KeyH');
      await ui.waitForTimeout(1500);
      await ui.screenshot({ path: path.join(dir, 'ui-02-controls.png') });
      await ui.keyboard.press('KeyH');
      await ui.keyboard.press('Escape');
      await ui.waitForTimeout(1500);
      await ui.screenshot({ path: path.join(dir, 'ui-03-pause.png') });
      const paused = await ui.evaluate(() => window.__NW.game.loop.paused);
      await ui.click('button[data-preset="medium"]', { timeout: 120000 });
      await ui.waitForTimeout(1500);
      const preset = await ui.evaluate(() => window.__NW.game && JSON.parse(localStorage.getItem('nightwarden.settings.v1') || '{}').preset);
      await ui.click('button[data-act="resume"]', { timeout: 120000 });
      await ui.waitForTimeout(1000);
      await ui.keyboard.press('F3');
      await ui.waitForTimeout(2500);
      await ui.screenshot({ path: path.join(dir, 'ui-04-stats.png') });
      await ui.keyboard.press('KeyM');
      await ui.waitForTimeout(2500);
      await ui.screenshot({ path: path.join(dir, 'ui-05-map.png') });
      await ui.keyboard.press('KeyM');
      await ui.waitForTimeout(1000);
      const resumed = await ui.evaluate(() => !window.__NW.game.loop.paused);
      console.log('ui flow', { paused, preset, resumed });
      if (!paused || preset !== 'medium' || !resumed) errors.push(`ui flow failed ${JSON.stringify({ paused, preset, resumed })}`);
      await ui.evaluate(() => localStorage.removeItem('nightwarden.settings.v1'));
      await ui.close();
      console.log('screenshot ui-*');
    }
  }
  console.log(`console errors: ${errors.length}, warnings: ${warnings.length}`);
  for (const e of errors) console.log('  ERROR', e);
  for (const w of [...new Set(warnings)].slice(0, 15)) console.log('  warn', w);
  await browser.close();
  server.kill();
  process.exit(state.error || errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
