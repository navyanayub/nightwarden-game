/**
 * Pedestrian simulation.
 *
 * Navigation: every city block's pavement is a rectangular ring (inset half a pavement from the
 * kerb). Pedestrians walk along ring edges with a personal lateral offset; at corners they turn
 * or cross the road to the facing block. Crossings at signal junctions wait for the walk phase
 * (the crossed road's lights are red); elsewhere they wait for a gap in traffic. People on a
 * crossing are published as obstacles that cars yield to.
 *
 * Behaviours: walking (some on the phone), standing / phone calls, chatting groups, sitting on
 * benches, waiting at bus stops (and boarding), umbrellas in rain. Reactions: stepping aside
 * when bumped, screaming and fleeing (some cower first) from a car on the pavement, a crash or
 * a gunshot; a hijacked driver runs away.
 *
 * Rendering is delegated to CrowdRender (GPU skinning); this module only produces Figures.
 */
import * as THREE from 'three';
import { events } from '../core/EventBus';
import { Rng, hashFloat, hashN } from '../core/Random';
import type { Block, CityData } from '../world/CityLayout';
import { heightAt } from '../world/Terrain';
import { KERB, districtAt, type District } from '../world/WorldConfig';
import { CrowdRender, type ClipName, type Figure, type Look } from './CrowdRender';
import type { Traffic, Obstacle, BusStop } from './Traffic';
import { greenLeft, signalState, type GNode } from './LaneGraph';

interface Ring {
  block: Block;
  c: [number, number][];
  e: [number, number][];
  len: number[];
  sw: number;
  district: District;
  /** Crossing links per corner. */
  links: CrossLink[][];
}

interface CrossLink {
  to: number;
  toCorner: number;
  node: GNode | null;
  /** Axis whose green allows walking (the crossed road's traffic is red). */
  walkAxis: 'ns' | 'ew';
  len: number;
}

type State = 'walk' | 'wait' | 'cross' | 'stand' | 'group' | 'sit' | 'bus' | 'board' | 'flee' | 'cower' | 'hit' | 'goto';

interface Ped {
  id: number;
  look: Look;
  state: State;
  ring: number;
  edge: number;
  dir: 1 | -1;
  u: number;
  lat: number;
  /** Logical position, and smoothed visual position. */
  x: number;
  z: number;
  vx: number;
  vz: number;
  y: number;
  yaw: number;
  speed: number;
  timer: number;
  clip: ClipName;
  clipT: number;
  prev: ClipName;
  prevT: number;
  blend: number;
  umbrella: boolean;
  umbrellaColor: [number, number, number];
  phoneWalker: boolean;
  formal: boolean;
  cross: { ax: number; az: number; bx: number; bz: number; s: number; len: number; link: CrossLink } | null;
  spot: { x: number; z: number; yaw: number; clip: ClipName } | null;
  next: State;
  threatX: number;
  threatZ: number;
  unseen: number;
  stop: BusStop | null;
  bench: number;
  groupId: number;
}

const SKIN: [number, number, number][] = [
  [1.0, 0.96, 0.92],
  [0.93, 0.8, 0.68],
  [0.8, 0.62, 0.48],
  [0.62, 0.44, 0.32],
  [0.45, 0.3, 0.21],
  [0.32, 0.21, 0.15],
];
const HAIR: [number, number, number][] = [
  [0.04, 0.035, 0.03],
  [0.12, 0.07, 0.04],
  [0.25, 0.15, 0.08],
  [0.35, 0.12, 0.05],
  [0.55, 0.42, 0.22],
  [0.45, 0.45, 0.45],
];
const TOPS: [number, number, number][] = [
  [0.08, 0.1, 0.16], [0.5, 0.08, 0.08], [0.15, 0.25, 0.15], [0.55, 0.5, 0.42], [0.06, 0.06, 0.07], [0.7, 0.7, 0.68],
  [0.18, 0.32, 0.5], [0.45, 0.3, 0.12], [0.35, 0.12, 0.3], [0.62, 0.45, 0.1], [0.25, 0.25, 0.27], [0.12, 0.38, 0.38],
];
const BOTTOMS: [number, number, number][] = [
  [0.07, 0.1, 0.17], [0.05, 0.05, 0.06], [0.22, 0.2, 0.18], [0.35, 0.3, 0.22], [0.12, 0.12, 0.14], [0.4, 0.38, 0.33], [0.2, 0.08, 0.1],
];
const UMBRELLAS: [number, number, number][] = [[0.06, 0.06, 0.07], [0.5, 0.06, 0.08], [0.1, 0.2, 0.45], [0.75, 0.62, 0.1], [0.15, 0.35, 0.2], [0.6, 0.6, 0.62]];
const PED_DENSITY: Record<District, number> = { midtown: 1, oldtown: 0.9, harbour: 0.35, industrial: 0.25, hills: 0.35, park: 0.5, island: 0.15, sea: 0 };
/** Seat surface to figure-root offset for the driving pose (pelvis sits on the seat). */
const DRIVER_DROP = 0.42;
/** Native ground speed of the walk clips (m/s) for playback-rate matching. */
const WALK_CLIP_SPEED = 1.35;

