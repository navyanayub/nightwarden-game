/**
 * Lane graph for traffic AI, derived from the street plan.
 *
 * Every road segment gets 1-2 directed lanes per direction (right-hand traffic, offsets match
 * the painted markings). A lane runs from the far side of one junction's crossing to the stop
 * line of the next; junctions are bridged by *connections* (Bezier turn paths) from each
 * incoming lane to the allowed outgoing lanes (inner lane: straight/left, outer: straight/right,
 * single lane: any). Dead ends get U-turns. Connections that cross within a car width are marked
 * as conflicting, which the traffic sim uses as an intersection reservation table.
 * The bridge carriageway is added as an extra segment with a U-turn loop on Gullhaven Island.
 */
import type { CityData, RoadNode, RoadSeg } from '../world/CityLayout';
import { heightAt } from '../world/Terrain';
import { BRIDGE, bridgeDeckY, districtAt, type District } from '../world/WorldConfig';
import { hashFloat } from '../core/Random';

/** A drivable polyline (lane or junction connection). */
export class Path {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  /** Cumulative length at each point. */
  readonly cum: Float32Array;
  readonly length: number;
  /** Cars currently on this path (unsorted; the sim sorts lazily). */
  cars: number[] = [];
  next: Connection[] = [];
  constructor(
    readonly id: number,
    pts: [number, number, number][],
  ) {
    const n = pts.length;
    this.xs = new Float32Array(n);
    this.ys = new Float32Array(n);
    this.zs = new Float32Array(n);
    this.cum = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.xs[i] = pts[i][0];
      this.ys[i] = pts[i][1];
      this.zs[i] = pts[i][2];
      if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]);
      this.cum[i] = acc;
    }
    this.length = acc;
  }

  /** Segment index containing distance s. */
  seg(s: number): number {
    const c = this.cum;
    let lo = 0;
    let hi = c.length - 1;
    if (s <= 0) return 0;
    if (s >= this.length) return c.length - 2;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (c[m] <= s) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Sample position + heading (unit dx, dz) at distance s. */
  sample(s: number, out: { x: number; y: number; z: number; dx: number; dz: number }): void {
    const i = this.seg(s);
    const l = this.cum[i + 1] - this.cum[i];
    const t = l > 1e-6 ? Math.min(1, Math.max(0, (s - this.cum[i]) / l)) : 0;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * t;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t;
    const dx = this.xs[i + 1] - this.xs[i];
    const dz = this.zs[i + 1] - this.zs[i];
    const dl = Math.hypot(dx, dz) || 1;
    out.dx = dx / dl;
    out.dz = dz / dl;
  }
}

export class Lane extends Path {
  /** 0 = inner (next to the centre line), 1 = outer (kerb side). */
  idx = 0;
  lanes = 1;
  /** Same-direction neighbour lanes for lane changes. */
  left: Lane | null = null;
  right: Lane | null = null;
  speedLimit = 13;
  from!: GNode;
  to!: GNode;
  road!: RoadSeg;
  /** Unit direction of travel. */
  dirX = 0;
  dirZ = 0;
  district: District = 'midtown';
  /** Lateral offset from the road centre line (+ = right of the segment's +axis direction). */
  offset = 0;
}

export type Turn = 'straight' | 'left' | 'right' | 'uturn';

export class Connection extends Path {
  from!: Lane;
  to!: Lane;
  node!: GNode;
  turn: Turn = 'straight';
  conflicts: Connection[] = [];
  /** Cars currently inside this connection. */
  occupants = 0;
  /** Signal axis this movement belongs to ('ns' | 'ew'), from the incoming lane. */
  axis: 'ns' | 'ew' = 'ns';
}

export class GNode {
  incoming: Lane[] = [];
  outgoing: Lane[] = [];
  connections: Connection[] = [];
  /** Signal phase offset (s). */
  offset = 0;
  constructor(
    readonly id: number,
    readonly x: number,
    readonly z: number,
    readonly road: RoadNode | null,
  ) {}
  get signal(): boolean {
    return !!this.road?.signal;
  }
  get arms(): number {
    return this.road?.arms ?? 1;
  }
}

/** Signal timing (seconds). */
export const SIGNAL = { green: 17, amber: 3, allRed: 2 };
const CYCLE = 2 * (SIGNAL.green + SIGNAL.amber + SIGNAL.allRed);

