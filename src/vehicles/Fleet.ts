/**
 * Registry of every AI-driven physical vehicle (police units, getaway / gang cars, roadblock
 * cars). Steps their drivers and physics, publishes them to the traffic renderer (instanced) and
 * to the traffic obstacle list, and finds out-of-view spawn points on the lane graph.
 */
import * as THREE from 'three';
import { AICar } from './AICar';
import { Driver } from '../ai/Driver';
import type { LaneGraph } from '../ai/LaneGraph';
import type { Traffic } from '../ai/Traffic';
import type { VehicleSpec } from './VehicleModels';
import { Rng } from '../core/Random';

const MAX_CARS = 14;

export class Fleet {
  readonly cars: AICar[] = [];
  readonly drivers = new Map<AICar, Driver>();
  private rng = new Rng(0xf1ee7);
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();

  constructor(
    readonly graph: LaneGraph,
    private readonly traffic: Traffic,
  ) {}

  get full(): boolean {
    return this.cars.length >= MAX_CARS;
  }

  add(spec: VehicleSpec, color: THREE.Color, x: number, y: number, z: number, yaw: number, speed = 0): AICar {
    const car = new AICar(spec, color, x, y, z, yaw, speed);
    this.cars.push(car);
    this.drivers.set(car, new Driver(car, this.graph));
    return car;
  }

  driver(car: AICar): Driver {
    return this.drivers.get(car)!;
  }

  remove(car: AICar): void {
    const i = this.cars.indexOf(car);
    if (i < 0) return;
    this.cars.splice(i, 1);
    this.drivers.delete(car);
    car.dispose();
  }

  fixedUpdate(dt: number): void {
    for (const c of this.cars) {
      this.drivers.get(c)?.update(dt);
      c.fixedUpdate(dt);
    }
  }

  postStep(): void {
    for (const c of this.cars) c.postStep();
  }

  /** Per frame: render states into traffic, obstacles for traffic cars. */
  sync(alpha: number, night: number, dt: number, cam: THREE.Vector3): void {
    const extra = this.traffic.extra;
    extra.length = 0;
    for (const c of this.cars) {
      c.sync(alpha, night, dt);
      c.rs.visible = Math.hypot(c.rs.x - cam.x, c.rs.z - cam.z) < 420;
      extra.push(c.rs);
      this.traffic.obstacles.push({ x: c.position.x, z: c.position.z, r: c.spec.width / 2 + 0.6, kind: 'car' });
    }
  }

  setCamera(cam: THREE.Camera): void {
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
  }

  inView(p: THREE.Vector3): boolean {
    return this.frustum.containsPoint(p);
  }

  /**
   * A lane point between minD and maxD from `near`, out of the camera's view (unless far),
   * at least `minPlayer` from the player. Heading points along the lane.
   */
  spawnPoint(near: THREE.Vector3, minD: number, maxD: number, player: THREE.Vector3, minPlayer = 70, toward?: THREE.Vector3): { x: number; y: number; z: number; yaw: number } | null {
    const lanes = this.graph.lanesNear(near.x, near.z, maxD);
    const q = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
    let best: { x: number; y: number; z: number; yaw: number } | null = null;
    let bs = -Infinity;
    for (let i = 0; i < 40 && lanes.length; i++) {
      const l = lanes[Math.floor(this.rng.next() * lanes.length)];
      if (l.length < 16) continue;
      l.sample(4 + this.rng.next() * (l.length - 8), q);
      const d = Math.hypot(q.x - near.x, q.z - near.z);
      if (d < minD || d > maxD) continue;
      const dp = Math.hypot(q.x - player.x, q.z - player.z);
      if (dp < minPlayer) continue;
      if (dp < 220 && this.inView(new THREE.Vector3(q.x, q.y + 1, q.z))) continue;
      // Clear of other AI cars.
      if (this.cars.some((c) => Math.hypot(c.position.x - q.x, c.position.z - q.z) < 9)) continue;
      // Prefer lanes heading towards the destination.
      let s = this.rng.next();
      if (toward) {
        const tx = toward.x - q.x;
        const tz = toward.z - q.z;
        const tl = Math.hypot(tx, tz) || 1;
        s += ((q.dx * tx + q.dz * tz) / tl) * 2;
      }
      if (s > bs) {
        bs = s;
        best = { x: q.x, y: q.y, z: q.z, yaw: Math.atan2(q.dx, q.dz) };
      }
    }
    return best;
  }

  clear(): void {
    for (const c of [...this.cars]) this.remove(c);
  }
}
