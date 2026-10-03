/**
 * Terrain: analytic land mask + height function, baked into a heightfield shared by
 * rendering (chunk meshes), physics (Rapier heightfield) and the water shader (depth).
 */
import * as THREE from 'three';
import { fbm2 } from '../core/Random';
import { RAPIER, physics, GROUPS_WORLD } from '../core/Physics';
import { CITY_HALF, COAST_CORNER, GROUND, ISLAND, LAKE, PARK, PIERS, TERRAIN, BRIDGE } from './WorldConfig';

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 0 = engineered seawall coast, 1 = natural beach coast. */
export function naturalCoast(x: number, z: number): number {
  if (x > CITY_HALF + 200) return 1; // island beaches
  return smooth(-140, -320, z);
}

function roundedRectSdf(x: number, z: number, half: number, r: number): number {
  const qx = Math.abs(x) - (half - r);
  const qz = Math.abs(z) - (half - r);
  const ox = Math.max(qx, 0);
  const oz = Math.max(qz, 0);
  const outside = Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0) - r;
  return -outside;
}

function boxSdf(x: number, z: number, minX: number, maxX: number, minZ: number, maxZ: number): number {
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const qx = Math.abs(x - cx) - (maxX - minX) / 2;
  const qz = Math.abs(z - cz) - (maxZ - minZ) / 2;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
  return -outside;
}

/** Signed distance-ish to the coastline, positive on land. */
export function landSdf(x: number, z: number): number {
  const nat = naturalCoast(x, z);
  let city = roundedRectSdf(x, z, CITY_HALF, COAST_CORNER + nat * 90);
  if (nat > 0) city += nat * (fbm2(x / 180, z / 180, 3, 11) * 34 + fbm2(x / 55, z / 55, 2, 12) * 6);
  let sd = city;
  for (const [a, b, c, d] of PIERS) sd = Math.max(sd, boxSdf(x, z, a, b, c, d));
  const ex = (x - ISLAND.x) / ISLAND.rx;
  const ez = (z - ISLAND.z) / ISLAND.rz;
  const er = Math.hypot(ex, ez);
  const island = (1 - er) * Math.min(ISLAND.rx, ISLAND.rz) + fbm2(x / 160, z / 160, 3, 21) * 30;
  sd = Math.max(sd, island);
  return sd;
}

function hills(x: number, z: number): number {
  if (z > -280) return 0;
  const n = 0.68 + 0.32 * fbm2(x / 240, z / 240, 3, 31);
  return 30 * smooth(-290, -540, z) * (1 - 0.5 * smooth(-610, -770, z)) * n * (1 - smooth(260, 430, x));
}

function lakeCut(x: number, z: number): number {
  const d = Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz);
  if (d > 1.3) return 0;
  return 3.4 * smooth(1.3, 0.8, d);
}

/** Inland ground height before coastal shaping. */
function inland(x: number, z: number): number {
  if (x > CITY_HALF + 200) return 3.0;
  let h = GROUND + hills(x, z);
  if (x > PARK.minX - 20 && z < PARK.maxZ + 20) {
    h += 1.4 * fbm2(x / 90, z / 90, 2, 41) * smooth(PARK.minX, PARK.minX + 40, x) * smooth(PARK.maxZ, PARK.maxZ - 40, z);
    h -= lakeCut(x, z);
  }
  return h;
}

/** Analytic terrain height (use `heightAt` for the baked, physics-consistent value). */
export function analyticHeight(x: number, z: number): number {
  const sd = landSdf(x, z);
  const nat = naturalCoast(x, z);
  const base = inland(x, z);
  if (sd >= 0) {
    const beachW = 22 + Math.max(0, base - GROUND) * 3;
    const t = smooth(0, beachW, sd);
    const natural = 0.5 + (base - 0.5) * t;
    return base + (natural - base) * nat;
  }
  const wall = -9;
  const natSea = Math.max(-14, 0.5 + sd * 0.11);
  return wall + (natSea - wall) * nat;
}

