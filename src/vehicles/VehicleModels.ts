/**
 * Parametric procedural vehicles. Every body is lofted from cross-sections whose bottom edge
 * follows the wheel arches and whose top follows a hood -> windshield -> roof -> rear glass ->
 * deck profile, so one generator covers city cars, hatchbacks, sedans, estates, SUVs, pickups,
 * vans, taxis and the city bus. Front = +Z, up = +Y, origin on the ground; driver sits on the
 * left (+X) for right-hand traffic.
 *
 * All makes and models are fictional (Corvane, Halden, Marisco, Oberline, Tessaro, Vellmar).
 */
import * as THREE from 'three';
import { MeshBuilder, type V3 } from '../world/MeshBuilder';
import { signs } from '../world/Signage';

export type VehicleKind = 'compact' | 'hatchback' | 'sedan' | 'estate' | 'suv' | 'pickup' | 'van' | 'taxi' | 'bus';

export interface VehicleSpec {
  kind: VehicleKind;
  make: string;
  model: string;
  length: number;
  width: number;
  track: number;
  frontAxle: number;
  rearAxle: number;
  wheelRadius: number;
  /** Underbody height between the axles. */
  clearance: number;
  belt: number;
  beltRise: number;
  /** Hood height at the windshield base / at the nose. */
  hoodBase: number;
  nose: number;
  roof: number;
  /** Trunk / rear deck height and the drop to the tail. */
  deck: number;
  tailDrop: number;
  /** Windshield base & top z; roof end & rear-glass bottom z. */
  ws0: number;
  ws1: number;
  rw0: number;
  rw1: number;
  sideFront: number;
  sideRear: number;
  pillars: number[];
  /** Plan-view corner rounding (0.74 = rounded car, 0.92 = boxy). */
  plan: number;
  /** Cabin tumblehome. */
  tumble: number;
  bed?: boolean;
  /** Physics / handling. */
  mass: number;
  engineForce: number;
  topSpeed: number;
  /** Typical cruising factor for AI drivers. */
  aiSpeed: number;
  palette: [number, number, number][];
}

const CAR_PALETTE: [number, number, number][] = [
  [0.42, 0.02, 0.03], [0.03, 0.07, 0.18], [0.72, 0.73, 0.74], [0.05, 0.05, 0.055], [0.85, 0.85, 0.83], [0.25, 0.26, 0.28],
  [0.05, 0.16, 0.1], [0.45, 0.3, 0.12], [0.12, 0.28, 0.45], [0.55, 0.42, 0.06], [0.6, 0.6, 0.62], [0.32, 0.05, 0.12],
];