export function makeLook(seed: number): Look {
  const r = new Rng(hashN(seed, 911));
  const gender: 0 | 1 = r.chance(0.5) ? 0 : 1;
  const topStyle = r.weighted([0, 1, 2, 3], gender === 0 ? [3, 3, 2, 2] : [2, 3, 2, 2]);
  const botStyle = gender === 1 ? r.weighted([0, 1, 2, 3], [3, 2, 3, 1]) : r.weighted([0, 1, 3], [4, 3, 1]);
  const top = r.pick(TOPS);
  const bot = r.pick(BOTTOMS);
  const skin = r.pick(SKIN);
  const hair = r.pick(HAIR);
  const vary = (c: [number, number, number], k: number): [number, number, number] => [c[0] * (1 + (r.next() - 0.5) * k), c[1] * (1 + (r.next() - 0.5) * k), c[2] * (1 + (r.next() - 0.5) * k)];
  return {
    gender,
    top: [...vary(top, 0.3), topStyle] as [number, number, number, number],
    bottom: [...vary(bot, 0.25), botStyle] as [number, number, number, number],
    skin: [...skin, r.int(0, 2)] as [number, number, number, number],
    hair: hair,
    hairStyle: gender === 0 ? r.weighted([0, 1, 2, 4], [4, 3, 2, 1]) : r.int(0, 2),
    height: gender === 0 ? r.range(0.95, 1.06) : r.range(0.96, 1.05),
    girth: r.range(0.94, 1.14),
  };
}

export class Crowd {
  readonly render: CrowdRender;
  private rings: Ring[] = [];
  private grid = new Map<string, number[]>();
  peds: Ped[] = [];
  private nextId = 1;
  private rng = new Rng(0xc0ffee);
  private spawnT = 0;
  private time = 0;
  private figures: Figure[] = [];
  private seats: { id: number; x: number; y: number; z: number; yaw: number; pitch: number }[] = [];
  private driverLooks = new Map<number, Look>();
  private benches: { x: number; z: number; y: number; yaw: number; used: number }[] = [];
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  target = 0;
  maxPeds: number;
  /** Peds standing in the road (crossing / fleeing) for the traffic AI. */
  readonly roadObstacles: Obstacle[] = [];
  private pedGrid = new Map<number, Ped[]>();
  private alarms: { x: number; z: number; r: number; kind: string }[] = [];
  /** Screams this frame (audio hooks). */
  screams: { x: number; z: number }[] = [];

  constructor(
    city: CityData,
    private readonly traffic: Traffic,
    maxPeds: number,
  ) {
    this.maxPeds = maxPeds;
    this.render = new CrowdRender(maxPeds + 40);
    this.buildRings(city);
    for (const p of city.props) if (p.type === 'bench') this.benches.push({ x: p.x, z: p.z, y: p.y, yaw: p.yaw, used: 0 });
    events.on('world:alarm', (a) => this.alarms.push({ x: a.x, z: a.z, r: a.radius, kind: a.kind }));
    events.on('player:hijack', (h) => this.spawnFleeing(h.x, h.z));
  }

  async load(): Promise<void> {
    await this.render.load();
  }

  // ---------------------------------------------------------------- navigation data

