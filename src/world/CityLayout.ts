/**
 * Port Vellmoor street plan and content placement — pure data, fully deterministic.
 * Geometry is built later per chunk from these specs (see BuildingGen / RoadGen / Props).
 */
import { Rng, rngFor, strHash } from '../core/Random';
import { heightAt, landSdf } from './Terrain';
import { BRIDGE, CITY_HALF, FORCED_X, FORCED_Z, GROUND, KERB, LAKE, LIGHTHOUSE, PARK, PIERS, districtAt, type District } from './WorldConfig';

export type RoadKind = 'arterial' | 'avenue' | 'street' | 'lane';

export interface RoadSeg {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** 'x' = runs along X (east-west), 'z' = runs along Z (north-south). */
  axis: 'x' | 'z';
  width: number;
  kind: RoadKind;
  surface: 'asphalt' | 'cobble';
  name: string;
}

export interface RoadNode {
  x: number;
  z: number;
  n?: RoadSeg;
  s?: RoadSeg;
  e?: RoadSeg;
  w?: RoadSeg;
  /** Half-size of the junction box along X / Z. */
  hx: number;
  hz: number;
  arms: number;
  signal: boolean;
}

export interface Block {
  /** Kerb rectangle (outer edge of the pavement). */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  sidewalk: number;
  district: District;
  kind: 'buildings' | 'plaza' | 'square' | 'railyard' | 'containers' | 'gardens';
  /** Which sides border a road (for lamps / frontage). */
  roadN: boolean;
  roadS: boolean;
  roadE: boolean;
  roadW: boolean;
  y: number;
}

export type BuildingStyle = 'glass' | 'office' | 'brick' | 'stone' | 'plaster' | 'warehouse' | 'factory' | 'house' | 'hangar' | 'terminal';
export type Side = 'n' | 's' | 'e' | 'w';

export interface Tier {
  w: number;
  d: number;
  h: number;
}

export interface BuildingSpec {
  id: number;
  style: BuildingStyle;
  cx: number;
  cz: number;
  w: number;
  d: number;
  baseY: number;
  floorH: number;
  floors: number;
  height: number;
  seed: number;
  front: Side;
  /** Sides that touch a neighbouring building (no windows). */
  party: Side[];
  roof: 'flat' | 'gable' | 'hip' | 'sawtooth' | 'barrel';
  wall: string;
  trim: string;
  tint: [number, number, number];
  shop: boolean;
  tiers: Tier[];
  district: District;
}

export interface PropSpec {
  type: string;
  x: number;
  z: number;
  y: number;
  yaw: number;
  s?: number;
  v?: number;
}

export interface Feature {
  type: string;
  x: number;
  z: number;
  y: number;
  yaw: number;
  p?: Record<string, number>;
}

export interface PathSpec {
  pts: [number, number][];
  width: number;
}

export interface CityData {
  xs: number[];
  zs: number[];
  roads: RoadSeg[];
  nodes: RoadNode[];
  blocks: Block[];
  buildings: BuildingSpec[];
  props: PropSpec[];
  features: Feature[];
  paths: PathSpec[];
  carSpots: { x: number; z: number; yaw: number }[];
  spawn: { x: number; z: number; yaw: number };
}

const NS_NAMES = ['Harrow', 'Calder', 'Wrenfield', 'Ashby', 'Marlow', 'Pellham', 'Corvin', 'Tollard', 'Brinley', 'Quill', 'Fenwick', 'Larch', 'Ostrey', 'Dunmore', 'Vale'];
const EW_NAMES = ['Kestrel', 'Lantern', 'Gullwing', 'Saltmarsh', 'Merrow', 'Tidewell', 'Copper', 'Halyard', 'Bramble', 'Sextant', 'Rook', 'Anchor', 'Linden', 'Foundry'];

function buildLines(forced: number[], rng: Rng): number[] {
  const out: number[] = [];
  for (let i = 0; i < forced.length - 1; i++) {
    const a = forced[i];
    const b = forced[i + 1];
    out.push(a);
    const n = Math.max(1, Math.round((b - a) / 128));
    const step = (b - a) / n;
    for (let k = 1; k < n; k++) out.push(Math.round(a + step * k + rng.range(-0.12, 0.12) * step));
  }
  out.push(forced[forced.length - 1]);
  return out;
}

const inPark = (x: number, z: number) => x > PARK.minX + 1 && x < PARK.maxX + 1 && z > PARK.minZ - 1 && z < PARK.maxZ - 1;