/** Light state for an axis at a signal node: 0 red, 1 amber, 2 green. Also the ped "walk" flag. */
export function signalState(node: GNode, axis: 'ns' | 'ew', time: number): 0 | 1 | 2 {
  const t = (((time + node.offset) % CYCLE) + CYCLE) % CYCLE;
  const half = SIGNAL.green + SIGNAL.amber + SIGNAL.allRed;
  const local = axis === 'ns' ? t : (t + half) % CYCLE;
  if (local < SIGNAL.green) return 2;
  if (local < SIGNAL.green + SIGNAL.amber) return 1;
  return 0;
}

/** Seconds of green remaining for an axis (0 when not green). */
export function greenLeft(node: GNode, axis: 'ns' | 'ew', time: number): number {
  const t = (((time + node.offset) % CYCLE) + CYCLE) % CYCLE;
  const half = SIGNAL.green + SIGNAL.amber + SIGNAL.allRed;
  const local = axis === 'ns' ? t : (t + half) % CYCLE;
  return local < SIGNAL.green ? SIGNAL.green - local : 0;
}

function roadY(x: number, z: number): number {
  if (Math.abs(z - BRIDGE.z) < BRIDGE.width / 2 && x > BRIDGE.startX - 2 && x < BRIDGE.endX + 2) return Math.max(bridgeDeckY(x), heightAt(x, z));
  return heightAt(x, z);
}

function laneOffsets(r: RoadSeg): number[] {
  if (r.kind === 'avenue') return [3.9, 8.3];
  if (r.width >= 15) {
    const hw = r.width / 2;
    return [hw * 0.29, hw * 0.72];
  }
  return [r.width / 4];
}

export class LaneGraph {
  nodes: GNode[] = [];
  lanes: Lane[] = [];
  connections: Connection[] = [];
  private nextId = 0;
  /** Spatial index of lanes (60 m cells) for spawning. */
  private grid = new Map<string, Lane[]>();

