/**
 * Driving brain for AICar: turns a goal into throttle / brake / steering.
 *
 * Navigation: A* over the lane graph (lanes as directed edges between junction nodes), giving a
 * waypoint polyline on the right-hand lanes; pure-pursuit steering with a speed-dependent
 * look-ahead; corner speed from the heading change ahead; two bumper rays for obstacle
 * avoidance; stuck recovery (reverse with opposite lock); auto-righting.
 *
 * Modes
 *  - route:  drive to `goal` (responding to a crime), then stop (`arrived`).
 *  - pursue: chase `target` (player car or getaway car). In line of sight within 70 m it drives
 *            straight at the predicted position and applies a tactic — 'chase' (follow), 'box'
 *            (hold an assigned slot ahead / beside / behind to hem the target in), 'ram' (full
 *            speed into it) or 'pit' (pull alongside the rear quarter, then steer into it to
 *            spin the target). Otherwise it routes to the target over the graph.
 *  - flee:   getaway driving: picks junctions far from every pursuer, drives fast with evasive
 *            swerves and handbrake turns, re-plans every few seconds or when a pursuer gets close.
 *  - park:   brake to a stop (handbrake on).
 */
import * as THREE from 'three';
import { physics, GROUPS_SHOT, GROUPS_PROBE, G_VEHICLE } from '../core/Physics';
import type { GNode, Lane, LaneGraph } from './LaneGraph';
import type { VehicleSim, DriveInput } from '../vehicles/VehicleSim';
import type { VehicleSpec } from '../vehicles/VehicleModels';

/** What the driver needs from a car (AICar, or an adapter around the player's Vehicle). */
export interface DrivenCar {
  readonly id: number;
  readonly sim: VehicleSim;
  readonly spec: VehicleSpec;
  readonly position: THREE.Vector3;
  readonly speed: number;
  readonly yaw: number;
  input: DriveInput;
  siren: boolean;
  driver: boolean;
  disabled: boolean;
  forward(out?: THREE.Vector3): THREE.Vector3;
}
import { hashN } from '../core/Random';

export type DriveMode = 'idle' | 'route' | 'pursue' | 'flee' | 'park';
export type Tactic = 'chase' | 'box' | 'ram' | 'pit';

export interface Target {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  /** The target is a vehicle (else a person on foot). */
  car: boolean;
}

/** Adjacency over graph nodes (built once per graph). */
const adjCache = new WeakMap<LaneGraph, Map<GNode, Lane[]>>();
function adjacency(g: LaneGraph): Map<GNode, Lane[]> {
  let m = adjCache.get(g);
  if (!m) {
    m = new Map();
    for (const l of g.lanes) {
      const arr = m.get(l.from) ?? [];
      arr.push(l);
      m.set(l.from, arr);
    }
    adjCache.set(g, m);
  }
  return m;
}

export function nearestNode(g: LaneGraph, x: number, z: number, filter?: (n: GNode) => boolean): GNode {
  let best = g.nodes[0];
  let bd = Infinity;
  for (const n of g.nodes) {
    if (!n.outgoing.length || (filter && !filter(n))) continue;
    const d = (n.x - x) ** 2 + (n.z - z) ** 2;
    if (d < bd) {
      bd = d;
      best = n;
    }
  }
  return best;
}

/** A* from a node to a node; returns the lane sequence. */
export function routeLanes(g: LaneGraph, from: GNode, to: GNode, avoid?: (n: GNode) => number): Lane[] {
  if (from === to) return [];
  const adj = adjacency(g);
  const open = new Map<GNode, number>([[from, 0]]);
  const gScore = new Map<GNode, number>([[from, 0]]);
  const prev = new Map<GNode, Lane>();
  const h = (n: GNode) => Math.hypot(n.x - to.x, n.z - to.z);
  let iter = 0;
  while (open.size && iter++ < 4000) {
    let cur: GNode | null = null;
    let cf = Infinity;
    for (const [n, f] of open) {
      if (f < cf) {
        cf = f;
        cur = n;
      }
    }
    if (!cur) break;
    open.delete(cur);
    if (cur === to) break;
    for (const l of adj.get(cur) ?? []) {
      const ng = gScore.get(cur)! + l.length + (avoid ? avoid(l.to) : 0);
      if (ng < (gScore.get(l.to) ?? Infinity)) {
        gScore.set(l.to, ng);
        prev.set(l.to, l);
        open.set(l.to, ng + h(l.to));
      }
    }
  }
  if (!prev.has(to)) return [];
  const out: Lane[] = [];
  let n = to;
  while (n !== from) {
    const l = prev.get(n);
    if (!l) break;
    out.unshift(l);
    n = l.from;
  }
  return out;
}