export function generateCity(): CityData {
  const rng = rngFor(strHash('layout'));
  const xs = buildLines(FORCED_X, rng);
  const zs = buildLines(FORCED_Z, rng);
  // The Midtown avenue: grid line closest to x=150.
  const avenueX = xs.reduce((best, x) => (Math.abs(x - 150) < Math.abs(best - 150) ? x : best), xs[0]);

  const lineWidthX = (x: number): number => {
    if (x === avenueX) return 22;
    if (x === -230 || x === 20) return 16;
    if (Math.abs(x) === 722) return 13;
    return x < -230 ? 11 : 13;
  };
  const lineWidthZ = (z: number): number => {
    if (z === BRIDGE.z) return 18;
    if (z === 240 || z === -270) return 16;
    if (Math.abs(z) === 722) return 13;
    return 13;
  };
  const kindOf = (w: number): RoadKind => (w >= 20 ? 'avenue' : w >= 16 ? 'arterial' : w >= 9 ? 'street' : 'lane');

  // ---------------------------------------------------------------- primary segments
  let roads: RoadSeg[] = [];
  const keepSeg = (x0: number, z0: number, x1: number, z1: number): boolean => {
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    if (inPark(mx, mz) && mx > PARK.minX + 1 && mz < PARK.maxZ - 1) return false;
    if (landSdf(x0, z0) < 22 || landSdf(x1, z1) < 22 || landSdf(mx, mz) < 22) return false;
    // Bridge approach occupies z=BRIDGE.z east of startX.
    if (z0 === z1 && z0 === BRIDGE.z && mx > BRIDGE.startX) return false;
    return true;
  };
  for (const x of xs) {
    for (let j = 0; j < zs.length - 1; j++) {
      const z0 = zs[j];
      const z1 = zs[j + 1];
      if (!keepSeg(x, z0, x, z1)) continue;
      const w = lineWidthX(x);
      const old = x < -230 && z0 >= -270 && z1 <= 240;
      roads.push({ x0: x, z0, x1: x, z1, axis: 'z', width: w, kind: kindOf(w), surface: old && w < 13 ? 'cobble' : 'asphalt', name: `${NS_NAMES[xs.indexOf(x) % NS_NAMES.length]} ${w >= 16 ? 'Avenue' : 'Street'}` });
    }
  }
  for (const z of zs) {
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      if (!keepSeg(x0, z, x1, z)) continue;
      const w = lineWidthZ(z);
      roads.push({ x0, z0: z, x1, z1: z, axis: 'x', width: w, kind: kindOf(w), surface: 'asphalt', name: `${EW_NAMES[zs.indexOf(z) % EW_NAMES.length]} ${w >= 16 ? 'Road' : 'Street'}` });
    }
  }

  // ---------------------------------------------------------------- cells, lanes & blocks
  const segAt = (axis: 'x' | 'z', line: number, a: number, b: number): RoadSeg | undefined =>
    roads.find((r) => r.axis === axis && (axis === 'z' ? r.x0 === line && r.z0 <= a + 0.1 && r.z1 >= b - 0.1 : r.z0 === line && r.x0 <= a + 0.1 && r.x1 >= b - 0.1));

  interface Cell {
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    hw: { n: number; s: number; e: number; w: number };
  }
  const cells: Cell[] = [];
  const lanes: RoadSeg[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const z0 = zs[j];
      const z1 = zs[j + 1];
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      if (inPark(cx, cz)) continue;
      if (landSdf(cx, cz) < 40) continue;
      const ramp = (z: number) => (z === BRIDGE.z && x0 >= BRIDGE.startX ? BRIDGE.width + 4 : 0);
      const hw = {
        n: (segAt('x', z0, x0, x1)?.width ?? ramp(z0)) / 2,
        s: (segAt('x', z1, x0, x1)?.width ?? ramp(z1)) / 2,
        w: (segAt('z', x0, z0, z1)?.width ?? 0) / 2,
        e: (segAt('z', x1, z0, z1)?.width ?? 0) / 2,
      };
      const d = districtAt(cx, cz);
      const crng = rngFor(i, j, 77);
      const W = x1 - x0;
      const D = z1 - z0;
      const wantsLane = (d === 'oldtown' && Math.max(W, D) > 95) || (d === 'hills' && Math.max(W, D) > 120);
      if (wantsLane) {
        const lw = d === 'oldtown' ? 7.5 : 9;
        const surface = d === 'oldtown' ? 'cobble' : 'asphalt';
        const name = d === 'oldtown' ? `${NS_NAMES[(i + j) % NS_NAMES.length]} Lane` : `${EW_NAMES[(i * 3 + j) % EW_NAMES.length]} Close`;
        if (W >= D) {
          const lx = Math.round(x0 + W * crng.range(0.42, 0.58));
          const lane: RoadSeg = { x0: lx, z0, x1: lx, z1, axis: 'z', width: lw, kind: 'lane', surface, name };
          if (hw.n > 0 && hw.s > 0) {
            lanes.push(lane);
            cells.push({ x0, x1: lx, z0, z1, hw: { ...hw, e: lw / 2 } });
            cells.push({ x0: lx, x1, z0, z1, hw: { ...hw, w: lw / 2 } });
            continue;
          }
        } else {
          const lz = Math.round(z0 + D * crng.range(0.42, 0.58));
          const lane: RoadSeg = { x0, z0: lz, x1, z1: lz, axis: 'x', width: lw, kind: 'lane', surface, name };
          if (hw.w > 0 && hw.e > 0) {
            lanes.push(lane);
            cells.push({ x0, x1, z0, z1: lz, hw: { ...hw, s: lw / 2 } });
            cells.push({ x0, x1, z0: lz, z1, hw: { ...hw, n: lw / 2 } });
            continue;
          }
        }
      }
      cells.push({ x0, x1, z0, z1, hw });
    }
  }
  roads = splitAtJunctions([...roads, ...lanes]);
  const nodes = buildNodes(roads);

  const blocks: Block[] = [];
  for (const c of cells) {
    const cx = (c.x0 + c.x1) / 2;
    const cz = (c.z0 + c.z1) / 2;
    const district = districtAt(cx, cz);
    const sidewalk = district === 'midtown' ? 5 : district === 'oldtown' ? 3.2 : district === 'hills' ? 2.6 : 3.5;
    const b: Block = {
      minX: c.x0 + c.hw.w,
      maxX: c.x1 - c.hw.e,
      minZ: c.z0 + c.hw.n,
      maxZ: c.z1 - c.hw.s,
      sidewalk,
      district,
      kind: 'buildings',
      roadN: c.hw.n > 0,
      roadS: c.hw.s > 0,
      roadW: c.hw.w > 0,
      roadE: c.hw.e > 0,
      y: heightAt(cx, cz) + KERB,
    };
    if (b.maxX - b.minX < 20 || b.maxZ - b.minZ < 20) continue;
    blocks.push(b);
  }

  const data: CityData = {
    xs,
    zs,
    roads,
    nodes,
    blocks,
    buildings: [],
    props: [],
    features: [],
    paths: [],
    carSpots: [],
    spawn: { x: 0, z: 0, yaw: 0 },
  };
  const ctx = new Ctx(data);
  // Special blocks.
  const square = nearestBlock(blocks, -470, -20, 'oldtown');
  if (square) square.kind = 'square';
  const rail = nearestBlock(blocks, -380, 420, 'industrial');
  if (rail) rail.kind = 'railyard';
  for (const b of blocks.filter((bb) => bb.district === 'harbour' && bb.minZ > 450)) b.kind = 'containers';

  for (const b of blocks) fillBlock(ctx, b);
  streetFurniture(ctx);
  park(ctx);
  coast(ctx);
  // Spawn on Midtown avenue near the bridge road; three parked sedans nearby & elsewhere.
  const spawnNode = nodes.reduce((best, n) => (Math.hypot(n.x - avenueX, n.z - BRIDGE.z) < Math.hypot(best.x - avenueX, best.z - BRIDGE.z) ? n : best), nodes[0]);
  data.spawn = { x: spawnNode.x + spawnNode.hx + 7, z: spawnNode.z + spawnNode.hz + 9, yaw: Math.PI * 0.9 };
  data.carSpots = [
    { x: spawnNode.x + 4.2, z: spawnNode.z + spawnNode.hz + 16, yaw: Math.PI },
    { x: -455, z: -20 + 34, yaw: Math.PI / 2 },
    { x: 300, z: 718, yaw: 0 },
  ];
  return data;
}

