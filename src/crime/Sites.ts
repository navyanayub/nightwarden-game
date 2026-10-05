/**
 * Where crimes and consequences happen, chosen once from the generated city:
 *  - Brightwater Savings Bank: a Midtown shop building facing a street (sign panel, alarm lamp),
 *  - Port Vellmoor General Hospital and VPD Precinct 1 (respawn points, signs, map markers),
 *  - shopfronts (robberies, arson), pavement and kerb points (muggings, street fights, car theft),
 *  - two enterable warehouses (Industrial, Harbour) for hostage situations and deals: brick shell
 *    with a roll-up door opening, a roof hatch over a skylight, interior lamps, crates and a deal
 *    table. Walls / roof / crates have their own static colliders.
 */
import * as THREE from 'three';
import type { BuildingSpec, CityData, Side } from '../world/CityLayout';
import type { District } from '../world/WorldConfig';
import type { Lane, LaneGraph } from '../ai/LaneGraph';
import { materials } from '../world/Materials';
import { MeshBuilder } from '../world/MeshBuilder';
import { signs, type Brand } from '../world/Signage';
import { physics, GROUPS_WORLD, GROUPS_PROP } from '../core/Physics';
import { heightAt } from '../world/Terrain';
import { findClearSpot } from '../ai/Enemies';
import type { Rng } from '../core/Random';

export interface Site {
  x: number;
  y: number;
  z: number;
  /** Outward facing (from the building to the street). */
  yaw: number;
  district: District;
  b?: BuildingSpec;
}

export interface Warehouse {
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  district: District;
  /** World-space helpers. */
  door: THREE.Vector3;
  inside: THREE.Vector3;
  hatch: THREE.Vector3;
  table: THREE.Vector3;
  local(lx: number, lz: number): THREE.Vector3;
  lamps: THREE.MeshStandardMaterial;
}

const NORMALS: Record<Side, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

/** Point on the front facade (centre, ground) and its outward normal. */
export function frontOf(b: BuildingSpec): { x: number; z: number; nx: number; nz: number; len: number } {
  const [nx, nz] = NORMALS[b.front];
  return { x: b.cx + (nx * b.w) / 2, z: b.cz + (nz * b.d) / 2, nx, nz, len: nx !== 0 ? b.d : b.w };
}

function laneDist(graph: LaneGraph, x: number, z: number): { d: number; lane: Lane | null } {
  let best = Infinity;
  let lane: Lane | null = null;
  for (const l of graph.lanesNear(x, z, 60)) {
    const x0 = l.xs[0];
    const z0 = l.zs[0];
    const x1 = l.xs[l.xs.length - 1];
    const z1 = l.zs[l.zs.length - 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const L2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / L2));
    const d = Math.hypot(x0 + dx * t - x, z0 + dz * t - z);
    if (d < best) {
      best = d;
      lane = l;
    }
  }
  return { d: best, lane };
}

export class CrimeSites {
  readonly group = new THREE.Group();
  bank!: Site;
  hospital!: Site;
  precinct!: Site;
  readonly shops: Site[] = [];
  readonly warehouses: Warehouse[] = [];
  /** Bank alarm lamp (blinks during a robbery). */
  alarmMat = new THREE.MeshStandardMaterial({ color: 0x300000, emissive: new THREE.Color(1, 0.05, 0.02), emissiveIntensity: 0, roughness: 0.3 });