const _v = new THREE.Vector3();

export class Driver {
  mode: DriveMode = 'idle';
  goal: THREE.Vector3 | null = null;
  /** Stop within this distance of the goal (route mode). */
  stopDist = 10;
  arrived = false;
  target: Target | null = null;
  tactic: Tactic = 'chase';
  /** Box slot: 0 ahead, 1 left, 2 right, 3 behind. */
  slot = 0;
  maxSpeed = 22;
  /** Positions of pursuers (flee mode). */
  pursuers: () => THREE.Vector3[] = () => [];
  /** Waypoints. */
  pts: THREE.Vector3[] = [];
  private wp = 0;
  private replanT = 0;
  private stuckT = 0;
  private reverseT = 0;
  private flipT = 0;
  private losT = 0;
  private los = false;
  private time = 0;
  private swerve = 0;
  private blockT = 0;
  private lastObs = Infinity;
  private stuckCount = 0;
  private forceReplan = false;
  private passT = 0;

  constructor(
    readonly car: DrivenCar,
    readonly graph: LaneGraph,
  ) {}

  /** Drive to a point (stop near it). */
  routeTo(goal: THREE.Vector3, maxSpeed: number, stopDist = 10): void {
    this.mode = 'route';
    this.goal = goal.clone();
    this.maxSpeed = maxSpeed;
    this.stopDist = stopDist;
    this.arrived = false;
    this.plan(goal);
  }

  pursue(target: Target, tactic: Tactic = 'chase', maxSpeed = 32): void {
    if (this.mode !== 'pursue') this.replanT = 0;
    this.mode = 'pursue';
    this.target = target;
    this.tactic = tactic;
    this.maxSpeed = maxSpeed;
  }

  flee(pursuers: () => THREE.Vector3[], maxSpeed = 28): void {
    this.mode = 'flee';
    this.pursuers = pursuers;
    this.maxSpeed = maxSpeed;
    this.replanT = 0;
  }

  park(): void {
    this.mode = 'park';
  }

