/**
 * Hand-designed (but procedurally built) features: clock tower, lighthouse, gantry cranes,
 * container stacks, rail yard, chimneys, tanks, fountains, hedges, fences, park pavilion,
 * seawalls & promenades, the Narrows suspension bridge and Gullhaven airfield.
 */
import * as THREE from 'three';
import { Rng, hashN } from '../core/Random';
import { MeshBuilder, type V2, type V3 } from './MeshBuilder';
import { materials } from './Materials';
import type { Feature, PropSpec } from './CityLayout';
import { groundPatch } from './RoadGen';
import { heightAt, naturalCoast } from './Terrain';
import { BRIDGE, CITY_HALF, COAST_CORNER, GROUND, ISLAND, PIERS, bridgeDeckY } from './WorldConfig';
import { signs } from './Signage';

export interface FeatureResult {
  props: PropSpec[];
  /** Static collision boxes [cx, cy, cz, hx, hy, hz, yaw]. */
  boxes: [number, number, number, number, number, number, number][];
  /** Triangle soup colliders (bridge deck, ramps). */
  trimeshes: { v: number[]; i: number[] }[];
  /** Objects animated every frame (clock hands, lighthouse lamp...). */
  animated: THREE.Object3D[];
}


export function buildFeature(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  switch (f.type) {
    case 'fountain':
      return fountain(mb, f, res);
    case 'clocktower':
      return clockTower(mb, f, res);
    case 'chimney':
      return chimney(mb, f, res);
    case 'tank':
      return tank(mb, f, res);
    case 'containers':
      return containers(mb, f, res);
    case 'crane':
      return crane(mb, f, res);
    case 'lighthouse':
      return lighthouse(mb, f, res);
    case 'railyard':
      return railyard(mb, f, res);
    case 'hedge':
      return hedge(mb, f);
    case 'fence':
      return fence(mb, f);
    case 'pavilion':
      return pavilion(mb, f, res);
    case 'jetty':
      return jetty(mb, f, res);
    case 'seawall':
      return seawall(mb, res);
    case 'bridge':
      return bridge(mb, res);
    case 'airport':
      return airport(mb, res);
    default:
      return;
  }
}

// ------------------------------------------------------------------ small features

function fountain(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const r = f.p?.r ?? 5;
  const y = f.y + 0.19;
  mb.lathe('granite', f.x, f.z, [[r + 0.3, y - 0.1], [r + 0.3, y + 0.55], [r + 0.1, y + 0.7], [r - 0.35, y + 0.7], [r - 0.35, y + 0.2]], 32);
  mb.lathe('water', f.x, f.z, [[r - 0.35, y + 0.45], [0.01, y + 0.45]], 32);
  mb.lathe('granite', f.x, f.z, [[0.9, y + 0.2], [0.7, y + 1.4], [0.45, y + 1.6], [0.45, y + 2.3], [1.6, y + 2.5], [1.7, y + 2.75], [0.3, y + 2.75]], 24, { capTop: true });
  mb.lathe('water', f.x, f.z, [[1.5, y + 2.62], [0.01, y + 2.62]], 24);
  mb.lathe('granite', f.x, f.z, [[0.25, y + 2.7], [0.18, y + 3.4], [0.35, y + 3.6], [0.0, y + 3.9]], 16, { capTop: true });
  res.boxes.push([f.x, y + 0.35, f.z, r + 0.3, 0.55, r + 0.3, 0]);
}

function chimney(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const h = f.p?.h ?? 40;
  const r = f.p?.r ?? 2;
  const y = f.y;
  mb.lathe('concrete', f.x, f.z, [[r * 1.35, y - 0.5], [r * 1.35, y + 3], [r * 1.15, y + 3.3]], 16);
  mb.lathe('brick_factory', f.x, f.z, [[r * 1.12, y + 3.3], [r * 0.72, y + h]], 20);
  for (let t = 10; t < h - 3; t += 9) mb.lathe('concrete', f.x, f.z, [[r * (1.12 - (0.4 * t) / h) + 0.12, y + t], [r * (1.12 - (0.4 * t) / h) + 0.12, y + t + 0.5]], 20);
  mb.lathe('concrete', f.x, f.z, [[r * 0.8, y + h], [r * 0.85, y + h + 0.8], [r * 0.6, y + h + 0.8]], 20);
  mb.lathe('dark_interior', f.x, f.z, [[r * 0.6, y + h + 0.6], [0.01, y + h + 0.6]], 16);
  // Access ladder.
  mb.box('paint_dark', f.x + r * 1.1, y + 3, f.z - 0.25, f.x + r * 1.1 + 0.05, y + h * 0.9, f.z - 0.2);
  mb.box('paint_dark', f.x + r * 1.1, y + 3, f.z + 0.2, f.x + r * 1.1 + 0.05, y + h * 0.9, f.z + 0.25);
  res.boxes.push([f.x, y + h / 2, f.z, r, h / 2, r, 0]);
}

function tank(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const r = Math.max(2, f.p?.r ?? 5);
  const h = f.p?.h ?? 10;
  const y = f.y + 0.2;
  const col = new THREE.Color(0.92, 0.92, 0.9);
  mb.lathe('concrete', f.x, f.z, [[r + 0.6, y - 0.3], [r + 0.6, y + 0.4], [r, y + 0.45]], 24);
  mb.lathe('paint', f.x, f.z, [[r, y + 0.4], [r, y + h], [r * 0.8, y + h + r * 0.18], [0.01, y + h + r * 0.25]], 28, { color: col });
  for (let t = 2; t < h; t += 2.4) mb.lathe('steel_light', f.x, f.z, [[r + 0.04, y + t], [r + 0.04, y + t + 0.12]], 28);
  // Railing ring on top + ladder.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    mb.box('paint_dark', f.x + Math.cos(a) * r * 0.85 - 0.03, y + h + r * 0.12, f.z + Math.sin(a) * r * 0.85 - 0.03, f.x + Math.cos(a) * r * 0.85 + 0.03, y + h + r * 0.12 + 1.0, f.z + Math.sin(a) * r * 0.85 + 0.03);
  }
  mb.lathe('paint_dark', f.x, f.z, [[r * 0.85, y + h + r * 0.12 + 0.95], [r * 0.85, y + h + r * 0.12 + 1.02]], 24);
  mb.box('paint_dark', f.x + r + 0.05, y + 0.5, f.z - 0.3, f.x + r + 0.12, y + h, f.z - 0.25);
  mb.box('paint_dark', f.x + r + 0.05, y + 0.5, f.z + 0.25, f.x + r + 0.12, y + h, f.z + 0.3);
  res.boxes.push([f.x, y + h / 2, f.z, r, h / 2, r, 0]);
}

const CONTAINER_COLS = [
  [0.55, 0.13, 0.09],
  [0.1, 0.25, 0.5],
  [0.12, 0.4, 0.24],
  [0.55, 0.55, 0.55],
  [0.82, 0.38, 0.08],
  [0.85, 0.85, 0.82],
  [0.75, 0.6, 0.1],
  [0.2, 0.45, 0.55],
];