  constructor(
    private readonly city: CityData,
    private readonly graph: LaneGraph,
    avoid: { x: number; z: number }[],
  ) {
    this.group.name = 'CrimeSites';
    const streetFacing = (b: BuildingSpec) => {
      const f = frontOf(b);
      return laneDist(graph, f.x + f.nx * 6, f.z + f.nz * 6).d < 12;
    };
    const site = (b: BuildingSpec, out = 2.6): Site => {
      const f = frontOf(b);
      const x = f.x + f.nx * out;
      const z = f.z + f.nz * out;
      return { x, y: heightAt(x, z) + 0.15, z, yaw: Math.atan2(f.nx, f.nz), district: b.district, b };
    };
    const pick = (filter: (b: BuildingSpec) => boolean, near: [number, number], not: BuildingSpec[] = []) => {
      const c = city.buildings.filter((b) => filter(b) && streetFacing(b) && !not.includes(b) && b.tiers.length <= 2);
      c.sort((a, b) => Math.hypot(a.cx - near[0], a.cz - near[1]) - Math.hypot(b.cx - near[0], b.cz - near[1]));
      return c[0] ?? city.buildings[0];
    };
    const sp = city.spawn;
    const bankB = pick((b) => b.district === 'midtown' && b.shop && b.height > 14 && Math.min(b.w, b.d) > 14, [sp.x + 60, sp.z - 120]);
    const hospB = pick((b) => (b.district === 'midtown' || b.district === 'hills') && b.height > 18 && Math.min(b.w, b.d) > 18 && b !== bankB, [300, -330], [bankB]);
    const precB = pick((b) => (b.district === 'oldtown' || b.district === 'midtown') && Math.min(b.w, b.d) > 14 && b.height > 10, [-240, -160], [bankB, hospB]);
    this.bank = site(bankB);
    this.hospital = site(hospB, 3.2);
    this.precinct = site(precB, 3.2);
    this.sign(bankB, { name: 'BRIGHTWATER', sub: 'SAVINGS BANK', bg: '#0f2f57', fg: '#ffffff', accent: '#4fb3e8', font: 'Arial, sans-serif' }, 'bank', 6.5);
    this.sign(hospB, { name: 'GENERAL HOSPITAL', sub: 'PORT VELLMOOR · EMERGENCY', bg: '#f4f7f8', fg: '#0d5c8a', accent: '#18a06a', font: 'Arial, sans-serif' }, 'hospital', 8);
    this.sign(precB, { name: 'VELLMOOR POLICE', sub: 'PRECINCT 1', bg: '#0a1830', fg: '#ffffff', accent: '#4a8ce6', font: 'Arial, sans-serif' }, 'precinct', 7);
    this.extras(bankB, hospB, precB);
    // Shopfronts across the city.
    for (const b of city.buildings) {
      if (!b.shop || b === bankB || !streetFacing(b)) continue;
      if (b.district === 'midtown' || b.district === 'oldtown' || b.district === 'harbour' || b.district === 'industrial') this.shops.push(site(b, 2.2));
    }
    // Warehouses.
    const spots: [string, District, number, number][] = [
      ['Coldwater Storage', 'industrial', -300, 420],
      ['Pier Nine Sheds', 'harbour', 300, 470],
    ];
    for (const [name, district, x, z] of spots) {
      const p = findClearSpotAway(graph, x, z, avoid);
      this.warehouses.push(this.buildWarehouse(name, district, p));
      avoid.push({ x: p.x, z: p.z });
    }
  }