  constructor(city: CityData) {
    const nodeMap = new Map<string, GNode>();
    const key = (x: number, z: number) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
    for (const n of city.nodes) {
      const g = new GNode(this.nodes.length, n.x, n.z, n);
      g.offset = hashFloat(Math.round(n.x), Math.round(n.z), 71) * CYCLE;
      nodeMap.set(key(n.x, n.z), g);
      this.nodes.push(g);
    }
    const roads = [...city.roads];
    // Bridge carriageway to the island, ending in a turning loop.
    const bridgeStart = nodeMap.get(key(BRIDGE.startX, BRIDGE.z));
    let bridgeEnd: GNode | null = null;
    if (bridgeStart) {
      const ex = BRIDGE.endX + 60;
      const seg: RoadSeg = { x0: BRIDGE.startX, z0: BRIDGE.z, x1: ex, z1: BRIDGE.z, axis: 'x', width: 18, kind: 'arterial', surface: 'asphalt', name: 'Narrows Bridge' };
      roads.push(seg);
      bridgeEnd = new GNode(this.nodes.length, ex, BRIDGE.z, null);
      this.nodes.push(bridgeEnd);
      nodeMap.set(key(ex, BRIDGE.z), bridgeEnd);
    }
    const nodeOf = (x: number, z: number) => nodeMap.get(key(x, z));
    const box = (n: GNode, axis: 'x' | 'z') => {
      const r = n.road;
      if (!r) return 0;
      const half = axis === 'x' ? r.hx : r.hz;
      return half + (r.arms >= 3 ? 5.2 : 0.5);
    };
    // Lanes.
    for (const r of roads) {
      const a = nodeOf(r.x0, r.z0);
      const b = nodeOf(r.x1, r.z1);
      if (!a || !b) continue;
      const offs = laneOffsets(r);
      const along = r.axis === 'x' ? [r.x0 + box(a, 'x'), r.x1 - box(b, 'x')] : [r.z0 + box(a, 'z'), r.z1 - box(b, 'z')];
      if (along[1] - along[0] < 6) continue;
      for (const dir of [1, -1] as const) {
        const group: Lane[] = [];
        offs.forEach((off, idx) => {
          // Right of travel: heading +axis => right is +Z for 'x' roads, -X for 'z' roads.
          const dX = r.axis === 'x' ? dir : 0;
          const dZ = r.axis === 'z' ? dir : 0;
          const rx = -dZ;
          const rz = dX;
          const pts: [number, number, number][] = [];
          const s0 = dir > 0 ? along[0] : along[1];
          const s1 = dir > 0 ? along[1] : along[0];
          const len = Math.abs(s1 - s0);
          const n = Math.max(2, Math.ceil(len / 8));
          for (let i = 0; i <= n; i++) {
            const s = s0 + ((s1 - s0) * i) / n;
            const x = (r.axis === 'x' ? s : r.x0) + rx * off;
            const z = (r.axis === 'z' ? s : r.z0) + rz * off;
            pts.push([x, roadY(x, z), z]);
          }
          const lane = new Lane(this.nextId++, pts);
          lane.idx = idx;
          lane.lanes = offs.length;
          lane.road = r;
          lane.from = dir > 0 ? a : b;
          lane.to = dir > 0 ? b : a;
          lane.dirX = dX;
          lane.dirZ = dZ;
          lane.offset = off;
          lane.speedLimit = r.kind === 'avenue' ? 15 : r.kind === 'arterial' ? 14 : r.kind === 'lane' ? 7.5 : 11.5;
          if (r.name === 'Narrows Bridge') lane.speedLimit = 19;
          const mx = (pts[0][0] + pts[pts.length - 1][0]) / 2;
          const mz = (pts[0][2] + pts[pts.length - 1][2]) / 2;
          lane.district = districtAt(mx, mz);
          lane.from.outgoing.push(lane);
          lane.to.incoming.push(lane);
          this.lanes.push(lane);
          group.push(lane);
        });
        if (group.length === 2) {
          // idx0 = inner (left of travel), idx1 = outer (right).
          group[0].right = group[1];
          group[1].left = group[0];
        }
      }
    }
    // Connections at every node.
    for (const n of this.nodes) {
      for (const inL of n.incoming) {
        const options: { out: Lane; turn: Turn }[] = [];
        for (const outL of n.outgoing) {
          const reverse = outL.road === inL.road;
          const cross = inL.dirX * outL.dirZ - inL.dirZ * outL.dirX;
          const dot = inL.dirX * outL.dirX + inL.dirZ * outL.dirZ;
          let turn: Turn;
          if (reverse) turn = 'uturn';
          else if (dot > 0.7) turn = 'straight';
          // Heading (dx,dz) -> turning right means new dir = right(old) = (-dz, dx); cross > 0.
          else turn = cross > 0 ? 'right' : 'left';
          if (turn === 'uturn' && n.incoming.length > 1) continue;
          // Lane discipline.
          if (inL.lanes === 2 && outL.lanes === 2) {
            if (turn === 'straight' && inL.idx !== outL.idx) continue;
            if (turn === 'left' && (inL.idx !== 0 || outL.idx !== 0)) continue;
            if (turn === 'right' && (inL.idx !== 1 || outL.idx !== 1)) continue;
          } else if (inL.lanes === 2) {
            if (turn === 'left' && inL.idx !== 0) continue;
            if (turn === 'right' && inL.idx !== 1) continue;
          } else if (outL.lanes === 2) {
            if (turn === 'left' && outL.idx !== 0) continue;
            if (turn === 'right' && outL.idx !== 1) continue;
            if (turn === 'straight' && outL.idx !== 1) continue;
          }
          if (turn === 'uturn' && outL.idx !== 0 && outL.lanes === 2) continue;
          options.push({ out: outL, turn });
        }
        for (const o of options) {
          const c = this.connect(inL, o.out, n, o.turn);
          inL.next.push(c);
          n.connections.push(c);
          this.connections.push(c);
        }
      }
      // Conflicts: paths that pass within ~2.2 m of each other (excluding same origin lane).
      const cs = n.connections;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const A = cs[i];
          const B = cs[j];
          if (A.from === B.from) continue;
          if (A.to === B.to || pathsTouch(A, B, 2.3)) {
            A.conflicts.push(B);
            B.conflicts.push(A);
          }
        }
      }
    }
    for (const l of this.lanes) {
      const mx = (l.xs[0] + l.xs[l.xs.length - 1]) / 2;
      const mz = (l.zs[0] + l.zs[l.zs.length - 1]) / 2;
      const k = `${Math.floor(mx / 60)},${Math.floor(mz / 60)}`;
      const arr = this.grid.get(k) ?? [];
      arr.push(l);
      this.grid.set(k, arr);
    }
  }

  private connect(a: Lane, b: Lane, n: GNode, turn: Turn): Connection {
    const p0 = [a.xs[a.xs.length - 1], a.ys[a.ys.length - 1], a.zs[a.zs.length - 1]];
    const p3 = [b.xs[0], b.ys[0], b.zs[0]];
    const d = Math.hypot(p3[0] - p0[0], p3[2] - p0[2]);
    let k = turn === 'straight' ? d / 3 : d * 0.55;
    if (turn === 'uturn') k = Math.max(6, d * 1.4);
    const p1 = [p0[0] + a.dirX * k, 0, p0[2] + a.dirZ * k];
    const p2 = [p3[0] - b.dirX * k, 0, p3[2] - b.dirZ * k];
    const pts: [number, number, number][] = [];
    const steps = turn === 'straight' ? 4 : 10;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
      const z = u * u * u * p0[2] + 3 * u * u * t * p1[2] + 3 * u * t * t * p2[2] + t * t * t * p3[2];
      const y = p0[1] + (p3[1] - p0[1]) * t;
      pts.push([x, Math.max(y, roadY(x, z) - 0.05), z]);
    }
    const c = new Connection(this.nextId++, pts);
    c.from = a;
    c.to = b;
    c.node = n;
    c.turn = turn;
    c.axis = a.road.axis === 'z' ? 'ns' : 'ew';
    c.next = [];
    return c;
  }

  /** Lanes whose midpoint is in the 60 m cells overlapping a disc. */
  lanesNear(x: number, z: number, r: number): Lane[] {
    const out: Lane[] = [];
    const c0x = Math.floor((x - r) / 60);
    const c1x = Math.floor((x + r) / 60);
    const c0z = Math.floor((z - r) / 60);
    const c1z = Math.floor((z + r) / 60);
    for (let i = c0x; i <= c1x; i++) for (let j = c0z; j <= c1z; j++) for (const l of this.grid.get(`${i},${j}`) ?? []) out.push(l);
    return out;
  }
}

