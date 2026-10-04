/**
 * The Nightwarden's cape: position-based (Verlet) cloth, 24 × 32 particles.
 *
 * - Top row pinned to an arc over the shoulders that follows the upper-spine bone.
 * - Structural and bending distance constraints plus a long-range "tether" per
 *   particle (never further from its pin than its rest path), solved in substeps so it stays
 *   stable at 60 fps even at glide / grapple speeds.
 * - Collides with capsules on the spine, head, arms and legs, with the ground and with up to
 *   three wall planes probed by the player.
 * - Forces: gravity + aerodynamic drag against the global wind (`systems/Weather.wind`) and the
 *   character's own motion, with per-particle turbulence — it streams when running, billows
 *   when falling and flaps in storms.
 * - Glide mode shape-matches the cloth into a taut wing anchored at the hands, blending back
 *   to free cloth on landing.
 * - Safety: NaN / teleport / over-stretch detection resets the cloth to its rest pose.
 */
import * as THREE from 'three';
import { wind } from '../systems/Weather';
import { stormFabricMaterial } from './HeroSuit';

const NU = 24;
const NV = 32;
const N = NU * NV;
const LENGTH = 1.22;
/** Substeps adapt to the frame time (≈120 Hz), 2..8 per frame. */
const SUB_HZ = 120;
const ITER = 2;
const THICK = 0.025;
/** Bottom flare: the hem is (1 + FLARE) times as wide as the shoulders. */
const FLARE = 2.6;
/** Row (fraction down the cape) held by the hands in the glide wing. */
export const WING_ROW = 0.55;

/** Half-width of the cape at row v (rest layout). */
export function capeHalfWidth(v: number): number {
  return 0.165 * (1 + v * FLARE);
}

interface Capsule {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
  /** One-sided (trunk, head): particles inside always resolve towards this (back) direction. */
  back?: THREE.Vector3;
}

export interface CapeFrame {
  /** Skinning matrix of the upper-spine bone (bind space → world). */
  spine: THREE.Matrix4;
  /** Model (character root) world matrix — the frame of the glide wing. */
  model: THREE.Matrix4;
  capsules: Capsule[];
  hands: [THREE.Vector3, THREE.Vector3];
  groundY: number;
  /** Nearby wall planes (only applied within 1.6 m of the probed point). */
  walls: { n: THREE.Vector3; d: number; p: THREE.Vector3 }[];
  /** 0..1 glide wing blend. */
  glide: number;
  /** Extra wind (m/s) e.g. updrafts. */
  extraWind: THREE.Vector3;
  /** Character velocity (seeds the cloth after a reset). */
  velocity: THREE.Vector3;
  /** 0..1 body-collision stiffness (ramped back in after a glide so the cloth eases out). */
  collideK?: number;
}

export class Cape {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(N * 3);
  private prev = new Float32Array(N * 3);
  private rest = new Float32Array(N * 3);
  private tether = new Float32Array(N);
  private cA: Int32Array;
  private cB: Int32Array;
  private cL: Float32Array;
  private cK: Float32Array;
  private nC: number;
  private normals = new Float32Array(N * 3);
  private pinPrev = new Float32Array(NU * 3);
  private pinCur = new Float32Array(NU * 3);
  private wing = new Float32Array(N * 3);
  private geo: THREE.BufferGeometry;
  private initialized = false;
  private fresh = true;
  private frame = 0;
  private time = 0;
  /** Diagnostics for tests: max edge stretch ratio and resets. */
  /** resets = recoveries from a broken simulation (should stay 0); teleports = expected snaps. */
  stats = { maxStretch: 1, resets: 0, teleports: 0, minBodyDist: 1, why: '' };
  private _v = new THREE.Vector3();
  private _w = new THREE.Vector3();