export const SPECS: Record<VehicleKind, VehicleSpec> = {
  compact: {
    kind: 'compact', make: 'Halden', model: 'Pip', length: 3.72, width: 1.72, track: 1.48, frontAxle: 1.22, rearAxle: -1.18, wheelRadius: 0.31,
    clearance: 0.2, belt: 0.95, beltRise: 0.03, hoodBase: 0.98, nose: 0.72, roof: 1.52, deck: 0.98, tailDrop: 0.22,
    ws0: 0.98, ws1: 0.18, rw0: -1.48, rw1: -1.78, sideFront: 0.84, sideRear: -1.38, pillars: [-0.38], plan: 0.78, tumble: 0.26,
    mass: 1050, engineForce: 5400, topSpeed: 48, aiSpeed: 0.92,
    palette: [[0.75, 0.12, 0.08], [0.9, 0.75, 0.2], [0.2, 0.45, 0.6], [0.85, 0.85, 0.83], [0.35, 0.55, 0.3], [0.05, 0.05, 0.055]],
  },
  hatchback: {
    kind: 'hatchback', make: 'Marisco', model: 'Vela', length: 4.22, width: 1.8, track: 1.55, frontAxle: 1.32, rearAxle: -1.3, wheelRadius: 0.33,
    clearance: 0.2, belt: 0.96, beltRise: 0.05, hoodBase: 0.98, nose: 0.7, roof: 1.46, deck: 1.0, tailDrop: 0.22,
    ws0: 1.0, ws1: 0.12, rw0: -1.58, rw1: -1.98, sideFront: 0.86, sideRear: -1.48, pillars: [-0.4], plan: 0.76, tumble: 0.3,
    mass: 1220, engineForce: 6300, topSpeed: 54, aiSpeed: 1,
    palette: CAR_PALETTE,
  },
  sedan: {
    kind: 'sedan', make: 'Corvane', model: 'Strata', length: 4.72, width: 1.86, track: 1.6, frontAxle: 1.38, rearAxle: -1.44, wheelRadius: 0.34,
    clearance: 0.2, belt: 0.96, beltRise: 0.06, hoodBase: 0.97, nose: 0.67, roof: 1.44, deck: 1.03, tailDrop: 0.24,
    ws0: 0.92, ws1: 0.02, rw0: -0.78, rw1: -1.42, sideFront: 0.72, sideRear: -0.98, pillars: [-0.22, -0.76], plan: 0.74, tumble: 0.3,
    mass: 1380, engineForce: 7200, topSpeed: 62, aiSpeed: 1.05,
    palette: CAR_PALETTE,
  },
  estate: {
    kind: 'estate', make: 'Corvane', model: 'Strata Tourer', length: 4.82, width: 1.86, track: 1.6, frontAxle: 1.4, rearAxle: -1.46, wheelRadius: 0.34,
    clearance: 0.2, belt: 0.97, beltRise: 0.04, hoodBase: 0.98, nose: 0.68, roof: 1.47, deck: 1.02, tailDrop: 0.2,
    ws0: 0.95, ws1: 0.05, rw0: -2.2, rw1: -2.34, sideFront: 0.76, sideRear: -2.05, pillars: [-0.22, -1.2], plan: 0.76, tumble: 0.28,
    mass: 1460, engineForce: 7000, topSpeed: 58, aiSpeed: 1,
    palette: CAR_PALETTE,
  },
  suv: {
    kind: 'suv', make: 'Oberline', model: 'Ridgeback', length: 4.72, width: 1.96, track: 1.68, frontAxle: 1.44, rearAxle: -1.42, wheelRadius: 0.39,
    clearance: 0.34, belt: 1.18, beltRise: 0.03, hoodBase: 1.2, nose: 0.96, roof: 1.8, deck: 1.22, tailDrop: 0.25,
    ws0: 0.98, ws1: 0.22, rw0: -2.12, rw1: -2.28, sideFront: 0.82, sideRear: -1.98, pillars: [-0.35, -1.32], plan: 0.82, tumble: 0.2,
    mass: 1950, engineForce: 8600, topSpeed: 52, aiSpeed: 0.98,
    palette: [[0.05, 0.05, 0.055], [0.85, 0.85, 0.83], [0.25, 0.26, 0.28], [0.18, 0.22, 0.16], [0.42, 0.02, 0.03], [0.12, 0.2, 0.32], [0.5, 0.45, 0.38]],
  },
  pickup: {
    kind: 'pickup', make: 'Tessaro', model: 'Mule', length: 5.3, width: 1.96, track: 1.7, frontAxle: 1.85, rearAxle: -1.55, wheelRadius: 0.39,
    clearance: 0.32, belt: 1.16, beltRise: 0.0, hoodBase: 1.2, nose: 1.02, roof: 1.86, deck: 1.16, tailDrop: 0.06,
    ws0: 1.25, ws1: 0.55, rw0: -0.72, rw1: -0.8, sideFront: 1.08, sideRear: -0.66, pillars: [-0.1], plan: 0.9, tumble: 0.16, bed: true,
    mass: 2050, engineForce: 8800, topSpeed: 48, aiSpeed: 0.95,
    palette: [[0.75, 0.12, 0.08], [0.85, 0.85, 0.83], [0.12, 0.2, 0.32], [0.05, 0.05, 0.055], [0.5, 0.45, 0.38], [0.18, 0.3, 0.2]],
  },
  van: {
    kind: 'van', make: 'Oberline', model: 'Carrier', length: 5.1, width: 2.0, track: 1.72, frontAxle: 1.72, rearAxle: -1.62, wheelRadius: 0.36,
    clearance: 0.26, belt: 1.15, beltRise: 0.0, hoodBase: 1.15, nose: 0.98, roof: 2.12, deck: 2.0, tailDrop: 0.05,
    ws0: 1.88, ws1: 1.12, rw0: -2.49, rw1: -2.53, sideFront: 1.62, sideRear: 0.92, pillars: [], plan: 0.92, tumble: 0.08,
    mass: 2300, engineForce: 8200, topSpeed: 44, aiSpeed: 0.9,
    palette: [[0.9, 0.9, 0.88], [0.9, 0.9, 0.88], [0.62, 0.64, 0.66], [0.12, 0.2, 0.32], [0.75, 0.12, 0.08]],
  },
  taxi: {
    kind: 'taxi', make: 'Vellmoor Cabs', model: 'Strata', length: 4.72, width: 1.86, track: 1.6, frontAxle: 1.38, rearAxle: -1.44, wheelRadius: 0.34,
    clearance: 0.2, belt: 0.96, beltRise: 0.06, hoodBase: 0.97, nose: 0.67, roof: 1.44, deck: 1.03, tailDrop: 0.24,
    ws0: 0.92, ws1: 0.02, rw0: -0.78, rw1: -1.42, sideFront: 0.72, sideRear: -0.98, pillars: [-0.22, -0.76], plan: 0.74, tumble: 0.3,
    mass: 1400, engineForce: 7000, topSpeed: 58, aiSpeed: 1.1,
    palette: [[0.02, 0.3, 0.33]],
  },
  bus: {
    kind: 'bus', make: 'Vellmar', model: 'Citiline', length: 11.8, width: 2.55, track: 2.1, frontAxle: 3.55, rearAxle: -2.55, wheelRadius: 0.5,
    clearance: 0.36, belt: 1.3, beltRise: 0.0, hoodBase: 1.05, nose: 1.0, roof: 3.05, deck: 2.95, tailDrop: 0.05,
    ws0: 5.86, ws1: 5.62, rw0: -5.84, rw1: -5.88, sideFront: 5.55, sideRear: -5.4, pillars: [4.2, 2.8, 1.4, 0, -1.4, -2.8, -4.2], plan: 0.94, tumble: 0.04,
    mass: 11000, engineForce: 30000, topSpeed: 24, aiSpeed: 0.75,
    palette: [[0.06, 0.25, 0.45]],
  },
};