  private buildRings(city: CityData): void {
    for (const b of city.blocks) {
      if (!(b.kind === 'buildings' || b.kind === 'plaza' || b.kind === 'square')) continue;
      const h = b.sidewalk / 2;
      const c: [number, number][] = [
        [b.minX + h, b.minZ + h],
        [b.maxX - h, b.minZ + h],
        [b.maxX - h, b.maxZ - h],
        [b.minX + h, b.maxZ - h],
      ];
      const e: [number, number][] = [];
      const len: number[] = [];
      for (let k = 0; k < 4; k++) {
        const a = c[k];
        const d = c[(k + 1) % 4];
        const l = Math.hypot(d[0] - a[0], d[1] - a[1]);
        len.push(l);
        e.push([(d[0] - a[0]) / l, (d[1] - a[1]) / l]);
      }
      this.rings.push({ block: b, c, e, len, sw: b.sidewalk, district: districtAt((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2), links: [[], [], [], []] });
    }
    this.rings.forEach((r, i) => {
      for (const [x, z] of r.c) {
        const k = `${Math.floor(x / 40)},${Math.floor(z / 40)}`;
        const arr = this.grid.get(k) ?? [];
        arr.push(i);
        this.grid.set(k, arr);
      }
    });
    // Crossing links: from each corner, look across the road along the two outward directions.
    const nodes = this.traffic.graph.nodes;
    for (let ri = 0; ri < this.rings.length; ri++) {
      const r = this.rings[ri];
      for (let k = 0; k < 4; k++) {
        const [cx, cz] = r.c[k];
        const outs: [number, number][] = [r.e[(k + 3) % 4], [-r.e[k][0], -r.e[k][1]]];
        for (const [dx, dz] of outs) {
          let best: { ri: number; k: number; d: number } | null = null;
          for (const rj of this.ringsNear(cx + dx * 20, cz + dz * 20)) {
            if (rj === ri) continue;
            const o = this.rings[rj];
            for (let kk = 0; kk < 4; kk++) {
              const [ox, oz] = o.c[kk];
              const along = (ox - cx) * dx + (oz - cz) * dz;
              const side = Math.abs((ox - cx) * dz - (oz - cz) * dx);
              if (along < 6 || along > 34 || side > 3.5) continue;
              if (!best || along < best.d) best = { ri: rj, k: kk, d: along };
            }
          }
          if (!best) continue;
          // Junction controlling this crossing.
          let node: GNode | null = null;
          let nd = 40;
          for (const n of nodes) {
            const d = Math.hypot(n.x - cx, n.z - cz);
            if (d < nd && n.arms >= 3) {
              nd = d;
              node = n;
            }
          }
          // Walking east-west crosses a north-south road: allowed while E-W traffic has green.
          const walkAxis = Math.abs(dx) > 0.5 ? 'ew' : 'ns';
          r.links[k].push({ to: best.ri, toCorner: best.k, node, walkAxis, len: best.d });
        }
      }
    }
  }

  private ringsNear(x: number, z: number): number[] {
    const out = new Set<number>();
    const cx = Math.floor(x / 40);
    const cz = Math.floor(z / 40);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const r of this.grid.get(`${cx + i},${cz + j}`) ?? []) out.add(r);
    return [...out];
  }

  private ringPos(p: Ped): [number, number] {
    const r = this.rings[p.ring];
    const [cx, cz] = r.c[p.edge];
    const [ex, ez] = r.e[p.edge];
    // Inward normal = right of the clockwise edge direction.
    return [cx + ex * p.u - ez * p.lat, cz + ez * p.u + ex * p.lat];
  }

