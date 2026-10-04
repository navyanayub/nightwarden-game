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
const ONLY_LIST = args.find((a) => a.startsWith('--only='))?.slice(7).split(',');
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
    // (Another car may be marginally nearer than the one we stopped: any taken traffic car counts.)
    const hijacked = g.mode === 'drive' && !!g.current && g.current.fromTraffic === true;
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

  // Stage 3: the vigilante (suit, cape, traversal, combat, enemies, ragdolls, gore).
  const vig = await page.evaluate(() => {
    const g = window.__NW.game;
    const pl = g.player;
    const c = pl.cape;
    const p = pl.position;
    g.setWeather('partly');
    g.setTime(13);
    g.clearDebugCamera();
    const s = g.world.city.spawn;
    g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
    g.enemies.clear();
    const goreDefault = g.settings.gore;
    g.setHero(true);
    g.simulate(0.5);
    const cape = { maxStretch: 0, minBody: 9, nan: false, phases: {} };
    let phase = 'start';
    const ph = (n) => (phase = n);
    const track = () => {
      cape.maxStretch = Math.max(cape.maxStretch, c.stats.maxStretch);
      cape.minBody = Math.min(cape.minBody, c.stats.minBodyDist);
      const e = (cape.phases[phase] ??= { max: 0, min: 9, resets0: c.stats.resets, resets: 0 });
      e.max = +Math.max(e.max, c.stats.maxStretch).toFixed(2);
      e.min = +Math.min(e.min, c.stats.minBodyDist).toFixed(3);
      e.resets = c.stats.resets - e.resets0;
      for (let i = 0; i < c.positions.length; i += 97) if (!Number.isFinite(c.positions[i])) cape.nan = true;
    };
    const step = (secs) => {
      for (let t = 0; t < secs - 1e-6; t += 0.05) {
        g.simulate(0.05);
        track();
      }
    };
    const r0 = c.stats.resets;
    // Cape in a storm: stand, sprint, jump.
    ph('storm');
    g.setWeather('storm');
    step(1);
    g.input.forced = { moveY: 1, sprint: true };
    step(1.2);
    g.input.trigger('jump');
    step(1);
    g.input.forced = null;
    step(0.5);
    g.setWeather('partly');
    // Ledge: fall past a roof edge, grab, shimmy, climb.
    ph('ledge');
    const b = g.world.city.buildings.filter((bb) => bb.district === 'midtown' && bb.roof === 'flat' && bb.height > 15 && bb.height < 45 && bb.tiers.length <= 1).sort((a, d) => Math.hypot(a.cx - p.x, a.cz - p.z) - Math.hypot(d.cx - p.x, d.cz - p.z))[0];
    const roofHit = (x, z) => g.__probeLedge(new g.__THREE.Vector3(x, b.baseY + b.height - 2.1, z), new g.__THREE.Vector3(0, 0, -1), 1, 3.5, 2);
    const lp = roofHit(b.cx, b.cz + b.d / 2 + 0.5);
    const top = lp ? lp.top : b.baseY + b.height;
    pl.teleport(b.cx, top - 1.9, (lp ? lp.edge.z : b.cz + b.d / 2) + 0.55, Math.PI);
    g.rig.yaw = 0;
    step(0.3);
    const hung = pl.state === 'hang';
    g.input.forced = { moveX: 1 };
    const x0 = p.x;
    step(0.6);
    const shimmied = p.x - x0;
    g.input.forced = null;
    step(0.3);
    g.input.trigger('jump');
    step(1.2);
    const climbed = pl.state === 'move' && p.y > top - 0.3;
    // Grapple from the street to the same roof edge.
    ph('grapple');
    const gx = b.cx;
    const gz = b.cz + b.d / 2 + 14;
    g.teleportPlayer(gx, gz, Math.PI, 0);
    step(0.4);
    const cam = g.renderer.camera;
    cam.position.set(gx, p.y + 1.8, gz + 3);
    cam.lookAt(gx, top - 2, b.cz + b.d / 2);
    cam.updateMatrixWorld();
    for (let i = 0; i < 3; i++) pl.updateAim(cam);
    const grappleTarget = !!pl.grappleTarget;
    g.input.trigger('grapple');
    step(2.5);
    const grappled = p.y > top - 0.5;
    // Glide from height: speed builds in a dive, updrafts lift.
    ph('glide');
    pl.teleport(p.x, top + 60, p.z, Math.PI);
    step(0.5);
    g.input.forced = { hold: ['jump'], moveY: 0 };
    pl.debugGlide(Math.PI, 12);
    const y0 = p.y;
    step(2);
    const sink = (y0 - p.y) / 2;
    g.input.forced = { hold: ['jump'], moveY: 1 };
    step(1.5);
    const diveSpeed = pl.glide.speed;
    const glided = pl.state === 'glide' || pl.state === 'move';
    g.input.forced = null;
    step(3);
    const u = g.updrafts.list[0];
    const lift = g.updrafts.lift(u.x, u.y0 + 6, u.z);
    // Fight five thugs at the spawn.
    ph('fight');
    g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
    pl.health = 100;
    pl.armour = 60;
    step(0.5);
    const thugs = g.spawnFight(5, ['thug', 'brute', 'shield', 'thug', 'thug']);
    let counters = 0;
    let dodges = 0;
    let maxCombo = 0;
    let warned = 0;
    for (let i = 0; i < 70; i++) {
      const danger = g.enemies.thugs.some((t) => t.warn === 2 && t.dist < 5);
      const warn = g.enemies.thugs.some((t) => t.warn === 1);
      if (warn || danger) warned++;
      if (danger) {
        g.input.trigger('jump');
        dodges++;
      } else if (warn) {
        g.input.trigger('counter');
        counters++;
      } else if (i % 9 === 4) g.input.trigger('capeStun');
      else if (g.combat.finisherReady) g.input.trigger('finisher');
      else g.input.trigger('attack');
      step(0.3);
      maxCombo = Math.max(maxCombo, g.combat.combo);
    }
    const kos = thugs.filter((t) => t.ko).length;
    // Gadgets.
    g.combat.gadget = 'smoke';
    g.input.trigger('useGadget');
    step(0.3);
    const smoke = g.enemies.smokes.length > 0;
    // Ragdolls: knocked-out bodies settle on the ground, no NaN.
    ph('ragdoll');
    step(3);
    let ragOk = true;
    for (const t of thugs.filter((tt) => tt.ko)) {
      const rd = t.actor.rig.ragdoll;
      if (!rd) continue;
      const q = rd.pelvis.translation();
      const ground = g.__THREE ? t.pos.y : 0;
      if (!Number.isFinite(q.y) || q.y < ground - 0.6 || q.y > ground + 2.5) ragOk = false;
    }
    // A pedestrian hit by a car ragdolls, gets up (front or back) and runs.
    ph('ped');
    g.enemies.clear();
    g.warmAI(5);
    const pedHit = g.knockNearestPed(9);
    const pedDown = g.pedActors.length > 0 && g.pedActors[g.pedActors.length - 1].actor.down;
    step(8);
    const pedUp = g.pedActors.some((e) => e.up);
    // Player knock-down and get-up.
    ph('plko');
    pl.knockDown(new g.__THREE.Vector3(3, 2, 0), 0.3);
    const plDown = pl.state === 'ragdoll';
    step(5);
    const plUp = pl.state === 'move';
    // Gore: off by default; on → an extreme vehicle hit can detach a limb.
    ph('gore');
    g.settings.gore = true;
    const gt = g.spawnFight(1)[0];
    step(0.2);
    g.enemies.damage(gt, 99, gt.pos.clone().add(new g.__THREE.Vector3(3, 0, 0)), { kind: 'vehicle', knock: 25 });
    g.goreHit(gt.actor, 1);
    const goreCount = g.gore.count;
    step(1);
    g.settings.gore = false;
    g.enemies.clear();
    g.setHero(false);
    step(0.3);
    return {
      goreDefault,
      cape: { ...cape, resets: c.stats.resets - r0 },
      ledge: { hung, shimmied: +shimmied.toFixed(2), climbed },
      grapple: { grappleTarget, grappled },
      glide: { glided, sink: +sink.toFixed(2), diveSpeed: +diveSpeed.toFixed(1), lift: +lift.toFixed(1) },
      fight: { kos, maxCombo, counters, dodges, warned, smoke, health: Math.round(pl.health), hangouts: g.enemies.hangouts.length },
      ragOk,
      ped: { pedHit, pedDown, pedUp },
      player: { plDown, plUp },
      goreCount,
    };
  });
  console.log('vigilante', JSON.stringify(vig));
  const vigOk =
    vig.goreDefault === false &&
    !vig.cape.nan &&
    vig.cape.resets === 0 &&
    vig.cape.maxStretch < 4 &&
    vig.cape.minBody > -0.08 &&
    vig.ledge.hung &&
    vig.ledge.climbed &&
    vig.grapple.grappleTarget &&
    vig.grapple.grappled &&
    vig.glide.glided &&
    vig.glide.sink < 5 &&
    vig.glide.diveSpeed > 15 &&
    vig.glide.lift > 3 &&
    vig.fight.kos >= 2 &&
    vig.fight.maxCombo >= 3 &&
    vig.fight.smoke &&
    vig.fight.hangouts === 6 &&
    vig.ragOk &&
    vig.ped.pedHit &&
    vig.ped.pedDown &&
    vig.ped.pedUp &&
    vig.player.plDown &&
    vig.player.plUp &&
    vig.goreCount > 0;
  if (!vigOk) errors.push(`vigilante check failed: ${JSON.stringify(vig)}`);

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
  fs.writeFileSync(path.join(ROOT, 'screenshots', 'perf-e2e.json'), JSON.stringify(perf, null, 2));

  if (SHOTS) {
    const dir = path.join(ROOT, 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const settle = async (ms = 2500) => {
      await page.evaluate(() => window.__NW.game.primeWorld());
      await page.waitForTimeout(ms);
    };
    const shot = async (name, fn, ms) => {
      if (ONLY_LIST && !ONLY_LIST.some((o) => name.includes(o))) return;
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
      g.setDebugCamera(155, 8, 728, 330, 4, 1060);
    }, 9000);
    await shot('20-storm-lightning', () => {
      const g = window.__NW.game;
      g.setWeather('storm');
      g.setTime(16.5);
      g.setDebugCamera(640, 26, 520, 120, 70, -60);
      g.lightning(true);
    }, 6000);
    await page.evaluate(() => window.__NW.game.releaseLightning());
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
    // Stage 3: the vigilante.
    await shot('24-hero-rooftop-rain-night', () => {
      const g = window.__NW.game;
      g.enemies.spawning = false;
      g.enemies.clear();
      g.setWeather('storm');
      g.setTime(22.5);
      g.setHero(true);
      g.clearDebugCamera();
      g.gotoRooftop(18, 60);
      g.simulate(2.5);
      const p = g.player.object.position;
      const y = g.player.yaw;
      const fx = Math.sin(y);
      const fz = Math.cos(y);
      g.setDebugCamera(p.x - fx * 2.6 + fz * 1.5, p.y + 1.6, p.z - fz * 2.6 - fx * 1.5, p.x + fx * 4, p.y + 0.6, p.z + fz * 4);
      g.lightning(true, 0.55);
    }, 7000);
    await page.evaluate(() => window.__NW.game.releaseLightning());
    await shot('25-glide-midtown', () => {
      const g = window.__NW.game;
      g.setHero(true);
      g.setWeather('partly');
      g.setTime(17.2);
      g.clearDebugCamera();
      const n = g.gotoJunction();
      const yaw = Math.PI;
      g.player.teleport(n.x + 4, 110, n.z + 140, yaw);
      g.simulate(0.6);
      g.input.forced = { hold: ['jump'], moveY: 0.25 };
      g.player.debugGlide(yaw, 16);
      g.simulate(2.2);
      const p = g.player.object.position;
      g.setDebugCamera(p.x + 2.4, p.y + 2.6, p.z + 4.6, p.x - 1.5, p.y - 4, p.z - 14);
      g.loop.paused = true;
    }, 7000);
    await page.evaluate(() => {
      const g = window.__NW.game;
      g.loop.paused = false;
      g.input.forced = null;
    });
    await shot('26-fight-five-thugs', () => {
      const g = window.__NW.game;
      g.setHero(true);
      g.enemies.clear();
      g.setWeather('clear');
      g.setTime(18.6);
      g.clearDebugCamera();
      const s = g.world.city.spawn;
      g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
      g.player.health = 100;
      g.player.armour = 60;
      g.simulate(0.5);
      g.spawnFight(5, ['thug', 'brute', 'shield', 'thug', 'thug']);
      g.simulate(1.6);
      for (let i = 0; i < 5; i++) {
        if (g.enemies.thugs.some((t) => t.warn === 1)) g.input.trigger('counter');
        else g.input.trigger('attack');
        g.simulate(0.32);
      }
      const thugs = g.enemies.thugs.filter((t) => !t.ko);
      const c = thugs.reduce((a, t) => a.add(t.pos), new g.__THREE.Vector3()).multiplyScalar(1 / Math.max(1, thugs.length));
      const p = g.player.position;
      const d = c.clone().sub(p).setY(0).normalize();
      g.rig.yaw = Math.atan2(-d.x, -d.z) + 0.5;
      g.rig.pitch = -0.32;
      // End mid-strike so the hero is caught throwing a punch.
      g.player.health = 100;
      g.input.trigger('attack');
      g.simulate(0.2);
      g.loop.paused = true;
    }, 4000);
    await page.evaluate(() => (window.__NW.game.loop.paused = false));
    await shot('27-ragdoll-knockdown', () => {
      const g = window.__NW.game;
      g.setHero(true);
      g.enemies.clear();
      g.setTime(15);
      g.setWeather('partly');
      g.clearDebugCamera();
      const s = g.world.city.spawn;
      g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
      g.simulate(0.3);
      const p = g.player.position.clone();
      const y = g.player.yaw;
      const fx = Math.sin(y);
      const fz = Math.cos(y);
      const t = g.enemies.spawnFight(p.x, p.z, 1, ['thug'])[0];
      const tx = p.x + fx * 1.25;
      const tz = p.z + fz * 1.25;
      t.pos.set(tx, p.y, tz);
      t.body.setTranslation({ x: tx, y: p.y + 0.95, z: tz }, true);
      t.yaw = y + Math.PI;
      g.simulate(0.15);
      g.player.face(y);
      g.player.playOnce('Sword_Attack', 1.25, 0.05, 0.2);
      g.simulate(0.3);
      g.enemies.damage(t, 99, p, { kind: 'finisher' });
      g.simulate(0.5);
      const q = t.actor.rig.ragdoll.pelvis.translation();
      const mx = (q.x + p.x) / 2;
      const mz = (q.z + p.z) / 2;
      g.setDebugCamera(mx + fz * 4.2, p.y + 1.4, mz - fx * 4.2, mx, p.y + 0.7, mz);
      g.loop.paused = true;
    }, 4000);
    await page.evaluate(() => (window.__NW.game.loop.paused = false));
    await shot('28-hero-closeup', () => {
      const g = window.__NW.game;
      g.setHero(true);
      g.enemies.clear();
      g.setTime(16.5);
      g.setWeather('clear');
      g.clearDebugCamera();
      const s = g.world.city.spawn;
      g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
      g.simulate(1.5);
      const p = g.player.object.position;
      const y = g.player.yaw;
      g.setDebugCamera(p.x + Math.sin(y + 0.5) * 2.2, p.y + 1.55, p.z + Math.cos(y + 0.5) * 2.2, p.x, p.y + 1.15, p.z);
    }, 4000);
    await shot('29-grapple-zip', () => {
      const g = window.__NW.game;
      g.setHero(true);
      g.enemies.clear();
      g.setTime(13.5);
      g.clearDebugCamera();
      const p = g.player.position;
      const b = g.world.city.buildings.filter((bb) => bb.district === 'midtown' && bb.roof === 'flat' && bb.height > 15 && bb.height < 45 && bb.tiers.length <= 1).sort((a, d) => Math.hypot(a.cx - p.x, a.cz - p.z) - Math.hypot(d.cx - p.x, d.cz - p.z))[0];
      const gx = b.cx;
      const gz = b.cz + b.d / 2 + 16;
      g.teleportPlayer(gx, gz, Math.PI, 0);
      g.simulate(0.4);
      const cam = g.renderer.camera;
      cam.position.set(gx, p.y + 1.8, gz + 3);
      cam.lookAt(gx, b.baseY + b.height - 2, b.cz + b.d / 2);
      cam.updateMatrixWorld();
      for (let i = 0; i < 3; i++) g.player.updateAim(cam);
      g.input.trigger('grapple');
      g.simulate(0.75);
      const q = g.player.object.position;
      g.setDebugCamera(q.x + 4, q.y - 1.5, q.z + 9, q.x, q.y + 3, q.z - 1);
      g.loop.paused = true;
    }, 4000);
    await page.evaluate(() => {
      const g = window.__NW.game;
      g.loop.paused = false;
      g.simulate(3);
      g.setHero(false);
      g.enemies.spawning = true;
    });
    await page.evaluate(() => {
      const g = window.__NW.game;
      g.setWeather('partly');
      g.setTime(12);
      g.clearDebugCamera();
    });
    if (!ONLY_LIST || ONLY_LIST.some((o) => o.startsWith('ui'))) {
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
      const resumed = await ui.evaluate(() => !window.__NW.game.loop.paused);
      // Full-screen map (M) opens and pauses the simulation; M again closes it (frames are slow
      // under SwiftShader, so wait for the game to process each key).
      await ui.keyboard.press('KeyM');
      const mapOpened = await ui.waitForFunction(() => window.__NW.game.minimap.open, null, { timeout: 120000, polling: 500 }).then(() => true, () => false);
      await ui.waitForTimeout(2500);
      await ui.screenshot({ path: path.join(dir, 'ui-05-map.png') });
      await ui.keyboard.press('KeyM');
      const mapClosed = await ui.waitForFunction(() => !window.__NW.game.minimap.open && !window.__NW.game.loop.paused, null, { timeout: 120000, polling: 500 }).then(() => true, () => false);
      if (!mapOpened || !mapClosed) errors.push(`map toggle failed ${JSON.stringify({ mapOpened, mapClosed })}`);
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