  /** Waypoints from the car's current lane to `goal`. */
  plan(goal: THREE.Vector3, avoid?: (n: GNode) => number): void {
    const c = this.car;
    const p = c.position;
    const f = c.forward(new THREE.Vector3());
    // Current lane: close, pointing roughly our way.
    let lane: Lane | null = null;
    let best = 22;
    let sAt = 0;
    const q = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
    for (const l of this.graph.lanesNear(p.x, p.z, 40)) {
      if (l.dirX * f.x + l.dirZ * f.z < 0.3) continue;
      // Project onto the lane polyline (lanes are straight).
      const x0 = l.xs[0];
      const z0 = l.zs[0];
      const along = (p.x - x0) * l.dirX + (p.z - z0) * l.dirZ;
      if (along < -6 || along > l.length + 6) continue;
      l.sample(Math.max(0, Math.min(l.length, along)), q);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < best) {
        best = d;
        lane = l;
        sAt = along;
      }
    }
    // Lane nearest the goal (prefer one with the goal on its kerb side): finish along it.
    let gl: Lane | null = null;
    let gS = 0;
    let gBest = Infinity;
    for (const l of this.graph.lanesNear(goal.x, goal.z, 60)) {
      const along = (goal.x - l.xs[0]) * l.dirX + (goal.z - l.zs[0]) * l.dirZ;
      const s = Math.max(0, Math.min(l.length, along));
      const lat = (goal.x - l.xs[0]) * -l.dirZ + (goal.z - l.zs[0]) * l.dirX;
      const d = Math.hypot(along - s, lat) + (lat < 0 ? 4 : 0);
      if (d < gBest) {
        gBest = d;
        gl = l;
        gS = s;
      }
    }
    const pts: THREE.Vector3[] = [];
    const lanePts = (l: Lane, s0: number, s1: number) => {
      for (let i = 0; i < l.xs.length; i++) {
        const along = (l.xs[i] - l.xs[0]) * l.dirX + (l.zs[i] - l.zs[0]) * l.dirZ;
        if (along > s0 && along <= s1) pts.push(new THREE.Vector3(l.xs[i], l.ys[i], l.zs[i]));
      }
      const q2 = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
      if (s1 < l.length) {
        l.sample(s1, q2);
        pts.push(new THREE.Vector3(q2.x, q2.y, q2.z));
      }
    };
    if (lane && gl === lane && gS > sAt + 2) {
      lanePts(lane, sAt + 4, gS);
    } else {
      let start: GNode;
      if (lane) {
        lanePts(lane, sAt + 4, lane.length);
        start = lane.to;
      } else start = nearestNode(this.graph, p.x, p.z);
      const end = gl ? gl.from : nearestNode(this.graph, goal.x, goal.z);
      let prev: Lane | null = lane;
      const route = routeLanes(this.graph, start, end, avoid);
      if (gl) route.push(gl);
      for (const [k, l] of route.entries()) {
        // Junction curve (Bezier connection) when there is a legal one.
        const con = prev?.next.find((c) => c.to === l);
        if (con) for (let i = 1; i < con.xs.length - 1; i++) pts.push(new THREE.Vector3(con.xs[i], con.ys[i], con.zs[i]));
        else if (prev) {
          // No legal movement from this lane (e.g. turning from the inner lane): a smooth curve anyway.
          const a = new THREE.Vector3(prev.xs[prev.xs.length - 1], prev.ys[prev.ys.length - 1], prev.zs[prev.zs.length - 1]);
          const b = new THREE.Vector3(l.xs[0], l.ys[0], l.zs[0]);
          const k = a.distanceTo(b) * 0.5;
          const c1 = a.clone().add(new THREE.Vector3(prev.dirX * k, 0, prev.dirZ * k));
          const c2 = b.clone().add(new THREE.Vector3(-l.dirX * k, 0, -l.dirZ * k));
          for (let i = 1; i < 8; i++) {
            const t = i / 8;
            const u = 1 - t;
            pts.push(new THREE.Vector3().addScaledVector(a, u * u * u).addScaledVector(c1, 3 * u * u * t).addScaledVector(c2, 3 * u * t * t).addScaledVector(b, t * t * t));
          }
        }
        lanePts(l, -1, k === route.length - 1 && gl ? gS : l.length + 1);
        prev = l;
      }
    }
    pts.push(goal.clone().setY(gl ? gl.ys[0] : goal.y));
    this.pts = pts;
    this.wp = 0;
  }

  update(dt: number): void {
    this.time += dt;
    const c = this.car;
    const inp = c.input;
    inp.handbrake = false;
    if (c.disabled || !c.driver) {
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = 0;
      return;
    }
    const sim = c.sim;
    // Righting a flipped car.
    this.flipT = sim.upsideDown ? this.flipT + dt : 0;
    if (this.flipT > 3) {
      sim.resetUpright();
      this.flipT = 0;
    }
    if (this.mode === 'idle' || this.mode === 'park') {
      inp.throttle = 0;
      inp.brake = Math.abs(c.speed) > 0.5 ? 1 : 0;
      inp.handbrake = Math.abs(c.speed) < 2;
      inp.steer = 0;
      return;
    }
    const p = c.position;
    const v = Math.abs(c.speed);
    let aim: THREE.Vector3 | null = null;
    let vDes = this.maxSpeed;
    let avoidObstacles = true;
    let ignoreCorner = false;
    if (this.mode === 'route') {
      const dg = this.goal ? Math.hypot(this.goal.x - p.x, this.goal.z - p.z) : 0;
      if (this.goal && dg < this.stopDist) {
        this.arrived = true;
        this.mode = 'park';
        return;
      }
      if (this.goal) vDes = Math.min(vDes, 4 + dg * 0.45);
      this.replanT -= dt;
      if (this.goal && (this.forceReplan || (this.replanT <= 0 && this.pts.length - this.wp < 2))) {
        this.forceReplan = false;
        this.replanT = 3;
        this.plan(this.goal);
      }
    } else if (this.mode === 'pursue' && this.target) {
      const T = this.target;
      const d = Math.hypot(T.pos.x - p.x, T.pos.z - p.z);
      this.losT -= dt;
      if (this.losT <= 0) {
        this.losT = 0.3;
        const eye = p.clone().setY(p.y + 1.5);
        const to = T.pos.clone().setY(T.pos.y + 1.0).sub(eye);
        const len = to.length();
        this.los = len < 75 && !physics.rayHit(eye, to.normalize(), len - 1, GROUPS_PROBE);
      }
      if (this.los) {
        const tv = T.vel;
        const tSpeed = Math.hypot(tv.x, tv.z);
        const tf = _v.set(Math.sin(T.yaw), 0, Math.cos(T.yaw));
        const tl = new THREE.Vector3(tf.z, 0, -tf.x); // target's left (+X local)
        const tPred = THREE.MathUtils.clamp(d / Math.max(6, v), 0, 1.4);
        const pred = T.pos.clone().addScaledVector(tv, tPred);
        aim = pred;
        if (!T.car) {
          // On foot: stop next to them.
          vDes = Math.max(0, Math.min(this.maxSpeed, (d - 9) * 0.8));
          if (d < 11) {
            this.arrived = true;
            vDes = 0;
          }
        } else if (this.tactic === 'ram') {
          vDes = this.maxSpeed;
          avoidObstacles = d > 20;
          ignoreCorner = true;
        } else if (this.tactic === 'pit') {
          const rel = p.clone().sub(T.pos);
          const along = rel.dot(tf);
          const side = Math.sign(rel.dot(tl)) || 1;
          if (along < -6 || d > 14) {
            // Catch up to the rear quarter.
            aim = T.pos.clone().addScaledVector(tf, -1.8).addScaledVector(tl, side * 2.2).addScaledVector(tv, 0.4);
            vDes = tSpeed + Math.min(10, d * 0.6);
          } else {
            // Alongside the rear wheels: turn in.
            aim = T.pos.clone().addScaledVector(tf, -1.2).addScaledVector(tl, -side * 1.5).addScaledVector(tv, 0.3);
            vDes = tSpeed + 2.5;
            avoidObstacles = false;
          }
          ignoreCorner = true;
        } else if (this.tactic === 'box') {
          const off = [
            [10, 0],
            [0, 3.4],
            [0, -3.4],
            [-9, 0],
          ][this.slot % 4];
          const slotP = T.pos.clone().addScaledVector(tf, off[0]).addScaledVector(tl, off[1]);
          aim = slotP.clone().addScaledVector(tv, 0.6);
          const ahead = slotP.clone().sub(p).dot(tf);
          vDes = Math.max(0, tSpeed + THREE.MathUtils.clamp(ahead * 0.7, -8, 12));
          ignoreCorner = d < 30;
          avoidObstacles = d > 12;
        } else {
          vDes = Math.max(6, tSpeed + (d - 10) * 0.7);
        }
        vDes = Math.min(vDes, this.maxSpeed);
        this.pts = [];
      } else {
        this.replanT -= dt;
        if (this.replanT <= 0 || this.pts.length - this.wp < 2) {
          this.replanT = 2.2;
          this.plan(T.pos);
        }
      }
    } else if (this.mode === 'flee') {
      const ps = this.pursuers();
      let near = Infinity;
      for (const q of ps) near = Math.min(near, Math.hypot(q.x - p.x, q.z - p.z));
      this.replanT -= dt;
      if (this.replanT <= 0 || this.pts.length - this.wp < 3 || (near < 25 && this.replanT < 3.5)) {
        this.replanT = 6;
        this.pickEscape(ps);
      }
      // Evasive swerves when a pursuer is close.
      if (near < 30) this.swerve = Math.sin(this.time * 1.7 + (this.car.id % 7)) * 0.25;
      else this.swerve *= 0.95;
    }
    if (!aim) aim = this.lookAhead(v);
    if (!aim) {
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = 0;
      return;
    }
    // Pure pursuit steering.
    const yaw = c.yaw;
    const toA = Math.atan2(aim.x - p.x, aim.z - p.z);
    let err = toA - yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const Ld = Math.max(4, Math.hypot(aim.x - p.x, aim.z - p.z));
    const wb = c.spec.frontAxle - c.spec.rearAxle;
    const delta = Math.atan2(2 * wb * Math.sin(err), Ld);
    const maxSteer = THREE.MathUtils.lerp(sim.tune.maxSteer, sim.tune.highSpeedSteer, Math.min(1, v / 38));
    let steer = THREE.MathUtils.clamp(-delta / maxSteer, -1, 1) + this.swerve;
    // Corner speed.
    if (!ignoreCorner && this.pts.length) vDes = Math.min(vDes, this.cornerSpeed(v));
    // Facing away from the aim: slow down to turn.
    if (Math.abs(err) > 1.2) vDes = Math.min(vDes, 8);
    // Obstacles; blocked by a car for a moment -> pull out and pass on the left.
    if (avoidObstacles) {
      const o = this.obstacles(v);
      this.lastObs = o.d;
      if (o.d < Infinity) {
        const stop = 3 + (v * v) / 12;
        if (o.d < stop) vDes = Math.min(vDes, Math.max(0, (o.d - 3) * 0.9));
        steer += o.steer;
        if (o.car && o.d < 18) this.blockT += dt;
      } else this.blockT = Math.max(0, this.blockT - dt);
      // Emergency / pursuit: pass at once; otherwise only round a car that stays stopped.
      if (this.passT <= 0 && (this.blockT > 3 || (this.blockT > 0.8 && (this.mode !== 'route' || this.car.siren)))) this.passT = 3;
    }
    if (this.passT > 0) {
      this.passT -= dt;
      steer -= 0.35 * Math.min(1, this.passT);
      vDes = Math.max(vDes, 9);
      if (this.passT <= 0) this.blockT = 0;
    }
    // Stuck recovery.
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      inp.throttle = 0;
      inp.brake = 1;
      inp.steer = -Math.sign(steer || 1);
      return;
    }
    if (v < 1 && (vDes > 3 || this.lastObs < 4)) {
      this.stuckT += dt;
      if (this.stuckT > 2.2) {
        this.stuckT = 0;
        this.reverseT = 1.6;
        // Second time stuck in a row: plan a fresh route once backed off.
        if (++this.stuckCount >= 2 && ((this.mode === 'route' && this.goal) || this.mode === 'flee')) {
          this.stuckCount = 0;
          if (this.mode === 'flee') this.replanT = 1.7;
          else this.forceReplan = true;
        }
      }
    } else {
      this.stuckT = 0;
      if (v > 4) this.stuckCount = 0;
    }
    inp.steer = THREE.MathUtils.clamp(steer, -1, 1);
    const fwdSpeed = c.speed;
    const dv = vDes - fwdSpeed;
    inp.throttle = THREE.MathUtils.clamp(dv * 0.35, 0, 1);
    inp.brake = dv < -1 ? THREE.MathUtils.clamp(-dv * 0.25, 0, 1) : 0;
    // Getaway handbrake turns on sharp corners at speed.
    inp.handbrake = this.mode === 'flee' && Math.abs(err) > 0.9 && v > 12 && hashN(this.car.id, Math.floor(this.time)) % 2 === 0;
  }

  /** Point on the waypoint polyline ~look-ahead metres away (tracks the closest point). */
  private lookAhead(v: number): THREE.Vector3 | null {
    const P = this.pts;
    if (!P.length) return null;
    const p = this.car.position;
    const L = THREE.MathUtils.clamp(4 + v * 0.38, 5.5, 15);
    // Closest polyline point within the next few waypoints.
    let best = this.wp;
    let bd = Infinity;
    for (let i = this.wp; i < Math.min(P.length, this.wp + 14); i++) {
      const d = Math.hypot(P[i].x - p.x, P[i].z - p.z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    this.wp = best;
    const f = this.car.forward(_v);
    for (let i = this.wp; i < P.length; i++) {
      const a = P[i];
      const dx = a.x - p.x;
      const dz = a.z - p.z;
      if (Math.hypot(dx, dz) >= L && dx * f.x + dz * f.z > -2) return a;
    }
    return P[P.length - 1];
  }

  /**
   * Max speed for the turn ahead: for every path segment within braking distance, the heading
   * change from the car's heading; a turn of angle a at distance d allows sqrt(vTurn² + 2·b·d).
   */
  private cornerSpeed(v: number): number {
    const P = this.pts;
    const win = 15 + (v * v) / 9;
    const yaw = this.car.yaw;
    const p = this.car.position;
    let acc = Math.hypot(P[this.wp].x - p.x, P[this.wp].z - p.z);
    let lim = this.maxSpeed;
    for (let i = this.wp; i < P.length - 1 && acc < win; i++) {
      const dx = P[i + 1].x - P[i].x;
      const dz = P[i + 1].z - P[i].z;
      const l = Math.hypot(dx, dz);
      if (l < 0.3) continue;
      let d = Math.atan2(dx, dz) - yaw;
      d = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
      const vTurn = THREE.MathUtils.lerp(this.maxSpeed, 7, THREE.MathUtils.clamp((d - 0.15) / 1.0, 0, 1));
      lim = Math.min(lim, Math.sqrt(vTurn * vTurn + 2 * 5.5 * acc));
      acc += l;
    }
    return lim;
  }

  /** Two bumper rays: nearest hit distance and a steering nudge away from it. */
  private obstacles(v: number): { d: number; steer: number; car: boolean } {
    const c = this.car;
    const p = c.sim.curPos;
    const f = c.forward(new THREE.Vector3());
    const left = new THREE.Vector3(f.z, 0, -f.x);
    const len = 6 + v * 1.1;
    let d = Infinity;
    let steer = 0;
    let car = false;
    const front = c.spec.length / 2 + 0.2;
    // Steering-aware: the rays bend with the front wheels.
    const turn = new THREE.Vector3().copy(f).applyAxisAngle(new THREE.Vector3(0, 1, 0), c.sim.steer * 0.8);
    for (const side of [-1, 0, 1]) {
      const o = new THREE.Vector3(p.x, p.y - c.sim.chassisY + 0.7, p.z).addScaledVector(f, front).addScaledVector(left, side * (c.spec.width / 2 - 0.15));
      const dir = turn.clone().addScaledVector(left, side * 0.06).normalize();
      const h = physics.rayExcluding(o, dir, side === 0 ? len : len * 0.8, GROUPS_SHOT, c.sim.chassis);
      if (h) {
        d = Math.min(d, h.dist);
        if ((h.collider.collisionGroups() >>> 16) & G_VEHICLE) car = true;
        // Obstacle on the left (+side) -> steer right (+).
        if (side !== 0) steer += side * 0.5 * (1 - h.dist / len);
      }
    }
    return { d, steer, car };
  }

  /** Getaway: route to a junction far from every pursuer. */
  private pickEscape(ps: THREE.Vector3[]): void {
    const p = this.car.position;
    let best: GNode | null = null;
    let bs = -Infinity;
    const f = this.car.forward(new THREE.Vector3());
    for (const n of this.graph.nodes) {
      if (!n.outgoing.length) continue;
      const d = Math.hypot(n.x - p.x, n.z - p.z);
      if (d < 150 || d > 480) continue;
      let minP = Infinity;
      for (const q of ps) minP = Math.min(minP, Math.hypot(n.x - q.x, n.z - q.z));
      const ahead = ((n.x - p.x) * f.x + (n.z - p.z) * f.z) / d;
      const s = Math.min(minP, 400) + ahead * 60 + (hashN(n.id, Math.floor(this.time / 6), this.car.id) % 100) * 0.6;
      if (s > bs) {
        bs = s;
        best = n;
      }
    }
    if (!best) return;
    // Avoid junctions close to pursuers along the way.
    this.plan(new THREE.Vector3(best.x, 0, best.z), (n) => {
      let m = Infinity;
      for (const q of ps) m = Math.min(m, Math.hypot(n.x - q.x, n.z - q.z));
      return m < 60 ? 400 : 0;
    });
  }
}
