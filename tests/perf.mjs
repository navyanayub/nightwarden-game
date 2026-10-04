#!/usr/bin/env node
/**
 * Performance log: High preset, busy Midtown with 60+ cars and 150+ pedestrians in view
 * (raised camera over the spawn junction). Writes screenshots/perf-high.json + perf-high.png.
 *
 * In headless Chromium the GPU is SwiftShader (software), so the FPS here is NOT representative
 * of a real graphics card; the CPU timings (AI, update) and the draw-call / triangle counts are.
 * Run on a machine with a GPU (headed) for real numbers: node tests/perf.mjs --headed
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const headed = process.argv.includes('--headed');
const PORT = 4177;
const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const on = (d) => String(d).includes(String(PORT)) && r();
  proc.stdout.on('data', on);
  proc.stderr.on('data', on);
  setTimeout(() => j(new Error('preview timeout')), 30000);
});
const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({
  executablePath: headed ? undefined : executablePath,
  headless: !headed,
  args: headed ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:${PORT}/nightwarden-game/?auto&capture&preset=high&time=13&weather=partly`, { timeout: 180000 });
await page.waitForFunction(() => window.__NW && (window.__NW.ready || window.__NW.error), null, { timeout: 600000, polling: 1000 });
const perf = await page.evaluate(async () => {
  const g = window.__NW.game;
  const T = g.__THREE;
  const n = g.gotoJunction();
  g.crowd.maxPeds = 200;
  g.traffic.maxCars = 150;
  g.warmAI(60);
  const p = g.player.position;
  // Above the north-south street, looking down it across the junction (open corridor, no towers in the way).
  g.setDebugCamera(n.x, p.y + 48, n.z + 95, n.x, p.y, n.z - 35);
  g.warmAI(5);
  await new Promise((r) => setTimeout(r, 4000));
  const f0 = g.loop.frames;
  const t0 = performance.now();
  while (performance.now() - t0 < 40000) await new Promise((r) => setTimeout(r, 500));
  const wall = (performance.now() - t0) / 1000;
  const cam = g.renderer.camera;
  const fr = new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  const carsOnScreen = g.traffic.cars.filter((c) => fr.containsPoint(new T.Vector3(c.x, c.y + 1, c.z))).length;
  const info = g.renderer.renderer.info.render;
  return {
    preset: 'high',
    renderer: 'SwiftShader (software) unless --headed',
    avgFps: +((g.loop.frames - f0) / wall).toFixed(3),
    frames: g.loop.frames - f0,
    seconds: +wall.toFixed(1),
    cpuUpdateMs: +g.perf.update.toFixed(2),
    trafficMs: +g.perf.traffic.toFixed(2),
    crowdMs: +g.perf.crowd.toFixed(2),
    renderSubmitMs: +g.perf.render.toFixed(1),
    cars: g.traffic.cars.length,
    carsOnScreen,
    pedestrians: g.crowd.peds.length,
    pedestriansDrawn: g.crowd.render.stats.drawn,
    pedLods: g.crowd.render.stats.lod,
    drawCalls: info.calls,
    triangles: info.triangles,
  };
});
console.log('PERF', JSON.stringify(perf, null, 2));
fs.writeFileSync(path.join(ROOT, 'screenshots', 'perf-high.json'), JSON.stringify(perf, null, 2));
await page.screenshot({ path: path.join(ROOT, 'screenshots', 'perf-high.png'), timeout: 180000 });
await browser.close();
proc.kill();
process.exit(0);
