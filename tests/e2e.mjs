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
  // Random crimes stay off until the Stage 4 checks so they cannot interfere.
  await page.evaluate(() => {
    const g = window.__NW.game;
    g.crimes.enabled = false;
    g.crimes.clear();
    g.police.clear();
  });
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

  // Stage 4: ten minutes of crime (simulated, logged to screenshots/crime-log.json).
  const crimeRun = await page.evaluate(() => {
    const g = window.__NW.game;
    g.loop.paused = true;
    g.enemies.clear();
    g.crimes.clear();
    g.police.clear();
    g.setHero(false);
    g.setWeather('partly');
    g.setTime(20.5);
    g.clearDebugCamera();
    const s = g.world.city.spawn;
    g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
    g.player.health = 100;
    g.crimes.enabled = true;
    g.crimes.spawnT = 5;
    const t0 = performance.now();
    const samples = [];
    for (let k = 0; k < 60; k++) {
      g.simulate(10);
      samples.push({ t: (k + 1) * 10, active: g.crimes.active.filter((c) => c.phase !== 'over').length, units: g.police.units.length, fighters: g.enemies.thugs.length, aiCars: g.fleet.cars.length });
    }
    const ms = performance.now() - t0;
    g.crimes.enabled = false;
    const log = g.crimes.log.map((l) => ({ ...l }));
    const done = log.filter((l) => l.outcome);
    const res = {
      seconds: 600,
      cpuSeconds: +(ms / 1000).toFixed(1),
      clock: g.crimes.log.length ? `${log[0].clock} → ${window.__NW.game.env ? '' : ''}` : '',
      crimes: log,
      byOutcome: done.reduce((a, l) => ((a[l.outcome] = (a[l.outcome] ?? 0) + 1), a), {}),
      types: [...new Set(log.map((l) => l.type))],
      territory: JSON.parse(JSON.stringify(g.territory.control)),
      shotsFired: g.enemies.gunfire.shots,
      criminalsCollected: g.police.collected,
      samples,
    };
    g.loop.paused = false;
    return res;
  });
  fs.writeFileSync(path.join(ROOT, 'screenshots', 'crime-log.json'), JSON.stringify(crimeRun, null, 2));
  console.log('crime log', JSON.stringify({ crimes: crimeRun.crimes.length, types: crimeRun.types, byOutcome: crimeRun.byOutcome, cpuSeconds: crimeRun.cpuSeconds, shots: crimeRun.shotsFired }));
  for (const c of crimeRun.crimes) console.log(`  t=${c.startedAt}s ${c.clock} ${c.type} (${c.gang}, ${c.district}) -> ${c.outcome ?? 'in progress'}${c.detail ? ': ' + c.detail : ''}`);
  const ended = crimeRun.crimes.filter((c) => c.outcome);
  const crimeRunOk = crimeRun.crimes.length >= 6 && crimeRun.types.length >= 4 && ended.length >= crimeRun.crimes.length - 3 && Object.keys(crimeRun.byOutcome).length >= 2;
  if (!crimeRunOk) errors.push(`crime run check failed: ${JSON.stringify({ n: crimeRun.crimes.length, types: crimeRun.types, byOutcome: crimeRun.byOutcome })}`);

  // Stage 4: stopping crimes, police response, wanted levels, roadblocks, busted / hospital, escape.
  const police = await page.evaluate(() => {
    const g = window.__NW.game;
    const T = g.__THREE;
    g.loop.paused = true;
    const reset = () => {
      g.wanted.clear('test');
      g.enemies.clear();
      g.crimes.clear();
      g.police.clear();
      g.enemies.spawning = false;
      if (g.mode === 'drive') g.exitVehicle();
      const s = g.world.city.spawn;
      g.teleportPlayer(s.x, s.z, Math.PI, 0.35);
      g.player.health = 100;
      g.player.armour = 60;
      g.simulate(0.5);
    };
    g.setTime(13);
    g.setWeather('partly');
    reset();
    const out = {};
    // Stop a mugging: the hero knocks the mugger out -> tied up, reputation / money / trust / control.
    g.setHero(true);
    const st0 = { rep: g.stats.reputation, money: g.stats.money, trust: g.stats.trust };
    const id = g.startCrime('mugging', true);
    const c = g.crimes.active.find((x) => x.id === id);
    const gang = c.gang;
    const dist = c.district;
    const ctl0 = g.territory.get(dist, gang);
    g.simulate(0.5);
    for (const t of c.criminals) g.enemies.damage(t, 99, g.player.position, { kind: 'strike' });
    g.simulate(1);
    out.stop = { outcome: c.outcome, tied: c.criminals.every((t) => t.tied), rep: g.stats.reputation - st0.rep, money: g.stats.money - st0.money, trust: g.stats.trust - st0.trust, control: g.territory.get(dist, gang) - ctl0 };
    // Police come for the tied criminal.
    for (let i = 0; i < 12 && g.police.collected === 0; i++) g.simulate(10);
    out.collected = g.police.collected;
    // Territory: knocking a gang to zero loses the district.
    let lost = null;
    const off = window.__NW.events.on('territory:lost', (e) => (lost = e));
    g.territory.adjust('tidewater', 'island', -100, 'test');
    off?.();
    out.territoryLost = !!lost && g.territory.get('island', 'tidewater') === 0;
    reset();
    // Bank robbery: police respond and fight the robbers (NPC gunfight with cover).
    g.setHero(false);
    const shots0 = g.enemies.gunfire.shots;
    const bid = g.startCrime('bankRobbery');
    const bank = g.crimes.active.find((x) => x.id === bid);
    bank.policeT = 0;
    g.simulate(45);
    out.bank = { units: g.police.units.length, officers: g.enemies.thugs.filter((t) => t.faction === 'vpd').length, shots: g.enemies.gunfire.shots - shots0, phase: bank.phase, outcome: bank.outcome };
    reset();
    // Wanted levels: units, tactical vans, helicopters.
    const levels = [];
    // On a roof, out of reach of arrests, so every level gets its full response.
    g.gotoRooftop(18, 60);
    for (let L = 1; L <= 5; L++) {
      g.setWanted(L);
      g.simulate(L === 1 ? 4 : 10);
      levels.push({ L, units: g.police.units.filter((u) => u.job.k === 'wanted').length, tactical: g.police.units.filter((u) => u.kind === 'tactical').length, helis: g.police.helis.filter((h) => h.active).length });
    }
    out.levels = levels;
    reset();
    // Level 3 roadblock + spike strip while driving.
    const v = g.vehicles[0];
    g.teleportPlayer(v.position.x + 2.5, v.position.z, 0);
    g.enterVehicle(0);
    g.setWanted(3);
    out.roadblock = g.forceRoadblock();
    const rb = g.police.roadblocks[0];
    if (rb) {
      const sx = rb.sx - rb.dx * 50;
      const sz = rb.sz - rb.dz * 50;
      const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.atan2(rb.dx, rb.dz));
      v.sim.chassis.setTranslation({ x: sx, y: g.enemies.groundAt(sx, sz, 5) + 1, z: sz }, true);
      v.sim.chassis.setRotation(q, true);
      v.sim.chassis.setLinvel({ x: rb.dx * 14, y: 0, z: rb.dz * 14 }, true);
      g.autoDrive = { throttle: 0.5, steer: 0, brake: 0, handbrake: false };
      g.simulate(5);
      g.autoDrive = null;
      out.flats = v.sim.flats;
      out.roadblockCars = rb.cars.length;
    }
    reset();
    // Offenses raise the level: running people over with police watching.
    g.setWanted(0);
    window.__NW.events.emit('player:offense', { kind: 'koOfficer', x: g.player.position.x, z: g.player.position.z });
    out.offenseLevel = g.wanted.level;
    reset();
    // Busted: level 1, standing still -> precinct with a fine.
    const busted0 = g.stats.busted;
    const m0 = g.stats.money;
    g.setWanted(1);
    for (let i = 0; i < 40 && g.stats.busted === busted0; i++) g.simulate(1);
    g.simulate(3);
    const pr = g.sites.precinct;
    out.busted = { ok: g.stats.busted > busted0, fine: m0 - g.stats.money, atPrecinct: Math.hypot(g.player.position.x - pr.x, g.player.position.z - pr.z) < 8, level: g.wanted.level };
    reset();
    // Knocked out -> General Hospital.
    const h0 = g.stats.hospital;
    g.player.hurt(500, g.player.position.clone().add(new T.Vector3(1, 0, 0)));
    g.simulate(5);
    const hs = g.sites.hospital;
    out.hospital = { ok: g.stats.hospital > h0, atHospital: Math.hypot(g.player.position.x - hs.x, g.player.position.z - hs.z) < 8 };
    reset();
    // Escape: lose the police (out of sight, out of the search circle, cooldown).
    g.setWanted(2);
    g.simulate(13);
    g.police.clear();
    const away = g.wanted.center.clone().add(new T.Vector3(320, 0, 0));
    g.teleportPlayer(away.x, away.z, 0);
    let t = 0;
    while (g.wanted.level > 0 && t < 60) {
      g.simulate(2);
      t += 2;
    }
    out.escape = { cleared: g.wanted.level === 0, seconds: t };
    // Police Trust: a low-trust hero at a crime scene next to officers is treated as a suspect.
    reset();
    g.setHero(true);
    g.stats.trust = 20;
    const sid = g.startCrime('mugging', true);
    const sc = g.crimes.active.find((x) => x.id === sid);
    if (sc) {
      g.teleportPlayer(sc.x + 3, sc.z + 3, 0);
      const o = g.enemies.spawn(g.enemies.makeCrew('vpd', 'police', 'test', sc.x, sc.z), g.player.position.x + 4, g.player.position.z, 'officer', 'pistol');
      g.simulate(0.2);
      out.suspect = g.enemies.policeVsPlayer;
      g.stats.trust = 70;
      g.simulate(0.2);
      out.trusted = g.enemies.policeVsPlayer;
      void o;
    }
    g.stats.trust = 40;
    reset();
    // Retaliation: pressure from lost control sends an ambush at the hero.
    g.setHero(true);
    out.ambush = g.crimes.ambush('ashline', g.player.position.clone());
    g.simulate(3);
    out.ambushFighting = g.enemies.thugs.filter((x) => x.crew.kind === 'ambush' && x.aware === 'combat').length;
    g.enemies.clear();
    g.setHero(false);
    g.enemies.spawning = true;
    g.loop.paused = false;
    return out;
  });
  console.log('police', JSON.stringify(police));
  const lv = police.levels ?? [];
  const policeOk =
    police.stop.outcome === 'stopped' &&
    police.stop.tied &&
    police.stop.rep > 0 &&
    police.stop.money > 0 &&
    police.stop.control < 0 &&
    police.collected >= 1 &&
    police.territoryLost &&
    police.bank.units >= 3 &&
    police.bank.shots > 5 &&
    lv[0]?.units >= 1 &&
    lv[1]?.units >= 3 &&
    lv[3]?.tactical >= 1 &&
    lv[3]?.helis >= 1 &&
    lv[4]?.helis === 2 &&
    police.roadblock &&
    police.flats >= 1 &&
    police.offenseLevel >= 2 &&
    police.busted.ok &&
    police.busted.atPrecinct &&
    police.busted.fine > 0 &&
    police.hospital.ok &&
    police.hospital.atHospital &&
    police.escape.cleared &&
    police.suspect === 1 &&
    police.trusted === 0 &&
    police.ambush >= 4 &&
    police.ambushFighting >= 3;
  if (!policeOk) errors.push(`police check failed: ${JSON.stringify(police)}`);

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
    // Stage 4: crime and police.
    const crimeReset = () =>
      page.evaluate(() => {
        const g = window.__NW.game;
        g.loop.paused = false;
        g.autopilot(null);
        g.autoDrive = null;
        if (g.mode === 'drive') g.exitVehicle();
        g.wanted.clear('test');
        g.crimes.clear();
        g.police.clear();
        g.enemies.clear();
        g.clearDebugCamera();
      });
    await crimeReset();
    await shot('30-bank-robbery', () => {
  const g = window.__NW.game;
  g.crimes.enabled = false;
  g.enemies.spawning = false;
  g.enemies.clear();
  g.setHero(false);
  g.setWeather('partly');
  g.setTime(15.6);
  const b = g.sites.bank;
  const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
  const sx = fz, sz = -fx;
  g.teleportPlayer(b.x + fx * 40 - sx * 20, b.z + fz * 40 - sz * 20, 0);
  const id = g.startCrime('bankRobbery');
  const c = g.crimes.active.find((x) => x.id === id);
  c.policeT = 0;
  g.simulate(22);
  for (let i = 0; i < 60 && g.enemies.gunfire.live === 0; i++) g.simulate(0.05);
  g.setDebugCamera(b.x + fx * 15 + sx * 9, b.y + 3.4, b.z + fz * 15 + sz * 9, b.x - fx * 0.5 + sx * 1, b.y + 1.5, b.z - fz * 0.5 + sz * 1);
  g.loop.paused = true;
  return { live: g.enemies.gunfire.live, units: g.police.units.map((u) => u.job.k + '/' + u.officers.length), fighters: g.enemies.thugs.map((t) => t.faction[0] + (t.ko ? 'x' : '')).join('') };
}, 8000);
    await crimeReset();
    await shot('31-night-chase-helicopter', () => {
  const g = window.__NW.game;
  g.crimes.enabled = false;
  g.enemies.spawning = false;
  g.enemies.clear();
  g.setHero(false);
  g.setWeather('overcast');
  g.setTime(22.6);
  const v = g.vehicles[0];
  g.teleportPlayer(v.position.x + 2.5, v.position.z, 0);
  g.enterVehicle(0);
  g.setWanted(4);
  g.autopilot('flee');
  const log = [];
  for (let i = 0; i < 14; i++) {
    g.simulate(2);
    const h = g.police.helis[0];
    log.push([Math.round(v.position.x), Math.round(v.position.z), v.sim.speed.toFixed(0), h.active ? Math.round(h.pos.distanceTo(v.position)) : '-', g.police.units.map((u) => Math.round(u.car.position.distanceTo(v.position))).join('/')].join(' '));
  }
  const p = v.position;
  const h = g.police.helis[0];
  const cop = g.police.units.filter((u) => u.job.k === 'wanted').sort((a, b) => a.car.position.distanceTo(p) - b.car.position.distanceTo(p))[0];
  const c = cop ? cop.car.position : p.clone().add(new g.__THREE.Vector3(10, 0, 0));
  const d = p.clone().sub(c).setY(0).normalize();
  const side = new g.__THREE.Vector3(d.z, 0, -d.x);
  g.setDebugCamera(c.x - d.x * 9 + side.x * 2.5, p.y + 3.6, c.z - d.z * 9 + side.z * 2.5, p.x + d.x * 6, p.y + 5, p.z + d.z * 6);
  log.push('cop ' + (cop ? Math.round(cop.car.position.distanceTo(p)) : '-') + ' heli ' + Math.round(h.pos.distanceTo(p)) + ' alt ' + Math.round(h.pos.y - p.y));
  g.loop.paused = true;
  return log;
}, 9000);
    await crimeReset();
    await shot('32-roadblock-level3', () => {
  const g = window.__NW.game;
  const T = g.__THREE;
  g.crimes.enabled = false;
  g.enemies.spawning = false;
  g.enemies.clear();
  g.setHero(false);
  g.setWeather('partly');
  g.setTime(17.9);
  const v = g.vehicles[0];
  g.teleportPlayer(v.position.x + 2.5, v.position.z, 0);
  g.enterVehicle(0);
  g.setWanted(3);
  g.police.clear();
  const ok = g.forceRoadblock();
  const rb = g.police.roadblocks[0];
  if (!rb) return 'no roadblock';
  const sx = rb.sx - rb.dx * 24, sz = rb.sz - rb.dz * 24;
  const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.atan2(rb.dx, rb.dz));
  v.sim.chassis.setTranslation({ x: sx, y: g.enemies.groundAt(sx, sz, 5) + 0.9, z: sz }, true);
  v.sim.chassis.setRotation(q, true);
  v.sim.chassis.setLinvel({ x: rb.dx * 9, y: 0, z: rb.dz * 9 }, true);
  g.autoDrive = { throttle: 0.15, steer: 0, brake: 0, handbrake: false };
  g.world.prime(new T.Vector3(rb.cx, 0, rb.cz));
  g.simulate(1.2);
  const p = v.position;
  const side = new T.Vector3(rb.dz, 0, -rb.dx);
  const W = rb.half / 0.27;
  const rx = rb.ax, rz = rb.az;
  const carX = rb.cx + rx * W * 0.22, carZ = rb.cz + rz * W * 0.22;
  const cx = rb.sx - rb.dx * 7 + rx * (W * 0.27 + 1.5), cz = rb.sz - rb.dz * 7 + rz * (W * 0.27 + 1.5);
  g.setDebugCamera(cx, p.y + 1.9, cz, carX - rx * 2.5, p.y + 0.7, carZ - rz * 2.5);
  g.loop.paused = true;
  return { ok, officers: rb.officers.map((o) => o.aware), dist: Math.round(Math.hypot(p.x - rb.cx, p.z - rb.cz)) };
}, 9000);
    await crimeReset();
    await shot('33-arson-night', () => {
  const g = window.__NW.game;
  g.crimes.enabled = false;
  g.enemies.spawning = false;
  g.enemies.clear();
  g.setWeather('clear');
  g.setTime(21.8);
  const sp = g.world.city.spawn;
  const shop = g.sites.shops.filter((x) => x.district === 'oldtown' || x.district === 'midtown').sort((a, b) => Math.hypot(a.x - sp.x, a.z - sp.z) - Math.hypot(b.x - sp.x, b.z - sp.z))[0];
  g.teleportPlayer(shop.x + Math.sin(shop.yaw) * 20, shop.z + Math.cos(shop.yaw) * 20, 0);
  const id = g.startCrime('arson', true);
  const c = g.crimes.active.find((x) => x.id === id);
  if (!c) return 'no arson';
  c.policeT = 999;
  g.simulate(40);
  const f = c.fire;
  const n = f.normal;
  const sx = n.z, sz = -n.x;
  g.setDebugCamera(f.pos.x + n.x * 13 + sx * 6, f.pos.y + 3.2, f.pos.z + n.z * 13 + sz * 6, f.pos.x, f.pos.y + 2.4, f.pos.z);
  g.loop.paused = true;
  return { level: f.level.toFixed(2), crim: c.criminals.length };
}, 8000);
    await crimeReset();
    await shot('34-hostage-warehouse', () => {
  const g = window.__NW.game;
  g.crimes.enabled = false;
  g.enemies.spawning = false;
  g.enemies.clear();
  g.setWeather('partly');
  g.setTime(14);
  const w = g.sites.warehouses[0];
  g.teleportPlayer(w.door.x, w.door.z, w.yaw + Math.PI);
  const id = g.startCrime('hostage', true);
  const c = g.crimes.active.find((x) => x.id === id);
  if (!c) return 'no hostage';
  c.policeT = 999;
  g.simulate(3);
  const a = w.local(6, 5.5);
  const t = w.local(-1.5, -1.5);
  g.setDebugCamera(a.x, w.y + 3.2, a.z, t.x, w.y + 0.9, t.z);
  g.loop.paused = true;
  return { crim: c.criminals.length, w: [Math.round(w.x), Math.round(w.z)] };
}, 8000);
    await crimeReset();
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
      // Record screen (J): reputation, Police Trust, gang control.
      await ui.keyboard.press('KeyJ');
      const recOpened = await ui.waitForFunction(() => window.__NW.game.crimeHud.open, null, { timeout: 120000, polling: 500 }).then(() => true, () => false);
      await ui.waitForTimeout(2000);
      await ui.screenshot({ path: path.join(dir, 'ui-06-record.png') });
      await ui.keyboard.press('KeyJ');
      const recClosed = await ui.waitForFunction(() => !window.__NW.game.crimeHud.open && !window.__NW.game.loop.paused, null, { timeout: 120000, polling: 500 }).then(() => true, () => false);
      if (!recOpened || !recClosed) errors.push(`record toggle failed ${JSON.stringify({ recOpened, recClosed })}`);
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
