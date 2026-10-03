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
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
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
      g.teleportPlayer(s.x, s.z, Math.PI * 0.85, Math.PI * 0.95);
      g.rig.pitch = -0.05;
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
  }
  console.log(`console errors: ${errors.length}, warnings: ${warnings.length}`);
  for (const e of errors) console.log('  ERROR', e);
  for (const w of [...new Set(warnings)].slice(0, 15)) console.log('  warn', w);
  await browser.close();
  server.kill();
  if (state.error || errors.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
