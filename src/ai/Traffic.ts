/**
 * Traffic simulation on the lane graph.
 *
 * Cars follow paths (lanes and junction connections) with the Intelligent Driver Model:
 * the leader is the nearest car ahead along the planned route, a red/amber light or a junction
 * they may not enter yet (conflicting movement inside the box, exit lane full, stop sign not
 * yet observed), or an obstacle (player, player's car, pedestrian) lying on the path ahead.
 * Multi-lane roads allow overtaking lane changes. Cars spawn out of view around the player with
 * a density that depends on the district and the hour, and despawn when far or long unseen.
 * A small fixed fleet of buses runs a loop with stops; they are never despawned.
 *
 * Cars near the player get kinematic Rapier bodies so the player and the player's car collide
 * with them; a hard hit turns a car into a dynamic "wreck" that physics takes over.
 */
import * as THREE from 'three';
import { physics, RAPIER, GROUPS_VEHICLE } from '../core/Physics';
import { hashFloat, Rng } from '../core/Random';
import { events } from '../core/EventBus';
import { SPECS, type VehicleSpec } from '../vehicles/VehicleModels';
import { Connection, Lane, LaneGraph, Path, greenLeft, signalState } from './LaneGraph';
import { RENDER_KINDS, TrafficRender, type CarRenderState } from './TrafficRender';
import type { District } from '../world/WorldConfig';

export interface Obstacle {
  x: number;
  z: number;
  r: number;
  /** Pedestrians are yielded to; the player triggers horns. */
  kind: 'ped' | 'player' | 'car';
}

export interface TrafficCar extends CarRenderState {
  id: number;
  spec: VehicleSpec;
  path: Path;
  s: number;
  speed: number;
  v0: number;
  route: Path[];
  latOff: number;
  state: 'drive' | 'wreck' | 'parked';
  driver: boolean;
  stopDone: boolean;
  waitT: number;
  unseenT: number;
  hornT: number;
  blockedT: number;
  bus: { stop: number; dwell: number } | null;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  indicator: number;
  laneChangeCool: number;
  /** Distance to a stop line the car is holding at (for pedestrians crossing). */
  holding: boolean;
  checkT: number;
  obsGap: number;
  /** Never despawned (showcase / buses). */
  persistent?: boolean;
}

const DENSITY: Record<District, number> = { midtown: 1, oldtown: 0.55, harbour: 0.65, industrial: 0.5, hills: 0.4, park: 0.3, island: 0.35, sea: 0 };
const IDM = { a: 1.8, b: 3.2, s0: 2.4, T: 1.25 };
const _p = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
const _q = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };

export interface BusStop {
  lane: Lane;
  s: number;
  x: number;
  z: number;
  yaw: number;
}

export class Traffic {
  readonly graph: LaneGraph;
  readonly render: TrafficRender;
  cars: TrafficCar[] = [];
  private nextId = 1;
  private rng = new Rng(0x5eed7);
  private spawnT = 0;
  time = 0;
  /** Target number of simulated cars (preset * district * hour). */
  target = 0;
  maxCars: number;
  obstacles: Obstacle[] = [];
  readonly busRoute: Path[] = [];
  readonly busStops: BusStop[] = [];
  private frustum = new THREE.Frustum();
  private projView = new THREE.Matrix4();
  /** Collider handles of the player's vehicle (for crash detection). */
  playerColliders: RAPIER.Collider[] = [];
  playerVehicleSpeed = 0;

  constructor(graph: LaneGraph, maxCars: number) {
    this.graph = graph;
    this.maxCars = maxCars;
    this.render = new TrafficRender(Math.ceil(maxCars * 0.6) + 10);
    this.buildBusRoute();
  }

  // ---------------------------------------------------------------- buses