function nearestBlock(blocks: Block[], x: number, z: number, d: District): Block | undefined {
  let best: Block | undefined;
  let bd = Infinity;
  for (const b of blocks) {
    if (b.district !== d) continue;
    const dd = Math.hypot((b.minX + b.maxX) / 2 - x, (b.minZ + b.maxZ) / 2 - z);
    if (dd < bd) {
      bd = dd;
      best = b;
    }
  }
  return best;
}

/** Split axis-aligned segments wherever another segment's endpoint lies on them. */
function splitAtJunctions(segs: RoadSeg[]): RoadSeg[] {
  const out: RoadSeg[] = [];
  for (const s of segs) {
    const cuts: number[] = [];
    for (const o of segs) {
      if (o === s) continue;
      for (const [px, pz] of [
        [o.x0, o.z0],
        [o.x1, o.z1],
      ]) {
        if (s.axis === 'x' && Math.abs(pz - s.z0) < 0.01 && px > s.x0 + 0.01 && px < s.x1 - 0.01) cuts.push(px);
        if (s.axis === 'z' && Math.abs(px - s.x0) < 0.01 && pz > s.z0 + 0.01 && pz < s.z1 - 0.01) cuts.push(pz);
      }
    }
    if (!cuts.length) {
      out.push(s);
      continue;
    }
    const sorted = [...new Set(cuts)].sort((a, b) => a - b);
    let a = s.axis === 'x' ? s.x0 : s.z0;
    for (const c of [...sorted, s.axis === 'x' ? s.x1 : s.z1]) {
      out.push(s.axis === 'x' ? { ...s, x0: a, x1: c } : { ...s, z0: a, z1: c });
      a = c;
    }
  }
  return out;
}

function buildNodes(roads: RoadSeg[]): RoadNode[] {
  const map = new Map<string, RoadNode>();
  const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
  const get = (x: number, z: number) => {
    const k = key(x, z);
    let n = map.get(k);
    if (!n) {
      n = { x, z, hx: 0, hz: 0, arms: 0, signal: false };
      map.set(k, n);
    }
    return n;
  };
  for (const r of roads) {
    const a = get(r.x0, r.z0);
    const b = get(r.x1, r.z1);
    if (r.axis === 'x') {
      a.e = r;
      b.w = r;
    } else {
      a.s = r;
      b.n = r;
    }
  }
  for (const n of map.values()) {
    n.arms = +!!n.n + +!!n.s + +!!n.e + +!!n.w;
    const ns = Math.max(n.n?.width ?? 0, n.s?.width ?? 0);
    const ew = Math.max(n.e?.width ?? 0, n.w?.width ?? 0);
    const cross = (n.n || n.s) && (n.e || n.w);
    n.hx = cross ? ns / 2 : 0;
    n.hz = cross ? ew / 2 : 0;
    const major = [n.n, n.s, n.e, n.w].filter((r) => r && r.kind !== 'lane').length;
    n.signal = !!cross && n.arms >= 3 && major >= 3;
  }
  return [...map.values()];
}

// ------------------------------------------------------------------ block filling

class Ctx {
  nextId = 1;
  constructor(readonly data: CityData) {}
  building(b: Omit<BuildingSpec, 'id' | 'baseY'> & { baseY?: number }): BuildingSpec {
    const hw = b.w / 2;
    const hd = b.d / 2;
    const ys = [heightAt(b.cx - hw, b.cz - hd), heightAt(b.cx + hw, b.cz - hd), heightAt(b.cx - hw, b.cz + hd), heightAt(b.cx + hw, b.cz + hd)];
    const spec: BuildingSpec = { ...b, id: this.nextId++, baseY: b.baseY ?? Math.min(...ys) + KERB };
    this.data.buildings.push(spec);
    return spec;
  }
  prop(type: string, x: number, z: number, yaw = 0, extra: Partial<PropSpec> = {}): void {
    this.data.props.push({ type, x, z, y: extra.y ?? heightAt(x, z) + KERB, yaw, ...extra });
  }
  feature(type: string, x: number, z: number, yaw = 0, p?: Record<string, number>, y?: number): void {
    this.data.features.push({ type, x, z, y: y ?? heightAt(x, z), yaw, p });
  }
}