function containers(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const len = f.p?.len ?? 12.2;
  const stack = f.p?.stack ?? 2;
  const rng = new Rng(f.p?.seed ?? 1);
  const w = 2.44;
  const h = 2.59;
  mb.pushTRS(f.x, f.y + 0.2, f.z, f.yaw);
  for (let k = 0; k < stack; k++) {
    const c = CONTAINER_COLS[rng.int(0, CONTAINER_COLS.length - 1)];
    const col = new THREE.Color(c[0], c[1], c[2]);
    const y0 = k * h;
    const off = rng.range(-0.15, 0.15);
    mb.box('container', -len / 2 + off, y0, -w / 2, len / 2 + off, y0 + h, w / 2, { color: col });
    // Door end detail: lock bars.
    for (const dz of [-0.7, -0.35, 0.35, 0.7]) mb.box('steel_dark', len / 2 + off, y0 + 0.2, dz - 0.03, len / 2 + off + 0.05, y0 + h - 0.2, dz + 0.03);
    // Corner castings.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) mb.box('steel_dark', sx * len / 2 + off - (sx > 0 ? 0.2 : 0), y0, sz * w / 2 - (sz > 0 ? 0.2 : 0), sx * len / 2 + off + (sx > 0 ? 0 : 0.2) + 0.01, y0 + 0.18, sz * w / 2 + (sz > 0 ? 0 : 0.2) + 0.01);
    if (len > 10 && rng.chance(0.35)) {
      const uv = signs().extraUV(rng.chance(0.5) ? 'vellmar' : 'nordstrand');
      const z = w / 2 + 0.03;
      mb.quad('signs', [-3.5 + off, y0 + 0.7, z], [3.5 + off, y0 + 0.7, z], [3.5 + off, y0 + 2.45, z], [-3.5 + off, y0 + 2.45, z], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
    }
  }
  mb.popTransform();
  res.boxes.push([f.x, f.y + (stack * h) / 2 + 0.2, f.z, len / 2, (stack * h) / 2, w / 2, f.yaw]);
}

function crane(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const col = f.p?.color ? new THREE.Color(0.12, 0.3, 0.55) : new THREE.Color(0.75, 0.2, 0.08);
  const y = f.y;
  mb.pushTRS(f.x, y, f.z, f.yaw);
  const legX = 9;
  const legZ = 8;
  const top = 32;
  // Legs on bogies.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      mb.box('paint', sx * legX - 0.7, 1.5, sz * legZ - 0.7, sx * legX + 0.7, top, sz * legZ + 0.7, { color: col });
      mb.box('paint_dark', sx * legX - 1.6, 0, sz * legZ - 0.9, sx * legX + 1.6, 1.5, sz * legZ + 0.9);
      for (const wx of [-1, 1]) mb.cylinder('rubber', sx * legX + wx * 0.9, 0, sz * legZ, 0.5, 0.5, 0.01, 12);
    }
    // Side portal beam and diagonal brace.
    mb.box('paint', sx * legX - 0.6, top - 2.2, -legZ - 0.6, sx * legX + 0.6, top, legZ + 0.6, { color: col });
    mb.beam('paint', [sx * legX, 4, -legZ], [sx * legX, top - 2.5, legZ], 0.5, { color: col });
    mb.box('paint', sx * legX - 0.5, 12, -legZ, sx * legX + 0.5, 13, legZ, { color: col });
  }
  // Cross girders.
  for (const sz of [-1, 1]) mb.box('paint', -legX - 0.6, top - 2.2, sz * legZ - 0.6, legX + 0.6, top, sz * legZ + 0.6, { color: col });
  // Boom (truss) along +z over the water, backreach along -z.
  const by = top + 2;
  const b0 = -24;
  const b1 = 48;
  for (const sx of [-1, 1]) {
    mb.box('paint', sx * 2.2 - 0.35, by - 0.35, b0, sx * 2.2 + 0.35, by + 0.35, b1, { color: col });
    mb.box('paint', sx * 2.2 - 0.25, by + 2.6, b0 + 4, sx * 2.2 + 0.25, by + 3.1, b1 - 6, { color: col });
    for (let z = b0 + 4; z < b1 - 7; z += 4) {
      mb.beam('paint', [sx * 2.2, by, z], [sx * 2.2, by + 2.8, z + 4], 0.18, { color: col });
      mb.box('paint', sx * 2.2 - 0.12, by, z - 0.12, sx * 2.2 + 0.12, by + 2.8, z + 0.12, { color: col });
    }
  }
  for (let z = b0; z < b1; z += 6) mb.box('paint', -2.2, by - 0.25, z - 0.15, 2.2, by + 0.05, z + 0.15, { color: col });
  // Apex A-frame and stays.
  const ay = by + 18;
  for (const sx of [-1, 1]) {
    mb.beam('paint', [sx * legX * 0.8, top, -legZ * 0.6], [sx * 1.2, ay, -2], 0.7, { color: col });
    mb.beam('paint', [sx * legX * 0.8, top, legZ * 0.6], [sx * 1.2, ay, -2], 0.7, { color: col });
    mb.beam('steel_dark', [sx * 1.2, ay, -2], [sx * 2.2, by + 3, b1 - 6], 0.15);
    mb.beam('steel_dark', [sx * 1.2, ay, -2], [sx * 2.2, by + 3, 22], 0.15);
    mb.beam('steel_dark', [sx * 1.2, ay, -2], [sx * 2.2, by + 3, b0 + 4], 0.15);
  }
  mb.box('paint', -1.8, ay - 0.5, -2.6, 1.8, ay + 0.6, -1.4, { color: col });
  // Machinery house, cab and trolley.
  mb.box('paint_white', -3.5, top, -10, 3.5, top + 4, -2);
  mb.box('roof_flat', -3.6, top + 4, -10.1, 3.6, top + 4.2, -1.9);
  mb.box('paint_white', -1.4, by - 3.8, 14, 1.4, by - 1.2, 17);
  mb.box('glass_plain', -1.42, by - 3.4, 16.8, 1.42, by - 1.6, 17.05);
  mb.box('paint_dark', -2.6, by - 1.0, 13, 2.6, by - 0.4, 18);
  for (const sx of [-0.8, 0.8]) mb.box('steel_dark', sx - 0.03, by - 14, 15.5, sx + 0.03, by - 1.0, 15.56);
  mb.box('paint', -1.6, by - 15, 14.2, 1.6, by - 14, 16.8, { color: new THREE.Color(0.9, 0.7, 0.1) });
  mb.cylinder('light_red', 0, ay + 0.6, -2, 0.25, 0.25, 0.3, 8);
  mb.popTransform();
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const lx = sx * legX;
      const lz = sz * legZ;
      res.boxes.push([f.x + lx * c + lz * s, y + top / 2, f.z - lx * s + lz * c, 0.8, top / 2, 0.8, f.yaw]);
    }
  }
}

function lighthouse(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const y = f.y;
  const x = f.x;
  const z = f.z;
  const white = new THREE.Color(0.95, 0.94, 0.9);
  const red = new THREE.Color(0.62, 0.08, 0.06);
  mb.lathe('stone', x, z, [[6.5, y - 0.5], [6.5, y + 1.2], [5.6, y + 1.5]], 24);
  const H = 30;
  const r = (t: number) => 3.8 - 1.2 * t;
  const bands = [0, 0.22, 0.34, 0.6, 0.72, 1];
  for (let i = 0; i < bands.length - 1; i++) {
    const t0 = bands[i];
    const t1 = bands[i + 1];
    mb.lathe('plaster', x, z, [[r(t0), y + 1.5 + H * t0], [r(t1), y + 1.5 + H * t1]], 24, { color: i % 2 === 1 ? red : white });
  }
  // Small windows up the tower.
  for (let k = 0; k < 4; k++) {
    const t = 0.15 + k * 0.2;
    const a = k * 1.3;
    const rr = r(t) + 0.02;
    mb.box('dark_interior', x + Math.cos(a) * rr - 0.35, y + 1.5 + H * t, z + Math.sin(a) * rr - 0.35, x + Math.cos(a) * rr + 0.35, y + 1.5 + H * t + 1.2, z + Math.sin(a) * rr + 0.35);
  }
  const gy = y + 1.5 + H;
  mb.lathe('paint_dark', x, z, [[2.6, gy - 0.6], [3.6, gy], [3.6, gy + 0.25], [0.1, gy + 0.25]], 24, { capTop: true });
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    mb.box('paint_dark', x + Math.cos(a) * 3.45 - 0.04, gy + 0.25, z + Math.sin(a) * 3.45 - 0.04, x + Math.cos(a) * 3.45 + 0.04, gy + 1.35, z + Math.sin(a) * 3.45 + 0.04);
  }
  mb.lathe('paint_dark', x, z, [[3.48, gy + 1.3], [3.48, gy + 1.38]], 24);
  mb.lathe('paint_dark', x, z, [[2.3, gy + 0.25], [2.3, gy + 1.0]], 16);
  mb.lathe('glass_plain', x, z, [[2.15, gy + 1.0], [2.15, gy + 3.6]], 16);
  mb.lathe('lamp_glow', x, z, [[0.7, gy + 1.6], [0.9, gy + 2.3], [0.7, gy + 3.0]], 12, { capTop: true });
  mb.lathe('copper', x, z, [[2.45, gy + 3.6], [2.4, gy + 3.9], [1.2, gy + 4.9], [0.25, gy + 5.4], [0.12, gy + 6.4], [0.0, gy + 6.5]], 16);
  // Keeper's house.
  mb.box('plaster', x - 9, y + 1.2, z - 4, x - 3.5, y + 5.2, z + 4, { color: white });
  mb.pushTRS(x - 6.25, y + 5.2, z, 0);
  mb.quad('roof_slate', [-3.1, 0, 4.3], [3.1, 0, 4.3], [3.1, 2, 0], [-3.1, 2, 0]);
  mb.quad('roof_slate', [3.1, 0, -4.3], [-3.1, 0, -4.3], [-3.1, 2, 0], [3.1, 2, 0]);
  mb.popTransform();
  res.boxes.push([x, y + H / 2, z, 3.8, H / 2 + 2, 3.8, 0]);
  res.boxes.push([x - 6.25, y + 3, z, 2.75, 2.5, 4, 0]);
}

