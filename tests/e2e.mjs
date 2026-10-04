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
    await page.evaluate(() => (window.__NW.game.autoDrive = null));
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
      await ui.click('.start');
      await ui.waitForTimeout(2500);
      await ui.keyboard.press('KeyH');
      await ui.waitForTimeout(1500);
      await ui.screenshot({ path: path.join(dir, 'ui-02-controls.png') });
      await ui.keyboard.press('KeyH');
      await ui.keyboard.press('Escape');
      await ui.waitForTimeout(1500);
      await ui.screenshot({ path: path.join(dir, 'ui-03-pause.png') });
      const paused = await ui.evaluate(() => window.__NW.game.loop.paused);
      await ui.click('button[data-preset="ultra"]');
      await ui.waitForTimeout(1500);
      const preset = await ui.evaluate(() => window.__NW.game && JSON.parse(localStorage.getItem('nightwarden.settings.v1') || '{}').preset);
      await ui.click('button[data-act="resume"]');
      await ui.waitForTimeout(1000);
      await ui.keyboard.press('F3');
      await ui.waitForTimeout(2500);
      await ui.screenshot({ path: path.join(dir, 'ui-04-stats.png') });
      const resumed = await ui.evaluate(() => !window.__NW.game.loop.paused);
      console.log('ui flow', { paused, preset, resumed });
      if (!paused || preset !== 'ultra' || !resumed) errors.push(`ui flow failed ${JSON.stringify({ paused, preset, resumed })}`);
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
