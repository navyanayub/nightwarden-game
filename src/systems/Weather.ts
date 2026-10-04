/**
 * Weather state machine + global wind.
 *
 * States blend smoothly: every few game hours a new state is picked from a Markov table and
 * all parameters (cloud cover, rain, fog, wind, overcast darkening, lightning) ease towards it.
 * Y cycles states manually. Wetness accumulates with rain and dries slowly afterwards.
 *
 * `wind` is a global, DOM-free value read by trees, rain, flags and (Stage 3) the cape.
 */
import * as THREE from 'three';
import { events } from '../core/EventBus';
import { hashFloat, noise2 } from '../core/Random';
import { clock } from './Clock';

export type WeatherState = 'clear' | 'partly' | 'overcast' | 'lightrain' | 'heavyrain' | 'storm' | 'fog';

export const WEATHER_ORDER: WeatherState[] = ['clear', 'partly', 'overcast', 'lightrain', 'heavyrain', 'storm', 'fog'];

export const WEATHER_NAMES: Record<WeatherState, string> = {
  clear: 'Clear',
  partly: 'Partly cloudy',
  overcast: 'Overcast',
  lightrain: 'Light rain',
  heavyrain: 'Heavy rain',
  storm: 'Thunderstorm',
  fog: 'Fog',
};

interface WeatherParams {
  clouds: number;
  cloudDensity: number;
  overcast: number;
  rain: number;
  fog: number;
  wind: number;
  lightning: number;
}

const PARAMS: Record<WeatherState, WeatherParams> = {
  clear: { clouds: 0.18, cloudDensity: 0.45, overcast: 0, rain: 0, fog: 1, wind: 0.15, lightning: 0 },
  partly: { clouds: 0.45, cloudDensity: 0.55, overcast: 0.05, rain: 0, fog: 1.1, wind: 0.3, lightning: 0 },
  overcast: { clouds: 0.9, cloudDensity: 0.85, overcast: 0.7, rain: 0, fog: 1.8, wind: 0.4, lightning: 0 },
  lightrain: { clouds: 0.95, cloudDensity: 0.9, overcast: 0.82, rain: 0.35, fog: 2.4, wind: 0.45, lightning: 0 },
  heavyrain: { clouds: 1, cloudDensity: 1, overcast: 0.92, rain: 1, fog: 3.6, wind: 0.65, lightning: 0 },
  storm: { clouds: 1, cloudDensity: 1, overcast: 1, rain: 1, fog: 3.2, wind: 1, lightning: 1 },
  fog: { clouds: 0.7, cloudDensity: 0.8, overcast: 0.55, rain: 0, fog: 11, wind: 0.06, lightning: 0 },
};

/** Likely next states (weights). */
const NEXT: Record<WeatherState, Partial<Record<WeatherState, number>>> = {
  clear: { clear: 3, partly: 4, fog: 1 },
  partly: { clear: 3, partly: 2, overcast: 3 },
  overcast: { partly: 3, overcast: 1, lightrain: 3, fog: 1 },
  lightrain: { overcast: 3, lightrain: 1, heavyrain: 2 },
  heavyrain: { lightrain: 3, storm: 2, overcast: 1 },
  storm: { heavyrain: 3, lightrain: 2 },
  fog: { partly: 3, overcast: 2, clear: 1 },
};

/** Global wind. Direction is where the wind blows *towards* (unit XZ). */
export const wind = {
  dirX: 0.8,
  dirZ: 0.6,
  /** 0..1 base strength from the weather. */
  strength: 0.2,
  /** 0..1 current gust factor on top of the base. */
  gust: 0,
  /** Current wind speed in m/s (base + gust). */
  speed: 3,
  /** World-space wind vector (m/s). */
  vector: new THREE.Vector3(2.4, 0, 1.8),
};

export class Weather {
  state: WeatherState = 'partly';
  private target: WeatherParams = { ...PARAMS.partly };
  readonly p: WeatherParams = { ...PARAMS.partly };
  /** 0..1 how wet surfaces are. */
  wetness = 0;
  /** Game hours until the next automatic change. */
  private nextChange = 3;
  private blendRate = 0.6;
  private t = 0;
  private lightningTimer = 6;
  /** Current lightning flash brightness (0..~3), decays quickly. */
  flash = 0;
  private flashQueue: { at: number; amp: number }[] = [];
  /** Last lightning bolt (for the bolt mesh and thunder). */
  bolt: { x: number; z: number; dist: number; time: number; seed: number } | null = null;
  /** 0..1 harbour fog bank strength (dawn). */
  fogBank = 0;

  constructor() {
    const w = new URLSearchParams(location.search).get('weather') as WeatherState | null;
    if (w && w in PARAMS) this.set(w, true);
  }

