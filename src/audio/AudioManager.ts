/**
 * WebAudio sound for Port Vellmoor. Created on the first user gesture (autoplay policy).
 *
 * Buses: master <- music (generative ambient pad) + effects (everything else); volumes are
 * saved and set from the pause menu. 3D sounds use PannerNodes driven by the camera listener.
 *
 * Sources:
 *  - Kenney "Impact Sounds" (CC0): footsteps per surface, crash impacts.
 *  - Everything else is synthesised: RPM-following engine, tyre skid, positional traffic engine
 *    voices (pooled on the nearest cars), horns, distant sirens, district/time ambience beds
 *    (traffic hum, crowd murmur, birds, crickets, gulls, sea, machinery), wind, rain, thunder
 *    delayed by distance, clock-tower chimes, screams, harbour foghorn.
 */
import * as THREE from 'three';
import { assetUrl } from '../core/AssetLoader';
import { events } from '../core/EventBus';
import type { District } from '../world/WorldConfig';

const STORAGE_KEY = 'nightwarden.audio.v1';

export interface AudioVolumes {
  master: number;
  music: number;
  effects: number;
}

export interface AudioFrame {
  camera: THREE.Camera;
  district: District;
  /** 0 day .. 1 night */
  night: number;
  hour: number;
  rain: number;
  wind: number;
  fog: number;
  /** Listener is inside a car (muffles outside sounds). */
  inCar: boolean;
  /** 0..1 how close to the sea / harbour water. */
  sea: number;
  /** Traffic cars near the listener (position + speed). */
  cars: { x: number; y: number; z: number; speed: number; bus: boolean }[];
  /** Pedestrians within ~40 m (for murmur). */
  crowdNear: number;
  screams: { x: number; z: number }[];
  /** Distance to the Old Town clock tower (for chimes). */
  clockDist: number;
}

type Surface = 'concrete' | 'grass' | 'wood' | 'snow';

