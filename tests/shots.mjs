#!/usr/bin/env node
/**
 * Ad-hoc screenshot tool: node tests/shots.mjs out.png "time=21&weather=heavyrain" "x,y,z,tx,ty,tz" [waitMs] [js-before]
 * Loads the built game headlessly, applies the query, sets the debug camera and captures one image.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [out, query = '', cam = '', wait = '6000', js = ''] = process.argv.slice(2);
const PORT = Number(process.env.PORT ?? 4175);
const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r, j) => {
  const on = (d) => {
    const t = String(d);
    if (t.includes('in use') || t.includes('EADDRINUSE')) j(new Error(`port ${PORT} in use`));
    else if (t.includes(String(PORT))) r();
  };
  proc.stdout.on('data', on);
  proc.stderr.on('data', on);
  setTimeout(() => j(new Error('preview timeout')), 30000);
});
const executablePath = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 720) } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${PORT}/nightwarden-game/?auto&capture&preset=high${query ? '&' + query : ''}${cam ? '&cam=' + cam : ''}`, { timeout: 120000 });
await page.waitForFunction(() => window.__NW && (window.__NW.ready || window.__NW.error), null, { timeout: 600000, polling: 1000 });
if (js) console.log('js result', await page.evaluate(js));
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out, timeout: 180000 });
console.log('saved', out, 'errors', errors.length);
for (const e of errors.slice(0, 10)) console.log("  ERR", e.split("\n").filter((l) => l.includes("ERROR") || l.includes(">") || l.includes("Material")).join("\n"));
await browser.close();
proc.kill();
process.exit(0);