  set(state: WeatherState, instant = false): void {
    this.state = state;
    this.target = { ...PARAMS[state] };
    this.nextChange = 2 + hashFloat(clock.day, Math.floor(clock.hours * 10), 31) * 3;
    if (instant) {
      Object.assign(this.p, this.target);
      if (this.p.rain > 0.2) this.wetness = Math.min(1, this.p.rain + 0.3);
    }
    this.blendRate = instant ? 100 : 0.6;
    events.emit('weather:change', { state });
  }

  /** Cycle to the next state quickly (Y key). */
  cycle(): void {
    const i = WEATHER_ORDER.indexOf(this.state);
    this.set(WEATHER_ORDER[(i + 1) % WEATHER_ORDER.length]);
    this.blendRate = 0.35; // ~3 s to settle
  }

  update(dt: number, camX: number, camZ: number): void {
    this.t += dt;
    // Automatic changes on the game clock.
    this.nextChange -= dt * clock.rate;
    if (this.nextChange <= 0) {
      const opts = NEXT[this.state];
      const total = Object.values(opts).reduce((a, b) => a + (b ?? 0), 0);
      let r = hashFloat(clock.day, Math.floor(clock.hours * 7), 77) * total;
      let pick: WeatherState = this.state;
      for (const [s, w] of Object.entries(opts) as [WeatherState, number][]) {
        r -= w;
        if (r <= 0) {
          pick = s;
          break;
        }
      }
      this.set(pick);
      this.blendRate = 0.6 * Math.max(1, clock.rate * 60);
    }
    // Ease every parameter: the time constant is in real seconds (~1/rate * 4).
    const k = 1 - Math.exp(-dt * this.blendRate * 0.25);
    for (const key of Object.keys(this.p) as (keyof WeatherParams)[]) this.p[key] += (this.target[key] - this.p[key]) * k;
    // Wetness.
    if (this.p.rain > 0.05) this.wetness = Math.min(1, this.wetness + dt * this.p.rain * 0.05 * (1 + clock.rate * 30));
    else this.wetness = Math.max(0, this.wetness - dt * 0.004 * (1 + clock.rate * 30) * (0.3 + clock.daylight));
    // Wind: slowly wandering direction, gusts from 1D noise.
    const a = 0.65 + noise2(this.t * 0.004, 3.1) * 1.2;
    wind.dirX = Math.cos(a);
    wind.dirZ = Math.sin(a);
    wind.strength = this.p.wind;
    wind.gust = Math.max(0, (noise2(this.t * 0.35, 9.7) * 0.5 + 0.5) * 1.6 - 0.55) * (0.3 + this.p.wind);
    wind.speed = 1 + this.p.wind * 14 + wind.gust * 8;
    wind.vector.set(wind.dirX * wind.speed, 0, wind.dirZ * wind.speed);
    // Lightning.
    this.flash *= Math.exp(-dt * 9);
    for (let i = this.flashQueue.length - 1; i >= 0; i--) {
      if (this.t >= this.flashQueue[i].at) {
        this.flash = Math.max(this.flash, this.flashQueue[i].amp);
        this.flashQueue.splice(i, 1);
      }
    }
    if (this.p.lightning > 0.5) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.strike(camX, camZ);
        this.lightningTimer = 5 + hashFloat(Math.floor(this.t * 10), 5) * 12;
      }
    }
    // Harbour fog bank at dawn (or whenever the fog state is active).
    const h = clock.hours;
    const dawn = THREE.MathUtils.smoothstep(h, 4, 5.8) * (1 - THREE.MathUtils.smoothstep(h, 7.6, 9.5));
    const today = hashFloat(clock.day, 404) < 0.75 ? 1 : 0.25;
    const target = Math.max(dawn * today * (1 - this.p.rain), this.state === 'fog' ? 0.9 : 0);
    this.fogBank += (target - this.fogBank) * (1 - Math.exp(-dt * 0.2));
  }

  /** Trigger a lightning strike somewhere around the camera (also used by tests). */
  strike(camX: number, camZ: number): void {
    const s = Math.floor(this.t * 1000);
    const ang = hashFloat(s, 1) * Math.PI * 2;
    const dist = 500 + hashFloat(s, 2) * 2600;
    const x = camX + Math.cos(ang) * dist;
    const z = camZ + Math.sin(ang) * dist;
    const amp = 1.4 + hashFloat(s, 3) * 1.6 * (1 - dist / 4000);
    // Multi-stroke flicker.
    this.flashQueue.push({ at: this.t, amp }, { at: this.t + 0.09, amp: amp * 0.4 }, { at: this.t + 0.2, amp: amp * 0.85 });
    if (hashFloat(s, 4) > 0.5) this.flashQueue.push({ at: this.t + 0.38, amp: amp * 0.5 });
    this.bolt = { x, z, dist, time: this.t, seed: s };
    events.emit('weather:lightning', { x, z, dist });
  }

  get time(): number {
    return this.t;
  }
}

export const weather = new Weather();