class Heightfield {
  readonly nx: number;
  readonly nz: number;
  readonly data: Float32Array;
  constructor() {
    this.nx = Math.round((TERRAIN.maxX - TERRAIN.minX) / TERRAIN.cell) + 1;
    this.nz = Math.round((TERRAIN.maxZ - TERRAIN.minZ) / TERRAIN.cell) + 1;
    this.data = new Float32Array(this.nx * this.nz);
  }
  bake(): void {
    for (let j = 0; j < this.nz; j++) {
      const z = TERRAIN.minZ + j * TERRAIN.cell;
      for (let i = 0; i < this.nx; i++) {
        const x = TERRAIN.minX + i * TERRAIN.cell;
        this.data[j * this.nx + i] = analyticHeight(x, z);
      }
    }
    // Keep the bridge approach embankments and lake edge as-is; flatten the island runway zone.
    void BRIDGE;
  }
  get(i: number, j: number): number {
    i = Math.min(this.nx - 1, Math.max(0, i));
    j = Math.min(this.nz - 1, Math.max(0, j));
    return this.data[j * this.nx + i];
  }
  /** Bilinear sample matching the rendered terrain mesh. */
  sample(x: number, z: number): number {
    const fx = (x - TERRAIN.minX) / TERRAIN.cell;
    const fz = (z - TERRAIN.minZ) / TERRAIN.cell;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    // Match Rapier's triangle split (anti-diagonal from (i+1,j) to (i,j+1)); the mesh uses the same.
    const h10 = this.get(i + 1, j);
    const h01 = this.get(i, j + 1);
    if (u + v <= 1) {
      const h00 = this.get(i, j);
      return h00 + (h10 - h00) * u + (h01 - h00) * v;
    }
    const h11 = this.get(i + 1, j + 1);
    return h11 + (h01 - h11) * (1 - u) + (h10 - h11) * (1 - v);
  }
}

export const heightfield = new Heightfield();

/** Baked terrain height at (x, z). */
export function heightAt(x: number, z: number): number {
  return heightfield.sample(x, z);
}

/** Create the static Rapier heightfield collider. */
export function createTerrainCollider(): void {
  const hf = heightfield;
  // Rapier: rows along Z, columns along X, column-major heights.
  const nrows = hf.nz - 1;
  const ncols = hf.nx - 1;
  const heights = new Float32Array(hf.nx * hf.nz);
  for (let i = 0; i < hf.nx; i++) {
    for (let j = 0; j < hf.nz; j++) heights[i * hf.nz + j] = hf.data[j * hf.nx + i];
  }
  const sx = (hf.nx - 1) * TERRAIN.cell;
  const sz = (hf.nz - 1) * TERRAIN.cell;
  const desc = RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, { x: sx, y: 1, z: sz })
    .setTranslation(TERRAIN.minX + sx / 2, 0, TERRAIN.minZ + sz / 2)
    .setCollisionGroups(GROUPS_WORLD)
    .setFriction(1.0);
  physics.world.createCollider(desc);
}

/** Half-float texture of terrain heights for the water shader (shore depth / foam). */
export function createHeightTexture(): THREE.DataTexture {
  const hf = heightfield;
  const w = Math.ceil(hf.nx / 2);
  const h = Math.ceil(hf.nz / 2);
  const data = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) data[j * w + i] = hf.get(i * 2, j * 2);
  const tex = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Terrain surface splat weights: r = grass, g = sand, b = rock/dirt. */
export function terrainSplat(x: number, z: number, h: number, slope: number): [number, number, number] {
  const nat = naturalCoast(x, z);
  let sand = 0;
  if (h < 3.2 && nat > 0.2) sand = smooth(3.4, 1.4, h);
  if (x > CITY_HALF + 200 && h < 3.6) sand = Math.max(sand, smooth(3.6, 2.2, h));
  const lakeD = Math.hypot((x - LAKE.x) / LAKE.rx, (z - LAKE.z) / LAKE.rz);
  if (lakeD < 1.3) sand = Math.max(sand, smooth(1.3, 1.05, lakeD) * 0.8);
  const rock = smooth(0.35, 0.7, slope);
  const grass = Math.max(0, 1 - sand - rock);
  return [grass, sand, rock];
}