  /** Snap a world point to the nearest pavement ring position. */
  private nearestRing(x: number, z: number): { ring: number; edge: number; u: number; d: number } | null {
    let best: { ring: number; edge: number; u: number; d: number } | null = null;
    for (const ri of this.ringsNear(x, z)) {
      const r = this.rings[ri];
      for (let k = 0; k < 4; k++) {
        const [cx, cz] = r.c[k];
        const [ex, ez] = r.e[k];
        const u = THREE.MathUtils.clamp((x - cx) * ex + (z - cz) * ez, 0, r.len[k]);
        const d = Math.hypot(cx + ex * u - x, cz + ez * u - z);
        if (!best || d < best.d) best = { ring: ri, edge: k, u, d };
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- spawning

  private newPed(seed: number, ring: number, edge: number, u: number): Ped {
    const look = makeLook(seed);
    const r = new Rng(hashN(seed, 77));
    const sw = this.rings[ring].sw;
    const p: Ped = {
      id: this.nextId++,
      look,
      state: 'walk',
      ring,
      edge,
      dir: r.chance(0.5) ? 1 : -1,
      u,
      lat: r.range(-(sw / 2 - 0.55), sw / 2 - 0.55),
      x: 0,
      z: 0,
      vx: 0,
      vz: 0,
      y: 0,
      yaw: 0,
      speed: r.range(1.15, 1.55),
      timer: r.range(20, 80),
      clip: 'walk',
      clipT: r.range(0, 2),
      prev: 'walk',
      prevT: 0,
      blend: 1,
      umbrella: r.chance(0.7),
      umbrellaColor: r.pick(UMBRELLAS),
      phoneWalker: r.chance(0.12),
      formal: r.chance(0.25),
      cross: null,
      spot: null,
      next: 'walk',
      threatX: 0,
      threatZ: 0,
      unseen: 0,
      stop: null,
      bench: -1,
      groupId: 0,
    };
    const [x, z] = this.ringPos(p);
    p.x = p.vx = x;
    p.z = p.vz = z;
    p.y = heightAt(x, z) + KERB;
    this.peds.push(p);
    return p;
  }

  private trySpawn(px: number, pz: number, initial: boolean, rain: number): void {
    const ang = this.rng.next() * Math.PI * 2;
    const dist = initial ? 8 + this.rng.next() * 110 : 55 + this.rng.next() * 70;
    const x = px + Math.cos(ang) * dist;
    const z = pz + Math.sin(ang) * dist;
    const near = this.nearestRing(x, z);
    if (!near || near.d > 25) return;
    const ring = this.rings[near.ring];
    if (this.rng.next() > PED_DENSITY[ring.district]) return;
    const [cx, cz] = ring.c[near.edge];
    const vis = new THREE.Vector3(cx + ring.e[near.edge][0] * near.u, heightAt(cx, cz) + 1, cz + ring.e[near.edge][1] * near.u);
    if (!initial && dist < 90 && this.frustum.containsPoint(vis)) return;
    const seed = this.nextId * 7919 + 13;
    const kind = this.rng.next();
    // Behaviour mix.
    if (kind < 0.07 && rain < 0.3) {
      this.spawnGroup(near.ring, near.edge, near.u);
      return;
    }
    const p = this.newPed(seed, near.ring, near.edge, near.u);
    if (kind < 0.15 && rain < 0.3) this.toBench(p);
    else if (kind < 0.22) this.toBusStop(p);
    else if (kind < 0.3) {
      p.state = 'stand';
      p.lat = Math.sign(p.lat || 1) * (ring.sw / 2 - 0.5);
      p.timer = this.rng.range(8, 40);
      p.next = this.rng.chance(0.5) ? 'stand' : 'walk';
      p.spot = { x: 0, z: 0, yaw: 0, clip: this.rng.chance(0.55) ? 'phone' : 'idle' };
    }
  }

  private spawnGroup(ring: number, edge: number, u: number): void {
    const r = this.rings[ring];
    const n = this.rng.int(2, 4);
    const base = this.newPed(this.nextId * 31 + 5, ring, edge, u);
    const [cx, cz] = this.ringPos(base);
    const gid = base.id;
    const rad = 0.55 + n * 0.08;
    for (let i = 0; i < n; i++) {
      const p = i === 0 ? base : this.newPed(this.nextId * 31 + 5, ring, edge, u);
      const a = (i / n) * Math.PI * 2 + this.rng.next() * 0.4;
      const x = cx + Math.cos(a) * rad;
      const z = cz + Math.sin(a) * rad;
      p.state = 'group';
      p.groupId = gid;
      p.spot = { x, z, yaw: Math.atan2(cx - x, cz - z), clip: this.rng.chance(0.55) ? 'talk' : 'idle' };
      p.timer = this.rng.range(30, 90);
      p.x = p.vx = x;
      p.z = p.vz = z;
      void r;
    }
  }

  private toBench(p: Ped): void {
    let best = -1;
    let bd = 60;
    for (let i = 0; i < this.benches.length; i++) {
      const b = this.benches[i];
      if (b.used >= 2) continue;
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return;
    const b = this.benches[best];
    const side = b.used === 0 ? -0.5 : 0.5;
    b.used++;
    p.bench = best;
    // Bench seat runs along the bench's local Z (model rotated); sitters face local +X.
    const fx = Math.sin(b.yaw + Math.PI / 2);
    const fz = Math.cos(b.yaw + Math.PI / 2);
    const sx = b.x + Math.sin(b.yaw) * side - fx * 0.05;
    const sz = b.z + Math.cos(b.yaw) * side - fz * 0.05;
    p.state = 'goto';
    p.next = 'sit';
    p.spot = { x: sx, z: sz, yaw: Math.atan2(fx, fz), clip: this.rng.chance(0.3) ? 'sitTalk' : 'sit' };
    p.timer = this.rng.range(30, 120);
    if (Math.hypot(sx - p.x, sz - p.z) > 30) {
      p.x = p.vx = sx;
      p.z = p.vz = sz;
    }
  }

  private toBusStop(p: Ped): void {
    const stops = this.traffic.busStops;
    let best: BusStop | null = null;
    let bd = 90;
    for (const s of stops) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    if (!best) return;
    const fx = Math.sin(best.yaw);
    const fz = Math.cos(best.yaw);
    const side = this.rng.range(-2.6, 2.6);
    const x = best.x + fx * this.rng.range(0.8, 1.6) + fz * side;
    const z = best.z + fz * this.rng.range(0.8, 1.6) - fx * side;
    p.state = 'goto';
    p.next = 'bus';
    p.stop = best;
    p.spot = { x, z, yaw: best.yaw + this.rng.range(-0.6, 0.6), clip: this.rng.chance(0.4) ? 'phone' : 'idle' };
    p.timer = 300;
    if (Math.hypot(x - p.x, z - p.z) > 35) {
      p.x = p.vx = x;
      p.z = p.vz = z;
    }
  }

  private spawnFleeing(x: number, z: number): void {
    const near = this.nearestRing(x, z);
    if (!near) return;
    const p = this.newPed(this.nextId * 131 + 7, near.ring, near.edge, near.u);
    p.x = p.vx = x;
    p.z = p.vz = z;
    this.flee(p, x - 1, z - 1, true);
    this.screams.push({ x, z });
  }

  private flee(p: Ped, tx: number, tz: number, now = false): void {
    if (p.bench >= 0) {
      this.benches[p.bench].used = Math.max(0, this.benches[p.bench].used - 1);
      p.bench = -1;
    }
    p.threatX = tx;
    p.threatZ = tz;
    p.cross = null;
    p.spot = null;
    // Join the pavement ring and pick the direction that leads away from the threat.
    const near = this.nearestRing(p.x, p.z);
    if (near) {
      p.ring = near.ring;
      p.edge = near.edge;
      p.u = near.u;
      const r = this.rings[p.ring];
      const [ex, ez] = r.e[p.edge];
      p.dir = (p.x - tx) * ex + (p.z - tz) * ez >= 0 ? 1 : -1;
    }
    p.state = now || this.rng.chance(0.75) ? 'flee' : 'cower';
    p.timer = p.state === 'flee' ? this.rng.range(10, 18) : this.rng.range(2.5, 6);
    p.speed = this.rng.range(4.2, 5.6);
  }

  // ---------------------------------------------------------------- update

  update(dt: number, camera: THREE.Camera, player: THREE.Vector3, playerOnFoot: boolean, car: { x: number; z: number; speed: number; yaw: number; onPavement: boolean } | null, activity: number, rain: number, paused: boolean): void {
    this.screams.length = 0;
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    if (!paused) {
      this.time += dt;
      this.simulate(Math.min(dt, 0.1), player, playerOnFoot, car, activity, rain, camera);
    }
    this.buildFigures(camera, rain);
    this.render.update(this.figures, camera);
  }

  private simulate(dt: number, player: THREE.Vector3, playerOnFoot: boolean, car: { x: number; z: number; speed: number; yaw: number; onPavement: boolean } | null, activity: number, rain: number, camera: THREE.Camera): void {
    // Population.
    this.target = Math.round(this.maxPeds * activity * (1 - 0.35 * rain));
    this.spawnT -= dt;
    const initial = this.time < 1.5;
    if ((this.spawnT <= 0 || initial) && this.peds.length < this.target) {
      this.spawnT = 0.08;
      const n = initial ? 30 : 2;
      for (let i = 0; i < n && this.peds.length < this.target; i++) this.trySpawn(player.x, player.z, initial, rain);
    }
    // Alarms (car on pavement, crash, gunshot).
    if (car && car.onPavement && Math.abs(car.speed) > 2.5) this.alarms.push({ x: car.x, z: car.z, r: 22, kind: 'pavement' });
    for (const a of this.alarms) {
      for (const p of this.peds) {
        const d = Math.hypot(p.x - a.x, p.z - a.z);
        if (d > a.r || p.state === 'flee' || p.state === 'board') continue;
        if (p.state === 'cower' && a.kind !== 'gunshot') continue;
        this.flee(p, a.x, a.z, a.kind === 'pavement' && d < 8);
        if (this.screams.length < 4 && hashFloat(p.id, 3) < 0.5) this.screams.push({ x: p.x, z: p.z });
      }
    }
    this.alarms.length = 0;
    // Spatial hash for separation.
    this.pedGrid.clear();
    for (const p of this.peds) {
      const k = Math.floor(p.x / 3) * 100003 + Math.floor(p.z / 3);
      const arr = this.pedGrid.get(k);
      if (arr) arr.push(p);
      else this.pedGrid.set(k, [p]);
    }
    this.roadObstacles.length = 0;
    const tmp = new THREE.Vector3();
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      const dPlayer = Math.hypot(p.x - player.x, p.z - player.z);
      tmp.set(p.vx, p.y + 1, p.vz);
      p.unseen = this.frustum.containsPoint(tmp) ? 0 : p.unseen + dt;
      if (dPlayer > 150 || (dPlayer > 70 && p.unseen > 6) || (p.state === 'board' && p.timer <= 0)) {
        if (p.bench >= 0) this.benches[p.bench].used = Math.max(0, this.benches[p.bench].used - 1);
        this.peds.splice(i, 1);
        continue;
      }
      // Bumped by the player.
      if (playerOnFoot && dPlayer < 0.6 && p.state !== 'hit' && p.state !== 'sit' && p.state !== 'flee') {
        p.next = p.state === 'cross' ? 'cross' : p.state === 'group' || p.state === 'stand' || p.state === 'bus' ? p.state : 'walk';
        p.state = 'hit';
        p.timer = 0.7;
        const ax = (p.x - player.x) / Math.max(dPlayer, 0.05);
        const az = (p.z - player.z) / Math.max(dPlayer, 0.05);
        p.x += ax * 0.5;
        p.z += az * 0.5;
        if (p.spot) {
          p.spot.x += ax * 0.5;
          p.spot.z += az * 0.5;
        }
        p.lat = THREE.MathUtils.clamp(p.lat + (Math.random() - 0.5) * 0.8, -(this.rings[p.ring].sw / 2 - 0.4), this.rings[p.ring].sw / 2 - 0.4);
      }
      // A car bearing down: dive aside.
      if (car && Math.abs(car.speed) > 4 && p.state !== 'flee') {
        const fx = Math.sin(car.yaw);
        const fz = Math.cos(car.yaw);
        const dx = p.x - car.x;
        const dz = p.z - car.z;
        const along = dx * fx + dz * fz;
        const side = dx * fz - dz * fx;
        if (along > 0 && along < 9 + Math.abs(car.speed) * 0.6 && Math.abs(side) < 1.8) {
          p.x += fz * Math.sign(side || 1) * 1.6;
          p.z -= fx * Math.sign(side || 1) * 1.6;
          this.flee(p, car.x, car.z, true);
          if (this.screams.length < 4) this.screams.push({ x: p.x, z: p.z });
        }
      }
      this.step(p, dt, rain);
      // Separation from neighbours (keeps crowds from overlapping).
      const k0 = Math.floor(p.x / 3);
      const k1 = Math.floor(p.z / 3);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          const arr = this.pedGrid.get((k0 + a) * 100003 + k1 + b);
          if (!arr) continue;
          for (const o of arr) {
            if (o === p) continue;
            const dx = p.x - o.x;
            const dz = p.z - o.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > 0.42 || d2 < 1e-6) continue;
            if (p.state === 'group' || p.state === 'sit') continue;
            const d = Math.sqrt(d2);
            const push = (0.65 - d) * 0.5;
            p.x += (dx / d) * push;
            p.z += (dz / d) * push;
          }
        }
      }
      // Smooth the visual position, height on the ground / pavement.
      const kk = Math.min(1, dt * 8);
      p.vx += (p.x - p.vx) * kk;
      p.vz += (p.z - p.vz) * kk;
      const onRoad = p.state === 'cross' || (p.state === 'flee' && !this.onPavement(p.x, p.z));
      const gy = heightAt(p.vx, p.vz) + (onRoad ? 0.02 : KERB);
      p.y += (gy - p.y) * Math.min(1, dt * 10);
      if (onRoad) this.roadObstacles.push({ x: p.x, z: p.z, r: 0.45, kind: 'ped' });
      void camera;
    }
  }