function railyard(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const w = (f.p?.w ?? 100) - 8;
  const d = (f.p?.d ?? 80) - 8;
  const rng = new Rng(hashN(f.x, f.z));
  const n = Math.max(2, Math.floor(d / 5));
  const y = heightAt(f.x, f.z) + 0.2;
  for (let i = 0; i < n; i++) {
    const tz = f.z - d / 2 + 2.5 + i * 5;
    const x0 = f.x - w / 2;
    const x1 = f.x + w / 2;
    mb.box('gravel', x0, y, tz - 1.6, x1, y + 0.25, tz + 1.6, { color: new THREE.Color(0.7, 0.66, 0.6) });
    for (let x = x0 + 0.4; x < x1; x += 0.65) mb.box('wood', x - 0.13, y + 0.25, tz - 1.25, x + 0.13, y + 0.4, tz + 1.25, { color: new THREE.Color(0.6, 0.5, 0.4), skip: ['ny'] });
    for (const rz of [-0.72, 0.72]) {
      mb.box('steel_light', x0, y + 0.4, tz + rz - 0.04, x1, y + 0.55, tz + rz + 0.04, { skip: ['ny'] });
    }
    mb.box('paint', x1 - 1, y + 0.4, tz - 1.2, x1, y + 1.4, tz + 1.2, { color: new THREE.Color(0.85, 0.7, 0.1) });
    // Wagons.
    let x = x0 + rng.range(3, 12);
    while (x < x1 - 20 && rng.chance(0.8)) {
      const len = rng.range(12, 16);
      const tankCar = rng.chance(0.35);
      const col = new THREE.Color().setHSL(rng.pick([0.02, 0.58, 0.08, 0.33]), 0.45, rng.range(0.22, 0.35));
      const cx = x + len / 2;
      mb.box('steel_dark', x + 0.5, y + 0.95, tz - 1.2, x + len - 0.5, y + 1.35, tz + 1.2);
      for (const bx of [x + 2.2, x + len - 2.2]) {
        mb.box('steel_dark', bx - 1.3, y + 0.5, tz - 1.0, bx + 1.3, y + 1.0, tz + 1.0);
        for (const wx of [-0.8, 0.8]) for (const wz of [-0.72, 0.72]) {
          mb.pushTRS(bx + wx, y + 0.92, tz + wz, 0);
          mb.pushTransform(new THREE.Matrix4().makeRotationX(Math.PI / 2));
          mb.cylinder('steel_dark', 0, -0.06, 0, 0.42, 0.42, 0.12, 12, { capBottom: true });
          mb.popTransform();
          mb.popTransform();
        }
      }
      if (tankCar) {
        mb.pushTRS(cx, y + 2.6, tz, 0);
        mb.pushTransform(new THREE.Matrix4().makeRotationZ(Math.PI / 2));
        mb.lathe('paint', 0, 0, [[0.2, -len / 2 + 0.6], [1.35, -len / 2 + 1.2], [1.4, 0], [1.35, len / 2 - 1.2], [0.2, len / 2 - 0.6]], 16, { color: col });
        mb.popTransform();
        mb.popTransform();
      } else {
        mb.box('corrugated', x + 0.3, y + 1.35, tz - 1.45, x + len - 0.3, y + 4.2, tz + 1.45, { color: col });
        mb.box('roof_flat', x + 0.2, y + 4.2, tz - 1.5, x + len - 0.2, y + 4.4, tz + 1.5);
      }
      res.boxes.push([cx, y + 2.4, tz, len / 2, 2, 1.5, 0]);
      x += len + rng.range(1.2, 6);
    }
  }
}

function hedge(mb: MeshBuilder, f: Feature): void {
  const len = f.p?.len ?? 10;
  const col = new THREE.Color(0.32, 0.45, 0.22);
  mb.pushTRS(f.x, heightAt(f.x, f.z) + 0.19, f.z, f.yaw);
  mb.box('hedge', -len / 2, 0, -0.45, len / 2, 1.0, 0.45, { color: col, skip: ['ny'] });
  mb.box('hedge', -len / 2 + 0.1, 1.0, -0.35, len / 2 - 0.1, 1.2, 0.35, { color: col, skip: ['ny'] });
  mb.popTransform();
}

function fence(mb: MeshBuilder, f: Feature): void {
  const len = f.p?.len ?? 10;
  mb.pushTRS(f.x, heightAt(f.x, f.z) + 0.19, f.z, f.yaw);
  mb.quad('picket', [-len / 2, 0, 0], [len / 2, 0, 0], [len / 2, 1.05, 0], [-len / 2, 1.05, 0], { uvs: [[0, 0], [len / 1.2, 0], [len / 1.2, 1], [0, 1]] });
  for (let x = -len / 2; x <= len / 2 + 0.01; x += 2.4) mb.box('paint_white', x - 0.05, 0, -0.05, x + 0.05, 1.15, 0.05);
  mb.popTransform();
}

function pavilion(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const y = heightAt(f.x, f.z);
  const R = 6;
  mb.lathe('stone', f.x, f.z, [[R + 0.6, y - 0.5], [R + 0.6, y + 0.6], [R + 0.2, y + 0.9], [0.01, y + 0.9]], 8, { capTop: true });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    mb.lathe('paint_white', f.x + Math.cos(a) * R, f.z + Math.sin(a) * R, [[0.22, y + 0.9], [0.18, y + 1.2], [0.15, y + 4.0], [0.24, y + 4.2]], 8, { capTop: true });
  }
  mb.lathe('paint_white', f.x, f.z, [[R + 0.3, y + 4.2], [R + 0.3, y + 4.6], [R + 0.9, y + 4.65]], 8);
  mb.lathe('copper', f.x, f.z, [[R + 0.9, y + 4.6], [R * 0.4, y + 6.8], [0.35, y + 7.8], [0.0, y + 8.6]], 8);
  mb.lathe('paint_dark', f.x, f.z, [[0.06, y + 8.6], [0.06, y + 9.6]], 6);
  res.boxes.push([f.x, y + 0.2, f.z, R, 0.7, R, 0]);
}

function jetty(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  mb.pushTRS(f.x, f.y, f.z, f.yaw);
  mb.box('wood', -2, -0.15, -1, 22, 0.1, 1, { color: new THREE.Color(0.8, 0.72, 0.62) });
  for (let x = 0; x < 22; x += 3) for (const z of [-0.9, 0.9]) mb.cylinder('wood', x, -2.5, z, 0.14, 0.14, 3.6, 6);
  mb.popTransform();
  res.boxes.push([f.x, f.y - 0.05, f.z + 10, 1, 0.15, 12, 0]);
}

// ------------------------------------------------------------------ clock tower

