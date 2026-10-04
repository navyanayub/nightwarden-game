/**
 * Third-person camera with mouse look, smoothing, sphere-cast collision, and a vehicle
 * chase mode with lag, auto-recentre and speed-sensitive FOV.
 */
import * as THREE from 'three';
import { physics } from '../core/Physics';

export type CamMode = 'foot' | 'vehicle';

export class CameraRig {
  yaw = 0;
  pitch = -0.12;
  distance = 4.2;
  private targetDistance = 4.2;
  private curDist = 4.2;
  private pivot = new THREE.Vector3();
  private pivotInit = false;
  private lastLook = -10;
  private time = 0;
  private fov = 62;
  mode: CamMode = 'foot';
  /** Vehicle heading the chase cam follows (radians, yaw of the car's forward). */
  vehicleYaw = 0;
  vehicleSpeed = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  setMode(mode: CamMode, yaw?: number): void {
    this.mode = mode;
    this.targetDistance = mode === 'vehicle' ? 7.2 : 4.2;
    if (yaw !== undefined) this.yaw = yaw;
    this.pitch = mode === 'vehicle' ? -0.16 : -0.12;
  }

  look(dx: number, dy: number): void {
    if (dx !== 0 || dy !== 0) this.lastLook = this.time;
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, -1.25, 0.85);
  }

  zoom(steps: number): void {
    const [min, max] = this.mode === 'vehicle' ? [5, 12] : [1.8, 8];
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + steps * 0.6, min, max);
  }

  /** Teleport without smoothing. */
  snap(target: THREE.Vector3): void {
    this.pivot.copy(target);
    this.pivotInit = true;
    this.curDist = this.targetDistance;
  }

  update(dt: number, target: THREE.Vector3): void {
    this.time += dt;
    if (!this.pivotInit) this.snap(target);
    // Pivot smoothing (critically damped-ish lerp).
    const k = this.mode === 'vehicle' ? 14 : 18;
    this.pivot.lerp(target, 1 - Math.exp(-k * dt));
    if (this.mode === 'vehicle') {
      // Auto-recentre behind the car after a moment without mouse input.
      const idle = this.time - this.lastLook > 1.4;
      if (idle) {
        const want = this.vehicleYaw;
        let d = want - this.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        const rate = 2.2 + Math.min(this.vehicleSpeed / 10, 4);
        this.yaw += d * (1 - Math.exp(-rate * dt));
        this.pitch += (-0.16 - this.pitch) * (1 - Math.exp(-2 * dt));
      }
      const speedK = Math.min(Math.abs(this.vehicleSpeed) / 45, 1);
      this.distance = this.targetDistance + speedK * 1.6;
      const wantFov = 62 + speedK * 18;
      this.fov += (wantFov - this.fov) * (1 - Math.exp(-3 * dt));
    } else {
      this.distance = this.targetDistance;
      this.fov += (62 - this.fov) * (1 - Math.exp(-3 * dt));
    }
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    // Desired camera offset: orbit around pivot with a slight shoulder offset on foot.
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const shoulder = this.mode === 'foot' ? new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(0.45) : new THREE.Vector3();
    const origin = this.pivot.clone().add(shoulder.clone().multiplyScalar(0.6));
    // Collision: sphere cast from the pivot towards the camera.
    const hit = physics.isReady ? physics.sphereCast(origin, dir, 0.25, this.distance) : this.distance;
    const want = Math.max(0.6, hit - 0.1);
    // Pull in fast, ease out slowly.
    this.curDist = want < this.curDist ? want : this.curDist + (want - this.curDist) * (1 - Math.exp(-3 * dt));
    this.camera.position.copy(origin).addScaledVector(dir, this.curDist).add(shoulder.multiplyScalar(0.4));
    const lookAt = this.pivot.clone();
    if (this.mode === 'vehicle') lookAt.y += 0.6;
    this.camera.lookAt(lookAt.add(this.mode === 'foot' ? new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).multiplyScalar(0.45) : new THREE.Vector3()));
  }

  /** Forward vector on the ground plane (camera looks along -dir). */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }
}