  /** True when (x, z) is on a pavement/block area rather than the road. */
  onPavement(x: number, z: number): boolean {
    for (const ri of this.ringsNear(x, z)) {
      const b = this.rings[ri].block;
      if (x > b.minX && x < b.maxX && z > b.minZ && z < b.maxZ) return true;
    }
    return false;
  }

  private setClip(p: Ped, clip: ClipName): void {
    if (p.clip === clip) return;
    p.prev = p.clip;
    p.prevT = p.clipT;
    p.clip = clip;
    p.clipT = 0;
    p.blend = 0;
  }

  private faceTo(p: Ped, yaw: number, dt: number, rate = 8): void {
    let d = yaw - p.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    p.yaw += d * Math.min(1, dt * rate);
  }

  private step(p: Ped, dt: number, rain: number): void {
    const r = this.rings[p.ring];
    const useUmb = p.umbrella && rain > 0.3 && p.state !== 'flee' && p.state !== 'cower' && p.state !== 'sit' && p.state !== 'board';
    const walkClip: ClipName = useUmb ? 'umbrellaWalk' : p.phoneWalker && rain < 0.3 ? 'phoneWalk' : p.formal ? 'walkFormal' : 'walk';
    const pace = rain > 0.3 ? 1.15 : 1;
    p.timer -= dt;
    switch (p.state) {
      case 'walk':
      case 'flee': {
        const sp = p.state === 'flee' ? p.speed : p.speed * pace;
        this.setClip(p, p.state === 'flee' ? 'sprint' : walkClip);
        p.u += p.dir * sp * dt;
        const L = r.len[p.edge];
        if (p.u > L || p.u < 0) {
          // Reached a corner.
          const corner = p.u > L ? (p.edge + 1) % 4 : p.edge;
          const links = r.links[corner];
          const flee = p.state === 'flee';
          if (!flee && links.length && this.rng.chance(0.4)) {
            const link = this.rng.pick(links);
            const [ax, az] = r.c[corner];
            const o = this.rings[link.to];
            const [bx, bz] = o.c[link.toCorner];
            p.cross = { ax, az, bx, bz, s: 0, len: Math.hypot(bx - ax, bz - az), link };
            p.state = 'wait';
            p.x = ax;
            p.z = az;
            break;
          }
          // Turn onto the next edge (keep circulating in the same rotational sense).
          if (p.dir > 0) {
            p.edge = (p.edge + 1) % 4;
            p.u = 0;
          } else {
            p.edge = (p.edge + 3) % 4;
            p.u = r.len[p.edge];
          }
          if (flee) {
            const [ex, ez] = r.e[p.edge];
            const [cx, cz] = r.c[p.edge];
            const mx = cx + ex * r.len[p.edge] * 0.5 - p.threatX;
            const mz = cz + ez * r.len[p.edge] * 0.5 - p.threatZ;
            p.dir = mx * ex + mz * ez >= 0 ? 1 : -1;
          }
        }
        const [x, z] = this.ringPos(p);
        const [ex, ez] = r.e[p.edge];
        p.x = x;
        p.z = z;
        this.faceTo(p, Math.atan2(ex * p.dir, ez * p.dir), dt);
        if (p.state === 'flee' && p.timer <= 0) {
          p.state = 'walk';
          p.speed = this.rng.range(1.2, 1.5);
        } else if (p.state === 'walk' && p.timer <= 0) {
          p.timer = this.rng.range(25, 90);
          const roll = this.rng.next();
          if (roll < 0.15) {
            p.state = 'stand';
            p.timer = this.rng.range(6, 25);
            p.next = 'walk';
            p.spot = { x: 0, z: 0, yaw: 0, clip: rain < 0.3 && this.rng.chance(0.5) ? 'phone' : 'idle' };
          } else if (roll < 0.22 && rain < 0.3) this.toBench(p);
        }
        break;
      }
      case 'wait': {
        const c = p.cross!;
        this.setClip(p, useUmb ? 'umbrella' : p.phoneWalker ? 'phone' : 'idle');
        this.faceTo(p, Math.atan2(c.bx - c.ax, c.bz - c.az), dt, 5);
        const n = c.link.node;
        let go = false;
        if (n && n.signal) go = signalState(n, c.link.walkAxis, this.traffic.time) === 2 && greenLeft(n, c.link.walkAxis, this.traffic.time) > c.len / 1.3 + 1;
        else {
          go = true;
          for (const car of this.traffic.cars) {
            if (car.state !== 'drive' || car.speed < 0.8) continue;
            const mx = (c.ax + c.bx) / 2;
            const mz = (c.az + c.bz) / 2;
            if (Math.hypot(car.x - mx, car.z - mz) < 14 + car.speed * 2) {
              go = false;
              break;
            }
          }
        }
        if (go) {
          p.state = 'cross';
          c.s = 0;
        }
        break;
      }
      case 'cross': {
        const c = p.cross!;
        this.setClip(p, walkClip);
        c.s += p.speed * 1.1 * pace * dt;
        const t = Math.min(1, c.s / c.len);
        p.x = c.ax + (c.bx - c.ax) * t;
        p.z = c.az + (c.bz - c.az) * t;
        this.faceTo(p, Math.atan2(c.bx - c.ax, c.bz - c.az), dt);
        if (t >= 1) {
          const o = this.rings[c.link.to];
          p.ring = c.link.to;
          const k = c.link.toCorner;
          // Continue away from the road: pick one of the two edges at the arrival corner.
          if (this.rng.chance(0.5)) {
            p.edge = k;
            p.u = 0;
            p.dir = 1;
          } else {
            p.edge = (k + 3) % 4;
            p.u = o.len[p.edge];
            p.dir = -1;
          }
          p.lat = THREE.MathUtils.clamp(p.lat, -(o.sw / 2 - 0.55), o.sw / 2 - 0.55);
          p.cross = null;
          p.state = 'walk';
        }
        break;
      }
      case 'stand': {
        this.setClip(p, useUmb ? 'umbrella' : p.spot?.clip ?? 'idle');
        const [x, z] = this.ringPos(p);
        p.x = x;
        p.z = z;
        if (p.timer <= 0) {
          p.state = 'walk';
          p.spot = null;
          p.timer = this.rng.range(25, 80);
        }
        break;
      }
      case 'goto': {
        const s = p.spot!;
        const dx = s.x - p.x;
        const dz = s.z - p.z;
        const d = Math.hypot(dx, dz);
        this.setClip(p, walkClip);
        if (d < 0.15) {
          p.state = p.next;
          p.x = s.x;
          p.z = s.z;
        } else {
          const st = Math.min(d, p.speed * dt);
          p.x += (dx / d) * st;
          p.z += (dz / d) * st;
          this.faceTo(p, Math.atan2(dx, dz), dt);
        }
        if (p.timer < -60) p.state = 'walk';
        break;
      }
      case 'sit':
      case 'group':
      case 'bus': {
        const s = p.spot!;
        this.setClip(p, p.state === 'bus' ? (useUmb ? 'umbrella' : s.clip) : p.state === 'group' && useUmb ? 'umbrella' : s.clip);
        p.x = s.x;
        p.z = s.z;
        this.faceTo(p, s.yaw, dt, 4);
        if (p.state === 'group' && this.rng.chance(dt * 0.15)) s.clip = s.clip === 'talk' ? 'idle' : 'talk';
        if (p.state === 'bus' && p.stop) {
          // Board a bus that has stopped here.
          const st = p.stop;
          const bus = this.traffic.cars.find((c) => c.bus && c.bus.dwell > 0 && Math.hypot(c.x - st.x, c.z - st.z) < 12);
          if (bus) {
            p.state = 'board';
            const fx = Math.sin(bus.yaw);
            const fz = Math.cos(bus.yaw);
            const door = bus.spec.length / 2 - 0.95;
            p.spot = { x: bus.x + fx * door - fz * -(bus.spec.width / 2 + 0.3), z: bus.z + fz * door + fx * -(bus.spec.width / 2 + 0.3), yaw: 0, clip: walkClip };
            p.timer = 4;
          }
        }
        if (p.timer <= 0 && p.state !== 'bus') {
          if (p.bench >= 0) {
            this.benches[p.bench].used = Math.max(0, this.benches[p.bench].used - 1);
            p.bench = -1;
          }
          const near = this.nearestRing(p.x, p.z);
          if (near) {
            p.ring = near.ring;
            p.edge = near.edge;
            p.u = near.u;
          }
          p.state = 'walk';
          p.spot = null;
          p.timer = this.rng.range(25, 80);
        }
        break;
      }
      case 'board': {
        const s = p.spot!;
        const dx = s.x - p.x;
        const dz = s.z - p.z;
        const d = Math.hypot(dx, dz);
        this.setClip(p, walkClip);
        if (d > 0.2) {
          p.x += (dx / d) * Math.min(d, 1.5 * dt);
          p.z += (dz / d) * Math.min(d, 1.5 * dt);
          this.faceTo(p, Math.atan2(dx, dz), dt);
        } else p.timer = Math.min(p.timer, 0);
        break;
      }
      case 'cower': {
        this.setClip(p, 'cower');
        this.faceTo(p, Math.atan2(p.threatX - p.x, p.threatZ - p.z), dt, 3);
        if (p.timer <= 0) this.flee(p, p.threatX, p.threatZ, true);
        break;
      }
      case 'hit': {
        this.setClip(p, 'hit');
        if (p.timer <= 0) {
          p.state = p.next;
          if (p.state === 'walk' || p.state === 'flee') {
            const near = this.nearestRing(p.x, p.z);
            if (near) {
              p.ring = near.ring;
              p.edge = near.edge;
              p.u = near.u;
            }
          }
        }
        break;
      }
    }
    // Animation clocks (playback speed follows ground speed for walk cycles).
    let rate = 1;
    if (p.clip === 'walk' || p.clip === 'walkFormal' || p.clip === 'phoneWalk' || p.clip === 'umbrellaWalk') rate = (p.speed * (p.state === 'cross' ? 1.1 : 1) * pace) / WALK_CLIP_SPEED;
    if (p.clip === 'sprint') rate = p.speed / 5.2;
    p.clipT += dt * rate;
    p.prevT += dt;
    p.blend = Math.min(1, p.blend + dt / 0.25);
  }