export const TRAFFIC_KINDS: VehicleKind[] = ['compact', 'hatchback', 'sedan', 'estate', 'suv', 'pickup', 'van', 'taxi'];

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Profile functions for a spec. */
class Shape {
  readonly L: number;
  constructor(readonly s: VehicleSpec) {
    this.L = s.length / 2;
  }

  halfWidth(z: number): number {
    const s = this.s;
    const L = this.L;
    const w = s.width / 2;
    const front = 1 - smoothstep(L - 0.42, L, z);
    const rear = 1 - smoothstep(L - 0.36, L, -z);
    const round = (t: number) => Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
    return w * (s.plan + (1 - s.plan) * Math.min(round(front), round(rear))) - 0.01 * Math.max(0, z) / L;
  }

  archR(): number {
    return this.s.wheelRadius * 1.19;
  }

  archBottom(z: number): number {
    const s = this.s;
    const L = this.L;
    let y = s.clearance + 0.16 * smoothstep(L - 0.55, L, z) + 0.12 * smoothstep(L - 0.7, L, -z);
    const r = this.archR();
    for (const a of [s.frontAxle, s.rearAxle]) {
      const d = z - a;
      if (Math.abs(d) < r) y = Math.max(y, s.wheelRadius + Math.sqrt(r * r - d * d) - 0.02);
    }
    return y;
  }

  beltY(z: number): number {
    return this.s.belt + this.s.beltRise * smoothstep(1.2, -1.6, z);
  }

  deckY(z: number): number {
    const s = this.s;
    const L = this.L;
    if (z > s.ws0 - 0.02) return s.hoodBase - (s.hoodBase - s.nose) * (0.67 * smoothstep(s.ws0, L, z) + 0.33 * smoothstep(L - 0.3, L, z));
    if (z < s.rw1 + 0.02) {
      if (s.bed) return s.deck - s.tailDrop * smoothstep(-L + 0.1, -L, z);
      return s.deck - 0.04 * smoothstep(s.rw1, -L + 0.2, z) - (s.tailDrop - 0.04) * smoothstep(-L + 0.25, -L, z);
    }
    return s.hoodBase;
  }

  roofY(z: number): number {
    const s = this.s;
    if (z >= s.ws0 || z <= s.rw1) return -1;
    if (z > s.ws1) return s.hoodBase + (s.roof - s.hoodBase) * Math.pow(smoothstep(s.ws0, s.ws1, z), 0.8);
    if (z < s.rw0) return s.deck + (s.roof - s.deck) * Math.pow(smoothstep(s.rw1, s.rw0, z), 0.85);
    const mid = (s.ws1 + s.rw0) / 2;
    const half = Math.max(0.4, (s.ws1 - s.rw0) / 2);
    return s.roof - 0.03 * Math.pow((z - mid) / half, 2);
  }

  section(z: number): { pts: [number, number][]; glassFrom: number } {
    const w = this.halfWidth(z);
    const yb = this.archBottom(z);
    const ys = this.beltY(z);
    const yd = this.deckY(z);
    const yr = this.roofY(z);
    const y2 = Math.max(yb + 0.06, Math.min(0.42 + (this.s.clearance - 0.2), ys - 0.2));
    const y3 = Math.max(y2 + 0.04, Math.min(0.62 + (this.s.clearance - 0.2), ys - 0.12));
    const y4 = Math.max(y3 + 0.03, ys - 0.05);
    const pts: [number, number][] = [
      [0, yb],
      [w - 0.1, yb],
      [w - 0.015, y2],
      [w, y3],
      [w - 0.012, y4],
      [w - 0.04, Math.max(Math.min(ys, Math.max(yd, yr)), y4 + 0.01)],
    ];
    const glassFrom = pts.length;
    const top = yr > 0 ? Math.max(yr, yd) : yd;
    const base = pts[pts.length - 1][1];
    const gh = Math.max(0, top - base);
    const cabin = yr > 0;
    const tumble = this.s.tumble;
    const inset = (t: number) => (cabin ? 0.045 + tumble * t * t : 0.05 + 0.12 * t * Math.min(1, gh / 0.12));
    for (const t of [0.06, 0.2, 0.42, 0.66, 0.9, 1.0]) pts.push([w - inset(t) - 0.04, base + gh * t]);
    const edgeX = pts[pts.length - 1][0];
    const crown = cabin ? 0.03 : 0.035;
    pts.push([edgeX * 0.55, top + crown * 0.75]);
    pts.push([0, top + crown]);
    return { pts, glassFrom };
  }
}

/** Lamp channel per light material key (traffic instancing reads it). */
export const LAMP_KEYS: Record<string, number> = {
  car_drl: 0,
  car_sign: 0,
  car_headlight: 1,
  car_brake: 2,
  car_reverse: 3,
  car_indicator_l: 4,
  car_indicator_r: 5,
};

