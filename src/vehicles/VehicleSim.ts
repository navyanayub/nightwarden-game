/**
 * Vehicle physics (no rendering) on Rapier's DynamicRayCastVehicleController:
 * rear-wheel drive with an automatic gearbox estimate, speed-sensitive steering, brakes,
 * handbrake drift (rear grip drop), aerodynamic drag/downforce and suspension
 * (weight transfer emerges from the per-wheel suspension forces).
 * Kept free of DOM/three-rendering code so it can be tuned headlessly (tools/tune-vehicle).
 */
import * as THREE from 'three';
import { physics, RAPIER, GROUPS_VEHICLE, GROUPS_WHEEL_RAY } from '../core/Physics';

export const CAR_DIMS = { width: 1.86, length: 4.72, track: 1.6, frontAxle: 1.38, rearAxle: -1.44, wheelRadius: 0.34 };

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

export const TUNING = {
  mass: 1380,
  comY: -0.3,
  engineForce: 7200,
  brakeForce: 70,
  handbrakeForce: 28,
  maxSteer: 0.62,
  highSpeedSteer: 0.16,
  steerSpeed: 3.2,
  suspensionRest: 0.3,
  suspensionTravel: 0.22,
  stiffness: 32,
  compression: 3.6,
  relaxation: 2.6,
  frictionFront: 2.7,
  frictionRear: 2.8,
  handbrakeFriction: 1.35,
  sideStiffness: 1.0,
  drag: 0.32,
  rolling: 9,
  downforce: 0.9,
  topSpeed: 62,
  reverseSpeed: 9,
  /** Stability assist: pulls the yaw rate towards the steering-implied rate (0 = off). */
  esc: 12000,
};

/** Height of the chassis rigid-body origin above the ground at rest. */
export const CHASSIS_Y = 0.75;

export class VehicleSim {
  readonly chassis: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  steer = 0;
  readonly prevPos = new THREE.Vector3();
  readonly curPos = new THREE.Vector3();
  readonly prevRot = new THREE.Quaternion();
  readonly curRot = new THREE.Quaternion();
  occupied = false;
  braking = false;
  reversing = false;
  speed = 0;
  rpm = 0;
  gear = 1;

  constructor(x: number, y: number, z: number, yaw: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y + CHASSIS_Y, z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.05)
      .setAngularDamping(0.6)
      .setCanSleep(true)
      .setCcdEnabled(true);
    this.chassis = physics.world.createRigidBody(desc);
    const body = RAPIER.ColliderDesc.cuboid(CAR_DIMS.width / 2 - 0.04, 0.3, CAR_DIMS.length / 2 - 0.05)
      .setTranslation(0, 0.05, 0)
      .setDensity(1)
      .setFriction(0.4)
      .setRestitution(0.1)
      .setCollisionGroups(GROUPS_VEHICLE);
    const cabin = RAPIER.ColliderDesc.cuboid(CAR_DIMS.width / 2 - 0.22, 0.24, 1.0).setTranslation(0, 0.55, -0.3).setDensity(0.2).setCollisionGroups(GROUPS_VEHICLE);
    physics.world.createCollider(body, this.chassis);
    physics.world.createCollider(cabin, this.chassis);
    this.chassis.setAdditionalMassProperties(TUNING.mass, { x: 0, y: TUNING.comY, z: 0.05 }, { x: 2400, y: 2700, z: 620 }, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.controller = physics.world.createVehicleController(this.chassis);
    this.controller.indexUpAxis = 1;
    this.controller.setIndexForwardAxis = 2;
    const hy = CAR_DIMS.wheelRadius - CHASSIS_Y + TUNING.suspensionRest - 0.04;
    for (const [wx, wz] of [
      [CAR_DIMS.track / 2, CAR_DIMS.frontAxle],
      [-CAR_DIMS.track / 2, CAR_DIMS.frontAxle],
      [CAR_DIMS.track / 2, CAR_DIMS.rearAxle],
      [-CAR_DIMS.track / 2, CAR_DIMS.rearAxle],
    ]) {
      this.controller.addWheel({ x: wx, y: hy, z: wz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, TUNING.suspensionRest, CAR_DIMS.wheelRadius);
    }
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelSuspensionStiffness(i, TUNING.stiffness);
      this.controller.setWheelSuspensionCompression(i, TUNING.compression);
      this.controller.setWheelSuspensionRelaxation(i, TUNING.relaxation);
      this.controller.setWheelMaxSuspensionTravel(i, TUNING.suspensionTravel);
      this.controller.setWheelMaxSuspensionForce(i, 60000);
      this.controller.setWheelFrictionSlip(i, i < 2 ? TUNING.frictionFront : TUNING.frictionRear);
      this.controller.setWheelSideFrictionStiffness(i, TUNING.sideStiffness);
    }
    this.curPos.set(x, y + CHASSIS_Y, z);
    this.prevPos.copy(this.curPos);
    this.curRot.copy(q);
    this.prevRot.copy(q);
  }