  constructor() {
    // Rest layout in bind space: pinned arc over the shoulders, flaring as it falls.
    for (let j = 0; j < NV; j++) {
      const v = j / (NV - 1);
      for (let i = 0; i < NU; i++) {
        const u = i / (NU - 1);
        // Pinned arc behind the neck, clear of the torso and shoulder collision capsules.
        const a = (u - 0.5) * Math.PI * 0.84;
        const px = Math.sin(a) * 0.17;
        const pz = -0.06 - Math.cos(a) * 0.145;
        const py = 1.5 - (1 - Math.cos(a)) * 0.03;
        const k = (j * NU + i) * 3;
        this.rest[k] = px * (1 + v * FLARE);
        this.rest[k + 1] = py - v * LENGTH;
        this.rest[k + 2] = THREE.MathUtils.lerp(pz, -0.22 - Math.cos(a) * 0.02, Math.min(1, v * 5)) - v * 0.03;
      }
    }
    // Constraints.
    const A: number[] = [];
    const B: number[] = [];
    const K: number[] = [];
    const add = (a: number, b: number, k: number) => {
      A.push(a);
      B.push(b);
      K.push(k);
    };
    const id = (i: number, j: number) => j * NU + i;
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        if (i < NU - 1) add(id(i, j), id(i + 1, j), 1);
        if (j < NV - 1) add(id(i, j), id(i, j + 1), 1);
        if (i < NU - 2) add(id(i, j), id(i + 2, j), 0.25);
        if (j < NV - 2) add(id(i, j), id(i, j + 2), 0.35);
      }
    }
    this.nC = A.length;
    this.cA = Int32Array.from(A);
    this.cB = Int32Array.from(B);
    this.cK = Float32Array.from(K);
    this.cL = new Float32Array(this.nC);
    const r = this.rest;
    for (let c = 0; c < this.nC; c++) {
      const a = this.cA[c] * 3;
      const b = this.cB[c] * 3;
      this.cL[c] = Math.hypot(r[a] - r[b], r[a + 1] - r[b + 1], r[a + 2] - r[b + 2]);
    }
    // Tethers: rest path length down each column.
    for (let i = 0; i < NU; i++) {
      let acc = 0;
      for (let j = 1; j < NV; j++) {
        const a = id(i, j - 1) * 3;
        const b = id(i, j) * 3;
        acc += Math.hypot(r[a] - r[b], r[a + 1] - r[b + 1], r[a + 2] - r[b + 2]);
        this.tether[id(i, j)] = acc * 1.04;
      }
    }
    // Render mesh.
    this.geo = new THREE.BufferGeometry();
    const uv = new Float32Array(N * 2);
    const idx: number[] = [];
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        uv[(j * NU + i) * 2] = i / (NU - 1);
        uv[(j * NU + i) * 2 + 1] = j / (NV - 1);
        if (i < NU - 1 && j < NV - 1) {
          const a = id(i, j);
          const b = id(i + 1, j);
          const c = id(i, j + 1);
          const d = id(i + 1, j + 1);
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    const na = new THREE.BufferAttribute(this.normals, 3);
    na.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', pa);
    this.geo.setAttribute('normal', na);
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setIndex(idx);
    const mat = stormFabricMaterial((shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCapeUv;')
        .replace('vBind = position;', 'vBind = vec3(uv.x * 1.1, uv.y * 1.3, 0.0);\nvCapeUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vCapeUv;')
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
          {
            // Frayed, ragged hem: jagged strands + a few torn notches.
            float strand = floor(vCapeUv.x * 70.0);
            float h = fract(sin(strand * 12.9898) * 43758.5453);
            float notch = smoothstep(0.82, 0.98, fract(sin(floor(vCapeUv.x * 9.0) * 78.233) * 12345.678));
            float hem = 0.012 + 0.03 * h * h + 0.05 * notch * (0.5 + 0.5 * sin(vCapeUv.x * 120.0));
            if (vCapeUv.y > 1.0 - hem) discard;
          }`,
        )
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= 1.0 - 0.25 * smoothstep(0.8, 1.0, vCapeUv.y);');
    }, 'nwCape');
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.name = 'Cape';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
  }

  /** Snap every particle to the rest pose under the given spine frame. */
  reset(f: CapeFrame): void {
    for (let k = 0; k < N; k++) {
      this._v.fromArray(this.rest, k * 3).applyMatrix4(f.spine);
      this._v.toArray(this.pos, k * 3);
      this._v.toArray(this.prev, k * 3);
    }
    for (let i = 0; i < NU; i++) {
      for (let c = 0; c < 3; c++) this.pinPrev[i * 3 + c] = this.pinCur[i * 3 + c] = this.pos[i * 3 + c];
    }
    this.initialized = true;
    this.fresh = true;
  }

  update(dt: number, f: CapeFrame): void {
    if (!this.mesh.visible || dt <= 0) return;
    this.frame++;
    if (!this.initialized) this.reset(f);
    this.time += dt;
    dt = Math.min(dt, 0.1);
    // Pins this frame (interpolated across substeps).
    this.pinPrev.set(this.pinCur);
    for (let i = 0; i < NU; i++) {
      this._v.fromArray(this.rest, i * 3).applyMatrix4(f.spine);
      this._v.toArray(this.pinCur, i * 3);
    }
    // Teleport / pop detection.
    const jump = Math.hypot(this.pinCur[0] - this.pinPrev[0], this.pinCur[1] - this.pinPrev[1], this.pinCur[2] - this.pinPrev[2]);
    if (jump > 3) {
      this.reset(f);
      this.stats.teleports++;
    }
    // Glide wing targets (model frame).
    const g = f.glide;
    if (g > 0.001) {
      for (let j = 0; j < NV; j++) {
        const v = j / (NV - 1);
        for (let i = 0; i < NU; i++) {
          // Taut wing: the rest layout spread 5% wider and flattened into a cambered sheet
          // behind the back (same column spacing as the rest pose, so it never over-stretches).
          const k = (j * NU + i) * 3;
          const a = (i / (NU - 1) - 0.5) * Math.PI * 0.84;
          const camber = 0.13 * Math.cos(a) * THREE.MathUtils.smoothstep(v, 0, 0.4);
          this._v.set(this.rest[k] * 1.05, this.rest[k + 1], Math.min(this.rest[k + 2], -0.17) - camber).applyMatrix4(f.model);
          this._v.toArray(this.wing, k);
        }
      }
    }
    const SUBSTEPS = Math.min(8, Math.max(2, Math.ceil(dt * SUB_HZ)));
    const h = dt / SUBSTEPS;
    const P = this.pos;
    const Q = this.prev;
    this.applyFlick(h);
    if (this.fresh) {
      // Start moving with the body instead of from rest.
      this.fresh = false;
      for (let k = 0; k < N; k++) {
        Q[k * 3] = P[k * 3] - f.velocity.x * h;
        Q[k * 3 + 1] = P[k * 3 + 1] - f.velocity.y * h;
        Q[k * 3 + 2] = P[k * 3 + 2] - f.velocity.z * h;
      }
    }
    const wv = this._w.set(wind.vector.x * (1 + wind.gust), 0, wind.vector.z * (1 + wind.gust)).add(f.extraWind);
    const t = this.time;
    for (let s = 0; s < SUBSTEPS; s++) {
      const alpha = (s + 1) / SUBSTEPS;
      // Integrate.
      for (let k = NU; k < N; k++) {
        const o = k * 3;
        const vx = (P[o] - Q[o]) / h;
        const vy = (P[o + 1] - Q[o + 1]) / h;
        const vz = (P[o + 2] - Q[o + 2]) / h;
        // Turbulent air relative to the particle.
        const ph = t * 6 + k * 0.37;
        const turb = 0.35 + 0.65 * wind.strength;
        const rx = wv.x + Math.sin(ph) * turb * 2 - vx;
        const ry = wv.y + Math.sin(ph * 1.3 + 1.7) * turb * 1.5 - vy;
        const rz = wv.z + Math.cos(ph * 0.9) * turb * 2 - vz;
        const nx = this.normals[o];
        const ny = this.normals[o + 1];
        const nz = this.normals[o + 2];
        const dn = rx * nx + ry * ny + rz * nz;
        let ax = 0.13 * Math.abs(dn) * dn * nx + 0.07 * rx;
        let ay = 0.13 * Math.abs(dn) * dn * ny + 0.07 * ry;
        let az = 0.13 * Math.abs(dn) * dn * nz + 0.07 * rz;
        const am = Math.hypot(ax, ay, az);
        if (am > 38) {
          ax *= 38 / am;
          ay *= 38 / am;
          az *= 38 / am;
        }
        ay -= 9.81;
        const damp = 0.992;
        Q[o] = P[o];
        Q[o + 1] = P[o + 1];
        Q[o + 2] = P[o + 2];
        P[o] += vx * h * damp + ax * h * h;
        P[o + 1] += vy * h * damp + ay * h * h;
        P[o + 2] += vz * h * damp + az * h * h;
      }
      // Pins.
      for (let i = 0; i < NU; i++) {
        const o = i * 3;
        Q[o] = P[o];
        Q[o + 1] = P[o + 1];
        Q[o + 2] = P[o + 2];
        P[o] = this.pinPrev[o] + (this.pinCur[o] - this.pinPrev[o]) * alpha;
        P[o + 1] = this.pinPrev[o + 1] + (this.pinCur[o + 1] - this.pinPrev[o + 1]) * alpha;
        P[o + 2] = this.pinPrev[o + 2] + (this.pinCur[o + 2] - this.pinPrev[o + 2]) * alpha;
      }
      // Glide: shape-match towards the taut wing (the hands are posed onto its edges).
      if (g > 0.001) {
        const kk = 0.45 * g;
        for (let k = NU; k < N; k++) {
          const o = k * 3;
          P[o] += (this.wing[o] - P[o]) * kk;
          P[o + 1] += (this.wing[o + 1] - P[o + 1]) * kk;
          P[o + 2] += (this.wing[o + 2] - P[o + 2]) * kk;
        }
      }
      for (let it = 0; it < ITER; it++) this.solve();
      this.collide(f, s === SUBSTEPS - 1 && this.frame % 8 === 0);
    }
    // Health checks: NaN or exploded cloth -> reset.
    let bad = false;
    let maxS = 0;
    for (let c = 0; c < this.nC; c++) {
      if (this.cK[c] < 1) continue;
      const a = this.cA[c] * 3;
      const b = this.cB[c] * 3;
      const d = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
      if (!(d === d)) bad = true;
      const r = d / this.cL[c];
      if (r > maxS) maxS = r;
    }
    if (!bad && maxS > 2.5) {
      // Over-stretched by a violent move: extra solver passes pull it back together.
      for (let it = 0; it < 10; it++) this.solve();
      maxS = this.measure();
    }
    this.stats.maxStretch = maxS;
    if (bad || maxS > 8) {
      this.reset(f);
      this.stats.resets++;
      this.stats.why = bad ? 'nan' : `stretch ${maxS.toFixed(1)}`;
    }
    this.computeNormals();
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Largest structural edge stretch ratio. */
  private measure(): number {
    const P = this.pos;
    let maxS = 0;
    for (let c = 0; c < this.nC; c++) {
      if (this.cK[c] < 1) continue;
      const a = this.cA[c] * 3;
      const b = this.cB[c] * 3;
      const r = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]) / this.cL[c];
      if (r > maxS) maxS = r;
    }
    return maxS;
  }

  private solve(): void {
    const P = this.pos;
    for (let c = 0; c < this.nC; c++) {
      const ia = this.cA[c];
      const ib = this.cB[c];
      const a = ia * 3;
      const b = ib * 3;
      const dx = P[b] - P[a];
      const dy = P[b + 1] - P[a + 1];
      const dz = P[b + 2] - P[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-9;
      const diff = ((d - this.cL[c]) / d) * this.cK[c];
      // Pinned top row has infinite mass.
      const wa = ia < NU ? 0 : 1;
      const wb = ib < NU ? 0 : 1;
      const ws = wa + wb;
      if (ws === 0) continue;
      const fa = (diff * wa) / ws;
      const fb = (diff * wb) / ws;
      P[a] += dx * fa;
      P[a + 1] += dy * fa;
      P[a + 2] += dz * fa;
      P[b] -= dx * fb;
      P[b + 1] -= dy * fb;
      P[b + 2] -= dz * fb;
    }
    // Tethers to the column pin.
    for (let k = NU; k < N; k++) {
      const o = k * 3;
      const p = (k % NU) * 3;
      const dx = P[o] - P[p];
      const dy = P[o + 1] - P[p + 1];
      const dz = P[o + 2] - P[p + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const m = this.tether[k];
      if (d > m) {
        const s = m / d;
        P[o] = P[p] + dx * s;
        P[o + 1] = P[p + 1] + dy * s;
        P[o + 2] = P[p + 2] + dz * s;
      }
    }
  }

  private bounds = new Float32Array(6 * 16);

  private collide(f: CapeFrame, measure: boolean): void {
    const P = this.pos;
    const bx = this.bounds;
    f.capsules.forEach((c, ci) => {
      const R = c.r + THICK;
      const o = ci * 6;
      bx[o] = Math.min(c.a.x, c.b.x) - R;
      bx[o + 1] = Math.max(c.a.x, c.b.x) + R;
      bx[o + 2] = Math.min(c.a.y, c.b.y) - R;
      bx[o + 3] = Math.max(c.a.y, c.b.y) + R;
      bx[o + 4] = Math.min(c.a.z, c.b.z) - R;
      bx[o + 5] = Math.max(c.a.z, c.b.z) + R;
    });
    const Q = this.prev;
    let minD = 9;
    for (let k = NU; k < N; k++) {
      const o = k * 3;
      const x0 = P[o];
      const y0 = P[o + 1];
      const z0 = P[o + 2];
      let x = x0;
      let y = y0;
      let z = z0;
      for (let ci = 0; ci < f.capsules.length; ci++) {
        const c = f.capsules[ci];
        // Cheap reject against the capsule's bounding box.
        const bo = ci * 6;
        const bx = this.bounds;
        if (x < bx[bo] || x > bx[bo + 1] || y < bx[bo + 2] || y > bx[bo + 3] || z < bx[bo + 4] || z > bx[bo + 5]) continue;
        // Closest point on segment.
        const abx = c.b.x - c.a.x;
        const aby = c.b.y - c.a.y;
        const abz = c.b.z - c.a.z;
        const L = abx * abx + aby * aby + abz * abz;
        let tt = L > 1e-8 ? ((x - c.a.x) * abx + (y - c.a.y) * aby + (z - c.a.z) * abz) / L : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const qx = x - (c.a.x + abx * tt);
        const qy = y - (c.a.y + aby * tt);
        const qz = z - (c.a.z + abz * tt);
        const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
        const R = c.r + THICK;
        if (d < R) {
          if (c.back) {
            // Keep the cloth behind the body: resolve along the back direction.
            const bb = qx * c.back.x + qy * c.back.y + qz * c.back.z;
            const sx = qx - c.back.x * bb;
            const sy = qy - c.back.y * bb;
            const sz = qz - c.back.z * bb;
            const s2 = sx * sx + sy * sy + sz * sz;
            if (s2 < R * R) {
              const out = Math.sqrt(R * R - s2);
              if (bb < out) {
                x = x - qx + sx + c.back.x * out;
                y = y - qy + sy + c.back.y * out;
                z = z - qz + sz + c.back.z * out;
              }
            }
          } else if (d > 1e-6) {
            const s = R / d;
            x = x - qx + qx * s;
            y = y - qy + qy * s;
            z = z - qz + qz * s;
          }
        }
      }
      const ck = f.collideK ?? 1;
      if (ck < 1) {
        x = x0 + (x - x0) * ck;
        y = y0 + (y - y0) * ck;
        z = z0 + (z - z0) * ck;
      }
      for (const w of f.walls) {
        if ((x - w.p.x) ** 2 + (y - w.p.y) ** 2 + (z - w.p.z) ** 2 > 2.6) continue;
        const dd = w.n.x * x + w.n.y * y + w.n.z * z - w.d;
        if (dd < THICK) {
          x += w.n.x * (THICK - dd);
          y += w.n.y * (THICK - dd);
          z += w.n.z * (THICK - dd);
        }
      }
      if (y < f.groundY + THICK) {
        y = f.groundY + THICK;
        // Friction on the ground.
        Q[o] += (x - Q[o]) * 0.4;
        Q[o + 2] += (z - Q[o + 2]) * 0.4;
      }
      P[o] = x;
      P[o + 1] = y;
      P[o + 2] = z;
      // Final clearance from the body (what is rendered), for the clipping check.
      if (measure) for (const c of f.capsules) {
        const abx = c.b.x - c.a.x;
        const aby = c.b.y - c.a.y;
        const abz = c.b.z - c.a.z;
        const L = abx * abx + aby * aby + abz * abz;
        let tt = L > 1e-8 ? ((x - c.a.x) * abx + (y - c.a.y) * aby + (z - c.a.z) * abz) / L : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const d = Math.hypot(x - (c.a.x + abx * tt), y - (c.a.y + aby * tt), z - (c.a.z + abz * tt)) - c.r;
        if (d < minD) minD = d;
      }
    }
    if (measure && (f.collideK ?? 1) >= 1) this.stats.minBodyDist = minD;
  }

  private computeNormals(): void {
    const P = this.pos;
    const Nn = this.normals;
    for (let j = 0; j < NV; j++) {
      for (let i = 0; i < NU; i++) {
        const k = j * NU + i;
        const l = (j * NU + Math.max(0, i - 1)) * 3;
        const r = (j * NU + Math.min(NU - 1, i + 1)) * 3;
        const u = (Math.max(0, j - 1) * NU + i) * 3;
        const d = (Math.min(NV - 1, j + 1) * NU + i) * 3;
        const tx = P[r] - P[l];
        const ty = P[r + 1] - P[l + 1];
        const tz = P[r + 2] - P[l + 2];
        const bx = P[d] - P[u];
        const by = P[d + 1] - P[u + 1];
        const bz = P[d + 2] - P[u + 2];
        let nx = by * tz - bz * ty;
        let ny = bz * tx - bx * tz;
        let nz = bx * ty - by * tx;
        const m = Math.hypot(nx, ny, nz) || 1;
        nx /= m;
        ny /= m;
        nz /= m;
        Nn[k * 3] = nx;
        Nn[k * 3 + 1] = ny;
        Nn[k * 3 + 2] = nz;
      }
    }
  }

  private pendingFlick: { center: THREE.Vector3; speed: number } | null = null;

  /** A sharp outward swirl (cape stun): up to `speed` m/s at the hem, applied next update. */
  flick(center: THREE.Vector3, speed: number): void {
    this.pendingFlick = { center: center.clone(), speed: Math.min(speed, 8) };
  }

  private applyFlick(h: number): void {
    const f = this.pendingFlick;
    if (!f) return;
    this.pendingFlick = null;
    for (let k = NU; k < N; k++) {
      const o = k * 3;
      const dx = this.pos[o] - f.center.x;
      const dz = this.pos[o + 2] - f.center.z;
      const m = Math.hypot(dx, dz) || 1;
      const dv = (Math.floor(k / NU) / (NV - 1)) * f.speed * h;
      // Outward + swirling (tangential) velocity, a little lift.
      this.prev[o] -= (dx / m) * dv - (dz / m) * dv * 0.8;
      this.prev[o + 2] -= (dz / m) * dv + (dx / m) * dv * 0.8;
      this.prev[o + 1] -= dv * 0.3;
    }
  }

  setVisible(v: boolean): void {
    if (v && !this.mesh.visible) this.initialized = false;
    this.mesh.visible = v;
  }

  /** Diagnostics: the most stretched structural edges as [ratio, i, j, i2, j2]. */
  stretchReport(n = 5): number[][] {
    const P = this.pos;
    const out: number[][] = [];
    for (let c = 0; c < this.nC; c++) {
      if (this.cK[c] < 1) continue;
      const a = this.cA[c] * 3;
      const b = this.cB[c] * 3;
      const d = Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]);
      out.push([+(d / this.cL[c]).toFixed(2), this.cA[c] % NU, Math.floor(this.cA[c] / NU), this.cB[c] % NU, Math.floor(this.cB[c] / NU)]);
    }
    return out.sort((x, y) => y[0] - x[0]).slice(0, n);
  }

  /** Particle positions (tests). */
  get positions(): Float32Array {
    return this.pos;
  }
}
