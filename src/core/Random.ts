/**
 * Deterministic randomness. Every procedural system must draw from these helpers
 * (never Math.random) so Port Vellmoor is identical on every run.
 */

/** Global world seed. Changing it changes the whole city. */
export const WORLD_SEED = 0x7e11_2024;

/** 32-bit integer hash (lowbias32). */
export function hash32(x: number): number {
  x = x | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Combine several integers into one hash. */
export function hashN(...values: number[]): number {
  let h = WORLD_SEED;
  for (const v of values) h = hash32(h ^ hash32(Math.floor(v) + 0x9e3779b9));
  return h;
}

/** Hash to float in [0,1). */
export function hashFloat(...values: number[]): number {
  return hashN(...values) / 4294967296;
}

/** Seeded PRNG (mulberry32) with convenience helpers. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }
  /** Weighted pick: weights array parallel to items. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
  /** Approximately normal distribution (mean 0, sd 1). */
  gauss(): number {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.732;
  }
}

/** Create a child RNG for a named sub-system so generation order never matters. */
export function rngFor(...keys: number[]): Rng {
  return new Rng(hashN(...keys));
}

/** String to stable integer (FNV-1a). */
export function strHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ------------------------------------------------------------------ value noise

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 2D value noise in [-1, 1]. */
export function noise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hashFloat(xi, yi, seed);
  const b = hashFloat(xi + 1, yi, seed);
  const c = hashFloat(xi, yi + 1, seed);
  const d = hashFloat(xi + 1, yi + 1, seed);
  const u = smooth(xf);
  const v = smooth(yf);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

/** Fractal Brownian motion of value noise in roughly [-1, 1]. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