function pathsTouch(a: Path, b: Path, d: number): boolean {
  const d2 = d * d;
  for (let i = 0; i < a.xs.length - 1; i++) {
    const ax0 = a.xs[i];
    const az0 = a.zs[i];
    const ax1 = a.xs[i + 1];
    const az1 = a.zs[i + 1];
    for (let j = 0; j < b.xs.length - 1; j++) {
      const bx0 = b.xs[j];
      const bz0 = b.zs[j];
      const bx1 = b.xs[j + 1];
      const bz1 = b.zs[j + 1];
      if (Math.max(ax0, ax1) + d < Math.min(bx0, bx1) || Math.max(bx0, bx1) + d < Math.min(ax0, ax1)) continue;
      if (Math.max(az0, az1) + d < Math.min(bz0, bz1) || Math.max(bz0, bz1) + d < Math.min(az0, az1)) continue;
      if (segSegDist2(ax0, az0, ax1, az1, bx0, bz0, bx1, bz1) < d2) return true;
    }
  }
  return false;
}

function ptSegDist2(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2)) : 0;
  const qx = x0 + dx * t - px;
  const qz = z0 + dz * t - pz;
  return qx * qx + qz * qz;
}

function segSegDist2(ax0: number, az0: number, ax1: number, az1: number, bx0: number, bz0: number, bx1: number, bz1: number): number {
  const cross = (ox: number, oz: number, px: number, pz: number, qx: number, qz: number) => (px - ox) * (qz - oz) - (pz - oz) * (qx - ox);
  const d1 = cross(ax0, az0, ax1, az1, bx0, bz0);
  const d2 = cross(ax0, az0, ax1, az1, bx1, bz1);
  const d3 = cross(bx0, bz0, bx1, bz1, ax0, az0);
  const d4 = cross(bx0, bz0, bx1, bz1, ax1, az1);
  if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
  return Math.min(ptSegDist2(ax0, az0, bx0, bz0, bx1, bz1), ptSegDist2(ax1, az1, bx0, bz0, bx1, bz1), ptSegDist2(bx0, bz0, ax0, az0, ax1, az1), ptSegDist2(bx1, bz1, ax0, az0, ax1, az1));
}