  /** Heading yaw of the car's forward (+Z) axis. */
  get yaw(): number {
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.curRot);
    return Math.atan2(f.x, f.z);
  }

  fixedUpdate(dt: number, input: DriveInput | null): void {
    const c = this.controller;
    const lin = this.chassis.linvel();
    const v = new THREE.Vector3(lin.x, lin.y, lin.z);
    const rot = this.chassis.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const fSpeed = v.dot(fwd);
    this.speed = fSpeed;
    const inp: DriveInput = input ?? { throttle: 0, brake: 0, steer: 0, handbrake: !this.occupied };
    // Steering: speed-sensitive max angle, rate limited.
    const sp = Math.abs(fSpeed);
    const maxSteer = THREE.MathUtils.lerp(TUNING.maxSteer, TUNING.highSpeedSteer, Math.min(1, sp / 38));
    const targetSteer = -inp.steer * maxSteer;
    this.steer += THREE.MathUtils.clamp(targetSteer - this.steer, -TUNING.steerSpeed * dt, TUNING.steerSpeed * dt);
    c.setWheelSteering(0, this.steer);
    c.setWheelSteering(1, this.steer);
    let engine = 0;
    let brake = 0;
    this.reversing = false;
    // Traction control: cut drive when the car is sliding sideways (unless drifting on purpose).
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const slip = Math.abs(Math.atan2(v.dot(side), Math.max(Math.abs(fSpeed), 0.5)));
    const tc = inp.handbrake ? 1 : THREE.MathUtils.clamp(1 - (slip - 0.12) * 2.5, 0.25, 1);
    if (inp.throttle > 0.05) {
      if (fSpeed < -0.8) brake = TUNING.brakeForce * inp.throttle;
      else engine = TUNING.engineForce * inp.throttle * this.torqueCurve(fSpeed) * tc;
    }
    if (inp.brake > 0.05) {
      if (fSpeed > 0.8) brake = Math.max(brake, TUNING.brakeForce * inp.brake);
      else {
        engine = -TUNING.engineForce * 0.55 * inp.brake * (fSpeed > -TUNING.reverseSpeed ? 1 : 0);
        this.reversing = true;
      }
    }
    if (!this.occupied && inp.throttle === 0 && inp.brake === 0) brake = TUNING.brakeForce * 0.2;
    if (Math.abs(fSpeed) > TUNING.topSpeed) engine = 0;
    this.braking = brake > 1 && fSpeed > 0.5;
    c.setWheelEngineForce(0, 0);
    c.setWheelEngineForce(1, 0);
    c.setWheelEngineForce(2, engine / 2);
    c.setWheelEngineForce(3, engine / 2);
    for (let i = 0; i < 4; i++) c.setWheelBrake(i, brake * (i < 2 ? 0.6 : 0.4));
    const hb = inp.handbrake;
    for (const i of [2, 3]) {
      c.setWheelFrictionSlip(i, hb ? TUNING.handbrakeFriction : TUNING.frictionRear);
      if (hb) c.setWheelBrake(i, TUNING.handbrakeForce);
    }
    // Drag, rolling resistance and downforce.
    const drag = v.clone().multiplyScalar(-TUNING.drag * v.length());
    const roll = fwd.clone().multiplyScalar(-Math.sign(fSpeed) * Math.min(Math.abs(fSpeed), 1) * TUNING.rolling * (this.occupied ? 1 : 3));
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(q).multiplyScalar(TUNING.downforce * v.lengthSq());
    const f = drag.add(roll).add(down).multiplyScalar(dt);
    this.chassis.applyImpulse({ x: f.x, y: f.y, z: f.z }, true);
    // Stability assist (arcade ESC): damp yaw towards the bicycle-model rate unless the
    // handbrake is held, so slides are catchable and the car straightens out on release.
    if (this.occupied && !hb && sp > 3) {
      const av = this.chassis.angvel();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const yawRate = av.x * up.x + av.y * up.y + av.z * up.z;
      const wantRate = (fSpeed * Math.tan(this.steer)) / (CAR_DIMS.frontAxle - CAR_DIMS.rearAxle);
      const err = THREE.MathUtils.clamp(wantRate - yawRate, -2.5, 2.5);
      const k = TUNING.esc * Math.min(1, sp / 12) * dt;
      this.chassis.applyTorqueImpulse({ x: up.x * err * k, y: up.y * err * k, z: up.z * err * k }, true);
    }
    const handle = this.chassis.handle;
    c.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS_WHEEL_RAY, (col) => col.parent()?.handle !== handle);
    const kmh = Math.abs(fSpeed) * 3.6;
    this.gear = this.reversing ? -1 : gearFor(kmh);
    const lo = this.gear > 1 ? gearTop(this.gear - 1) : 0;
    const hi = gearTop(Math.max(1, this.gear));
    this.rpm = this.reversing ? Math.min(1, kmh / 30) : THREE.MathUtils.clamp(0.18 + 0.82 * ((kmh - lo) / Math.max(1, hi - lo)), 0.15, 1);
  }

  /** Wheel engine force multiplier vs speed (more pull at low speed, fading near top speed). */
  private torqueCurve(v: number): number {
    const t = Math.max(0, v) / TUNING.topSpeed;
    return Math.max(0, 1.1 - 0.35 * t - 0.75 * t * t);
  }

  /** Record transforms after each physics step (for render interpolation). */
  postStep(): void {
    this.prevPos.copy(this.curPos);
    this.prevRot.copy(this.curRot);
    const p = this.chassis.translation();
    const r = this.chassis.rotation();
    this.curPos.set(p.x, p.y, p.z);
    this.curRot.set(r.x, r.y, r.z, r.w);
  }

  resetUpright(): void {
    const p = this.chassis.translation();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    this.chassis.setTranslation({ x: p.x, y: p.y + 1.5, z: p.z }, true);
    this.chassis.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  get upsideDown(): boolean {
    return new THREE.Vector3(0, 1, 0).applyQuaternion(this.curRot).y < 0.2;
  }
}

export function gearTop(g: number): number {
  return [0, 32, 62, 96, 132, 170, 260][g] ?? 260;
}

function gearFor(kmh: number): number {
  for (let g = 1; g <= 6; g++) if (kmh < gearTop(g)) return g;
  return 6;
}