const TINTS = {
  brick: [
    [1, 1, 1],
    [0.92, 0.86, 0.82],
    [1.05, 0.95, 0.9],
  ],
  plaster: [
    [0.96, 0.9, 0.78],
    [0.86, 0.9, 0.92],
    [0.95, 0.82, 0.74],
    [0.82, 0.88, 0.8],
    [0.98, 0.96, 0.92],
    [0.9, 0.8, 0.68],
  ],
  house: [
    [0.97, 0.95, 0.9],
    [0.86, 0.9, 0.93],
    [0.94, 0.86, 0.74],
    [0.8, 0.86, 0.8],
    [0.95, 0.9, 0.84],
    [0.74, 0.8, 0.86],
  ],
} as const;

function fillBlock(ctx: Ctx, b: Block): void {
  const rng = rngFor(Math.round(b.minX), Math.round(b.minZ), 501);
  const inner = { minX: b.minX + b.sidewalk, maxX: b.maxX - b.sidewalk, minZ: b.minZ + b.sidewalk, maxZ: b.maxZ - b.sidewalk };
  const W = inner.maxX - inner.minX;
  const D = inner.maxZ - inner.minZ;
  const cx = (inner.minX + inner.maxX) / 2;
  const cz = (inner.minZ + inner.maxZ) / 2;
  switch (b.district) {
    case 'midtown': {
      if (rng.chance(0.13) && W < 120) {
        b.kind = 'plaza';
        ctx.feature('fountain', cx, cz, 0, { r: 6 });
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          ctx.prop('tree', cx + Math.cos(a) * Math.min(W, D) * 0.33, cz + Math.sin(a) * Math.min(W, D) * 0.33, rng.range(0, 6));
          ctx.prop('bench', cx + Math.cos(a + 0.4) * 11, cz + Math.sin(a + 0.4) * 11, -a + Math.PI / 2);
        }
        ctx.prop('planter', cx + 14, cz - 14, 0);
        ctx.prop('planter', cx - 14, cz + 14, 0);
        break;
      }
      const lots = W > 85 && rng.chance(0.6) ? 2 : 1;
      for (let l = 0; l < lots; l++) {
        const lx0 = inner.minX + (W / lots) * l;
        const lx1 = lx0 + W / lots;
        const setback = rng.range(0, 4);
        let w = Math.min(lx1 - lx0 - setback * 2 - (lots > 1 ? 4 : 0), 58);
        let d = Math.min(D - setback * 2, 58);
        w = Math.max(w, 18);
        d = Math.max(d, 18);
        const bx = (lx0 + lx1) / 2;
        const dist = Math.hypot(bx - 120, cz + 20);
        const height = Math.max(28, (45 + 190 * Math.exp(-(dist * dist) / (2 * 230 * 230))) * rng.range(0.55, 1.15));
        const glass = rng.chance(0.55);
        const floorH = glass ? 3.9 : 3.7;
        const floors = Math.max(6, Math.round(height / floorH));
        const tiers: Tier[] = [];
        if (floors * floorH > 90 && rng.chance(0.7)) {
          tiers.push({ w: w * rng.range(0.72, 0.86), d: d * rng.range(0.72, 0.86), h: floors * floorH * rng.range(0.55, 0.7) });
          if (rng.chance(0.5)) tiers.push({ w: w * 0.55, d: d * 0.55, h: floors * floorH * rng.range(0.82, 0.9) });
        }
        ctx.building({
          style: glass ? 'glass' : 'office',
          cx: bx,
          cz,
          w,
          d,
          floorH,
          floors,
          height: floors * floorH,
          seed: rng.int(0, 1e9),
          front: 's',
          party: [],
          roof: 'flat',
          wall: glass ? 'steel_light' : rng.pick(['concrete', 'stone', 'concrete_panels', 'granite']),
          trim: glass ? 'steel_dark' : 'concrete',
          tint: glass ? [1, 1, 1] : rng.pick([[1, 1, 1], [0.95, 0.93, 0.9], [0.88, 0.9, 0.93]] as [number, number, number][]),
          shop: rng.chance(0.6),
          tiers,
          district: 'midtown',
        });
        // Forecourt trees & benches.
        if (setback > 2.5) {
          ctx.prop('planter', bx - w / 2 + 2, cz + d / 2 + setback * 0.5, 0);
          ctx.prop('bench', bx + w / 4, cz + d / 2 + setback * 0.6, 0);
        }
      }
      break;
    }
    case 'oldtown': {
      if (b.kind === 'square') {
        ctx.feature('clocktower', cx, cz, 0);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          ctx.prop('tree', cx + Math.cos(a) * W * 0.36, cz + Math.sin(a) * D * 0.36, rng.range(0, 6));
          ctx.prop('bench', cx + Math.cos(a) * 16, cz + Math.sin(a) * 16, -a - Math.PI / 2);
          ctx.prop('lamp_park', cx + Math.cos(a + 0.4) * 20, cz + Math.sin(a + 0.4) * 20, 0);
        }
        ctx.feature('fountain', cx + W * 0.28, cz - D * 0.25, 0, { r: 4 });
        break;
      }
      terraces(ctx, b, inner, rng, 'oldtown');
      break;
    }
    case 'harbour': {
      if (b.kind === 'containers') {
        containerYard(ctx, inner, rng);
        break;
      }
      const n = W > 90 ? 2 : 1;
      let maxWd = 0;
      for (let i = 0; i < n; i++) {
        const lx0 = inner.minX + (W / n) * i + 3;
        const lw = W / n - 6;
        const wd = Math.min(D - 10, rng.range(26, 40));
        maxWd = Math.max(maxWd, wd);
        ctx.building({
          style: 'warehouse',
          cx: lx0 + lw / 2,
          cz: inner.minZ + 4 + wd / 2,
          w: lw,
          d: wd,
          floorH: 5,
          floors: 2,
          height: rng.range(9, 13),
          seed: rng.int(0, 1e9),
          front: 'n',
          party: [],
          roof: 'gable',
          wall: 'corrugated',
          trim: 'steel_dark',
          tint: rng.pick([[0.62, 0.7, 0.75], [0.75, 0.42, 0.32], [0.82, 0.8, 0.74], [0.45, 0.58, 0.5]] as [number, number, number][]),
          shop: false,
          tiers: [],
          district: 'harbour',
        });
      }
      // Yard behind the sheds: container stacks, crates and a harbour office.
      const yard = { minX: inner.minX, maxX: inner.maxX, minZ: inner.minZ + 4 + maxWd + 8, maxZ: inner.maxZ };
      if (yard.maxZ - yard.minZ > 16) {
        const officeW = Math.min(22, W * 0.3);
        if (yard.maxZ - yard.minZ > 22 && rng.chance(0.6)) {
          const of = rng.int(2, 4);
          ctx.building({
            style: 'brick',
            cx: yard.maxX - officeW / 2 - 2,
            cz: yard.maxZ - 8,
            w: officeW,
            d: 13,
            floorH: 3.6,
            floors: of,
            height: 3.6 * 1.18 + (of - 1) * 3.6,
            seed: rng.int(0, 1e9),
            front: 's',
            party: [],
            roof: 'flat',
            wall: rng.pick(['brick_red', 'brick_brown']),
            trim: 'concrete',
            tint: [1, 1, 1],
            shop: false,
            tiers: [],
            district: 'harbour',
          });
          yard.maxX -= officeW + 6;
        }
        containerYard(ctx, yard, rng);
      }
      for (let k = 0; k < 6; k++) ctx.prop(rng.chance(0.5) ? 'crate' : 'barrel', rng.range(inner.minX + 3, inner.maxX - 3), inner.minZ + 4 + maxWd + rng.range(1.5, 5), rng.range(0, 6));
      break;
    }
    case 'industrial': {
      if (b.kind === 'railyard') {
        ctx.feature('railyard', cx, cz, 0, { w: W, d: D });
        break;
      }
      const fw = Math.min(W - 10, rng.range(45, 85));
      const fd = Math.min(D - 14, rng.range(32, 60));
      const fx = inner.minX + 5 + fw / 2;
      const fz = inner.minZ + 6 + fd / 2;
      ctx.building({
        style: 'factory',
        cx: fx,
        cz: fz,
        w: fw,
        d: fd,
        floorH: 6,
        floors: 2,
        height: rng.range(11, 17),
        seed: rng.int(0, 1e9),
        front: 'n',
        party: [],
        roof: rng.chance(0.6) ? 'sawtooth' : 'flat',
        wall: rng.chance(0.65) ? 'brick_factory' : 'concrete_panels',
        trim: 'concrete',
        tint: [1, 1, 1],
        shop: false,
        tiers: [],
        district: 'industrial',
      });
      const spareX = inner.maxX - (fx + fw / 2);
      if (rng.chance(0.75)) ctx.feature('chimney', fx + fw / 2 - 6, fz - fd / 2 + 6, 0, { h: rng.range(30, 52), r: rng.range(1.6, 2.6) }, undefined);
      if (spareX > 14) {
        const tx = fx + fw / 2 + spareX / 2;
        ctx.feature('tank', tx, fz - fd / 4, 0, { r: Math.min(6, spareX / 2 - 2), h: rng.range(8, 14) });
        if (D > 70) ctx.feature('tank', tx, fz + fd / 4, 0, { r: Math.min(5, spareX / 2 - 2), h: rng.range(7, 12) });
      }
      const backD = inner.maxZ - (fz + fd / 2) - 8;
      if (backD > 14) {
        const sd = Math.min(backD - 4, rng.range(16, 26));
        ctx.building({
          style: 'warehouse',
          cx: inner.minX + 5 + (W - 10) * 0.35,
          cz: inner.maxZ - 4 - sd / 2,
          w: (W - 10) * 0.7,
          d: sd,
          floorH: 5,
          floors: 2,
          height: rng.range(8, 11),
          seed: rng.int(0, 1e9),
          front: 'n',
          party: [],
          roof: 'gable',
          wall: 'corrugated',
          trim: 'steel_dark',
          tint: rng.pick([[0.55, 0.58, 0.6], [0.7, 0.66, 0.55], [0.5, 0.55, 0.62]] as [number, number, number][]),
          shop: false,
          tiers: [],
          district: 'industrial',
        });
      }
      for (let k = 0; k < 8; k++) ctx.prop(rng.chance(0.5) ? 'barrel' : 'crate', rng.range(inner.minX + 3, inner.maxX - 3), fz + fd / 2 + rng.range(2, 6), rng.range(0, 6));
      ctx.prop('utility_box', inner.minX + 1.5, inner.maxZ - 2, 0);
      break;
    }
    case 'hills': {
      houses(ctx, b, inner, rng);
      break;
    }
    default:
      break;
  }
}