function clockTower(mb: MeshBuilder, f: Feature, res: FeatureResult): void {
  const x = f.x;
  const z = f.z;
  const y = heightAt(x, z) + 0.2;
  const s = 7;
  const hs = s / 2;
  // Stepped plinth.
  for (let k = 0; k < 3; k++) mb.box('stone', x - hs - 1.6 + k * 0.4, y + k * 0.35, z - hs - 1.6 + k * 0.4, x + hs + 1.6 - k * 0.4, y + (k + 1) * 0.35, z + hs + 1.6 - k * 0.4);
  const y0 = y + 1.05;
  const shaftTop = y0 + 32;
  // Shaft walls with recessed arched-window slots.
  mb.pushTRS(x, y0, z, 0);
  const sides: { ox: number; oz: number; tx: number; tz: number; nx: number; nz: number }[] = [
    { ox: -hs, oz: hs, tx: 1, tz: 0, nx: 0, nz: 1 },
    { ox: hs, oz: hs, tx: 0, tz: -1, nx: 1, nz: 0 },
    { ox: hs, oz: -hs, tx: -1, tz: 0, nx: 0, nz: -1 },
    { ox: -hs, oz: -hs, tx: 0, tz: 1, nx: -1, nz: 0 },
  ];
  const Pt = (sd: (typeof sides)[number], u: number, v: number, o = 0): V3 => [sd.ox + sd.tx * u + sd.nx * o, v, sd.oz + sd.tz * u + sd.nz * o];
  for (const sd of sides) {
    const wins = [
      [6, 10],
      [15, 19.5],
      [24, 28],
    ];
    let v = 0;
    const u0 = s / 2 - 0.7;
    const u1 = s / 2 + 0.7;
    for (const [a, b] of wins) {
      mb.quad('stone', Pt(sd, 0, v), Pt(sd, s, v), Pt(sd, s, a), Pt(sd, 0, a), { uvs: [[0, v], [s, v], [s, a], [0, a]] });
      mb.quad('stone', Pt(sd, 0, a), Pt(sd, u0, a), Pt(sd, u0, b), Pt(sd, 0, b), { uvs: [[0, a], [u0, a], [u0, b], [0, b]] });
      mb.quad('stone', Pt(sd, u1, a), Pt(sd, s, a), Pt(sd, s, b), Pt(sd, u1, b), { uvs: [[u1, a], [s, a], [s, b], [u1, b]] });
      // Recess.
      mb.quad('dark_interior', Pt(sd, u0, a, -0.5), Pt(sd, u1, a, -0.5), Pt(sd, u1, b, -0.5), Pt(sd, u0, b, -0.5));
      mb.quad('stone', Pt(sd, u0, a, 0), Pt(sd, u0, a, -0.5), Pt(sd, u0, b, -0.5), Pt(sd, u0, b, 0));
      mb.quad('stone', Pt(sd, u1, a, -0.5), Pt(sd, u1, a, 0), Pt(sd, u1, b, 0), Pt(sd, u1, b, -0.5));
      mb.quad('stone', Pt(sd, u1, a, 0), Pt(sd, u1, a, -0.5), Pt(sd, u0, a, -0.5), Pt(sd, u0, a, 0));
      mb.quad('stone', Pt(sd, u0, b, 0), Pt(sd, u0, b, -0.5), Pt(sd, u1, b, -0.5), Pt(sd, u1, b, 0));
      v = b;
    }
    mb.quad('stone', Pt(sd, 0, v), Pt(sd, s, v), Pt(sd, s, 32), Pt(sd, 0, 32), { uvs: [[0, v], [s, v], [s, 32], [0, 32]] });
    // Door on the south face.
    if (sd.nz === 1) {
      mb.quad('paint', Pt(sd, s / 2 - 1.1, 0, 0.02), Pt(sd, s / 2 + 1.1, 0, 0.02), Pt(sd, s / 2 + 1.1, 3.4, 0.02), Pt(sd, s / 2 - 1.1, 3.4, 0.02), { color: new THREE.Color(0.12, 0.07, 0.04) });
    }
  }
  // Corner pilasters and string courses.
  for (const [cx, cz] of [
    [-hs, -hs],
    [hs, -hs],
    [hs, hs],
    [-hs, hs],
  ]) mb.box('stone', cx - 0.45, 0, cz - 0.45, cx + 0.45, 32, cz + 0.45);
  const loop: V2[] = [
    [-hs, hs],
    [hs, hs],
    [hs, -hs],
    [-hs, -hs],
  ];
  for (const v of [5, 14, 23]) mb.extrude('stone', loop, true, [[0.3, v], [0.6, v + 0.2], [0.6, v + 0.55], [0.3, v + 0.7]]);
  mb.popTransform();
  // Clock stage (wider) with faces on four sides.
  const cs = s + 0.8;
  const ch = 8;
  mb.box('stone', x - cs / 2, shaftTop, z - cs / 2, x + cs / 2, shaftTop + ch, z + cs / 2);
  mb.extrude('stone', [[x - cs / 2, z + cs / 2], [x + cs / 2, z + cs / 2], [x + cs / 2, z - cs / 2], [x - cs / 2, z - cs / 2]], true, [[0, shaftTop - 0.6], [0.4, shaftTop - 0.3], [0.4, shaftTop + 0.2], [0, shaftTop + 0.2]]);
  const uv = signs().extraUV('clock');
  const cr = 2.4;
  const cy = shaftTop + ch / 2;
  const hands = new THREE.Group();
  hands.name = 'clockHands';
  const handMat = new THREE.MeshStandardMaterial({ color: 0x151515, metalness: 0.6, roughness: 0.4 });
  const faces: [number, number, number][] = [
    [0, 1, 0],
    [1, 0, Math.PI / 2],
    [0, -1, Math.PI],
    [-1, 0, -Math.PI / 2],
  ];
  for (const [nx, nz, yaw] of faces) {
    const px = x + nx * (cs / 2 + 0.03);
    const pz = z + nz * (cs / 2 + 0.03);
    mb.pushTRS(px, cy, pz, yaw);
    mb.quad('signs', [-cr, -cr, 0], [cr, -cr, 0], [cr, cr, 0], [-cr, cr, 0], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
    mb.lathe('paint_dark', 0, 0, [[cr + 0.25, -0.02], [cr + 0.25, 0.08]], 32);
    mb.popTransform();
    // Hands: pivot group per face, animated by World from the game clock.
    const pivot = new THREE.Group();
    pivot.position.set(px + nx * 0.06, cy, pz + nz * 0.06);
    pivot.rotation.y = yaw;
    const hour = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.4, 0.04).translate(0, 0.6, 0), handMat);
    hour.name = 'hour';
    const minute = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.1, 0.04).translate(0, 0.95, 0.03), handMat);
    minute.name = 'minute';
    pivot.add(hour, minute);
    hands.add(pivot);
  }
  res.animated.push(hands);
  // Belfry with open arches.
  const by = shaftTop + ch;
  const bh = 7;
  for (const [cx, cz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) mb.box('stone', x + cx * (cs / 2 - 0.8) - 0.8, by, z + cz * (cs / 2 - 0.8) - 0.8, x + cx * (cs / 2 - 0.8) + 0.8, by + bh, z + cz * (cs / 2 - 0.8) + 0.8);
  for (const [nx, nz] of [
    [0, 1],
    [1, 0],
    [0, -1],
    [-1, 0],
  ]) {
    const lx = nx !== 0 ? 0.6 : cs / 2;
    const lz = nz !== 0 ? 0.6 : cs / 2;
    mb.box('stone', x + nx * (cs / 2 - 0.6) - lx, by + bh - 1.6, z + nz * (cs / 2 - 0.6) - lz, x + nx * (cs / 2 - 0.6) + lx, by + bh, z + nz * (cs / 2 - 0.6) + lz);
    mb.box('stone', x + nx * (cs / 2 - 0.6) - lx, by, z + nz * (cs / 2 - 0.6) - lz, x + nx * (cs / 2 - 0.6) + lx, by + 1.1, z + nz * (cs / 2 - 0.6) + lz);
  }
  mb.box('dark_interior', x - cs / 2 + 1.3, by, z - cs / 2 + 1.3, x + cs / 2 - 1.3, by + bh, z + cs / 2 - 1.3);
  mb.lathe('copper', x, z, [[1.2, by + 2.0], [1.3, by + 2.6], [1.0, by + 3.8], [0.4, by + 4.4], [0.0, by + 4.5]], 16, { color: new THREE.Color(0.85, 0.55, 0.3) });
  // Cornice, balustrade and copper spire.
  const ty = by + bh;
  mb.box('stone', x - cs / 2 - 0.5, ty, z - cs / 2 - 0.5, x + cs / 2 + 0.5, ty + 0.7, z + cs / 2 + 0.5);
  for (let i = 0; i < 4; i++) {
    for (let k = -3; k <= 3; k++) {
      const a = [0, Math.PI / 2, Math.PI, -Math.PI / 2][i];
      const ox = Math.sin(a) * (cs / 2 + 0.2) + Math.cos(a) * k * 1.15;
      const oz = Math.cos(a) * (cs / 2 + 0.2) - Math.sin(a) * k * 1.15;
      mb.lathe('stone', x + ox, z + oz, [[0.14, ty + 0.7], [0.2, ty + 1.0], [0.12, ty + 1.4], [0.16, ty + 1.6]], 6);
    }
  }
  mb.extrude('stone', [[x - cs / 2 - 0.4, z + cs / 2 + 0.4], [x + cs / 2 + 0.4, z + cs / 2 + 0.4], [x + cs / 2 + 0.4, z - cs / 2 - 0.4], [x - cs / 2 - 0.4, z - cs / 2 - 0.4]], true, [[0, ty + 1.6], [0, ty + 1.8], [-0.4, ty + 1.8]]);
  mb.lathe('copper', x, z, [[cs / 2 - 0.2, ty + 0.7], [cs / 2 - 0.8, ty + 2.5], [0.6, ty + 13], [0.2, ty + 15]], 4);
  mb.lathe('aluminium', x, z, [[0.12, ty + 15], [0.3, ty + 15.4], [0.0, ty + 15.8]], 12, { color: new THREE.Color(1.0, 0.8, 0.4) });
  mb.lathe('aluminium', x, z, [[0.04, ty + 15.8], [0.04, ty + 17.5]], 6, { color: new THREE.Color(1.0, 0.8, 0.4) });
  res.boxes.push([x, y + (ty - y) / 2, z, cs / 2, (ty - y) / 2, cs / 2, 0]);
}