  private buildBusRoute(): void {
    // Loop through Midtown and Old Town along the main roads: BFS over legal lane connections
    // between corner waypoints, so every turn in the loop is a real junction movement.
    const corners: [number, number][] = [
      [20, -270],
      [330, -270],
      [330, 240],
      [-230, 240],
      [-230, -270],
    ];
    const nodeAt = (x: number, z: number) => this.graph.nodes.reduce((b, n) => (Math.hypot(n.x - x, n.z - z) < Math.hypot(b.x - x, b.z - z) ? n : b), this.graph.nodes[0]);
    const nodes = corners.map(([x, z]) => nodeAt(x, z));
    const route: Path[] = [];
    let starts: { lane: Lane; via: Connection | null }[] = nodes[0].outgoing.filter((l) => l.idx === l.lanes - 1).map((lane) => ({ lane, via: null }));
    for (let i = 1; i <= nodes.length; i++) {
      const goal = nodes[i % nodes.length];
      const firstLane = route.length ? (route[0] as Lane) : null;
      const seg = this.bfs(starts, (l) => (i === nodes.length && firstLane ? l.next.some((c) => c.to === firstLane) : l.to === goal));
      if (!seg) return;
      route.push(...seg);
      const last = route[route.length - 1] as Lane;
      if (i === nodes.length && firstLane) {
        route.push(last.next.find((c) => c.to === firstLane)!);
        break;
      }
      starts = last.next.filter((c) => c.turn !== 'uturn').map((c) => ({ lane: c.to, via: c }));
    }
    this.busRoute.push(...route);
    // Stops every ~260 m on lanes long enough, on the kerb side.
    let acc = 0;
    for (const p of this.busRoute) {
      acc += p.length;
      if (!(p instanceof Lane) || p.length < 50 || p.idx !== p.lanes - 1) continue;
      if (acc < 260) continue;
      acc = 0;
      const s = p.length * 0.55;
      p.sample(s, _p);
      const rx = -_p.dz;
      const rz = _p.dx;
      const off = p.road.width / 2 - p.offset + 1.6;
      this.busStops.push({ lane: p, s, x: _p.x + rx * off, z: _p.z + rz * off, yaw: Math.atan2(-rx, -rz) });
    }
  }

  /** Breadth-first search over lanes; returns [via?, lane, conn, lane, ...] ending at a goal lane. */
  private bfs(starts: { lane: Lane; via: Connection | null }[], goal: (l: Lane) => boolean): Path[] | null {
    const prev = new Map<Lane, { from: Lane | null; via: Connection | null }>();
    const q: Lane[] = [];
    for (const st of starts) {
      if (prev.has(st.lane)) continue;
      prev.set(st.lane, { from: null, via: st.via });
      q.push(st.lane);
    }
    let found: Lane | null = null;
    while (q.length) {
      const l = q.shift()!;
      if (goal(l)) {
        found = l;
        break;
      }
      for (const c of l.next) {
        if (c.turn === 'uturn' || prev.has(c.to)) continue;
        prev.set(c.to, { from: l, via: c });
        q.push(c.to);
      }
    }
    if (!found) return null;
    const out: Path[] = [];
    let cur: Lane | null = found;
    while (cur) {
      const e: { from: Lane | null; via: Connection | null } = prev.get(cur)!;
      out.unshift(cur);
      if (e.via) out.unshift(e.via);
      cur = e.from;
    }
    return out;
  }

  /** Put the bus fleet on the loop (call once). */
  spawnBuses(count: number): void {
    if (!this.busRoute.length) return;
    const total = this.busRoute.reduce((a, p) => a + p.length, 0);
    for (let k = 0; k < count; k++) {
      let d = (total * k) / count;
      let i = 0;
      while (d > this.busRoute[i].length) {
        d -= this.busRoute[i].length;
        i = (i + 1) % this.busRoute.length;
      }
      const p = this.busRoute[i];
      if (!(p instanceof Lane)) continue;
      const car = this.makeCar(SPECS.bus, p, d, new THREE.Color(0.06, 0.25, 0.45));
      car.bus = { stop: i, dwell: 0 };
      car.route = [];
      this.extendBusRoute(car);
    }
  }

  private extendBusRoute(car: TrafficCar): void {
    const R = this.busRoute;
    let last = car.route.length ? car.route[car.route.length - 1] : car.path;
    while (car.route.length < 4) {
      const i = R.indexOf(last);
      const nxt = R[(i + 1) % R.length];
      car.route.push(nxt);
      last = nxt;
    }
  }

  // ---------------------------------------------------------------- spawning