  /** Sign panel over the entrance of a building (covers any existing shop fascia). */
  private sign(b: BuildingSpec, brand: Brand, key: string, w: number): void {
    const f = frontOf(b);
    const uv = signs().customUV(key, brand);
    const y = b.baseY + Math.min(4.6, b.floorH * 1.05) + 0.4;
    const h = w / 4;
    const mb = new MeshBuilder();
    const cx = f.x + f.nx * 0.36;
    const cz = f.z + f.nz * 0.36;
    // Tangent along the facade (left → right seen from the street).
    const tx = f.nz;
    const tz = -f.nx;
    const p = (u: number, v: number): [number, number, number] => [cx + tx * u, y + v, cz + tz * u];
    mb.quad('signs', p(-w / 2, -h / 2), p(w / 2, -h / 2), p(w / 2, h / 2), p(-w / 2, h / 2), { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]], normal: [f.nx, 0, f.nz] });
    const back = new MeshBuilder();
    // Backing panel behind the sign face (its front face sits 2 cm behind the sign).
    back.boxYaw('steel_dark', cx - f.nx * 0.14, cz - f.nz * 0.14, y - h / 2 - 0.08, y + h / 2 + 0.08, f.nx !== 0 ? 0.12 : w / 2 + 0.08, f.nx !== 0 ? w / 2 + 0.08 : 0.12, 0);
    const g = mb.build(materials.m, { name: `sign:${key}` });
    const g2 = back.build(materials.m, { name: `signback:${key}` });
    this.group.add(g, g2);
  }

  /** Bank alarm lamp, hospital emblem, precinct blue lamps. */
  private extras(bank: BuildingSpec, hosp: BuildingSpec, prec: BuildingSpec): void {
    const f = frontOf(bank);
    const tx = -f.nz;
    const tz = f.nx;
    const y = bank.baseY + Math.min(4.6, bank.floorH * 1.05) + 0.4;
    const alarm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.2), this.alarmMat);
    alarm.position.set(f.x + f.nx * 0.35 + tx * 4.3, y, f.z + f.nz * 0.35 + tz * 4.3);
    alarm.rotation.y = Math.atan2(f.nx, f.nz);
    this.group.add(alarm);
    // Hospital: a green "H" emblem panel beside the sign.
    const h = frontOf(hosp);
    const hy = hosp.baseY + Math.min(4.6, hosp.floorH * 1.05) + 0.4;
    const em = new THREE.Group();
    const green = new THREE.MeshStandardMaterial({ color: 0x0f7a4f, emissive: new THREE.Color(0.1, 0.9, 0.5), emissiveIntensity: 0.6, roughness: 0.4 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.5 });
    em.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 0.12), green));
    for (const [w, hh, x] of [
      [0.22, 1.1, -0.35],
      [0.22, 1.1, 0.35],
      [0.7, 0.2, 0],
    ]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, hh, 0.04), white);
      bar.position.set(x, 0, 0.08);
      em.add(bar);
    }
    em.position.set(h.x + h.nx * 0.4 - h.nz * 5.6, hy, h.z + h.nz * 0.4 + h.nx * 5.6);
    em.rotation.y = Math.atan2(h.nx, h.nz);
    this.group.add(em);
    // Precinct: two blue lamps on posts by the door.
    const pf = frontOf(prec);
    const blue = new THREE.MeshStandardMaterial({ color: 0x0a1a40, emissive: new THREE.Color(0.15, 0.4, 1), emissiveIntensity: 2.5, roughness: 0.3 });
    const post = materials.m.steel_dark;
    for (const s of [-1, 1]) {
      const x = pf.x + pf.nx * 1.4 - pf.nz * s * 2.2;
      const z = pf.z + pf.nz * 1.4 + pf.nx * s * 2.2;
      const gy = heightAt(x, z) + 0.15;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.6, 8), post);
      pole.position.set(x, gy + 1.3, z);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.32), blue);
      lamp.position.set(x, gy + 2.8, z);
      this.group.add(pole, lamp);
    }
  }

  private buildWarehouse(name: string, district: District, p: THREE.Vector3): Warehouse {
    const W = 22;
    const D = 15;
    const H = 7;
    const t = 0.35;
    // Face the nearest road.
    const { lane } = laneDist(this.graph, p.x, p.z);
    let yaw = 0;
    if (lane) {
      const q = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
      const x0 = lane.xs[0];
      const z0 = lane.zs[0];
      const along = Math.max(0, Math.min(lane.length, (p.x - x0) * lane.dirX + (p.z - z0) * lane.dirZ));
      lane.sample(along, q);
      yaw = Math.atan2(q.x - p.x, q.z - p.z);
      // Snap to the street grid.
      yaw = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    }
    const y = p.y;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const local = (lx: number, lz: number) => new THREE.Vector3(p.x + lx * c + lz * s, y, p.z - lx * s + lz * c);
    const mb = new MeshBuilder();
    mb.pushTRS(p.x, y, p.z, yaw);
    const doorW = 4.4;
    const doorH = 4.2;
    const boxes: [string, number, number, number, number, number, number][] = [
      ['brick_factory', -W / 2, 0, -D / 2, W / 2, H, -D / 2 + t],
      ['brick_factory', -W / 2, 0, -D / 2, -W / 2 + t, H, D / 2],
      ['brick_factory', W / 2 - t, 0, -D / 2, W / 2, H, D / 2],
      ['brick_factory', -W / 2, 0, D / 2 - t, -doorW / 2, H, D / 2],
      ['brick_factory', doorW / 2, 0, D / 2 - t, W / 2, H, D / 2],
      ['brick_factory', -doorW / 2, doorH, D / 2 - t, doorW / 2, H, D / 2],
    ];
    // Roof with a 3 × 3 m hatch near the back-left corner.
    const hx0 = -W / 2 + 3;
    const hx1 = hx0 + 3;
    const hz0 = -D / 2 + 2.5;
    const hz1 = hz0 + 3;
    const roof: [number, number, number, number][] = [
      [-W / 2, -D / 2, W / 2, hz0],
      [-W / 2, hz1, W / 2, D / 2],
      [-W / 2, hz0, hx0, hz1],
      [hx1, hz0, W / 2, hz1],
    ];
    for (const [x0, z0, x1, z1] of roof) boxes.push(['corrugated', x0 - 0.2, H, z0 - 0.2 * (z0 === -D / 2 ? 1 : 0), x1 + 0.2, H + 0.25, z1 + 0.2 * (z1 === D / 2 ? 1 : 0)]);
    boxes.push(['concrete', -W / 2 + t, 0, -D / 2 + t, W / 2 - t, 0.1, D / 2 - t]);
    for (const b of boxes) mb.box(b[0], b[1], b[2], b[3], b[4], b[5], b[6]);
    // Hatch frame + rolled-up door + parapet trim.
    mb.box('steel_dark', hx0 - 0.15, H + 0.25, hz0 - 0.15, hx1 + 0.15, H + 0.5, hz0);
    mb.box('steel_dark', hx0 - 0.15, H + 0.25, hz1, hx1 + 0.15, H + 0.5, hz1 + 0.15);
    mb.box('shutter', -doorW / 2, doorH - 0.6, D / 2 - 0.2, doorW / 2, doorH, D / 2 - 0.05);
    mb.box('concrete', -W / 2 - 0.1, H - 0.3, D / 2, W / 2 + 0.1, H + 0.35, D / 2 + 0.12);
    // Interior: crates, shelving, the deal table, lamps.
    const crates: [number, number, number][] = [
      [-8, -4.5, 1.1],
      [-6.6, -4.6, 1.0],
      [-7.4, -4.4, 0.9],
      [7.5, -4, 1.2],
      [8, -2.4, 1.0],
      [6.5, 4.5, 1.1],
      [-8.2, 4.2, 1.0],
    ];
    for (const [cx, cz, sz] of crates) mb.box('wood', cx - sz / 2, 0.1, cz - sz / 2, cx + sz / 2, 0.1 + sz, cz + sz / 2);
    for (const sx of [-4, 4]) {
      mb.box('steel_light', sx - 2, 0.1, -D / 2 + 0.6, sx + 2, 0.15, -D / 2 + 1.6);
      for (const yy of [1.2, 2.3]) mb.box('steel_light', sx - 2, yy, -D / 2 + 0.6, sx + 2, yy + 0.05, -D / 2 + 1.6);
      for (const ex of [-2, 2]) mb.box('steel_dark', sx + ex - 0.05, 0.1, -D / 2 + 0.6, sx + ex + 0.05, 2.9, -D / 2 + 1.6);
    }
    mb.box('wood', -1, 0.82, 0.4, 1, 0.88, 1.4);
    for (const [lx, lz] of [
      [-0.9, 0.5],
      [0.9, 0.5],
      [-0.9, 1.3],
      [0.9, 1.3],
    ])
      mb.box('steel_dark', lx - 0.03, 0.1, lz - 0.03, lx + 0.03, 0.82, lz + 0.03);
    mb.box('paint_dark', -0.25, 0.88, 0.7, 0.2, 1.0, 1.0);
    mb.popTransform();
    const g = mb.build(materials.m, { name: `warehouse:${name}`, castShadow: true, receiveShadow: true });
    // Lamps (emissive panels under the roof).
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(1, 0.9, 0.7), emissiveIntensity: 2.4 });
    for (const lx of [-5.5, 0, 5.5]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.06, 0.3), lampMat);
      l.position.copy(local(lx, 0)).setY(y + H - 0.4);
      l.rotation.y = yaw;
      g.add(l);
    }
    this.group.add(g);
    // Colliders (walls, roof slabs, crates, table).
    for (const b of boxes) {
      const [, x0, y0, z0, x1, y1, z1] = b;
      const cc = local((x0 + x1) / 2, (z0 + z1) / 2);
      physics.addStaticBox(cc.x, y + (y0 + y1) / 2, cc.z, (x1 - x0) / 2, Math.max(0.05, (y1 - y0) / 2), (z1 - z0) / 2, yaw, GROUPS_WORLD);
    }
    for (const [cx, cz, sz] of crates) {
      const cc = local(cx, cz);
      physics.addStaticBox(cc.x, y + 0.1 + sz / 2, cc.z, sz / 2, sz / 2, sz / 2, yaw, GROUPS_PROP);
    }
    const tc = local(0, 0.9);
    physics.addStaticBox(tc.x, y + 0.5, tc.z, 1, 0.42, 0.5, yaw, GROUPS_PROP);
    return {
      name,
      x: p.x,
      y,
      z: p.z,
      yaw,
      district,
      door: local(0, D / 2 + 3),
      inside: local(0, 0),
      hatch: local((hx0 + hx1) / 2, (hz0 + hz1) / 2),
      table: local(0, 0.9),
      local,
      lamps: lampMat,
    };
  }

  /** A pavement point (beside a lane, kerb side) between minD and maxD of `near`. */
  streetPoint(rng: Rng, near: THREE.Vector3, minD: number, maxD: number, filter?: (d: District) => boolean): Site | null {
    const lanes = this.graph.lanesNear(near.x, near.z, maxD);
    const q = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
    for (let i = 0; i < 40 && lanes.length; i++) {
      const l = rng.pick(lanes);
      if (l.length < 20 || (filter && !filter(l.district)) || l.road.name === 'Narrows Bridge') continue;
      l.sample(rng.range(6, l.length - 6), q);
      const rx = -q.dz;
      const rz = q.dx;
      const off = l.road.width / 2 - l.offset + 2.0;
      const x = q.x + rx * off;
      const z = q.z + rz * off;
      const d = Math.hypot(x - near.x, z - near.z);
      if (d < minD || d > maxD) continue;
      return { x, y: heightAt(x, z) + 0.15, z, yaw: Math.atan2(-rx, -rz), district: l.district };
    }
    return null;
  }

  /** A kerbside parking spot (in the outer lane, against the kerb), heading along the lane. */
  parkingSpot(rng: Rng, near: THREE.Vector3, minD: number, maxD: number, filter?: (d: District) => boolean): Site | null {
    const lanes = this.graph.lanesNear(near.x, near.z, maxD);
    const q = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
    for (let i = 0; i < 40 && lanes.length; i++) {
      const l = rng.pick(lanes);
      if (l.length < 30 || l.idx !== l.lanes - 1 || (filter && !filter(l.district)) || l.road.name === 'Narrows Bridge') continue;
      l.sample(rng.range(10, l.length - 10), q);
      const rx = -q.dz;
      const rz = q.dx;
      const off = l.road.width / 2 - l.offset - 1.25;
      const x = q.x + rx * off;
      const z = q.z + rz * off;
      const d = Math.hypot(x - near.x, z - near.z);
      if (d < minD || d > maxD) continue;
      return { x, y: heightAt(x, z), z, yaw: Math.atan2(q.dx, q.dz), district: l.district };
    }
    return null;
  }

  /** Respawn / map points. */
  get landmarks(): { x: number; z: number; kind: 'hospital' | 'precinct' | 'bank'; label: string }[] {
    return [
      { x: this.hospital.x, z: this.hospital.z, kind: 'hospital', label: 'Port Vellmoor General Hospital' },
      { x: this.precinct.x, z: this.precinct.z, kind: 'precinct', label: 'VPD Precinct 1' },
      { x: this.bank.x, z: this.bank.z, kind: 'bank', label: 'Brightwater Savings Bank' },
    ];
  }

  get cityData(): CityData {
    return this.city;
  }
}

function findClearSpotAway(graph: LaneGraph, x: number, z: number, avoid: { x: number; z: number }[]): THREE.Vector3 {
  // Spiral candidates from findClearSpot's pattern, rejecting points near roads / hangouts.
  for (let i = 0; i < 400; i += 7) {
    const a = i * 2.4;
    const r = Math.sqrt(i) * 6;
    const cx = x + Math.cos(a) * r;
    const cz = z + Math.sin(a) * r;
    if (laneDist(graph, cx, cz).d < 24) continue;
    if (avoid.some((p) => Math.hypot(p.x - cx, p.z - cz) < 45)) continue;
    const p = findClearSpot(cx, cz, 12, 6);
    if (Math.hypot(p.x - cx, p.z - cz) < 12 && laneDist(graph, p.x, p.z).d > 22) return p;
  }
  return findClearSpot(x, z, 12);
}
