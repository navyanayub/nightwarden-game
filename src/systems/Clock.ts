/**
 * Game clock and sky geometry. One game day lasts `dayMinutes` real minutes (24 by default,
 * so one game hour = one real minute). Holding T fast-forwards. Sun and moon directions come
 * from a simple solar-position model for Port Vellmoor's (fictional) latitude, so sunrise is
 * around 05:50 and sunset around 18:10, with long warm evenings.
 */
import * as THREE from 'three';

const LATITUDE = THREE.MathUtils.degToRad(50);
const DECLINATION = THREE.MathUtils.degToRad(7);
const STORAGE_KEY = 'nightwarden.clock.v1';

/** Direction (unit, +Y up, north = -Z) of a body at an hour angle with a declination. */
function bodyDir(hourAngle: number, decl: number, out: THREE.Vector3): THREE.Vector3 {
  const sinEl = Math.sin(LATITUDE) * Math.sin(decl) + Math.cos(LATITUDE) * Math.cos(decl) * Math.cos(hourAngle);
  const el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const cosAz = (Math.sin(decl) - Math.sin(el) * Math.sin(LATITUDE)) / Math.max(1e-6, Math.cos(el) * Math.cos(LATITUDE));
  let az = Math.acos(THREE.MathUtils.clamp(cosAz, -1, 1)); // from north, towards east in the morning
  if (Math.sin(hourAngle) > 0) az = Math.PI * 2 - az; // afternoon: west
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

export class GameClock {
  /** Hours since midnight, 0..24. */
  hours = 10;
  /** Real minutes per game day. */
  dayMinutes = 24;
  /** Game days elapsed (for moon phase / weather seeds). */
  day = 0;
  fastForward = false;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly moonDir = new THREE.Vector3(0, -1, 0);
  /** 0 = night .. 1 = full day (smooth through twilight). */
  daylight = 1;
  /** 0..1 strength of the warm sunrise / sunset tint. */
  golden = 0;
  /** 0..1: how dark it is (drives street lamps, headlights, lit windows). */
  night = 0;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as { dayMinutes?: number };
        if (s.dayMinutes && s.dayMinutes > 0) this.dayMinutes = s.dayMinutes;
      }
    } catch {
      /* storage unavailable */
    }
    const q = new URLSearchParams(location.search);
    const t = q.get('time');
    if (t !== null && !Number.isNaN(Number(t))) this.hours = ((Number(t) % 24) + 24) % 24;
    const dm = q.get('daymin');
    if (dm && Number(dm) > 0) this.dayMinutes = Number(dm);
    this.compute();
  }

  setDayMinutes(m: number): void {
    this.dayMinutes = m;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ dayMinutes: m }));
    } catch {
      /* ignore */
    }
  }

  /** Game hours advanced per real second. */
  get rate(): number {
    return (24 / (this.dayMinutes * 60)) * (this.fastForward ? 40 : 1);
  }

  update(dt: number): void {
    this.hours += dt * this.rate;
    while (this.hours >= 24) {
      this.hours -= 24;
      this.day++;
    }
    this.compute();
  }

  set(hours: number): void {
    this.hours = ((hours % 24) + 24) % 24;
    this.compute();
  }

  compute(): void {
    const ha = ((this.hours - 12) / 24) * Math.PI * 2;
    bodyDir(ha, DECLINATION, this.sunDir);
    // The moon trails the anti-sun by ~2 h with a lower declination.
    bodyDir(ha + Math.PI - 0.5, -DECLINATION * 1.4, this.moonDir);
    const el = this.sunDir.y;
    this.daylight = THREE.MathUtils.smoothstep(el, -0.1, 0.16);
    this.night = 1 - THREE.MathUtils.smoothstep(el, -0.08, 0.06);
    this.golden = Math.max(0, 1 - Math.abs(el - 0.05) / 0.2) * (el > -0.1 ? 1 : 0);
  }

  /** "HH:MM" */
  label(): string {
    const h = Math.floor(this.hours);
    const m = Math.floor((this.hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** 0..1 traffic / crowd activity for the current hour (rush hours peak, small hours quiet). */
  activity(): number {
    const h = this.hours;
    const bump = (c: number, w: number) => Math.exp(-((h - c) * (h - c)) / (2 * w * w));
    const base = 0.18 + 0.55 * THREE.MathUtils.smoothstep(h, 5.5, 8) * (1 - THREE.MathUtils.smoothstep(h, 21, 24.5));
    return Math.min(1, base + 0.35 * bump(8.3, 1.1) + 0.3 * bump(17.6, 1.4) + 0.08 * bump(13, 1.5));
  }
}

export const clock = new GameClock();