  private makeCar(spec: VehicleSpec, path: Path, s: number, color: THREE.Color): TrafficCar {
    const car: TrafficCar = {
      id: this.nextId++,
      spec,
      kind: RENDER_KINDS.indexOf(spec.kind),
      path,
      s,
      speed: 0,
      v0: spec.aiSpeed * (0.85 + this.rng.next() * 0.3),
      route: [],
      latOff: 0,
      state: 'drive',
      driver: true,
      stopDone: false,
      waitT: 0,
      unseenT: 0,
      hornT: 0,
      blockedT: 0,
      bus: null,
      body: null,
      collider: null,
      indicator: 0,
      laneChangeCool: 0,
      holding: false,
      checkT: this.rng.next() * 0.2,
      obsGap: Infinity,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      color,
      wheelSpin: 0,
      steer: 0,
      head: 0,
      brake: 0,
      indL: 0,
      indR: 0,
      visible: true,
    };
    if (path instanceof Lane) car.speed = Math.min(path.speedLimit * car.v0 * 0.8, 9);
    path.cars.push(car.id);
    this.cars.push(car);
    this.idMap.set(car.id, car);
    this.place(car);
    return car;
  }

  private pickSpec(): VehicleSpec {
    const r = this.rng.next();
    const table: [number, keyof typeof SPECS][] = [
      [0.15, 'compact'],
      [0.33, 'hatchback'],
      [0.53, 'sedan'],
      [0.63, 'estate'],
      [0.76, 'suv'],
      [0.83, 'pickup'],
      [0.9, 'van'],
      [1, 'taxi'],
    ];
    for (const [p, k] of table) if (r < p) return SPECS[k];
    return SPECS.sedan;
  }

  private colorFor(spec: VehicleSpec): THREE.Color {
    const [r, g, b] = spec.palette[Math.floor(this.rng.next() * spec.palette.length)];
    const k = 0.9 + this.rng.next() * 0.2;
    return new THREE.Color(r * k, g * k, b * k);
  }

  private spawnAround(px: number, pz: number, camPos: THREE.Vector3, initial: boolean): void {
    const lanes = this.graph.lanesNear(px, pz, 260);
    if (!lanes.length) return;
    for (let tries = 0; tries < 6; tries++) {
      const lane = lanes[Math.floor(this.rng.next() * lanes.length)];
      if (lane.length < 14) continue;
      const dens = DENSITY[lane.district];
      if (this.rng.next() > dens) continue;
      const s = 4 + this.rng.next() * (lane.length - 8);
      lane.sample(s, _p);
      const d = Math.hypot(_p.x - px, _p.z - pz);
      if (d > 250 || (!initial && d < 90)) continue;
      // Out of view (unless filling the city at load).
      if (!initial && d < 200 && this.frustum.containsPoint(new THREE.Vector3(_p.x, _p.y + 1, _p.z))) continue;
      if (Math.hypot(_p.x - camPos.x, _p.z - camPos.z) < 25) continue;
      // Gap on the lane.
      let ok = true;
      for (const id of lane.cars) {
        const o = this.byId(id);
        if (o && Math.abs(o.s - s) < 14) ok = false;
      }
      if (!ok) continue;
      const spec = this.pickSpec();
      this.makeCar(spec, lane, s, this.colorFor(spec));
      return;
    }
  }

  private idMap = new Map<number, TrafficCar>();
  byId(id: number): TrafficCar | undefined {
    return this.idMap.get(id);
  }

  remove(car: TrafficCar): void {
    this.leavePath(car, car.path);
    if (car.body) {
      physics.world.removeRigidBody(car.body);
      car.body = null;
      car.collider = null;
    }
    this.cars.splice(this.cars.indexOf(car), 1);
    this.idMap.delete(car.id);
  }

  private leavePath(car: TrafficCar, p: Path): void {
    const i = p.cars.indexOf(car.id);
    if (i >= 0) p.cars.splice(i, 1);
    if (p instanceof Connection) p.occupants = Math.max(0, p.occupants - 1);
  }

  // ---------------------------------------------------------------- per-frame

