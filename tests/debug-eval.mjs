#!/usr/bin/env node
// Load the built game headlessly and print the result of a JS expression evaluated in the page.
// Usage: node tests/debug-eval.mjs "<expression using window.__NW.game>"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const expr = process.argv[2];
const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', '4174', '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => { const f = (d) => String(d).includes('4174') && r(); proc.stdout.on('data', f); proc.stderr.on('data', f); setTimeout(r, 8000); });
const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));
await page.goto('http://localhost:4174/nightwarden-game/?auto', { waitUntil: 'load' });
await page.waitForFunction(() => window.__NW && (window.__NW.ready || window.__NW.error), null, { timeout: 600000, polling: 1000 });
await page.waitForTimeout(4000);
const out = await page.evaluate(expr);
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
await browser.close();
proc.kill();