// ------------------------------------------------------------------ seawalls & promenades

function seawall(mb: MeshBuilder, res: FeatureResult): void {
  const H = CITY_HALF;
  const r = COAST_CORNER;
  // Sample the rounded-rect coastline and emit wall where the coast is engineered.
  const pts: V2[] = [];
  const edge = (x0: number, z0: number, x1: number, z1: number) => {
    const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 10);
    for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
  };
  const arc = (cx: number, cz: number, a0: number, a1: number) => {
    for (let i = 0; i < 6; i++) {
      const a = a0 + ((a1 - a0) * i) / 6;
      pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  };
  // Loop in facade order (outward = sea).
  edge(-H + r, H, H - r, H);
  arc(H - r, H - r, Math.PI / 2, 0);
  edge(H, H - r, H, -H + r);
  arc(H - r, -H + r, 0, -Math.PI / 2);
  edge(H - r, -H, -H + r, -H);
  arc(-H + r, -H + r, -Math.PI / 2, -Math.PI);
  edge(-H, -H + r, -H, H - r);
  arc(-H + r, H - r, Math.PI, Math.PI / 2);
  const isWall = (x: number, z: number) => {
    if (naturalCoast(x, z) > 0.4) return false;
    if (Math.abs(z - H) < 1 && PIERS.some(([a, b]) => x > a - 1 && x < b + 1)) return false;
    return true;
  };
  let run: V2[] = [];
  const flush = () => {
    if (run.length > 1) wallRun(mb, run, res);
    run = [];
  };
  for (let i = 0; i <= pts.length; i++) {
    const p = pts[i % pts.length];
    if (isWall(p[0], p[1])) run.push(p);
    else flush();
  }
  flush();
  // Pier walls (three sides each).
  for (const [x0, x1, , z1] of PIERS) {
    wallRun(mb, [[x0, H], [x0, z1], [x1, z1], [x1, H]] as V2[], res, true);
    groundPatch(mb, 'kerb', x0 + 0.3, H - 2, x1 - 0.3, z1 - 0.3, 0.02, 10, new THREE.Color(0.72, 0.71, 0.69));
  }
  // Promenade / quay paving between the ring road and the seawall.
  const ring = 722 + 6.5;
  groundPatch(mb, 'pavement', ring, -150, H - 0.6, H - r, 0.19, 6);
  groundPatch(mb, 'pavement', -H + 0.6, -150, -ring, H - r, 0.19, 6);
  groundPatch(mb, 'kerb', -H + r, ring, H - r, H - 0.6, 0.19, 8, new THREE.Color(0.74, 0.73, 0.7));
  for (const [cx, cz, a0] of [
    [H - r, H - r, 0],
    [-H + r, H - r, Math.PI / 2],
  ] as [number, number, number][]) {
    for (let k = 0; k < 6; k++) {
      const a1 = a0 + (k / 6) * (Math.PI / 2);
      const a2 = a0 + ((k + 1) / 6) * (Math.PI / 2);
      const y = GROUND + 0.19;
      mb.quad('kerb', [cx, y, cz], [cx + Math.cos(a2) * (r - 0.6), y, cz + Math.sin(a2) * (r - 0.6)], [cx + Math.cos(a1) * (r - 0.6), y, cz + Math.sin(a1) * (r - 0.6)], [cx + Math.cos(a1) * (r - 0.6), y, cz + Math.sin(a1) * (r - 0.6)], { normal: [0, 1, 0], color: new THREE.Color(0.74, 0.73, 0.7) });
    }
  }
  // Fill between corner fans and strips.
  groundPatch(mb, 'kerb', H - r, ring, ring, H - r, 0.19, 8, new THREE.Color(0.74, 0.73, 0.7));
  groundPatch(mb, 'kerb', -ring, ring, -H + r, H - r, 0.19, 8, new THREE.Color(0.74, 0.73, 0.7));
}

/** Vertical quay wall along a polyline (sea on the outward side) with coping and railings/fenders. */
function wallRun(mb: MeshBuilder, run: V2[], res: FeatureResult, pier = false): void {
  const top = GROUND + 0.25;
  const bottom = -9;
  mb.extrude('rough_wall', run, false, [[0, bottom], [0, top - 0.3]]);
  mb.extrude('kerb', run, false, [[-0.6, top - 0.3], [0.15, top - 0.3], [0.15, top], [-0.6, top]], { color: new THREE.Color(0.8, 0.79, 0.76) });
  const south = run.every(([, z]) => z > CITY_HALF - 2);
  for (let i = 0; i < run.length - 1; i++) {
    const [x0, z0] = run[i];
    const [x1, z1] = run[i + 1];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / len;
    const dz = (z1 - z0) / len;
    const nx = -dz;
    const nz = dx;
    // Railing on promenades; tyre fenders on quays and piers.
    if (!south && !pier) {
      for (let s = 0; s < len; s += 2.5) {
        const px = x0 + dx * s - nx * 0.25;
        const pz = z0 + dz * s - nz * 0.25;
        mb.box('paint_dark', px - 0.04, top, pz - 0.04, px + 0.04, top + 1.1, pz + 0.04);
      }
      mb.beam('paint_dark', [x0 - nx * 0.25, top + 1.1, z0 - nz * 0.25], [x1 - nx * 0.25, top + 1.1, z1 - nz * 0.25], 0.07);
      mb.beam('paint_dark', [x0 - nx * 0.25, top + 0.55, z0 - nz * 0.25], [x1 - nx * 0.25, top + 0.55, z1 - nz * 0.25], 0.04);
      res.boxes.push([(x0 + x1) / 2 - nx * 0.25, top + 0.6, (z0 + z1) / 2 - nz * 0.25, len / 2, 0.6, 0.1, Math.atan2(-dz, dx)]);
    } else {
      for (let s = 3; s < len; s += 12) {
        const px = x0 + dx * s + nx * 0.35;
        const pz = z0 + dz * s + nz * 0.35;
        mb.pushTRS(px, 0.9, pz, Math.atan2(dx, dz));
        mb.lathe('rubber', 0, 0, [[0.45, -0.25], [0.55, 0], [0.45, 0.25]], 12);
        mb.popTransform();
      }
    }
  }
}

// ------------------------------------------------------------------ suspension bridge

