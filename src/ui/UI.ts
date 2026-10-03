/**
 * DOM UI: loading screen, HUD (prompt, district, speedometer), controls panel (H),
 * pause menu with graphics presets (Esc) and the F3 performance overlay.
 */
import './styles.css';
import { events } from '../core/EventBus';
import { settings, type GraphicsPreset } from '../core/Settings';

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 3 L56 12 V30 C56 46 45 56 32 61 C19 56 8 46 8 30 V12 Z" fill="#0d1622" stroke="#c9a45c" stroke-width="2.5"/>
<path d="M40 16 a14 14 0 1 0 6 22 a11 11 0 1 1 -6 -22z" fill="#c9a45c"/><rect x="21" y="30" width="6" height="20" fill="#e8e2d2"/><path d="M19 30 L24 22 L29 30Z" fill="#e8e2d2"/></svg>`;

const CONTROLS: [string, [string, string][]][] = [
  ['On foot', [['Move', 'W A S D'], ['Look', 'Mouse'], ['Sprint', 'Shift'], ['Jump', 'Space'], ['Enter / exit vehicle', 'E']]],
  ['Driving', [['Accelerate / brake / reverse', 'W / S'], ['Steer', 'A / D'], ['Handbrake (drift)', 'Space'], ['Headlights', 'L'], ['Look around', 'Mouse'], ['Exit vehicle', 'E']]],
  ['General', [['Controls panel', 'H'], ['Pause / settings', 'Esc'], ['Performance overlay', 'F3'], ['Camera zoom', 'Mouse wheel']]],
  ['Gamepad', [['Move / steer', 'Left stick'], ['Look', 'Right stick'], ['Throttle / brake', 'RT / LT'], ['Jump / handbrake', 'A'], ['Enter / exit', 'Y'], ['Pause', 'Start']]],
];

export class UI {
  readonly root: HTMLElement;
  private loading: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private startBtn: HTMLButtonElement;
  private prompt: HTMLElement;
  private district: HTMLElement;
  private speedo: HTMLElement;
  private speedNum: HTMLElement;
  private speedGear: HTMLElement;
  private speedArc: SVGPathElement;
  private pause: HTMLElement;
  private controls: HTMLElement;
  private stats: HTMLElement;
  private toastEl: HTMLElement;
  private toastTimer = 0;
  paused = false;
  controlsOpen = false;
  onResume: () => void = () => undefined;
  onStart: () => void = () => undefined;

  constructor() {
    this.root = document.getElementById('ui')!;
    this.root.innerHTML = `
      <div class="crosshair"></div>
      <div class="hud-district"><small>Port Vellmoor</small><span></span></div>
      <div class="hud-hint">H — controls &nbsp;·&nbsp; Esc — pause</div>
      <div class="hud-prompt"></div>
      <div class="speedo">
        <svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="86" fill="rgba(8,12,20,0.72)" stroke="rgba(201,164,92,0.35)" stroke-width="2"/>
        <path d="${arcPath(0, 1)}" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="9" stroke-linecap="round"/>
        <path class="arc" d="${arcPath(0, 0.01)}" fill="none" stroke="#c9a45c" stroke-width="9" stroke-linecap="round"/>
        ${ticks()}</svg>
        <div class="num">0</div><div class="unit">KM/H</div><div class="gear">N</div>
      </div>
      <div class="stats"></div>
      <div class="toast"></div>
      <div class="overlay pause interactive"><div class="panel"><h3>Paused</h3>
        <div class="menu"><button data-act="resume">Resume</button><button data-act="controls">Controls</button></div>
        <h3 style="margin-top:22px">Graphics</h3>
        <div class="presets">${(['low', 'medium', 'high', 'ultra'] as GraphicsPreset[]).map((p) => `<button data-preset="${p}">${p}</button>`).join('')}</div>
        <div class="note">Low/Medium suit integrated graphics; High targets 60 fps on a mid-range gaming PC; Ultra raises render resolution, shadow range, AO quality and draw distance for high-end GPUs.</div>
      </div></div>
      <div class="overlay controls interactive"><div class="panel"><h3>Controls</h3><div class="controls-grid">
        ${CONTROLS.map(([h, rows]) => `<h4>${h}</h4>${rows.map(([a, k]) => `<div><span>${a}</span><span>${k}</span></div>`).join('')}`).join('')}
        </div><div class="note">Press H or Esc to close.</div></div></div>
      <div class="loading interactive">
        <div class="logo">${LOGO}<h1>NIGHTWARDEN</h1><h2>PORT VELLMOOR</h2></div>
        <div class="bar"><div></div></div><div class="label">Initialising</div>
        <button class="start">CLICK TO PLAY</button>
        <div class="tip">Stage 1 — explore the city on foot and behind the wheel.</div>
      </div>`;
    const q = <T extends Element = HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.loading = q('.loading');
    this.bar = q('.bar > div');
    this.label = q('.loading .label');
    this.startBtn = q<HTMLButtonElement>('.start');
    this.prompt = q('.hud-prompt');
    this.district = q('.hud-district span');
    this.speedo = q('.speedo');
    this.speedNum = q('.speedo .num');
    this.speedGear = q('.speedo .gear');
    this.speedArc = q<SVGPathElement>('.speedo .arc');
    this.pause = q('.overlay.pause');
    this.controls = q('.overlay.controls');
    this.stats = q('.stats');
    this.toastEl = q('.toast');

    events.on('loading:progress', ({ progress, label }) => {
      this.bar.style.width = `${Math.round(progress * 100)}%`;
      this.label.textContent = label;
    });
    this.startBtn.addEventListener('click', () => this.onStart());
    this.pause.querySelectorAll('button[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const act = (b as HTMLElement).dataset.act;
        if (act === 'resume') this.onResume();
        if (act === 'controls') this.toggleControls(true);
      }),
    );
    this.pause.querySelectorAll('button[data-preset]').forEach((b) =>
      b.addEventListener('click', () => {
        settings.setPreset((b as HTMLElement).dataset.preset as GraphicsPreset);
        this.refreshPresets();
        this.toast(`Graphics: ${settings.preset.toUpperCase()}`);
      }),
    );
    this.refreshPresets();
  }

  private refreshPresets(): void {
    this.pause.querySelectorAll('button[data-preset]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.preset === settings.preset));
  }

  setLoadingDone(): void {
    this.bar.style.width = '100%';
    this.label.textContent = 'Ready';
    this.startBtn.classList.add('show');
  }

  hideLoading(): void {
    this.loading.classList.add('done');
  }

  get loadingVisible(): boolean {
    return !this.loading.classList.contains('done');
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.pause.classList.toggle('show', p);
    if (!p) this.toggleControls(false);
  }

  toggleControls(force?: boolean): void {
    this.controlsOpen = force ?? !this.controlsOpen;
    this.controls.classList.toggle('show', this.controlsOpen);
  }

  setPrompt(html: string | null): void {
    if (html) this.prompt.innerHTML = html;
    this.prompt.classList.toggle('show', !!html);
  }

  setDistrict(name: string): void {
    if (this.district.textContent !== name) this.district.textContent = name;
  }

  setSpeedo(show: boolean, kmh = 0, gear = 'N', rpm = 0): void {
    this.speedo.classList.toggle('show', show);
    if (!show) return;
    this.speedNum.textContent = String(Math.round(kmh));
    this.speedGear.textContent = gear;
    this.speedArc.setAttribute('d', arcPath(0, Math.max(0.01, Math.min(1, kmh / 240))));
    this.speedArc.setAttribute('stroke', rpm > 0.9 ? '#e8553a' : '#c9a45c');
  }

  setStats(text: string | null): void {
    this.stats.classList.toggle('show', !!text);
    if (text) this.stats.textContent = text;
  }

  toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }
}

/** SVG arc for the speedometer: t in [0,1] across a 260 degree sweep. */
function arcPath(t0: number, t1: number): string {
  const a0 = ((140 + t0 * 260) * Math.PI) / 180;
  const a1 = ((140 + t1 * 260) * Math.PI) / 180;
  const r = 74;
  const x0 = 100 + Math.cos(a0) * r;
  const y0 = 100 + Math.sin(a0) * r;
  const x1 = 100 + Math.cos(a1) * r;
  const y1 = 100 + Math.sin(a1) * r;
  const large = (t1 - t0) * 260 > 180 ? 1 : 0;
  return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

function ticks(): string {
  let s = '';
  for (let i = 0; i <= 12; i++) {
    const a = ((140 + (i / 12) * 260) * Math.PI) / 180;
    const r0 = i % 2 === 0 ? 58 : 62;
    s += `<line x1="${(100 + Math.cos(a) * r0).toFixed(1)}" y1="${(100 + Math.sin(a) * r0).toFixed(1)}" x2="${(100 + Math.cos(a) * 66).toFixed(1)}" y2="${(100 + Math.sin(a) * 66).toFixed(1)}" stroke="rgba(233,228,216,0.6)" stroke-width="${i % 2 === 0 ? 2 : 1}"/>`;
  }
  return s;
}