/** Old Town perimeter blocks: rows of attached buildings around a courtyard. */
function terraces(ctx: Ctx, b: Block, r: { minX: number; maxX: number; minZ: number; maxZ: number }, rng: Rng, district: District): void {
  const depth = rng.range(11, 14);
  const W = r.maxX - r.minX;
  const D = r.maxZ - r.minZ;
  const rows: { side: Side; a0: number; a1: number }[] = [
    { side: 'n', a0: r.minX, a1: r.maxX },
    { side: 's', a0: r.minX, a1: r.maxX },
  ];
  if (D > depth * 2 + 6) {
    rows.push({ side: 'w', a0: r.minZ + depth, a1: r.maxZ - depth });
    rows.push({ side: 'e', a0: r.minZ + depth, a1: r.maxZ - depth });
  }
  void W;
  for (const row of rows) {
    let a = row.a0;
    while (row.a1 - a > 6) {
      let w = rng.range(8, 16);
      if (row.a1 - a - w < 7) w = row.a1 - a;
      const style = rng.weighted<BuildingStyle>(['brick', 'stone', 'plaster'], [0.5, 0.2, 0.3]);
      const floors = rng.int(3, 6);
      const floorH = rng.range(3.4, 3.9);
      const wall = style === 'brick' ? rng.pick(['brick_red', 'brick_brown']) : style === 'stone' ? 'stone' : rng.pick(['plaster', 'plaster_grey']);
      const tint = (style === 'plaster' ? rng.pick(TINTS.plaster) : rng.pick(TINTS.brick)) as [number, number, number];
      let cx: number;
      let cz: number;
      let bw: number;
      let bd: number;
      const party: Side[] = [];
      if (row.side === 'n' || row.side === 's') {
        cx = a + w / 2;
        cz = row.side === 'n' ? r.minZ + depth / 2 : r.maxZ - depth / 2;
        bw = w;
        bd = depth;
        if (a > row.a0 + 0.1) party.push('w');
        if (a + w < row.a1 - 0.1) party.push('e');
      } else {
        cz = a + w / 2;
        cx = row.side === 'w' ? r.minX + depth / 2 : r.maxX - depth / 2;
        bw = depth;
        bd = w;
        party.push('n', 's');
      }
      const facesRoad = { n: b.roadN, s: b.roadS, e: b.roadE, w: b.roadW }[row.side];
      ctx.building({
        style,
        cx,
        cz,
        w: bw,
        d: bd,
        floorH,
        floors,
        height: floorH * 1.18 + (floors - 1) * floorH,
        seed: rng.int(0, 1e9),
        front: row.side,
        party,
        roof: rng.chance(0.4) ? 'gable' : 'flat',
        wall,
        trim: style === 'stone' ? 'stone' : rng.pick(['stone', 'concrete']),
        tint,
        shop: facesRoad && rng.chance(0.75),
        tiers: [],
        district,
      });
      a += w;
    }
  }
  // Courtyard tree.
  if (D > depth * 2 + 12 && rng.chance(0.6)) ctx.prop('tree', (r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2, rng.range(0, 6));
}

function houses(ctx: Ctx, b: Block, r: { minX: number; maxX: number; minZ: number; maxZ: number }, rng: Rng): void {
  const W = r.maxX - r.minX;
  const D = r.maxZ - r.minZ;
  const sides: Side[] = [];
  if (b.roadN) sides.push('n');
  if (b.roadS) sides.push('s');
  const halfDepth = D / 2;
  for (const side of sides) {
    let a = r.minX + 2;
    while (r.maxX - a > 16) {
      let lot = rng.range(20, 27);
      if (r.maxX - a - lot < 16) lot = r.maxX - a;
      const hw = Math.min(lot - 7, rng.range(10, 14));
      const hd = Math.min(halfDepth - 12, rng.range(9, 12));
      if (hd < 7) break;
      const front = rng.range(6, 8.5);
      const cx = a + lot / 2 + rng.range(-1.5, 1.5);
      const cz = side === 'n' ? r.minZ + front + hd / 2 : r.maxZ - front - hd / 2;
      const floors = rng.chance(0.65) ? 2 : 1;
      ctx.building({
        style: 'house',
        cx,
        cz,
        w: hw,
        d: hd,
        floorH: 3.1,
        floors,
        height: floors * 3.1,
        seed: rng.int(0, 1e9),
        front: side,
        party: [],
        roof: rng.chance(0.6) ? 'gable' : 'hip',
        wall: rng.chance(0.7) ? 'plaster' : 'brick_red',
        trim: 'paint_white',
        tint: rng.pick(TINTS.house) as [number, number, number],
        shop: false,
        tiers: [],
        district: 'hills',
      });
      // Garden: hedge/fence along the street, trees behind.
      const fz = side === 'n' ? r.minZ + 0.6 : r.maxZ - 0.6;
      ctx.feature(rng.chance(0.5) ? 'hedge' : 'fence', a + lot / 2, fz, side === 'n' ? 0 : Math.PI, { len: lot - 4.5 });
      const bz = side === 'n' ? r.minZ + front + hd + rng.range(4, 8) : r.maxZ - front - hd - rng.range(4, 8);
      if (Math.abs(bz - (r.minZ + r.maxZ) / 2) > 2) ctx.prop(rng.chance(0.5) ? 'tree' : 'tree_small', a + rng.range(3, lot - 3), bz, rng.range(0, 6));
      ctx.prop('bin', a + lot - 3, fz + (side === 'n' ? 1.5 : -1.5), 0);
      a += lot;
    }
  }
  void W;
}

function containerYard(ctx: Ctx, r: { minX: number; maxX: number; minZ: number; maxZ: number }, rng: Rng): void {
  const rowsZ = Math.floor((r.maxZ - r.minZ - 6) / 8);
  for (let i = 0; i < rowsZ; i++) {
    const z = r.minZ + 5 + i * 8;
    let x = r.minX + 4;
    while (x < r.maxX - 14) {
      const len = rng.chance(0.6) ? 12.2 : 6.1;
      if (rng.chance(0.85)) ctx.feature('containers', x + len / 2, z, 0, { len, stack: rng.int(1, 4), seed: rng.int(0, 1e6) });
      x += len + rng.range(0.4, 3);
    }
  }
}

// ------------------------------------------------------------------ street furniture

function streetFurniture(ctx: Ctx): void {
  const d = ctx.data;
  // Along each block's pavement ring.
  for (const b of d.blocks) {
    const rng = rngFor(Math.round(b.minX), Math.round(b.minZ), 900);
    const inset = 0.75;
    const sides: { side: Side; road: boolean; a0: number; a1: number; fixed: number; yaw: number }[] = [
      { side: 'n', road: b.roadN, a0: b.minX, a1: b.maxX, fixed: b.minZ + inset, yaw: Math.PI },
      { side: 's', road: b.roadS, a0: b.minX, a1: b.maxX, fixed: b.maxZ - inset, yaw: 0 },
      { side: 'w', road: b.roadW, a0: b.minZ, a1: b.maxZ, fixed: b.minX + inset, yaw: -Math.PI / 2 },
      { side: 'e', road: b.roadE, a0: b.minZ, a1: b.maxZ, fixed: b.maxX - inset, yaw: Math.PI / 2 },
    ];
    const lampGap = b.district === 'oldtown' ? 26 : 32;
    const treesOn = b.district === 'midtown' || (b.district === 'oldtown' && b.sidewalk > 3);
    for (const s of sides) {
      if (!s.road) continue;
      const len = s.a1 - s.a0;
      const n = Math.max(1, Math.floor((len - 12) / lampGap));
      const step = (len - 12) / n;
      for (let i = 0; i <= n; i++) {
        const a = s.a0 + 6 + step * i;
        const [x, z] = s.side === 'n' || s.side === 's' ? [a, s.fixed] : [s.fixed, a];
        if ((i + (s.side === 'n' || s.side === 'w' ? 0 : 1)) % 2 === 0 || b.district === 'oldtown') ctx.prop(b.district === 'oldtown' ? 'lamp_old' : 'lamp', x, z, s.yaw);
        if (treesOn && i < n && b.sidewalk >= 4) {
          const ta = a + step / 2;
          const [tx, tz] = s.side === 'n' || s.side === 's' ? [ta, s.fixed + (s.side === 'n' ? 0.6 : -0.6)] : [s.fixed + (s.side === 'w' ? 0.6 : -0.6), ta];
          ctx.prop('tree', tx, tz, rng.range(0, 6), { v: 1 });
        }
        if (i < n && rng.chance(b.district === 'hills' ? 0.04 : 0.18)) {
          const ba = a + step * 0.3;
          const off = b.sidewalk - 1.0;
          const [bx, bz] = s.side === 'n' || s.side === 's' ? [ba, s.fixed + (s.side === 'n' ? off - inset : -(off - inset))] : [s.fixed + (s.side === 'w' ? off - inset : -(off - inset)), ba];
          ctx.prop(rng.chance(0.5) ? 'bench' : 'bin', bx, bz, s.yaw + Math.PI);
        }
      }
    }
    // Hydrant near one corner, utility boxes occasionally.
    if (rng.chance(0.7)) ctx.prop('hydrant', b.minX + 2.2, b.maxZ - 1.0, rng.range(0, 6));
    if (b.district !== 'hills' && rng.chance(0.35)) ctx.prop('utility_box', b.maxX - 1.2, b.minZ + 4, Math.PI / 2);
    if (rng.chance(0.5)) ctx.prop('manhole', b.maxX + 3, (b.minZ + b.maxZ) / 2 + rng.range(-20, 20), 0, { y: heightAt(b.maxX + 3, (b.minZ + b.maxZ) / 2) });
  }
  // Traffic signals and street signs at junctions.
  for (const n of d.nodes) {
    if (n.arms < 3) continue;
    const ox = n.hx + 1.4;
    const oz = n.hz + 1.4;
    if (n.signal) {
      // Corner poles (right-hand traffic); yaw = direction the signal head faces.
      if (n.s) ctx.prop('signal', n.x + ox, n.z + oz, 0, { v: 0 });
      if (n.n) ctx.prop('signal', n.x - ox, n.z - oz, Math.PI, { v: 0 });
      if (n.e) ctx.prop('signal', n.x + ox, n.z - oz, Math.PI / 2, { v: 1 });
      if (n.w) ctx.prop('signal', n.x - ox, n.z + oz, -Math.PI / 2, { v: 1 });
    } else {
      ctx.prop('stop_sign', n.x + ox, n.z + oz, 0);
    }
    ctx.prop('street_sign', n.x - ox, n.z + oz, 0, { v: strHash(`${n.x},${n.z}`) % 1000 });
  }
}

// ------------------------------------------------------------------ park

function park(ctx: Ctx): void {
  const rng = rngFor(strHash('park'));
  const d = ctx.data;
  // Footpaths: loop around the lake + diagonals to the corners.
  const loop: [number, number][] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    loop.push([LAKE.x + Math.cos(a) * (LAKE.rx + 18), LAKE.z + Math.sin(a) * (LAKE.rz + 16)]);
  }
  d.paths.push({ pts: loop, width: 4 });
  const entries: [number, number][] = [
    [PARK.minX + 10, PARK.maxZ - 10],
    [PARK.minX + 10, PARK.minZ + 60],
    [PARK.maxX - 20, PARK.maxZ - 10],
    [(PARK.minX + PARK.maxX) / 2, PARK.maxZ - 8],
  ];
  for (const [ex, ez] of entries) {
    const a = Math.atan2(ez - LAKE.z, ex - LAKE.x);
    const tx = LAKE.x + Math.cos(a) * (LAKE.rx + 18);
    const tz = LAKE.z + Math.sin(a) * (LAKE.rz + 16);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const bend = Math.sin(t * Math.PI) * 18;
      pts.push([ex + (tx - ex) * t + Math.cos(a + Math.PI / 2) * bend, ez + (tz - ez) * t + Math.sin(a + Math.PI / 2) * bend]);
    }
    d.paths.push({ pts, width: 3.5 });
  }
  // Pavilion on the north shore, boathouse jetty on the east.
  ctx.feature('pavilion', LAKE.x - 20, LAKE.z - LAKE.rz - 34, 0);
  ctx.feature('jetty', LAKE.x + LAKE.rx - 6, LAKE.z + 10, Math.PI / 2, undefined, LAKE.level + 0.4);
  // Trees: scattered, avoiding lake, paths and the pavilion.
  const nearPath = (x: number, z: number) => {
    for (const p of d.paths) for (const [px, pz] of p.pts) if (Math.hypot(px - x, pz - z) < 6) return true;
    return false;
  };
  let placed = 0;
  for (let i = 0; i < 900 && placed < 300; i++) {
    const x = rng.range(PARK.minX + 8, PARK.maxX + 30);
    const z = rng.range(PARK.minZ - 30, PARK.maxZ - 8);
    if (landSdf(x, z) < 30) continue;
    const ld = Math.hypot((x - LAKE.x) / (LAKE.rx + 14), (z - LAKE.z) / (LAKE.rz + 14));
    if (ld < 1.15) continue;
    if (nearPath(x, z)) continue;
    if (Math.hypot(x - (LAKE.x - 20), z - (LAKE.z - LAKE.rz - 34)) < 16) continue;
    const cluster = 0.5 + 0.5 * Math.sin(x * 0.02) * Math.cos(z * 0.025);
    if (!rng.chance(0.35 + cluster * 0.5)) continue;
    ctx.prop(rng.chance(0.8) ? 'tree' : 'tree_small', x, z, rng.range(0, 6), { y: heightAt(x, z), s: rng.range(0.85, 1.25) });
    placed++;
  }
  // Benches and lamps along paths.
  for (const p of d.paths) {
    for (let i = 2; i < p.pts.length - 1; i += 3) {
      const [x0, z0] = p.pts[i];
      const [x1, z1] = p.pts[i + 1];
      const a = Math.atan2(z1 - z0, x1 - x0);
      const nx = -Math.sin(a);
      const nz = Math.cos(a);
      const side = i % 2 === 0 ? 1 : -1;
      const off = p.width / 2 + 1.2;
      if (i % 6 === 2) ctx.prop('bench', x0 + nx * off * side, z0 + nz * off * side, -a + (side > 0 ? -Math.PI / 2 : Math.PI / 2), { y: heightAt(x0, z0) });
      else ctx.prop('lamp_park', x0 - nx * off * side, z0 - nz * off * side, 0, { y: heightAt(x0, z0) });
      if (i % 9 === 5) ctx.prop('bin', x0 + nx * (off + 1) * side, z0 + nz * (off + 1) * side, 0, { y: heightAt(x0, z0) });
    }
  }
  for (let i = 0; i < 6; i++) ctx.prop('picnic', rng.range(PARK.minX + 30, PARK.minX + 120), rng.range(PARK.maxZ - 120, PARK.maxZ - 30), rng.range(0, 6), {});
}