/** Emit a full vehicle body into a MeshBuilder (keys: car_paint, car_glass, car_trim, car_black...). */
export function buildBody(spec: VehicleSpec, mb: MeshBuilder, lowDetail = false): { seat: THREE.Vector3 } {
  const sh = new Shape(spec);
  const L = sh.L;
  const s = spec;
  // ---------------------------------------------------------------- body loft
  const stations: number[] = [];
  const step = (s.kind === 'bus' ? 0.09 : 0.045) * (lowDetail ? 2.4 : 1);
  for (let z = -L; z <= L + 1e-6; z += step) stations.push(Math.min(z, L));
  if (stations[stations.length - 1] < L) stations.push(L);
  const secs = stations.map((z) => sh.section(z));
  const np = secs[0].pts.length;
  const gf = secs[0].glassFrom;
  const glassAt = (z: number, k: number): 'glass' | 'paint' | 'trim' => {
    const yr = sh.roofY(z);
    if (k < gf - 1 || yr < 0) return 'paint';
    if (k === gf - 1) return 'trim';
    if (k >= gf + 5) return z > s.ws1 + 0.04 || z < s.rw0 - 0.06 ? 'glass' : 'paint';
    if (k === gf + 4) return 'paint';
    if (s.kind === 'bus' && k === gf) return 'trim';
    if (z > s.sideFront || z < s.sideRear) return 'paint';
    for (const p of s.pillars) if (Math.abs(z - p) < (s.kind === 'bus' ? 0.08 : 0.06)) return 'trim';
    return 'glass';
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const za = stations[i];
    const zb = stations[i + 1];
    const A = secs[i].pts;
    const B = secs[i + 1].pts;
    for (let k = 0; k < np - 1; k++) {
      const kind = glassAt((za + zb) / 2, k);
      const key = kind === 'glass' ? 'car_glass' : kind === 'trim' ? 'car_trim' : 'car_paint';
      for (const side of [1, -1]) {
        const p0: V3 = [A[k][0] * side, A[k][1], za];
        const p1: V3 = [B[k][0] * side, B[k][1], zb];
        const p2: V3 = [B[k + 1][0] * side, B[k + 1][1], zb];
        const p3: V3 = [A[k + 1][0] * side, A[k + 1][1], za];
        if (side > 0) mb.quad(key, p1, p0, p3, p2);
        else mb.quad(key, p0, p1, p2, p3);
      }
    }
  }
  for (const [idx, sign] of [
    [0, -1],
    [stations.length - 1, 1],
  ] as [number, number][]) {
    const pts = secs[idx].pts;
    const z = stations[idx];
    for (let k = 0; k < np - 1; k++) {
      // Vans and buses have glazed ends above the belt.
      const key = (s.kind === 'bus' || s.kind === 'van') && pts[k][1] > s.belt + 0.25 && pts[k + 1][1] < s.roof - 0.12 && (sign > 0 || s.kind === 'bus') ? 'car_glass' : 'car_paint';
      for (const side of [1, -1]) {
        const a: V3 = [0, pts[k][1], z];
        const b: V3 = [pts[k][0] * side, pts[k][1], z];
        const c: V3 = [pts[k + 1][0] * side, pts[k + 1][1], z];
        const d: V3 = [0, pts[k + 1][1], z];
        if (sign * side > 0) mb.quad(key, a, b, c, d);
        else mb.quad(key, b, a, d, c);
      }
    }
  }
  // ---------------------------------------------------------------- front
  const fz = L;
  const rz = -L;
  const big = s.kind === 'suv' || s.kind === 'pickup' || s.kind === 'van' || s.kind === 'bus';
  const ny = sh.deckY(L - 0.02);
  const gw = big ? 0.62 : 0.46;
  const gy0 = ny - (big ? 0.42 : 0.21);
  const gy1 = ny - 0.06;
  mb.box('car_chrome', -gw, gy0, fz - 0.07, gw, gy1, fz + 0.006);
  mb.box('car_black', -gw + 0.03, gy0 + 0.015, fz - 0.06, gw - 0.03, gy1 - 0.015, fz + 0.012);
  const slats = big ? 6 : 4;
  for (let k = 0; k < slats; k++) {
    const y = gy0 + 0.03 + k * ((gy1 - gy0 - 0.06) / slats);
    mb.box('car_chrome', -gw + 0.05, y, fz, gw - 0.05, y + 0.007, fz + 0.02);
  }
  mb.box('car_black', -s.width / 2 + 0.2, gy0 - 0.14, fz - 0.16, s.width / 2 - 0.2, gy0 - 0.1, fz + 0.025);
  for (const sx of [-1, 1]) {
    const hx = sx * (s.width / 2 - (big ? 0.3 : 0.27));
    mb.pushTRS(hx, ny - 0.045, fz - 0.09, 0);
    mb.pushTransform(new THREE.Matrix4().makeRotationX(big ? -0.1 : -0.42).multiply(new THREE.Matrix4().makeRotationY(sx * -0.12)));
    const hw = big ? 0.2 : 0.17;
    mb.box('car_chrome', -hw, -0.035, -0.12, hw, 0.035, 0.07);
    mb.box('car_headlight', -hw + 0.015, -0.026, -0.1, hw - 0.015, 0.026, 0.074);
    mb.box('car_drl', -hw + 0.01, -0.045, -0.06, hw - 0.01, -0.034, 0.072);
    mb.popTransform();
    mb.popTransform();
    // Front indicator (amber) at the outer corner.
    mb.box(sx > 0 ? 'car_indicator_l' : 'car_indicator_r', hx + sx * 0.14 - 0.035, ny - 0.13, fz - 0.12, hx + sx * 0.14 + 0.035, ny - 0.09, fz + 0.01);
    mb.pushTRS(sx * (s.width / 2 - 0.31), gy0 - 0.06, fz - 0.03, 0);
    mb.pushTransform(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    mb.cylinder('car_headlight', 0, 0, 0, 0.04, 0.04, 0.035, 12);
    mb.popTransform();
    mb.popTransform();
  }
  // ---------------------------------------------------------------- rear
  const tailTop = sh.deckY(-L + 0.01);
  const ty1 = Math.min(tailTop - 0.04, s.belt + 0.05);
  const ty0 = ty1 - (s.kind === 'van' || s.kind === 'bus' ? 0.3 : 0.15);
  const rearBar = s.kind === 'sedan' || s.kind === 'taxi' || s.kind === 'estate';
  if (rearBar) mb.box('car_brake', -0.62, ty1 - 0.04, rz - 0.035, 0.62, ty1, rz + 0.06);
  for (const sx of [-1, 1]) {
    const cx = sx * (s.width / 2 - 0.16);
    mb.box('car_brake', cx - 0.13, ty0, rz - 0.04, cx + 0.13, ty1, rz + 0.12);
    mb.box(sx > 0 ? 'car_indicator_l' : 'car_indicator_r', cx - 0.13, ty0 - 0.06, rz - 0.04, cx + 0.13, ty0 - 0.005, rz + 0.1);
    mb.box('car_reverse', sx * 0.52 - 0.06, ty0 - 0.02, rz - 0.035, sx * 0.52 + 0.06, ty0 + 0.04, rz + 0.05);
  }
  const by = Math.max(0.25, s.clearance + 0.05);
  mb.box('car_black', -s.width / 2 + 0.13, by, rz - 0.04, s.width / 2 - 0.13, by + 0.11, rz + 0.18);
  if (s.kind !== 'bus') {
    for (const sx of [-1, 1]) {
      mb.pushTRS(sx * 0.5, by + 0.03, rz + 0.05, 0);
      mb.pushTransform(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      mb.lathe('car_chrome', 0, 0, [[0.045, -0.1], [0.045, 0.12]], 12);
      mb.popTransform();
      mb.popTransform();
    }
  }
  // Plates.
  const plate = signs().extraUV('plate');
  const puv: [[number, number], [number, number], [number, number], [number, number]] = [[plate[0], plate[1]], [plate[2], plate[1]], [plate[2], plate[3]], [plate[0], plate[3]]];
  const py0 = gy0 - 0.1;
  mb.quad('car_plate', [-0.26, py0 - 0.11, fz + 0.035], [0.26, py0 - 0.11, fz + 0.035], [0.26, py0, fz + 0.035], [-0.26, py0, fz + 0.035], { uvs: puv });
  const rp = ty0 - 0.12;
  mb.box('car_black', -0.28, rp - 0.02, rz - 0.04, 0.28, rp + 0.13, rz + 0.02);
  mb.quad('car_plate', [0.26, rp, rz - 0.045], [-0.26, rp, rz - 0.045], [-0.26, rp + 0.11, rz - 0.045], [0.26, rp + 0.11, rz - 0.045], { uvs: [puv[1], puv[0], puv[3], puv[2]] });
  // Badge.
  mb.pushTRS(0, (gy0 + gy1) / 2 + 0.02, fz + 0.012, 0);
  mb.pushTransform(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  mb.lathe('car_chrome', 0, 0, [[0.07, 0], [0.07, 0.015], [0.0, 0.02]], 16, { capTop: true });
  mb.popTransform();
  mb.popTransform();
  // ---------------------------------------------------------------- sides
  const mz = s.sideFront + 0.03;
  for (const sx of [-1, 1]) {
    const mx = sx * (sh.halfWidth(mz) + 0.08);
    mb.pushTRS(mx, sh.beltY(mz) + 0.12, mz, sx * 0.15);
    mb.box('car_paint', -0.09, -0.06, -0.07, 0.09, 0.07 + (big ? 0.06 : 0), 0.06);
    mb.box('car_glass_mirror', -0.075, -0.05, -0.075, 0.075, 0.055 + (big ? 0.06 : 0), -0.068);
    mb.popTransform();
    // Door handles & shut lines.
    const doors = s.kind === 'van' ? [s.sideFront - 0.1, -0.2] : s.kind === 'bus' ? [] : s.pillars.length ? [s.sideFront - 0.4, s.pillars[0] - 0.4] : [s.sideFront - 0.4];
    for (const hz of doors) {
      const hx = sx * (sh.halfWidth(hz) + 0.004);
      mb.box('car_chrome', hx - 0.012, s.belt - 0.1, hz - 0.1, hx + 0.012, s.belt - 0.075, hz + 0.05);
    }
    const seams = s.kind === 'bus' ? [] : s.kind === 'van' ? [s.sideFront + 0.12, 0.85, -1.3] : [s.sideFront + 0.14, ...s.pillars];
    for (const sz of seams) {
      const x = sx * (sh.halfWidth(sz) + 0.002);
      mb.box('car_black', x - 0.003, sh.archBottom(sz) + 0.05, sz - 0.004, x + 0.003, sh.beltY(sz) - 0.02, sz + 0.004);
    }
    if (s.kind !== 'bus' && s.kind !== 'van') mb.beam('car_chrome', [sx * (sh.halfWidth(s.sideFront + 0.13) - 0.035), sh.beltY(s.sideFront) + 0.012, s.sideFront + 0.13], [sx * (sh.halfWidth(s.sideRear - 0.2) - 0.035), sh.beltY(s.sideRear) + 0.012, s.sideRear - 0.2], 0.018);
    mb.beam('car_black', [sx * (sh.halfWidth(s.frontAxle - 0.5) - 0.04), s.clearance + 0.04, s.frontAxle - 0.46], [sx * (sh.halfWidth(s.rearAxle + 0.5) - 0.04), s.clearance + 0.04, s.rearAxle + 0.46], 0.07, { height: 0.08 });
  }
  // Bus: entry doors on the kerb side (-X), destination display, livery band.
  if (s.kind === 'bus') {
    for (const dz of [L - 0.95, -0.6]) {
      const x = -(s.width / 2) - 0.004;
      mb.box('car_glass', x - 0.01, s.clearance + 0.12, dz - 0.6, x + 0.01, s.roof - 0.5, dz + 0.6);
      mb.box('car_black', x - 0.015, s.clearance + 0.1, dz - 0.015, x + 0.015, s.roof - 0.48, dz + 0.015);
    }
    mb.box('car_sign', -0.9, s.roof - 0.42, fz - 0.03, 0.9, s.roof - 0.16, fz + 0.012);
    for (const sx of [-1, 1]) mb.box('car_stripe', sx * (s.width / 2) - 0.006, s.belt - 0.32, -L + 0.3, sx * (s.width / 2) + 0.006, s.belt - 0.14, L - 0.3);
  }
  // Pickup: open bed (dark floor inset), tailgate edge.
  if (s.bed) {
    const w = s.width / 2 - 0.12;
    const y = s.deck + 0.004;
    mb.quad('car_black', [-w, y, s.rw1 - 0.08], [w, y, s.rw1 - 0.08], [w, y, -L + 0.1], [-w, y, -L + 0.1], { normal: [0, 1, 0] });
    mb.quad('car_black', [w, y, s.rw1 - 0.08], [-w, y, s.rw1 - 0.08], [-w, y, -L + 0.1], [w, y, -L + 0.1], { normal: [0, 1, 0] });
  }
  // Taxi: roof sign + chequered stripe.
  if (s.kind === 'taxi') {
    mb.box('car_black', -0.32, s.roof + 0.02, -0.45, 0.32, s.roof + 0.05, -0.15);
    mb.box('car_sign', -0.3, s.roof + 0.05, -0.43, 0.3, s.roof + 0.23, -0.17);
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 18; k++) {
        const z0 = 0.7 - k * 0.1;
        const z1 = z0 - 0.1;
        const x = sx * (sh.halfWidth((z0 + z1) / 2) + 0.004);
        const yb = s.belt - 0.26 + (k % 2) * 0.05;
        mb.box('car_stripe', x - 0.004, yb, z1, x + 0.004, yb + 0.05, z0);
      }
    }
  }
  // Wheel arch liners.
  const ar = sh.archR() - 0.015;
  for (const az of [s.frontAxle, s.rearAxle]) {
    for (const sx of [-1, 1]) {
      const segs = 10;
      for (let k = 0; k < segs; k++) {
        const a0 = (k / segs) * Math.PI;
        const a1 = ((k + 1) / segs) * Math.PI;
        const y0 = s.wheelRadius + Math.sin(a0) * ar;
        const y1 = s.wheelRadius + Math.sin(a1) * ar;
        const z0 = az + Math.cos(a0) * ar;
        const z1 = az + Math.cos(a1) * ar;
        const xo = sx * (s.width / 2 - 0.02);
        const xi = sx * (s.width / 2 - 0.34);
        if (sx > 0) mb.quad('car_black', [xi, y0, z0], [xo, y0, z0], [xo, y1, z1], [xi, y1, z1]);
        else mb.quad('car_black', [xo, y0, z0], [xi, y0, z0], [xi, y1, z1], [xo, y1, z1]);
      }
    }
  }
  mb.box('car_black', -s.width / 2 + 0.11, s.clearance - 0.04, -L + 0.4, s.width / 2 - 0.11, s.clearance + 0.04, L - 0.35, { skip: ['py'] });
  // ---------------------------------------------------------------- interior
  const fy = s.clearance + 0.22;
  const seatZ = Math.min(s.sideFront - 0.55, (s.ws1 + s.sideFront) / 2 - 0.5);
  mb.box('car_interior', -s.width / 2 + 0.08, fy - 0.13, s.rw0 + 0.2, s.width / 2 - 0.08, fy, s.ws1 + 0.9);
  for (const sx of [-0.4, 0.4]) {
    mb.box('car_seat', sx - 0.25, fy, seatZ - 0.2, sx + 0.25, fy + 0.13, seatZ + 0.28);
    mb.pushTRS(sx, fy + 0.13, seatZ - 0.22, 0);
    mb.pushTransform(new THREE.Matrix4().makeRotationX(-0.25));
    mb.box('car_seat', -0.25, 0, -0.08, 0.25, 0.62, 0.06);
    mb.box('car_seat', -0.13, 0.64, -0.06, 0.13, 0.8, 0.04);
    mb.popTransform();
    mb.popTransform();
  }
  if (s.kind === 'bus') {
    for (let z = s.sideFront - 2.2; z > s.sideRear + 0.6; z -= 1.1) for (const sx of [-0.75, 0.75]) mb.box('car_seat', sx - 0.42, fy + 0.25, z - 0.25, sx + 0.42, fy + 0.95, z + 0.2);
  } else if (s.pillars.length && !s.bed) {
    const rz2 = (s.pillars[0] + Math.max(s.sideRear, s.rw0)) / 2;
    mb.box('car_seat', -0.75, fy, rz2 - 0.25, 0.75, fy + 0.13, rz2 + 0.2);
    mb.box('car_seat', -0.75, fy + 0.13, rz2 - 0.32, 0.75, fy + 0.63, rz2 - 0.22);
  }
  const dashZ = s.ws0 - 0.15;
  mb.box('car_interior', -s.width / 2 + 0.11, s.belt - 0.28, dashZ - 0.28, s.width / 2 - 0.11, s.belt + 0.02, dashZ);
  mb.pushTRS(0.4, s.belt - 0.03, dashZ - 0.32, 0);
  mb.pushTransform(new THREE.Matrix4().makeRotationX(s.kind === 'bus' || s.kind === 'van' ? -0.5 : -1.15));
  mb.lathe('car_black', 0, 0, [[0.18, -0.02], [0.2, 0.0], [0.18, 0.02], [0.16, 0.0], [0.18, -0.02]], 18);
  mb.cylinder('car_black', 0, -0.25, 0, 0.03, 0.03, 0.25, 8);
  mb.popTransform();
  mb.popTransform();
  return { seat: new THREE.Vector3(0.4, fy, seatZ) };
}

/** Wheel (tyre, rim, spokes, disc) with its axle along X, outer face +X, centred at origin. */
export function buildWheel(radius: number, mb: MeshBuilder, heavy = false, lowDetail = false): void {
  const seg = lowDetail ? 14 : 32;
  const k = radius / 0.34;
  const R = radius;
  const wd = heavy ? 1.35 : 1;
  const tyre: [number, number][] = [
    [0.235 * k, -0.11 * wd],
    [0.27 * k, -0.118 * wd],
    [0.31 * k, -0.115 * wd],
    [0.33 * k, -0.1 * wd],
    [R, -0.075 * wd],
    [R + 0.002, 0],
    [R, 0.075 * wd],
    [0.33 * k, 0.1 * wd],
    [0.31 * k, 0.115 * wd],
    [0.27 * k, 0.118 * wd],
    [0.235 * k, 0.11 * wd],
  ];
  const rot = new THREE.Matrix4().makeRotationZ(-Math.PI / 2);
  mb.pushTransform(rot);
  mb.lathe('car_tyre', 0, 0, lowDetail ? tyre.filter((_, i) => i % 2 === 0 || i === 5) : tyre, seg);
  mb.lathe('car_rim', 0, 0, [[0.235 * k, 0.112 * wd], [0.24 * k, 0.1 * wd], [0.232 * k, 0.08 * wd], [0.225 * k, -0.09 * wd], [0.21 * k, -0.1 * wd]], lowDetail ? 12 : 24);
  mb.lathe('car_rim', 0, 0, [[0.2 * k, 0.06 * wd], [0.07 * k, 0.085 * wd], [0.06 * k, 0.1 * wd], [0.0, 0.1 * wd]], lowDetail ? 10 : 20, { capTop: true });
  const spokes = lowDetail ? 5 : heavy ? 8 : 10;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + (i % 2) * 0.12;
    mb.beam('car_rim', [Math.cos(a) * 0.06 * k, 0.088 * wd, Math.sin(a) * 0.06 * k], [Math.cos(a) * 0.222 * k, 0.075 * wd, Math.sin(a) * 0.222 * k], 0.026 * k, { height: 0.035 });
  }
  if (!lowDetail) {
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      mb.cylinder('car_chrome', Math.cos(a) * 0.04 * k, 0.1 * wd, Math.sin(a) * 0.04 * k, 0.009, 0.009, 0.012, 6);
    }
    mb.lathe('car_disc', 0, 0, [[0.19 * k, -0.02], [0.19 * k, 0.02], [0.06 * k, 0.02], [0.06 * k, -0.02]], 24);
  }
  mb.box('car_caliper', 0.12 * k, -0.04, -0.06, 0.2 * k, 0.035, 0.06);
  mb.popTransform();
}