function noiseBuffer(ctx: AudioContext, seconds: number, color: 'white' | 'pink' | 'brown'): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (color === 'white') d[i] = w * 0.5;
    else if (color === 'pink') {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private music!: GainNode;
  private sfx!: GainNode;
  /** Outside-world sounds (muffled by a lowpass when inside a car). */
  private world!: GainNode;
  private worldFilter!: BiquadFilterNode;
  private reverb!: ConvolverNode;
  private paused = false;
  volumes: AudioVolumes = { master: 0.8, music: 0.35, effects: 0.85 };
  private noise: Record<string, AudioBuffer> = {};
  private samples = new Map<string, AudioBuffer>();
  // Engine
  private engGain!: GainNode;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engNoise!: GainNode;
  private skidGain!: GainNode;
  // Beds
  private beds: Record<string, GainNode> = {};
  private bedTargets: Record<string, number> = {};
  // Traffic voices
  private voices: { panner: PannerNode; gain: GainNode; osc: OscillatorNode; filt: BiquadFilterNode; busy: boolean }[] = [];
  private voiceTimer = 0;
  // Timers for scheduled synth events
  private birdT = 2;
  private gullT = 4;
  private sirenT = 40;
  private foghornT = 30;
  private lastHourChimed = -1;
  private stepSide = 0;
  private lastPhase = 0;
  private musicT = 0;
  private musicVoices: OscillatorNode[][] = [];
  private musicChord = 0;
  private listenerPos = new THREE.Vector3();
  private frame: AudioFrame | null = null;
  private horn: { osc: OscillatorNode[]; gain: GainNode } | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(this.volumes, JSON.parse(raw));
    } catch {
      /* storage unavailable */
    }
    events.on('weather:lightning', (l) => this.thunder(l.dist));
    events.on('traffic:horn', (h) => this.hornAt(h.x, h.z));
    events.on('world:alarm', (a) => {
      if (a.kind === 'crash') this.crash(a.x, a.z);
      if (a.kind === 'gunshot') this.gunshot(a.x, a.z);
    });
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  setVolumes(v: Partial<AudioVolumes>): void {
    Object.assign(this.volumes, v);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.volumes));
    } catch {
      /* ignore */
    }
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.music.gain.setTargetAtTime(this.volumes.music * 0.5, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.volumes.effects, t, 0.05);
  }

  unlock(): void {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
    } catch {
      return;
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.music = ctx.createGain();
    this.music.connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.worldFilter = ctx.createBiquadFilter();
    this.worldFilter.type = 'lowpass';
    this.worldFilter.frequency.value = 20000;
    this.world = ctx.createGain();
    this.world.connect(this.worldFilter).connect(this.sfx);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(2.8);
    const revOut = ctx.createGain();
    revOut.gain.value = 0.7;
    this.reverb.connect(revOut).connect(this.music);
    this.applyVolumes();
    this.noise.white = noiseBuffer(ctx, 3, 'white');
    this.noise.pink = noiseBuffer(ctx, 4, 'pink');
    this.noise.brown = noiseBuffer(ctx, 4, 'brown');
    this.buildEngine();
    this.buildBeds();
    this.buildVoices();
    this.buildMusic();
    void this.loadSamples();
  }

  private impulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  private async loadSamples(): Promise<void> {
    const ctx = this.ctx!;
    const names: string[] = [];
    for (const s of ['concrete', 'grass', 'wood', 'snow']) for (let i = 0; i < 5; i++) names.push(`footstep_${s}_00${i}`);
    for (let i = 0; i < 3; i++) names.push(`impactMetal_heavy_00${i}`, `impactGlass_medium_00${i}`, `impactPlate_heavy_00${i}`);
    await Promise.all(
      names.map(async (n) => {
        try {
          const r = await fetch(assetUrl(`audio/${n}.ogg`));
          const buf = await ctx.decodeAudioData(await r.arrayBuffer());
          this.samples.set(n, buf);
        } catch {
          /* undecodable on this browser: synthesised fallbacks are used */
        }
      }),
    );
  }

  private loopNoise(color: 'white' | 'pink' | 'brown'): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise[color];
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random() * 2);
    return src;
  }

  // ---------------------------------------------------------------- engine & skid

  private buildEngine(): void {
    const ctx = this.ctx!;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 600;
    this.engFilter.Q.value = 2;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    this.engA = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB = ctx.createOscillator();
    this.engB.type = 'square';
    this.engSub = ctx.createOscillator();
    this.engSub.type = 'sine';
    const subG = ctx.createGain();
    subG.gain.value = 0.8;
    this.engA.connect(this.engFilter);
    this.engB.connect(this.engFilter);
    this.engSub.connect(subG).connect(this.engFilter);
    const n = this.loopNoise('brown');
    this.engNoise = ctx.createGain();
    this.engNoise.gain.value = 0;
    n.connect(this.engNoise).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.sfx);
    for (const o of [this.engA, this.engB, this.engSub]) o.start();
    // Tyre skid: band-passed noise.
    const sk = this.loopNoise('white');
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 3;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    sk.connect(bp).connect(this.skidGain).connect(this.sfx);
  }

  /** Player vehicle engine (on/off), RPM 0..1, throttle 0..1, tyre slip 0..1. */
  setEngine(on: boolean, rpm: number, throttle: number, skid = 0): void {
    if (!this.ctx || this.paused) return;
    const t = this.ctx.currentTime;
    const f = 34 + rpm * 125;
    this.engA.frequency.setTargetAtTime(f, t, 0.04);
    this.engB.frequency.setTargetAtTime(f * 0.5, t, 0.04);
    this.engSub.frequency.setTargetAtTime(f * 0.25, t, 0.04);
    this.engFilter.frequency.setTargetAtTime(280 + rpm * 1100 + throttle * 700, t, 0.06);
    this.engGain.gain.setTargetAtTime(on ? 0.045 + throttle * 0.06 + rpm * 0.02 : 0, t, 0.1);
    this.engNoise.gain.setTargetAtTime(on ? 0.4 + throttle * 0.8 : 0, t, 0.1);
    this.skidGain.gain.setTargetAtTime(on ? Math.min(0.35, skid * 0.4) : 0, t, 0.05);
  }

  /** Player horn (held). */
  setHorn(on: boolean): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (on && !this.horn) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 2200;
      const osc = [400, 503].map((hz) => {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = hz;
        o.connect(f);
        o.start();
        return o;
      });
      f.connect(gain).connect(this.sfx);
      gain.gain.setTargetAtTime(0.06, ctx.currentTime, 0.01);
      this.horn = { osc, gain };
    } else if (!on && this.horn) {
      const h = this.horn;
      h.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.02);
      setTimeout(() => h.osc.forEach((o) => o.stop()), 200);
      this.horn = null;
    }
  }

  // ---------------------------------------------------------------- ambience beds

  private bed(name: string, src: AudioNode, filter: BiquadFilterType, freq: number, q = 0.7, dest: AudioNode = this.world): GainNode {
    const ctx = this.ctx!;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f).connect(g).connect(dest);
    this.beds[name] = g;
    this.bedTargets[name] = 0;
    return g;
  }

  private buildBeds(): void {
    const ctx = this.ctx!;
    this.bed('traffic', this.loopNoise('brown'), 'lowpass', 380);
    // Crowd murmur: pink noise through a vowel-ish band, slowly amplitude modulated.
    const mur = this.loopNoise('pink');
    const am = ctx.createGain();
    am.gain.value = 0.6;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.35;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.35;
    lfo.connect(lfoG).connect(am.gain);
    lfo.start();
    mur.connect(am);
    this.bed('murmur', am, 'bandpass', 700, 0.9);
    this.bed('sea', this.loopNoise('brown'), 'lowpass', 520);
    // Wind: gusts modulate a source-level gain (around 0.7 ± 0.3) before the bed level.
    const windSrc = this.loopNoise('pink');
    const gustGain = ctx.createGain();
    gustGain.gain.value = 0.7;
    const gust = ctx.createOscillator();
    gust.frequency.value = 0.13;
    const gg = ctx.createGain();
    gg.gain.value = 0.3;
    gust.connect(gg).connect(gustGain.gain);
    gust.start();
    windSrc.connect(gustGain);
    this.bed('wind', gustGain, 'bandpass', 600, 0.6, this.sfx);
    this.bed('rain', this.loopNoise('white'), 'highpass', 1800, 0.5, this.sfx);
    this.bed('roof', this.loopNoise('pink'), 'bandpass', 900, 1.2, this.sfx);
    // Industrial hum.
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth';
    hum.frequency.value = 49;
    hum.start();
    this.bed('machine', hum, 'lowpass', 160, 3);
    // Crickets: high sine with fast tremolo.
    const cr = ctx.createOscillator();
    cr.frequency.value = 4400;
    const tr = ctx.createGain();
    const trl = ctx.createOscillator();
    trl.frequency.value = 28;
    const trg = ctx.createGain();
    trg.gain.value = 0.5;
    trl.connect(trg).connect(tr.gain);
    tr.gain.value = 0.5;
    cr.connect(tr);
    cr.start();
    trl.start();
    this.bed('crickets', tr, 'bandpass', 4400, 6);
  }

  private buildVoices(): void {
    const ctx = this.ctx!;
    for (let i = 0; i < 6; i++) {
      const panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 5;
      panner.maxDistance = 200;
      panner.rolloffFactor = 1.3;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 40;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 300;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const n = this.loopNoise('brown');
      const ng = ctx.createGain();
      ng.gain.value = 0.6;
      n.connect(ng).connect(filt);
      osc.connect(filt).connect(gain).connect(panner).connect(this.world);
      osc.start();
      this.voices.push({ panner, gain, osc, filt, busy: false });
    }
  }

  // ---------------------------------------------------------------- music

  private buildMusic(): void {
    const ctx = this.ctx!;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 900;
    filt.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lg = ctx.createGain();
    lg.gain.value = 350;
    lfo.connect(lg).connect(filt.frequency);
    lfo.start();
    const g = ctx.createGain();
    g.gain.value = 0.05;
    filt.connect(g);
    g.connect(this.music);
    g.connect(this.reverb);
    for (let v = 0; v < 4; v++) {
      const pair = [-7, 7].map((det) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.detune.value = det;
        o.frequency.value = 220;
        o.connect(filt);
        o.start();
        return o;
      });
      this.musicVoices.push(pair);
    }
    this.nextChord();
  }

  private nextChord(): void {
    const ctx = this.ctx!;
    const night = (this.frame?.night ?? 0) > 0.5;
    // Day: Fmaj7 - Am9 - Dm9 - G6sus ; Night: Am(add9) - Fmaj7 - Em7 - Dm9 (lower, darker).
    const day = [
      [41, 48, 52, 57],
      [45, 52, 55, 59],
      [38, 45, 48, 53],
      [43, 50, 52, 55],
    ];
    const nightC = [
      [33, 40, 47, 48],
      [29, 36, 40, 45],
      [28, 35, 38, 43],
      [26, 33, 36, 41],
    ];
    const chord = (night ? nightC : day)[this.musicChord % 4];
    this.musicChord++;
    const t = ctx.currentTime;
    this.musicVoices.forEach((pair, i) => {
      const hz = 440 * Math.pow(2, (chord[i] + 12 - 69) / 12);
      for (const o of pair) o.frequency.setTargetAtTime(hz, t, 1.2);
    });
    // Sparse pentatonic pluck.
    const notes = night ? [57, 60, 62, 64, 67] : [60, 62, 65, 67, 69, 72];
    for (let k = 0; k < 2; k++) {
      const n = notes[Math.floor(Math.random() * notes.length)];
      const at = t + 1 + Math.random() * 6;
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = 440 * Math.pow(2, (n - 69) / 12);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0, at);
      e.gain.linearRampToValueAtTime(0.05, at + 0.02);
      e.gain.exponentialRampToValueAtTime(0.0005, at + 3);
      o.connect(e);
      e.connect(this.music);
      e.connect(this.reverb);
      o.start(at);
      o.stop(at + 3.2);
    }
  }

  // ---------------------------------------------------------------- one-shots

  private positional(x: number, y: number, z: number, ref = 8): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = ref;
    p.rolloffFactor = 1.1;
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
    p.connect(this.world);
    return p;
  }

  private sample(name: string, dest: AudioNode, gain: number, rate = 1, when = 0): boolean {
    const buf = this.samples.get(name);
    if (!buf || !this.ctx) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(dest);
    src.start(this.ctx.currentTime + when);
    return true;
  }

  /** Footstep on a surface (wet adds a splash). */
  footstep(surface: Surface, wet: number, loud: number): void {
    if (!this.ctx || this.paused) return;
    const i = Math.floor(Math.random() * 5);
    const ok = this.sample(`footstep_${surface}_00${i}`, this.sfx, 0.35 * loud, 0.9 + Math.random() * 0.2);
    if (!ok) this.synthStep(surface, loud);
    if (wet > 0.3) {
      const ctx = this.ctx;
      const n = ctx.createBufferSource();
      n.buffer = this.noise.white;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2500;
      const g = ctx.createGain();
      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.12 * wet * loud, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      n.connect(f).connect(g).connect(this.sfx);
      n.start(t, Math.random() * 2);
      n.stop(t + 0.15);
    }
  }

  private synthStep(surface: Surface, loud: number): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noise.white;
    const f = ctx.createBiquadFilter();
    f.type = surface === 'grass' ? 'lowpass' : 'bandpass';
    f.frequency.value = surface === 'grass' ? 900 : surface === 'wood' ? 500 : 2200;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.2 * loud, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (surface === 'grass' ? 0.12 : 0.06));
    n.connect(f).connect(g).connect(this.sfx);
    n.start(t, Math.random() * 2);
    n.stop(t + 0.15);
  }

  private hornAt(x: number, z: number): void {
    if (!this.ctx || this.paused) return;
    if (Math.hypot(x - this.listenerPos.x, z - this.listenerPos.z) > 160) return;
    const ctx = this.ctx;
    const p = this.positional(x, 1, z, 10);
    const g = ctx.createGain();
    const t = ctx.currentTime;
    const dur = 0.25 + Math.random() * 0.5;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.02);
    g.gain.setValueAtTime(0.09, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2000;
    f.connect(g).connect(p);
    const base = 330 + Math.random() * 120;
    for (const k of [1, 1.26]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = base * k;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }

  private crash(x: number, z: number): void {
    if (!this.ctx) return;
    const p = this.positional(x, 1, z, 10);
    const ok = this.sample(`impactMetal_heavy_00${Math.floor(Math.random() * 3)}`, p, 1.2, 0.7);
    this.sample(`impactGlass_medium_00${Math.floor(Math.random() * 3)}`, p, 0.6, 1, 0.05);
    this.sample(`impactPlate_heavy_00${Math.floor(Math.random() * 3)}`, p, 0.8, 0.6, 0.02);
    if (!ok) this.burst(p, 0.5, 300, 0.4);
  }

  private gunshot(x: number, z: number): void {
    if (!this.ctx) return;
    const p = this.positional(x, 1.5, z, 15);
    this.burst(p, 0.9, 1500, 0.25);
    this.burst(this.reverb, 0.3, 800, 0.8);
  }

  private burst(dest: AudioNode, gain: number, freq: number, dur: number, when = 0): void {
    const ctx = this.ctx!;
    const n = ctx.createBufferSource();
    n.buffer = this.noise.white;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime + when;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(f).connect(g).connect(dest);
    n.start(t, Math.random() * 2);
    n.stop(t + dur + 0.05);
  }

  private thunder(dist: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const delay = dist / 343;
    const loud = Math.min(1, 900 / Math.max(dist, 300));
    const t = ctx.currentTime + delay;
    const n = ctx.createBufferSource();
    n.buffer = this.noise.brown;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = dist < 900 ? 900 : 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    // Crack (close strikes) then a long rolling rumble.
    g.gain.linearRampToValueAtTime(0.9 * loud, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.35 * loud, t + 0.6);
    g.gain.linearRampToValueAtTime(0.5 * loud, t + 1.3);
    g.gain.exponentialRampToValueAtTime(0.001, t + 5 + dist / 1500);
    n.connect(f).connect(g);
    g.connect(this.sfx);
    g.connect(this.reverb);
    n.start(t, Math.random());
    n.stop(t + 7);
  }

  private scream(x: number, z: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const p = this.positional(x, 1.6, z, 6);
    const t = ctx.currentTime + Math.random() * 0.2;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = 700 + Math.random() * 500;
    o.frequency.setValueAtTime(f0 * 0.8, t);
    o.frequency.linearRampToValueAtTime(f0 * 1.15, t + 0.15);
    o.frequency.linearRampToValueAtTime(f0 * 0.7, t + 0.9);
    const vib = ctx.createOscillator();
    vib.frequency.value = 7;
    const vg = ctx.createGain();
    vg.gain.value = 18;
    vib.connect(vg).connect(o.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1300;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1);
    o.connect(bp).connect(g).connect(p);
    o.start(t);
    vib.start(t);
    o.stop(t + 1.05);
    vib.stop(t + 1.05);
  }

  private chirp(x: number, y: number, z: number, kind: 'bird' | 'gull'): void {
    const ctx = this.ctx!;
    const p = this.positional(x, y, z, kind === 'gull' ? 20 : 8);
    const t = ctx.currentTime;
    const notes = kind === 'bird' ? 2 + Math.floor(Math.random() * 4) : 3;
    for (let i = 0; i < notes; i++) {
      const at = t + i * (kind === 'bird' ? 0.12 : 0.32);
      const o = ctx.createOscillator();
      o.type = kind === 'bird' ? 'sine' : 'sawtooth';
      const f = kind === 'bird' ? 2800 + Math.random() * 1800 : 900 + Math.random() * 200;
      o.frequency.setValueAtTime(f, at);
      o.frequency.exponentialRampToValueAtTime(kind === 'bird' ? f * 1.4 : f * 0.6, at + (kind === 'bird' ? 0.08 : 0.28));
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(kind === 'bird' ? 0.025 : 0.03, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, at + (kind === 'bird' ? 0.1 : 0.3));
      const out: AudioNode = kind === 'gull' ? (() => {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1400;
        bp.Q.value = 1.5;
        bp.connect(p);
        return bp;
      })() : p;
      o.connect(g).connect(out);
      o.start(at);
      o.stop(at + 0.4);
    }
  }

  private siren(): void {
    const ctx = this.ctx!;
    const a = Math.random() * Math.PI * 2;
    const d = 350 + Math.random() * 300;
    const p = this.positional(this.listenerPos.x + Math.cos(a) * d, 5, this.listenerPos.z + Math.sin(a) * d, 60);
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const dur = 7;
    for (let k = 0; k < dur / 1.4; k++) {
      o.frequency.setValueAtTime(620, t + k * 1.4);
      o.frequency.linearRampToValueAtTime(1180, t + k * 1.4 + 0.7);
      o.frequency.linearRampToValueAtTime(620, t + k * 1.4 + 1.4);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 2);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(p);
    o.start(t);
    o.stop(t + dur);
  }

  private foghorn(): void {
    const ctx = this.ctx!;
    const p = this.positional(580, 10, 1062, 120);
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.4);
    g.gain.setValueAtTime(0.5, t + 2.6);
    g.gain.linearRampToValueAtTime(0, t + 3.4);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    f.connect(g).connect(p);
    g.connect(this.reverb);
    for (const hz of [73, 110]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = hz;
      o.connect(f);
      o.start(t);
      o.stop(t + 3.5);
    }
  }

  private chime(count: number, dist: number): void {
    const ctx = this.ctx!;
    const loud = Math.min(1, 120 / Math.max(dist, 40));
    for (let i = 0; i < count; i++) {
      const at = ctx.currentTime + i * 2.2;
      for (const [mult, amp] of [
        [1, 1],
        [2.01, 0.5],
        [2.76, 0.35],
        [5.4, 0.2],
      ]) {
        const o = ctx.createOscillator();
        o.frequency.value = 196 * mult;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.12 * amp * loud, at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0005, at + 3.5);
        o.connect(g);
        g.connect(this.sfx);
        g.connect(this.reverb);
        o.start(at);
        o.stop(at + 3.6);
      }
    }
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, f: AudioFrame): void {
    if (!this.ctx || this.paused) return;
    this.frame = f;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Listener.
    const cam = f.camera;
    cam.getWorldPosition(this.listenerPos);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(this.listenerPos.x, t, 0.02);
      L.positionY.setTargetAtTime(this.listenerPos.y, t, 0.02);
      L.positionZ.setTargetAtTime(this.listenerPos.z, t, 0.02);
      L.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      L.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      L.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      L.upX.setTargetAtTime(up.x, t, 0.02);
      L.upY.setTargetAtTime(up.y, t, 0.02);
      L.upZ.setTargetAtTime(up.z, t, 0.02);
    }
    this.worldFilter.frequency.setTargetAtTime(f.inCar ? 1400 : 20000, t, 0.2);
    // Ambience targets by district and time.
    const day = 1 - f.night;
    const d = f.district;
    const urban = d === 'midtown' ? 1 : d === 'oldtown' ? 0.75 : d === 'harbour' ? 0.6 : d === 'industrial' ? 0.55 : d === 'hills' ? 0.3 : d === 'park' ? 0.25 : 0.2;
    const carsNear = f.cars.filter((c) => c.speed > 1).length;
    const tg = this.bedTargets;
    tg.traffic = (0.05 + 0.1 * urban + Math.min(0.2, carsNear * 0.012)) * (0.45 + 0.55 * day);
    tg.murmur = Math.min(0.12, f.crowdNear * 0.006) * (0.5 + 0.5 * day) * (1 - 0.6 * f.rain);
    tg.sea = 0.2 * f.sea;
    tg.wind = Math.min(0.4, 0.015 + f.wind * 0.018) * (f.inCar ? 0.35 : 1) * (1 + Math.max(0, this.listenerPos.y - 20) / 60);
    tg.rain = f.rain * (f.inCar ? 0.05 : 0.22);
    tg.roof = f.inCar ? f.rain * 0.25 : 0;
    tg.machine = d === 'industrial' ? 0.12 * (0.5 + 0.5 * day) : d === 'harbour' ? 0.04 : 0;
    tg.crickets = (d === 'park' || d === 'hills' || d === 'island' ? 0.012 : 0.003) * f.night * (1 - f.rain);
    for (const [k, g] of Object.entries(this.beds)) g.gain.setTargetAtTime(tg[k] ?? 0, t, 0.6);
    // Scheduled synth events.
    this.birdT -= dt;
    if (this.birdT <= 0) {
      this.birdT = 1.5 + Math.random() * 5;
      if (day > 0.5 && f.rain < 0.2 && (d === 'park' || d === 'hills' || d === 'oldtown' || Math.random() < 0.2)) {
        const a = Math.random() * Math.PI * 2;
        this.chirp(this.listenerPos.x + Math.cos(a) * 25, this.listenerPos.y + 8, this.listenerPos.z + Math.sin(a) * 25, 'bird');
      }
    }
    this.gullT -= dt;
    if (this.gullT <= 0) {
      this.gullT = 4 + Math.random() * 9;
      if (f.sea > 0.3 && day > 0.4) {
        const a = Math.random() * Math.PI * 2;
        this.chirp(this.listenerPos.x + Math.cos(a) * 40, this.listenerPos.y + 25, this.listenerPos.z + Math.sin(a) * 40, 'gull');
      }
    }
    this.sirenT -= dt;
    if (this.sirenT <= 0) {
      this.sirenT = 70 + Math.random() * 120;
      if (urban > 0.4) this.siren();
    }
    this.foghornT -= dt;
    if (this.foghornT <= 0) {
      this.foghornT = 45 + Math.random() * 60;
      if (f.sea > 0.2 && (f.fog > 2.5 || f.night > 0.5)) this.foghorn();
    }
    const hour = Math.floor(f.hour);
    if (hour !== this.lastHourChimed && f.hour - hour < 0.05 && f.clockDist < 600) {
      this.lastHourChimed = hour;
      this.chime(((hour + 11) % 12) + 1, f.clockDist);
    }
    for (const s of f.screams) this.scream(s.x, s.z);
    // Traffic engine voices on the nearest moving cars.
    this.voiceTimer -= dt;
    if (this.voiceTimer <= 0) {
      this.voiceTimer = 0.15;
      const near = f.cars
        .filter((c) => c.speed > 0.5 || c.bus)
        .map((c) => ({ c, d: (c.x - this.listenerPos.x) ** 2 + (c.z - this.listenerPos.z) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, this.voices.length);
      this.voices.forEach((v, i) => {
        const n = near[i];
        if (!n) {
          v.gain.gain.setTargetAtTime(0, t, 0.3);
          return;
        }
        const c = n.c;
        v.panner.positionX.setTargetAtTime(c.x, t, 0.1);
        v.panner.positionY.setTargetAtTime(c.y + 0.6, t, 0.1);
        v.panner.positionZ.setTargetAtTime(c.z, t, 0.1);
        const rpm = Math.min(1, (c.speed % 9) / 9 + 0.15);
        v.osc.frequency.setTargetAtTime((c.bus ? 26 : 34) + rpm * 70, t, 0.15);
        v.filt.frequency.setTargetAtTime(220 + c.speed * 25, t, 0.2);
        v.gain.gain.setTargetAtTime(c.bus ? 0.22 : 0.1 + Math.min(0.12, c.speed * 0.008), t, 0.2);
      });
    }
    // Music chord changes.
    this.musicT -= dt;
    if (this.musicT <= 0) {
      this.musicT = 9;
      this.nextChord();
    }
  }

  /** Footstep trigger from the player's locomotion phase. */
  playerSteps(phase: number, speed: number, surface: Surface, wet: number): void {
    if (speed < 0.4) {
      this.lastPhase = phase;
      return;
    }
    const crossed = (a: number, b: number, x: number) => (a <= b ? a < x && b >= x : a < x || b >= x);
    if (crossed(this.lastPhase, phase, 0.02) || crossed(this.lastPhase, phase, 0.52)) {
      this.stepSide ^= 1;
      this.footstep(surface, wet, Math.min(1.3, 0.5 + speed * 0.12));
    }
    this.lastPhase = phase;
  }

  setPaused(p: boolean): void {
    this.paused = p;
    if (!this.ctx) return;
    if (p) void this.ctx.suspend();
    else void this.ctx.resume();
  }
}
