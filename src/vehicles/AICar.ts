/**
 * A physically simulated vehicle driven by AI (police cars, tactical vans, getaway cars, gang
 * cars). Physics is the same VehicleSim the player drives; rendering goes through the traffic
 * instancing (`CarRenderState`, see Traffic.extra) so a dozen pursuit cars add no draw calls.
 *
 * Damage: a sudden velocity change after a physics step (a crash) costs health; at zero the car
 * is disabled (hazards on, engine dead). Spike strips puncture the tyres (VehicleSim.puncture).
 * Police kinds flash the lightbar (red / blue halves on the instanced indicator channels) when
 * the siren is on.
 */
import * as THREE from 'three';
import { physics } from '../core/Physics';
import { VehicleSim, type DriveInput } from './VehicleSim';
import type { VehicleSpec } from './VehicleModels';
import { RENDER_KINDS, type CarRenderState } from '../ai/TrafficRender';

export interface AIRenderState extends CarRenderState {
  id: number;
  spec: VehicleSpec;
  driver: boolean;
}

let serial = 1_000_000;

export class AICar {
  readonly sim: VehicleSim;
  readonly spec: VehicleSpec;
  readonly rs: AIRenderState;
  readonly id = serial++;
  input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  siren = false;
  /** Someone at the wheel (false = parked / abandoned). */
  driver = true;
  health = 100;
  disabled = false;
  /** Last crash: impact speed change and time. */
  lastHit = { dv: 0, t: -9 };
  time = 0;
  private prevVel = new THREE.Vector3();
  private spin = 0;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();

  constructor(spec: VehicleSpec, color: THREE.Color, x: number, y: number, z: number, yaw: number, speed = 0) {
    this.spec = spec;
    this.sim = new VehicleSim(x, y + 0.05, z, yaw, spec);
    this.sim.occupied = true;
    if (speed > 0) this.sim.chassis.setLinvel({ x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed }, true);
    this.position.set(x, y, z);
    this.rs = {
      id: this.id,
      spec,
      driver: true,
      kind: RENDER_KINDS.indexOf(spec.kind),
      x,
      y,
      z,
      yaw,
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
  }

  get speed(): number {
    return this.sim.speed;
  }

  get yaw(): number {
    return this.sim.yaw;
  }

  get police(): boolean {
    return this.spec.kind === 'police' || this.spec.kind === 'tactical';
  }

  fixedUpdate(dt: number): void {
    this.time += dt;
    const lv = this.sim.chassis.linvel();
    this.prevVel.set(lv.x, lv.y, lv.z);
    this.sim.occupied = this.driver && !this.disabled;
    if (this.disabled || !this.driver) this.sim.fixedUpdate(dt, null);
    else this.sim.fixedUpdate(dt, this.input);
  }

  /** After physics.step(): interpolation state + crash damage. */
  postStep(): void {
    this.sim.postStep();
    const lv = this.sim.chassis.linvel();
    this.velocity.set(lv.x, lv.y, lv.z);
    const dv = this.velocity.distanceTo(this.prevVel);
    if (dv > 3.5) {
      this.lastHit = { dv, t: this.time };
      this.health -= Math.max(0, dv - 4.5) * (this.spec.kind === 'tactical' ? 2.5 : 5.5);
      if (this.health <= 0) this.disabled = true;
    }
    this.position.copy(this.sim.curPos).setY(this.sim.curPos.y - this.sim.chassisY);
  }

  /** Upload the interpolated pose and lamp levels to the render state. */
  sync(alpha: number, night: number, dt: number): void {
    const s = this.sim;
    const p = new THREE.Vector3().lerpVectors(s.prevPos, s.curPos, alpha);
    const q = new THREE.Quaternion().slerpQuaternions(s.prevRot, s.curRot, alpha);
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
    const r = this.rs;
    r.x = p.x;
    r.y = p.y - s.chassisY;
    r.z = p.z;
    r.yaw = e.y;
    r.pitch = e.x;
    r.roll = e.z;
    this.spin += (s.speed / this.spec.wheelRadius) * dt;
    r.wheelSpin = this.spin;
    r.steer = s.steer;
    r.driver = this.driver && !this.disabled;
    const lights = night > 0.25 || this.siren;
    r.head = this.disabled ? 0 : lights ? 1.6 : 0.15;
    r.brake = (this.input.brake > 0.1 || Math.abs(s.speed) < 0.4 ? 1.8 : 0) + (lights ? 0.5 : 0.1);
    if (this.police && this.siren && !this.disabled) {
      // Lightbar: alternating red / blue with a double flash.
      const t = this.time * 2.6;
      const ph = t % 1;
      const flash = ph < 0.18 || (ph > 0.26 && ph < 0.42) ? 6 : 1.2;
      const red = Math.floor(t) % 2 === 0;
      r.indL = red ? flash : 1.0;
      r.indR = red ? 1.0 : flash;
    } else if (this.disabled) {
      const blink = Math.floor(this.time / 0.38) % 2 === 0 ? 2.5 : 0;
      r.indL = this.police ? 0 : blink;
      r.indR = this.police ? 0 : blink;
    } else {
      r.indL = 0;
      r.indR = 0;
    }
  }

  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.sim.curRot).setY(0).normalize();
  }

  dispose(): void {
    physics.world.removeRigidBody(this.sim.chassis);
  }
}