/** Weld coincident vertices and recompute smooth normals (keeps hard edges above angle). */
export function smoothNormals(geo: THREE.BufferGeometry, creaseCos = 0.35): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const map = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const kk = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
    const arr = map.get(kk);
    if (arr) arr.push(i);
    else map.set(kk, [i]);
  }
  const out = new Float32Array(nor.count * 3);
  const n = new THREE.Vector3();
  const m = new THREE.Vector3();
  for (const idxs of map.values()) {
    for (const i of idxs) {
      n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
      const acc = new THREE.Vector3();
      for (const j of idxs) {
        m.set(nor.getX(j), nor.getY(j), nor.getZ(j));
        if (n.dot(m) > creaseCos) acc.add(m);
      }
      acc.normalize();
      out[i * 3] = acc.x;
      out[i * 3 + 1] = acc.y;
      out[i * 3 + 2] = acc.z;
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
}

/** Fixed colours for non-paint parts when merged for instancing (vertex colours). */
export const PART_COLORS: Record<string, [number, number, number]> = {
  car_trim: [0.012, 0.013, 0.014],
  car_black: [0.018, 0.019, 0.02],
  car_chrome: [0.75, 0.75, 0.76],
  car_interior: [0.03, 0.032, 0.035],
  car_seat: [0.05, 0.045, 0.042],
  car_plate: [0.85, 0.85, 0.8],
  car_glass_mirror: [0.55, 0.6, 0.62],
  car_tyre: [0.03, 0.03, 0.03],
  car_rim: [0.55, 0.57, 0.6],
  car_disc: [0.2, 0.2, 0.2],
  car_caliper: [0.35, 0.05, 0.05],
  car_stripe: [0.9, 0.9, 0.88],
  car_drl: [0.85, 0.9, 1.0],
  car_sign: [1.0, 0.85, 0.45],
  car_headlight: [0.9, 0.9, 0.88],
  car_brake: [0.6, 0.02, 0.01],
  car_reverse: [0.6, 0.6, 0.6],
  car_indicator_l: [0.8, 0.35, 0.02],
  car_indicator_r: [0.8, 0.35, 0.02],
};

/** Detailed materials for a player-drivable vehicle. */
export function vehicleMaterials(color: THREE.Color) {
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04, vertexColors: false });
  const brake = new THREE.MeshStandardMaterial({ color: 0x3a0303, emissive: new THREE.Color(1, 0.04, 0.02), emissiveIntensity: 0.6, roughness: 0.25 });
  const reverse = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, roughness: 0.2 });
  const head = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: new THREE.Color(1, 0.97, 0.9), emissiveIntensity: 1.5, roughness: 0.1, metalness: 0.2 });
  const indicator = new THREE.MeshStandardMaterial({ color: 0x3a2000, emissive: new THREE.Color(1, 0.45, 0.02), emissiveIntensity: 0, roughness: 0.25 });
  const byKey: Record<string, THREE.Material> = {
    car_paint: paint,
    car_glass: new THREE.MeshPhysicalMaterial({ color: 0x0b0f12, metalness: 0.0, roughness: 0.02, transparent: true, opacity: 0.55, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide }),
    car_glass_mirror: new THREE.MeshStandardMaterial({ color: 0x7d878d, metalness: 1, roughness: 0.12 }),
    car_trim: new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.35, metalness: 0.3 }),
    car_black: new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.6, metalness: 0.1 }),
    car_chrome: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.08, metalness: 1 }),
    car_headlight: head,
    car_drl: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(0.85, 0.92, 1), emissiveIntensity: 3, roughness: 0.2 }),
    car_brake: brake,
    car_reverse: reverse,
    car_indicator_l: indicator,
    car_indicator_r: indicator,
    car_sign: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(1, 0.85, 0.45), emissiveIntensity: 1.5, roughness: 0.3 }),
    car_stripe: new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.35, metalness: 0.1 }),
    car_plate: signs().material,
    car_interior: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8 }),
    car_seat: new THREE.MeshStandardMaterial({ color: 0x2a2523, roughness: 0.75 }),
    car_tyre: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.88 }),
    car_rim: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.25, metalness: 0.95 }),
    car_disc: new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.45, metalness: 0.9 }),
    car_caliper: new THREE.MeshStandardMaterial({ color: 0xa01818, roughness: 0.4, metalness: 0.3 }),
  };
  return { byKey, paint, brake, reverse, head, indicator };
}