  update(dt: number, player: THREE.Vector3, camera: THREE.Camera, activity: number, rainSlow: number, night: number): void {
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.idMap.clear();
    for (const c of this.cars) this.idMap.set(c.id, c);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    // Population control.
    this.target = Math.round(this.maxCars * (0.25 + 0.75 * activity));
    this.spawnT -= dt;
    const drivers = this.cars.filter((c) => !c.bus).length;
    const initial = this.time < 1.5;
    if ((this.spawnT <= 0 || initial) && drivers < this.target) {
      this.spawnT = 0.12;
      const n = initial ? 40 : 1;
      for (let i = 0; i < n && this.cars.length < this.target + 4; i++) this.spawnAround(player.x, player.z, camera.position, initial);
    }
    // Stopped wrecks / parked cars are off the lane graph: publish them as obstacles.
    for (const c of this.cars) if (c.state !== 'drive') this.obstacles.push({ x: c.x, z: c.z, r: c.spec.width / 2 + 0.4, kind: 'car' });
    // Simulate (substeps keep IDM stable at low frame rates).
    const steps = Math.max(1, Math.ceil(dt / 0.034));
    const h = dt / steps;
    for (let k = 0; k < steps; k++) {
      for (const car of this.cars) {
        if (car.state === 'drive') this.drive(car, h, rainSlow, k === 0 ? dt : 0);
      }
    }
    // Despawn, physics proxies, lights.
    const lightsOn = night > 0.25;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const car = this.cars[i];
      const dx = car.x - player.x;
      const dz = car.z - player.z;
      const d = Math.hypot(dx, dz);
      const inView = this.frustum.containsPoint(new THREE.Vector3(car.x, car.y + 1, car.z));
      car.unseenT = inView ? 0 : car.unseenT + dt;
      if (!car.bus && !car.persistent && (d > 330 || (d > 140 && car.unseenT > 4) || (car.state !== 'drive' && d > 220) || (car.waitT > 40 && !inView))) {
        this.remove(car);
        continue;
      }
      car.visible = Math.hypot(car.x - camera.position.x, car.z - camera.position.z) < 420;
      this.syncBody(car, d);
      if (car.state === 'wreck' && car.body) {
        const t = car.body.translation();
        const r = car.body.rotation();
        const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
        const cy = this.bodyHalfHeight(car.spec);
        car.x = t.x;
        car.y = t.y - cy;
        car.z = t.z;
        car.yaw = e.y;
        car.pitch = e.x;
        car.roll = e.z;
        car.speed = 0;
      }
      car.head = car.state === 'drive' && lightsOn ? 1.6 : car.state === 'drive' ? 0.15 : 0;
      car.brake = (car.state === 'drive' && (car.speed < 0.3 || car.holding) ? 1.8 : 0) + (lightsOn ? 0.5 : 0.1);
      const blink = Math.floor(this.time / 0.38) % 2 === 0 ? 2.5 : 0;
      const hazard = car.state === 'wreck';
      car.indL = (car.indicator < 0 || hazard) && blink ? blink : 0;
      car.indR = (car.indicator > 0 || hazard) && blink ? blink : 0;
    }
  }

  /** Bus stop dwell & route; IDM + junction logic for one car. */
  private drive(car: TrafficCar, dt: number, rainSlow: number, frameDt: number): void {
    car.laneChangeCool -= dt;
    car.latOff *= Math.exp(-dt * 1.2);
    if (Math.abs(car.latOff) < 0.02) car.latOff = 0;
    if (!car.bus && car.route.length < 3) this.planRoute(car);
    if (car.bus && car.route.length < 3) this.extendBusRoute(car);
    // Desired speed.
    let v0 = (car.path instanceof Lane ? car.path.speedLimit : 7.5) * car.v0 * rainSlow;
    if (car.path instanceof Connection) v0 = Math.min(v0, car.path.turn === 'straight' ? 11 : car.path.turn === 'uturn' ? 3.5 : 6);
    // Leader search along the route.
    const len = car.spec.length;
    const look = 12 + car.speed * 3;
    let gap = Infinity;
    let lv = 0;
    let dist = -car.s;
    car.holding = false;
    car.indicator = 0;
    const seq = [car.path, ...car.route];
    for (let pi = 0; pi < seq.length; pi++) {
      const p = seq[pi];
      for (const id of p.cars) {
        if (id === car.id) continue;
        const o = this.idMap.get(id);
        if (!o) continue;
        const d = dist + o.s - (o.spec.length + len) / 2;
        if (pi === 0 && o.s <= car.s) continue;
        if (d < gap) {
          gap = d;
          lv = o.state === 'drive' ? o.speed : 0;
        }
      }
      const toEnd = dist + p.length;
      const nxt = seq[pi + 1];
      if (p instanceof Lane && nxt instanceof Connection && toEnd < look + 10) {
        if (toEnd < 45 && nxt.turn !== 'straight') car.indicator = nxt.turn === 'left' || nxt.turn === 'uturn' ? -1 : 1;
        if (!this.mayEnter(car, nxt, toEnd)) {
          const sg = toEnd - len / 2 - 0.8;
          if (sg < gap) {
            gap = sg;
            lv = 0;
          }
          car.holding = toEnd < 30;
          if (car.speed < 0.4 && toEnd < 12) car.waitT += dt;
          break;
        }
      }
      if (toEnd > look) break;
      dist = toEnd;
    }
    // Bus stop.
    if (car.bus) {
      const stop = this.busStops.find((b) => b.lane === car.path && b.s > car.s - 1);
      if (stop) {
        const d = stop.s - car.s;
        if (car.bus.dwell > 0) {
          car.bus.dwell -= dt;
          gap = Math.min(gap, 0.1);
          lv = 0;
          if (car.bus.dwell <= 0) car.bus.stop = this.busStops.indexOf(stop) + 1000;
        } else if (car.bus.stop !== this.busStops.indexOf(stop) + 1000 && d < 40) {
          if (d < 0.6 && car.speed < 0.5) car.bus.dwell = 9;
          else if (d - 0.3 < gap) {
            gap = d - 0.3;
            lv = 0;
          }
        }
      }
    }
    // Obstacles on the path ahead (player, player's car, pedestrians), refreshed ~6x / s.
    car.checkT -= dt;
    if (car.checkT <= 0) {
      car.checkT = 0.16;
      car.obsGap = this.obstacleGap(car, look + 8);
    }
    if (car.obsGap < gap) {
      gap = car.obsGap;
      lv = 0;
      car.blockedT += dt;
      if (car.blockedT > 2.5 && car.hornT <= 0 && car.speed < 1) {
        car.hornT = 4 + this.rng.next() * 4;
        events.emit('traffic:horn', { x: car.x, z: car.z });
      }
    } else car.blockedT = 0;
    car.hornT -= dt;
    // IDM.
    const v = car.speed;
    const vf = Math.max(v0, 0.1);
    const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * (v - lv)) / (2 * Math.sqrt(IDM.a * IDM.b)));
    let acc = IDM.a * (1 - Math.pow(v / vf, 4) - (gap === Infinity ? 0 : Math.pow(sStar / Math.max(gap, 0.1), 2)));
    acc = Math.max(acc, -9);
    car.speed = Math.max(0, v + acc * dt);
    if (gap < 0.3 && car.speed > 0) car.speed = Math.min(car.speed, Math.max(0, gap));
    if (car.speed > 0.5) car.waitT = 0;
    // Lane change (overtake a slow leader).
    if (frameDt > 0 && car.path instanceof Lane && car.laneChangeCool <= 0 && !car.bus && gap < 25 && lv < v0 * 0.6 && car.s < car.path.length - 35 && car.speed > 2) {
      this.tryLaneChange(car);
    }
    // Advance.
    car.s += car.speed * dt;
    while (car.s > car.path.length) {
      const next = car.route.shift();
      if (!next) {
        car.s = car.path.length;
        car.speed = 0;
        car.waitT += dt;
        break;
      }
      car.s -= car.path.length;
      this.leavePath(car, car.path);
      car.path = next;
      next.cars.push(car.id);
      if (next instanceof Connection) {
        next.occupants++;
        car.stopDone = false;
      }
    }
    car.wheelSpin -= (car.speed * dt) / car.spec.wheelRadius;
    this.place(car);
  }

  private planRoute(car: TrafficCar): void {
    let last = car.route.length ? car.route[car.route.length - 1] : car.path;
    let guard = 0;
    while (car.route.length < 4 && guard++ < 8) {
      if (last instanceof Lane) {
        const opts = last.next;
        if (!opts.length) break;
        let pick = opts[0];
        let best = -1;
        for (const c of opts) {
          const w = (c.turn === 'straight' ? 2.4 : c.turn === 'uturn' ? 0.05 : 1) * (0.3 + this.rng.next());
          if (w > best) {
            best = w;
            pick = c;
          }
        }
        car.route.push(pick);
        last = pick;
      } else if (last instanceof Connection) {
        car.route.push(last.to);
        last = last.to;
      } else break;
    }
  }

  /** May the car enter junction connection `c` now? (signals, stop signs, conflicts, exit space) */
  private mayEnter(car: TrafficCar, c: Connection, toEnd: number): boolean {
    const n = c.node;
    if (c.occupants > 0 && c.cars.includes(car.id)) return true;
    // Signals.
    if (n.signal) {
      const st = signalState(n, c.axis, this.time);
      if (st === 0) return false;
      if (st === 1) {
        const stopDist = (car.speed * car.speed) / (2 * 4.5);
        if (toEnd > stopDist + 2) return false;
      }
      if (st === 2 && greenLeft(n, c.axis, this.time) < 1.2 && toEnd > 6 && car.speed < 4) return false;
    } else if (n.arms >= 3) {
      // Stop / give-way: come to a near stop at the line first (minor roads).
      const major = c.from.road.kind === 'avenue' || c.from.road.kind === 'arterial';
      if (!major && !car.stopDone) {
        if (toEnd < 3 && car.speed < 0.6) car.stopDone = true;
        else return false;
      }
    }
    // Conflicting movements already inside the box (or entering it right now).
    const impatient = car.waitT > 14;
    for (const k of c.conflicts) {
      if (k.occupants > 0) return false;
      for (const id of k.from.cars) {
        const o = this.idMap.get(id);
        if (!o || o === car || o.state !== 'drive' || o.route[0] !== k || o.speed < 0.3) continue;
        const od = k.from.length - o.s;
        if (od < 2.5 + o.speed * 0.6 && (od < toEnd || (Math.abs(od - toEnd) < 0.5 && o.id < car.id))) return false;
      }
      if (impatient) continue;
      // Yield to oncoming / priority traffic about to enter.
      if (c.turn === 'left' || c.turn === 'uturn' || (!n.signal && !(c.from.road.kind === 'avenue' || c.from.road.kind === 'arterial'))) {
        for (const id of k.from.cars) {
          const o = this.idMap.get(id);
          if (!o || o === car || o.state !== 'drive') continue;
          if (o.route[0] !== k) continue;
          const d = k.from.length - o.s;
          if (d < 4 + o.speed * 2.2 && o.speed > 1.5 && !(n.signal && signalState(n, k.axis, this.time) === 0)) return false;
        }
      }
    }
    // Don't block the box: need room on the exit lane.
    for (const id of c.to.cars) {
      const o = this.idMap.get(id);
      if (o && o.s < car.spec.length + 3 && o.speed < 3) return false;
    }
    return true;
  }

  private tryLaneChange(car: TrafficCar): void {
    const lane = car.path as Lane;
    for (const alt of [lane.left, lane.right]) {
      if (!alt) continue;
      let ahead = Infinity;
      let behind = Infinity;
      for (const id of alt.cars) {
        const o = this.idMap.get(id);
        if (!o) continue;
        const d = o.s - car.s;
        if (d >= 0) ahead = Math.min(ahead, d - (o.spec.length + car.spec.length) / 2);
        else behind = Math.min(behind, -d - (o.spec.length + car.spec.length) / 2 - o.speed * 0.8);
      }
      if (ahead > 22 && behind > 8) {
        this.leavePath(car, lane);
        alt.cars.push(car.id);
        // Start from the old lateral position (latOff > 0 = right of the new lane centre).
        car.latOff += lane.offset - alt.offset;
        car.path = alt;
        car.route = [];
        this.planRoute(car);
        car.laneChangeCool = 6;
        return;
      }
    }
  }

  /** Distance along the car's path to the first obstacle within the lane corridor. */
  private obstacleGap(car: TrafficCar, look: number): number {
    if (!this.obstacles.length) return Infinity;
    const hw = car.spec.width / 2 + 0.45;
    let best = Infinity;
    const fx = Math.sin(car.yaw);
    const fz = Math.cos(car.yaw);
    for (const o of this.obstacles) {
      const dx = o.x - car.x;
      const dz = o.z - car.z;
      const fwd = dx * fx + dz * fz;
      if (fwd < 0 || fwd > look + car.spec.length) continue;
      // Corridor test against the planned path: sample at the obstacle's along-distance.
      const s = car.s + fwd;
      let p: Path = car.path;
      let ss = s;
      let i = 0;
      while (ss > p.length && i < car.route.length) {
        ss -= p.length;
        p = car.route[i++];
      }
      p.sample(Math.min(ss, p.length), _q);
      const lat = Math.hypot(o.x - _q.x, o.z - _q.z);
      if (lat > hw + o.r) continue;
      const g = fwd - car.spec.length / 2 - o.r - (o.kind === 'ped' ? 1.2 : 1.5);
      if (g < best) best = g;
    }
    return best;
  }

  private place(car: TrafficCar): void {
    const p = car.path;
    const L = car.spec.frontAxle - car.spec.rearAxle;
    p.sample(car.s, _p);
    // Smooth heading from points ahead/behind along the route (handles polyline kinks).
    const ahead = this.sampleAlong(car, car.s + L * 0.5, _q);
    const ax = ahead.x;
    const ay = ahead.y;
    const az = ahead.z;
    const behind = this.sampleAlong(car, car.s - L * 0.5, _q);
    const bx = behind.x;
    const by = behind.y;
    const bz = behind.z;
    const yaw = Math.atan2(ax - bx, az - bz);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    // Right vector of travel is (-dz, dx); latOff>0 shifts right.
    car.x = (ax + bx) / 2 - rx * car.latOff;
    car.z = (az + bz) / 2 - rz * car.latOff;
    car.y = (ay + by) / 2;
    const prevYaw = car.yaw;
    car.yaw = yaw;
    car.pitch = -Math.atan2(ay - by, L);
    car.roll = 0;
    let dyaw = yaw - prevYaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    car.steer = THREE.MathUtils.clamp(car.speed > 0.3 ? dyaw * 8 : car.steer, -0.5, 0.5);
  }

  private sampleAlong(car: TrafficCar, s: number, out: typeof _q): typeof _q {
    let p: Path = car.path;
    let ss = s;
    let i = 0;
    while (ss > p.length && i < car.route.length) {
      ss -= p.length;
      p = car.route[i++];
    }
    p.sample(Math.max(0, Math.min(ss, p.length)), out);
    if (ss < 0) {
      out.x += out.dx * ss;
      out.z += out.dz * ss;
    } else if (ss > p.length) {
      out.x += out.dx * (ss - p.length);
      out.z += out.dz * (ss - p.length);
    }
    return { ...out };
  }

  // ---------------------------------------------------------------- physics proxies

  private bodyHalfHeight(spec: VehicleSpec): number {
    return (spec.roof - spec.clearance) / 2 + spec.clearance;
  }

  private syncBody(car: TrafficCar, d: number): void {
    const want = d < 70;
    if (!want && car.body && car.state === 'drive') {
      physics.world.removeRigidBody(car.body);
      car.body = null;
      car.collider = null;
      return;
    }
    if (!want) return;
    const s = car.spec;
    const cy = this.bodyHalfHeight(s);
    if (!car.body) {
      const desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(car.x, car.y + cy, car.z);
      car.body = physics.world.createRigidBody(desc);
      const hh = (s.roof - s.clearance) / 2;
      car.collider = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(s.width / 2 - 0.05, hh, s.length / 2 - 0.1).setTranslation(0, 0, 0).setCollisionGroups(GROUPS_VEHICLE).setFriction(0.5).setDensity(s.mass / ((s.width - 0.1) * (s.length - 0.2) * hh * 2)),
        car.body,
      );
    }
    if (car.state === 'drive') {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(car.pitch, car.yaw, 0, 'YXZ'));
      car.body.setNextKinematicTranslation({ x: car.x, y: car.y + cy, z: car.z });
      car.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  /** After the physics step: did the player's car hit a traffic car? Turn it into a wreck. */
  detectCrashes(): void {
    if (!this.playerColliders.length) return;
    for (const car of this.cars) {
      if (car.state !== 'drive' || !car.collider || !car.body) continue;
      let hit = false;
      for (const pc of this.playerColliders) {
        physics.world.contactPair(car.collider, pc, (m) => {
          if (m.numContacts() > 0) hit = true;
        });
        if (hit) break;
      }
      if (!hit) continue;
      if (Math.abs(this.playerVehicleSpeed) + car.speed < 2.5) continue;
      this.wreck(car);
      events.emit('world:alarm', { x: car.x, z: car.z, radius: 30, kind: 'crash' });
    }
  }

  /** Hand the car over to physics (dynamic body), keeping its velocity. */
  wreck(car: TrafficCar): void {
    if (!car.body) return;
    const v = car.speed;
    car.state = 'wreck';
    this.leavePath(car, car.path);
    car.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    car.body.setLinearDamping(0.6);
    car.body.setAngularDamping(1.2);
    car.body.setLinvel({ x: Math.sin(car.yaw) * v, y: 0, z: Math.cos(car.yaw) * v }, true);
    car.speed = 0;
  }

  /** Debug/showcase: park one car of every kind in a row (no drivers). */
  parkShowcase(x: number, z: number, yaw: number, y: number): void {
    const kinds = ['compact', 'hatchback', 'sedan', 'estate', 'suv', 'pickup', 'van', 'taxi', 'bus'] as const;
    let off = 0;
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    for (const k of kinds) {
      const spec = SPECS[k];
      const car = this.makeCar(spec, this.graph.lanes[0], 1, this.colorFor(spec));
      this.leavePath(car, car.path);
      car.state = 'parked';
      car.driver = false;
      off += spec.length / 2;
      car.x = x + fx * off;
      car.z = z + fz * off;
      car.y = y;
      car.yaw = yaw - Math.PI / 2;
      car.pitch = 0;
      car.persistent = true;
      off += spec.length / 2 + 1.6;
    }
  }

  /** Nearest traffic car to a point (for entering / hijacking). */
  nearest(x: number, z: number, maxD: number): TrafficCar | null {
    let best: TrafficCar | null = null;
    let bd = maxD;
    for (const c of this.cars) {
      if (c.spec.kind === 'bus' && c.speed > 0.5) continue;
      // Distance to the car's footprint (roughly) or its driver door.
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      const dx = x - c.x;
      const dz = z - c.z;
      const along = dx * fx + dz * fz;
      const side = dx * fz - dz * fx;
      const ex = Math.max(0, Math.abs(along) - c.spec.length / 2);
      const ey = Math.max(0, Math.abs(side) - c.spec.width / 2);
      const d = Math.hypot(ex, ey);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** Render upload. */
  draw(night: number, cam: THREE.Vector3): void {
    this.render.update(this.cars, night, cam);
  }

  /** Random seat-height world positions of visible drivers near the camera (for crowd figures). */
  driverSeats(cam: THREE.Vector3, maxD: number, out: { id: number; x: number; y: number; z: number; yaw: number; pitch: number }[]): void {
    out.length = 0;
    for (const c of this.cars) {
      if (!c.driver || !c.visible) continue;
      const d = Math.hypot(c.x - cam.x, c.z - cam.z);
      if (d > maxD) continue;
      const s = c.spec;
      const seatZ = Math.min(s.sideFront - 0.55, (s.ws1 + s.sideFront) / 2 - 0.5);
      const sx = 0.4;
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      // Local (x right-handed: +X is the car's left) -> world.
      const wx = c.x + fz * sx + fx * seatZ;
      const wz = c.z - fx * sx + fz * seatZ;
      out.push({ id: c.id, x: wx, y: c.y + s.clearance + 0.22, z: wz, yaw: c.yaw, pitch: c.pitch });
    }
  }

  /** Deterministic jitter helper. */
  static jitter(a: number, b: number): number {
    return hashFloat(a, b) - 0.5;
  }
}
