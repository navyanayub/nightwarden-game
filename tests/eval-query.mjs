#!/usr/bin/env node
// Like debug-eval.mjs but with URL flags and an async expression:
//   node tests/eval-query.mjs "norender&nocrime" "(async () => { ... })()"
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const query = process.argv[2] ?? '';
const expr = process.argv[3];
const port = 4175 + Math.floor(Math.random() * 200);
const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((r) => { const f = (d) => String(d).includes(String(port)) && r(); proc.stdout.on('data', f); proc.stderr.on('data', f); setTimeout(r, 8000); });
const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`console ${m.type()}:`, m.text().slice(0, 400)));
page.on('pageerror', (e) => console.log('pageerror:', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')));
await page.goto(`http://localhost:${port}/nightwarden-game/?auto&${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__NW && (window.__NW.ready || window.__NW.error), null, { timeout: 900000, polling: 1000 });
const out = await page.evaluate(expr);
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
await browser.close();
proc.kill();