export interface VehicleParts {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Group[];
  brakeMat: THREE.MeshStandardMaterial;
  reverseMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  indicatorMat: THREE.MeshStandardMaterial;
  paint: THREE.MeshPhysicalMaterial;
  seat: THREE.Object3D;
}

/** Full-detail vehicle (separate materials, animated wheels) for the player-driven car. */
export function buildVehicle(spec: VehicleSpec, color: THREE.Color): VehicleParts {
  const mats = vehicleMaterials(color);
  const mb = new MeshBuilder();
  const { seat: seatPos } = buildBody(spec, mb);
  const body = mb.build(mats.byKey, { name: `${spec.kind}Body` });
  for (const child of body.children) {
    const m = child as THREE.Mesh;
    if (m.name === 'car_paint' || m.name === 'car_glass' || m.name === 'car_trim') smoothNormals(m.geometry);
    if (m.name === 'car_glass') {
      m.castShadow = false;
      m.renderOrder = 2;
    }
  }
  const root = new THREE.Group();
  root.name = spec.kind;
  root.add(body);
  const seat = new THREE.Object3D();
  seat.position.copy(seatPos);
  root.add(seat);
  const wmb = new MeshBuilder();
  buildWheel(spec.wheelRadius, wmb, spec.kind === 'bus' || spec.kind === 'van');
  const wheelProto = wmb.build(mats.byKey, { name: 'wheel' });
  for (const c of wheelProto.children) smoothNormals((c as THREE.Mesh).geometry, 0.6);
  const wheels: THREE.Group[] = [];
  for (const [x, z] of [
    [spec.track / 2, spec.frontAxle],
    [-spec.track / 2, spec.frontAxle],
    [spec.track / 2, spec.rearAxle],
    [-spec.track / 2, spec.rearAxle],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, spec.wheelRadius, z);
    const spin = new THREE.Group();
    spin.name = 'spin';
    const w = wheelProto.clone();
    if (x < 0) w.rotation.y = Math.PI;
    spin.add(w);
    pivot.add(spin);
    root.add(pivot);
    wheels.push(pivot);
  }
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (m.name !== 'car_glass') m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return { root, body, wheels, brakeMat: mats.brake, reverseMat: mats.reverse, headMat: mats.head, indicatorMat: mats.indicator, paint: mats.paint, seat };
}