// ------------------------------------------------------------------ coast: quays, promenades, piers

function coast(ctx: Ctx): void {
  const rng = rngFor(strHash('coast'));
  // South quay (harbour): cranes along the seawall, bollards, containers.
  const quayZ = CITY_HALF - 4;
  for (let x = 40; x < 690; x += 22) {
    ctx.prop('bollard', x, quayZ + 2.5, 0, { y: GROUND });
  }
  for (const cx of [60, 250, 470, 650]) ctx.feature('crane', cx, CITY_HALF - 14, 0, { color: cx % 2 });
  // Piers: cranes, containers, warehouse.
  PIERS.forEach(([x0, x1, z0, z1], i) => {
    if (x1 - x0 < 60) return; // breakwater: lighthouse only
    const cx = (x0 + x1) / 2;
    ctx.feature('crane', x1 - 12, (z0 + z1) / 2 + 20, Math.PI / 2, { color: i });
    for (let z = z0 + 22; z < z1 - 30; z += 9) {
      if (rng.chance(0.8)) ctx.feature('containers', cx - 12, z, Math.PI / 2 * 0, { len: 12.2, stack: rng.int(1, 3), seed: rng.int(0, 1e6) });
    }
    for (let z = z0 + 12; z < z1 - 4; z += 20) {
      ctx.prop('bollard', x0 + 1.5, z, 0, { y: GROUND });
      ctx.prop('bollard', x1 - 1.5, z, 0, { y: GROUND });
    }
    ctx.prop('lamp', x0 + 3, z1 - 6, -Math.PI / 2, { y: GROUND });
    ctx.prop('lamp', x1 - 3, z1 - 6, Math.PI / 2, { y: GROUND });
  });
  ctx.feature('lighthouse', LIGHTHOUSE.x, LIGHTHOUSE.z, 0, undefined, GROUND);
  // Sea markers and buoys.
  for (const [bx, bz] of [
    [480, 990],
    [680, 1010],
    [820, 860],
    [760, 120],
    [-820, 300],
  ]) ctx.prop('sea_marker', bx, bz, rng.range(0, 6), { y: 0 });
  // East & west promenades: railings, lamps, benches along the seawall.
  for (let z = -230; z < 690; z += 30) {
    if (Math.abs(z - BRIDGE.z) < 22) continue;
    ctx.prop('lamp', CITY_HALF - 5, z, Math.PI / 2, { y: GROUND });
    if (rng.chance(0.4)) ctx.prop('bench', CITY_HALF - 8, z + 12, -Math.PI / 2, { y: GROUND });
    ctx.prop('lamp', -CITY_HALF + 5, z, -Math.PI / 2, { y: GROUND });
  }
  ctx.feature('seawall', 0, 0, 0);
  ctx.feature('bridge', 0, 0, 0);
  ctx.feature('airport', 0, 0, 0);
}