function bridge(mb: MeshBuilder, res: FeatureResult): void {
  const z = BRIDGE.z;
  const hw = BRIDGE.width / 2;
  const x0 = BRIDGE.startX + 9;
  const x1 = BRIDGE.endX;
  const step = 6;
  const deck: { x: number; y: number }[] = [];
  for (let x = x0; x <= x1 + 0.01; x += step) deck.push({ x, y: bridgeDeckY(x) });
  // Road surface + markings.
  const tri = { v: [] as number[], i: [] as number[] };
  for (let k = 0; k < deck.length - 1; k++) {
    const a = deck[k];
    const b = deck[k + 1];
    mb.quad('asphalt', [a.x, a.y, z + hw - 3], [b.x, b.y, z + hw - 3], [b.x, b.y, z - hw + 3], [a.x, a.y, z - hw + 3], { normal: [0, 1, 0], uvs: [[a.x, -(z + hw)], [b.x, -(z + hw)], [b.x, -(z - hw)], [a.x, -(z - hw)]] });
    // Walkways (raised) and parapets.
    for (const side of [-1, 1]) {
      const zi = z + side * (hw - 3);
      const zo = z + side * hw;
      const [za, zb] = side > 0 ? [zi, zo] : [zo, zi];
      mb.quad('pavement', [a.x, a.y + 0.2, zb], [b.x, b.y + 0.2, zb], [b.x, b.y + 0.2, za], [a.x, a.y + 0.2, za], { normal: [0, 1, 0] });
      mb.quad('kerb', side > 0 ? [b.x, b.y, zi] : [a.x, a.y, zi], side > 0 ? [a.x, a.y, zi] : [b.x, b.y, zi], side > 0 ? [a.x, a.y + 0.2, zi] : [b.x, b.y + 0.2, zi], side > 0 ? [b.x, b.y + 0.2, zi] : [a.x, a.y + 0.2, zi]);
      // Railing: posts + rails.
      mb.box('paint_bridge', a.x - 0.06, a.y + 0.2, zo - side * 0.15 - 0.06, a.x + 0.06, a.y + 1.4, zo - side * 0.15 + 0.06);
      mb.beam('paint_bridge', [a.x, a.y + 1.4, zo - side * 0.15], [b.x, b.y + 1.4, zo - side * 0.15], 0.1);
      mb.beam('paint_bridge', [a.x, a.y + 0.8, zo - side * 0.15], [b.x, b.y + 0.8, zo - side * 0.15], 0.05);
      // Vehicle barrier.
      mb.beam('steel_light', [a.x, a.y + 0.75, zi - side * 0.1], [b.x, b.y + 0.75, zi - side * 0.1], 0.08, { height: 0.35 });
    }
    // Centre line & lane dashes.
    const mid = (k % 2 === 0) as boolean;
    mb.quad('markings_yellow', [a.x, a.y + 0.012, z + 0.2], [b.x, b.y + 0.012, z + 0.2], [b.x, b.y + 0.012, z + 0.05], [a.x, a.y + 0.012, z + 0.05], { normal: [0, 1, 0] });
    mb.quad('markings_yellow', [a.x, a.y + 0.012, z - 0.05], [b.x, b.y + 0.012, z - 0.05], [b.x, b.y + 0.012, z - 0.2], [a.x, a.y + 0.012, z - 0.2], { normal: [0, 1, 0] });
    if (mid) {
      for (const lz of [-hw / 2 + 1.5, hw / 2 - 1.5]) {
        const ex = a.x + 3;
        const ey = a.y + ((b.y - a.y) * 3) / step;
        mb.quad('markings', [a.x, a.y + 0.012, lz + 0.08], [ex, ey + 0.012, lz + 0.08], [ex, ey + 0.012, lz - 0.08], [a.x, a.y + 0.012, lz - 0.08], { normal: [0, 1, 0] });
      }
    }
    // Stiffening girder under the deck (box with truss panels on the sides).
    const gd = 3.2;
    for (const side of [-1, 1]) {
      const zz = z + side * (hw - 0.4);
      const yA = a.y - 0.3;
      const yB = b.y - 0.3;
      const [p0, p1, p2, p3]: V3[] = side > 0 ? [[a.x, yA - gd, zz], [b.x, yB - gd, zz], [b.x, yB, zz], [a.x, yA, zz]] : [[b.x, yB - gd, zz], [a.x, yA - gd, zz], [a.x, yA, zz], [b.x, yB, zz]];
      mb.quad('paint_bridge', p0, p1, p2, p3);
      mb.beam('steel_dark', [a.x, yA - gd, zz + side * 0.05], [b.x, yB, zz + side * 0.05], 0.18);
    }
    mb.quad('paint_bridge', [b.x, b.y - 0.3 - gd, z + hw - 0.4], [a.x, a.y - 0.3 - gd, z + hw - 0.4], [a.x, a.y - 0.3 - gd, z - hw + 0.4], [b.x, b.y - 0.3 - gd, z - hw + 0.4]);
    // Collision surface.
    const base = tri.v.length / 3;
    tri.v.push(a.x, a.y, z - hw, b.x, b.y, z - hw, b.x, b.y, z + hw, a.x, a.y, z + hw);
    tri.i.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  res.trimeshes.push(tri);
  for (const side of [-1, 1]) res.boxes.push([(x0 + x1) / 2, BRIDGE.deckY + 0.6, z + side * (hw - 0.1), (x1 - x0) / 2, 0.8, 0.2, 0]);
  // Lamps along the deck.
  for (let x = x0 + 20; x < x1; x += 40) {
    for (const side of [-1, 1]) res.props.push({ type: 'lamp', x, z: z + side * (hw - 1.2), y: bridgeDeckY(x) + 0.2, yaw: side > 0 ? Math.PI : 0 });
  }
  // Approach piers (viaduct columns) where the deck is high enough.
  for (let x = x0 + 30; x < x1 - 10; x += 36) {
    if (x > BRIDGE.towerX[0] - 10 && x < BRIDGE.towerX[1] + 10) continue;
    const dy = bridgeDeckY(x);
    const g = heightAt(x, z);
    if (dy - g < 4) continue;
    for (const side of [-1, 1]) mb.box('concrete', x - 1.2, Math.min(g, 0) - 4, z + side * 7 - 1.2, x + 1.2, dy - 3.4, z + side * 7 + 1.2);
    mb.box('concrete', x - 1.4, dy - 4.4, z - hw + 1, x + 1.4, dy - 3.3, z + hw - 1);
    res.boxes.push([x, (dy + Math.min(g, 0)) / 2 - 2, z - 7, 1.2, (dy - Math.min(g, 0)) / 2, 1.2, 0]);
    res.boxes.push([x, (dy + Math.min(g, 0)) / 2 - 2, z + 7, 1.2, (dy - Math.min(g, 0)) / 2, 1.2, 0]);
  }
  // Towers.
  const top = BRIDGE.towerTop;
  for (const tx of BRIDGE.towerX) {
    mb.box('concrete', tx - 9, -12, z - hw - 6, tx + 9, 3, z + hw + 6);
    for (const side of [-1, 1]) {
      const lz = z + side * (hw + 1.6);
      // Tapered leg built from stacked boxes.
      const segs = 6;
      for (let k = 0; k < segs; k++) {
        const ya = 3 + ((top - 3) * k) / segs;
        const yb = 3 + ((top - 3) * (k + 1)) / segs;
        const wa = 2.6 - k * 0.18;
        mb.box('paint_bridge', tx - wa, ya, lz - wa * 0.8, tx + wa, yb, lz + wa * 0.8);
        mb.box('steel_dark', tx - wa - 0.05, yb - 0.4, lz - wa * 0.8 - 0.05, tx + wa + 0.05, yb, lz + wa * 0.8 + 0.05);
      }
      // Saddle on top.
      mb.box('steel_dark', tx - 2.2, top, lz - 1.4, tx + 2.2, top + 1.6, lz + 1.4);
      mb.cylinder('light_red', tx, top + 1.6, lz, 0.3, 0.3, 0.4, 8);
      res.boxes.push([tx, (3 + top) / 2, lz, 2.6, (top - 3) / 2, 2.1, 0]);
    }
    // Portal cross beams.
    for (const by of [BRIDGE.deckY - 4.5, 52, top - 6]) {
      const h = by > 60 ? 4 : 3;
      mb.box('paint_bridge', tx - 1.8, by, z - hw - 1.6, tx + 1.8, by + h, z + hw + 1.6);
    }
    // Diagonal braces between the lower portals.
    for (const side of [-1, 1]) mb.beam('paint_bridge', [tx, BRIDGE.deckY - 1, z - side * (hw + 1)], [tx, 50, z + side * (hw + 1)], 1.2);
  }
  // Main cables (parabolic main span + side spans to anchorages) and hangers.
  const anchorA = 742;
  const anchorB = 1300;
  const sag = BRIDGE.deckY + 4;
  const cableY = (x: number): number => {
    const [t0, t1] = BRIDGE.towerX;
    if (x < t0) {
      const u = (x - anchorA) / (t0 - anchorA);
      return bridgeDeckY(anchorA) + 6 + (top + 0.8 - (bridgeDeckY(anchorA) + 6)) * (u * u * 0.6 + u * 0.4);
    }
    if (x > t1) {
      const u = (anchorB - x) / (anchorB - t1);
      return bridgeDeckY(anchorB) + 6 + (top + 0.8 - (bridgeDeckY(anchorB) + 6)) * (u * u * 0.6 + u * 0.4);
    }
    const u = (x - (t0 + t1) / 2) / ((t1 - t0) / 2);
    return sag + (top + 0.8 - sag) * u * u;
  };
  for (const side of [-1, 1]) {
    const cz = z + side * (hw + 1.6);
    const pts: THREE.Vector3[] = [];
    for (let x = anchorA; x <= anchorB; x += 8) pts.push(new THREE.Vector3(x, cableY(x), cz));
    for (let k = 0; k < pts.length - 1; k++) mb.beam('steel_dark', [pts[k].x, pts[k].y, pts[k].z], [pts[k + 1].x, pts[k + 1].y, pts[k + 1].z], 0.9);
    for (let x = anchorA + 12; x < anchorB - 8; x += 12) {
      if (Math.abs(x - BRIDGE.towerX[0]) < 4 || Math.abs(x - BRIDGE.towerX[1]) < 4) continue;
      const cy = cableY(x);
      const dy = bridgeDeckY(x);
      if (cy - dy < 2) continue;
      mb.box('steel_dark', x - 0.07, dy + 0.4, cz - side * 0.9 - 0.07, x + 0.07, cy, cz - side * 0.9 + 0.07);
    }
  }
  // Anchorages.
  for (const ax of [anchorA, anchorB]) {
    const ay = bridgeDeckY(ax);
    mb.box('concrete', ax - 10, Math.min(heightAt(ax, z), 0) - 2, z - hw - 5, ax + 10, ay + 7, z - hw + 2);
    mb.box('concrete', ax - 10, Math.min(heightAt(ax, z), 0) - 2, z + hw - 2, ax + 10, ay + 7, z + hw + 5);
    res.boxes.push([ax, ay / 2 + 2, z - hw - 1.5, 10, ay / 2 + 5, 3.5, 0]);
    res.boxes.push([ax, ay / 2 + 2, z + hw + 1.5, 10, ay / 2 + 5, 3.5, 0]);
  }
  // Name plaque.
  const uv = signs().extraUV('welcome');
  const px = x0 + 4;
  const py = bridgeDeckY(px) + 2.2;
  mb.quad('signs', [px, py, z - hw - 0.3], [px, py, z + hw + 0.3], [px, py + 1.6, z + hw + 0.3], [px, py + 1.6, z - hw - 0.3], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
  mb.box('paint_bridge', px + 0.01, py - 0.2, z - hw - 0.5, px + 0.3, py + 1.8, z + hw + 0.5);
  for (const side of [-1, 1]) mb.box('paint_bridge', px, bridgeDeckY(px), z + side * (hw + 0.4) - 0.2, px + 0.3, py, z + side * (hw + 0.4) + 0.2);
}

// ------------------------------------------------------------------ Gullhaven airfield

function airport(mb: MeshBuilder, res: FeatureResult): void {
  const cx = 1835;
  const z0 = ISLAND.z - 600;
  const z1 = ISLAND.z + 600;
  const rw = 45;
  const y = 3.0;
  groundPatch(mb, 'asphalt', cx - rw / 2, z0, cx + rw / 2, z1, 0.05, 20);
  // Shoulders.
  groundPatch(mb, 'kerb', cx - rw / 2 - 6, z0 - 10, cx - rw / 2, z1 + 10, 0.03, 20, new THREE.Color(0.6, 0.6, 0.58));
  groundPatch(mb, 'kerb', cx + rw / 2, z0 - 10, cx + rw / 2 + 6, z1 + 10, 0.03, 20, new THREE.Color(0.6, 0.6, 0.58));
  const mk = (xa: number, za: number, xb: number, zb: number, key = 'markings') =>
    mb.quad(key, [xa, y + 0.07, zb], [xb, y + 0.07, zb], [xb, y + 0.07, za], [xa, y + 0.07, za], { normal: [0, 1, 0] });
  // Centreline, edge lines, threshold piano keys, numbers, touchdown bars.
  for (let z = z0 + 90; z < z1 - 90; z += 50) mk(cx - 0.45, z, cx + 0.45, z + 30);
  mk(cx - rw / 2 + 0.6, z0, cx - rw / 2 + 1.5, z1);
  mk(cx + rw / 2 - 1.5, z0, cx + rw / 2 - 0.6, z1);
  for (const [zs, dir] of [
    [z0 + 6, 1],
    [z1 - 6, -1],
  ] as [number, number][]) {
    for (let k = 0; k < 6; k++) {
      for (const sx of [-1, 1]) {
        const xa = cx + sx * (2.2 + k * 3.3);
        mk(Math.min(xa, xa + sx * 1.8), Math.min(zs, zs + dir * 30), Math.max(xa, xa + sx * 1.8), Math.max(zs, zs + dir * 30));
      }
    }
    for (let t = 0; t < 3; t++) {
      const zz = zs + dir * (150 + t * 150);
      for (const sx of [-1, 1]) mk(cx + sx * 6, Math.min(zz, zz + dir * 22), cx + sx * 10, Math.max(zz, zz + dir * 22));
    }
    const uv = signs().extraUV(dir > 0 ? 'rw36' : 'rw18');
    const zn = zs + dir * 45;
    const nw = 9;
    const nl = 18;
    if (dir > 0) mb.quad('signs', [cx - nw, y + 0.075, zn + nl], [cx + nw, y + 0.075, zn + nl], [cx + nw, y + 0.075, zn], [cx - nw, y + 0.075, zn], { normal: [0, 1, 0], uvs: [[uv[2], uv[3]], [uv[0], uv[3]], [uv[0], uv[1]], [uv[2], uv[1]]] });
    else mb.quad('signs', [cx - nw, y + 0.075, zn], [cx + nw, y + 0.075, zn], [cx + nw, y + 0.075, zn - nl], [cx - nw, y + 0.075, zn - nl], { normal: [0, 1, 0], uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
  }
  // Edge lights.
  for (let z = z0; z <= z1; z += 60) {
    for (const sx of [-1, 1]) mb.cylinder('lamp_glow', cx + sx * (rw / 2 + 1.5), y, z, 0.12, 0.1, 0.4, 6);
  }
  // Parallel taxiway with connectors.
  const tx = cx - 120;
  groundPatch(mb, 'asphalt', tx - 11, z0 + 60, tx + 11, z1 - 60, 0.05, 20);
  for (let z = z0 + 80; z < z1 - 80; z += 6) mk(tx - 0.15, z, tx + 0.15, z + 3, 'markings_yellow');
  for (const zc of [z0 + 70, ISLAND.z, z1 - 70]) {
    groundPatch(mb, 'asphalt', tx + 11, zc - 11, cx - rw / 2, zc + 11, 0.045, 20);
    mk(tx, zc - 0.15, cx - rw / 2, zc + 0.15, 'markings_yellow');
  }
  // Apron.
  const ax0 = tx - 11 - 150;
  const ax1 = tx - 11;
  groundPatch(mb, 'kerb', ax0, ISLAND.z - 170, ax1, ISLAND.z + 170, 0.04, 20, new THREE.Color(0.78, 0.77, 0.74));
  for (let z = ISLAND.z - 150; z < ISLAND.z + 150; z += 50) mk(ax0 + 40, z, ax1, z + 0.3, 'markings_yellow');
  // Hangars facing the apron (+x).
  [ISLAND.z - 110, ISLAND.z, ISLAND.z + 110].forEach((hz, i) => hangar(mb, ax0 - 28, hz, i, res));
  // Terminal + control tower + car park.
  terminal(mb, ax0 + 30, ISLAND.z + 240, res);
  controlTower(mb, ax0 + 95, ISLAND.z + 250, res);
  // Access road from the bridge to the terminal.
  const ry = (x: number, z: number) => heightAt(x, z);
  void ry;
  groundPatch(mb, 'asphalt', BRIDGE.endX - 6, BRIDGE.z - 7, ax0 - 60, BRIDGE.z + 7, 0.05, 8);
  groundPatch(mb, 'asphalt', ax0 - 74, BRIDGE.z - 7, ax0 - 60, ISLAND.z + 270, 0.05, 8);
  groundPatch(mb, 'asphalt', ax0 - 74, ISLAND.z + 256, ax0 + 10, ISLAND.z + 270, 0.05, 8);
  for (let x = BRIDGE.endX; x < ax0 - 70; x += 9) mk(x, BRIDGE.z - 0.08, x + 3, BRIDGE.z + 0.08);
  for (let z = BRIDGE.z + 10; z < ISLAND.z + 250; z += 9) mk(ax0 - 67.08, z, ax0 - 66.92, z + 3);
  const welcome = signs().extraUV('airfield');
  const sx = BRIDGE.endX + 20;
  mb.box('paint_dark', sx - 0.1, y, BRIDGE.z + 9, sx + 0.1, y + 3.4, BRIDGE.z + 9.2);
  mb.box('paint_dark', sx - 0.1, y, BRIDGE.z + 15, sx + 0.1, y + 3.4, BRIDGE.z + 15.2);
  mb.quad('signs', [sx - 0.12, y + 2, BRIDGE.z + 16], [sx - 0.12, y + 2, BRIDGE.z + 8.4], [sx - 0.12, y + 3.5, BRIDGE.z + 8.4], [sx - 0.12, y + 3.5, BRIDGE.z + 16], { uvs: [[welcome[0], welcome[1]], [welcome[2], welcome[1]], [welcome[2], welcome[3]], [welcome[0], welcome[3]]] });
  // Windsock.
  const wx = cx - rw / 2 - 30;
  const wz = z0 + 140;
  mb.cylinder('paint_white', wx, y, wz, 0.08, 0.06, 7, 8);
  // The sock itself is a separate object that World turns with the wind.
  const sockMb = new MeshBuilder();
  sockMb.pushTransform(new THREE.Matrix4().makeRotationZ(-Math.PI / 2 + 0.2));
  sockMb.lathe('fabric', 0, 0, [[0.45, 0], [0.2, 3.2]], 10, { color: new THREE.Color(0.95, 0.35, 0.05) });
  sockMb.popTransform();
  const sock = sockMb.build(materials.m, { name: 'windsock' });
  sock.position.set(wx, y + 6.6, wz);
  sock.name = 'windsock';
  res.animated.push(sock);
  // Fuel tanks.
  for (let k = 0; k < 3; k++) {
    const fx = ax0 - 70 + k * 12;
    const fz = ISLAND.z - 250;
    mb.lathe('paint', fx, fz, [[4.5, y], [4.5, y + 7], [3.5, y + 8], [0.01, y + 8.3]], 24, { color: new THREE.Color(0.92, 0.92, 0.9) });
    res.boxes.push([fx, y + 4, fz, 4.5, 4.2, 4.5, 0]);
  }
}

function hangar(mb: MeshBuilder, x: number, z: number, i: number, res: FeatureResult): void {
  const w = 44;
  const d = 52;
  const h = 15;
  const y = 3.05;
  const col = new THREE.Color().setHSL(0.58, 0.08 + i * 0.05, 0.62);
  const segs = 14;
  const R = d / 2;
  for (let k = 0; k < segs; k++) {
    const a0 = (k / segs) * Math.PI;
    const a1 = ((k + 1) / segs) * Math.PI;
    const zA = z - Math.cos(a0) * R;
    const yA = y + 5 + Math.sin(a0) * (h - 5);
    const zB = z - Math.cos(a1) * R;
    const yB = y + 5 + Math.sin(a1) * (h - 5);
    mb.quad('corrugated', [x + w / 2, yA, zA], [x - w / 2, yA, zA], [x - w / 2, yB, zB], [x + w / 2, yB, zB], { color: col });
  }
  // Side walls and back wall.
  mb.box('corrugated', x - w / 2, y, z - R, x + w / 2, y + 5, z - R + 0.3, { color: col });
  mb.box('corrugated', x - w / 2, y, z + R - 0.3, x + w / 2, y + 5, z + R, { color: col });
  const back = x - w / 2;
  const prof2: V3[] = [];
  for (let k = 0; k <= segs; k++) {
    const a = (k / segs) * Math.PI;
    prof2.push([back, y + 5 + Math.sin(a) * (h - 5), z - Math.cos(a) * R]);
  }
  for (let k = 0; k < segs; k++) mb.quad('corrugated', [back, y, prof2[k][2]], [back, y, prof2[k + 1][2]], prof2[k + 1], prof2[k], { color: col.clone().multiplyScalar(0.9) });
  // Open front: dark interior + door leaves parked at the sides + gable infill.
  mb.box('dark_interior', x - w / 2 + 0.5, y, z - R + 0.4, x + w / 2 - 2, y + 0.05, z + R - 0.4);
  mb.quad('dark_interior', [x - w / 2 + 0.6, y, z + R - 0.4], [x - w / 2 + 0.6, y, z - R + 0.4], [x - w / 2 + 0.6, y + h - 1, z - R + 0.4], [x - w / 2 + 0.6, y + h - 1, z + R - 0.4]);
  const front = x + w / 2;
  for (let k = 0; k < segs; k++) {
    const a0 = (k / segs) * Math.PI;
    const a1 = ((k + 1) / segs) * Math.PI;
    const za = z - Math.cos(a0) * R;
    const zb = z - Math.cos(a1) * R;
    const ya = y + 5 + Math.sin(a0) * (h - 5);
    const yb = y + 5 + Math.sin(a1) * (h - 5);
    mb.quad('corrugated', [front, y + 11, zb], [front, y + 11, za], [front, Math.max(ya, y + 11), za], [front, Math.max(yb, y + 11), zb], { color: col.clone().multiplyScalar(0.85) });
  }
  mb.box('paint_dark', front - 0.3, y + 10.4, z - R, front + 0.2, y + 11, z + R);
  for (const s of [-1, 1]) mb.box('corrugated', front - 0.4, y, z + s * R - (s > 0 ? 9 : 0), front + 0.1, y + 10.4, z + s * R + (s < 0 ? 9 : 0), { color: col.clone().multiplyScalar(0.95) });
  res.boxes.push([x, y + 4, z - R + 0.5, w / 2, 4, 0.5, 0]);
  res.boxes.push([x, y + 4, z + R - 0.5, w / 2, 4, 0.5, 0]);
  res.boxes.push([back + 0.5, y + h / 2, z, 0.5, h / 2, R, 0]);
  res.boxes.push([x, y + h - 2, z, w / 2, 2, R, 0]);
}

function terminal(mb: MeshBuilder, x: number, z: number, res: FeatureResult): void {
  const y = 3.05;
  const w = 70;
  const d = 22;
  const h = 9;
  mb.box('granite', x - w / 2, y, z - d / 2, x + w / 2, y + 0.6, z + d / 2);
  // Glass curtain walls with mullions.
  for (const side of [-1, 1]) {
    const zz = z + side * d / 2;
    const n = Math.round(w / 2.5);
    for (let k = 0; k < n; k++) {
      const xa = x - w / 2 + (w / n) * k;
      const xb = xa + w / n;
      const pts: V3[] = side > 0 ? [[xa, y + 0.6, zz], [xb, y + 0.6, zz], [xb, y + h, zz], [xa, y + h, zz]] : [[xb, y + 0.6, zz], [xa, y + 0.6, zz], [xa, y + h, zz], [xb, y + h, zz]];
      mb.quad('glass_shop', pts[0], pts[1], pts[2], pts[3], { uvs: [[0, 0], [1, 0], [1, 1], [0, 1]], win: [hashN(k, side) % 997, w / n, h - 0.6, 2] });
      mb.box('aluminium', xa - 0.06, y + 0.6, zz - 0.15, xa + 0.06, y + h, zz + 0.15);
    }
  }
  mb.box('aluminium', x - w / 2, y, z - d / 2, x - w / 2 + 0.6, y + h, z + d / 2);
  mb.box('aluminium', x + w / 2 - 0.6, y, z - d / 2, x + w / 2, y + h, z + d / 2);
  // Floating roof slab with deep overhang.
  mb.box('paint_white', x - w / 2 - 4, y + h, z - d / 2 - 6, x + w / 2 + 4, y + h + 1.2, z + d / 2 + 6);
  for (let k = 0; k < 6; k++) mb.cylinder('aluminium', x - w / 2 + 6 + k * 11.6, y, z + d / 2 + 5, 0.25, 0.25, h, 10);
  const uv = signs().extraUV('airfield');
  mb.quad('signs', [x - 10, y + h + 0.1, z + d / 2 + 6.05], [x + 10, y + h + 0.1, z + d / 2 + 6.05], [x + 10, y + h + 1.1, z + d / 2 + 6.05], [x - 10, y + h + 1.1, z + d / 2 + 6.05], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
  res.boxes.push([x, y + h / 2, z, w / 2, h / 2, d / 2, 0]);
}

function controlTower(mb: MeshBuilder, x: number, z: number, res: FeatureResult): void {
  const y = 3.05;
  mb.box('concrete', x - 6, y, z - 6, x + 6, y + 4, z + 6);
  mb.lathe('concrete', x, z, [[3.2, y + 4], [2.6, y + 28]], 16);
  mb.lathe('paint_white', x, z, [[2.6, y + 28], [5.4, y + 29.5], [5.4, y + 30]], 8);
  mb.lathe('glass_plain', x, z, [[4.8, y + 30], [5.6, y + 33.5]], 8);
  mb.lathe('steel_dark', x, z, [[5.8, y + 33.5], [5.8, y + 34.2], [0.01, y + 34.4]], 8, { capTop: true });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    mb.beam('steel_dark', [x + Math.cos(a) * 4.8, y + 30, z + Math.sin(a) * 4.8], [x + Math.cos(a) * 5.6, y + 33.5, z + Math.sin(a) * 5.6], 0.14);
  }
  mb.cylinder('steel_light', x + 2, y + 34.3, z, 0.08, 0.05, 6, 6);
  mb.cylinder('light_red', x + 2, y + 40.3, z, 0.18, 0.18, 0.3, 8);
  mb.lathe('aluminium', x - 2, z + 1, [[0.05, y + 34.3], [1.2, y + 35.5], [0.0, y + 35.6]], 16);
  res.boxes.push([x, y + 17, z, 3.2, 17, 3.2, 0]);
}