  private buildFigures(camera: THREE.Camera, rain: number): void {
    const F = this.figures;
    F.length = 0;
    const R = this.render;
    for (const p of this.peds) {
      const g = p.look.gender;
      const fig: Figure = {
        x: p.vx,
        y: p.y,
        z: p.vz,
        yaw: p.yaw,
        look: p.look,
        rowA: R.row(g, p.clip, p.clipT),
        rowB: R.row(g, p.prev, p.prevT),
        blend: p.blend,
        prop: p.clip === 'phone' || p.clip === 'phoneWalk' ? 1 : p.clip === 'umbrella' || p.clip === 'umbrellaWalk' ? 2 : 0,
        propColor: p.umbrellaColor,
      };
      if (p.state === 'sit' || (p.state === 'goto' && p.next === 'sit' && p.blend < 1)) fig.y -= 0.0;
      F.push(fig);
    }
    // Drivers in nearby traffic.
    this.traffic.driverSeats(camera.position, 45, this.seats);
    if (this.driverLooks.size > 400) this.driverLooks.clear();
    for (const s of this.seats) {
      let look = this.driverLooks.get(s.id);
      if (!look) {
        look = makeLook(hashN(s.id, 4049));
        this.driverLooks.set(s.id, look);
      }
      F.push({ x: s.x, y: s.y - DRIVER_DROP, z: s.z, yaw: s.yaw, look, rowA: R.row(look.gender, 'drive', this.time + s.id * 0.37), rowB: 0, blend: 1, prop: 0 });
    }
    void rain;
  }

  /** Debug: count by state. */
  get stateCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of this.peds) out[p.state] = (out[p.state] ?? 0) + 1;
    return out;
  }
}
