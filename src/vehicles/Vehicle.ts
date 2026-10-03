/**
 * A drivable car: VehicleSim physics + procedural sedan visuals, wheel animation and
 * emissive head/brake/reverse lamps. Real spotlights come from the shared HeadlightRig,
 * which attaches to whichever car is being driven (keeps the scene light count constant).
 */
import * as THREE from 'three';
import { buildSedan, type SedanParts } from './SedanModel';
import { CAR_DIMS, CHASSIS_Y, TUNING, VehicleSim, type DriveInput } from './VehicleSim';

export type { DriveInput };

export class Vehicle {
  readonly parts: SedanParts;
  readonly sim: VehicleSim;
  readonly name: string;
  lightsOn = true;
  private wheelSpin = [0, 0, 0, 0];
  constructor(name: string, color: THREE.Color, x: number, y: number, z: number, yaw: number) {
    this.name = name;
    this.sim = new VehicleSim(x, y, z, yaw);
    this.parts = buildSedan(color);
    this.parts.root.name = name;
    this.update(0, 1);
  }


  get object(): THREE.Group {
    return this.parts.root;
  }

  get position(): THREE.Vector3 {
    return this.parts.root.position;
  }

  get occupied(): boolean {
    return this.sim.occupied;
  }

  set occupied(v: boolean) {
    this.sim.occupied = v;
  }

  /** World position of the driver door (for enter/exit). */
  doorPosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(CAR_DIMS.width / 2 + 0.75, 0, 0.2).applyQuaternion(this.parts.root.quaternion).add(this.parts.root.position);
  }

  fixedUpdate(dt: number, input: DriveInput | null): void {
    this.sim.fixedUpdate(dt, input);
  }

  postStep(): void {
    this.sim.postStep();
  }

  update(dt: number, alpha: number): void {
    const s = this.sim;
    const root = this.parts.root;
    root.position.lerpVectors(s.prevPos, s.curPos, alpha);
    root.quaternion.slerpQuaternions(s.prevRot, s.curRot, alpha);
    root.position.add(new THREE.Vector3(0, -CHASSIS_Y, 0).applyQuaternion(root.quaternion));
    const c = s.controller;
    for (let i = 0; i < 4; i++) {
      const w = this.parts.wheels[i];
      const susp = c.wheelSuspensionLength(i) ?? TUNING.suspensionRest;
      const hp = c.wheelChassisConnectionPointCs(i);
      if (hp) w.position.set(hp.x, hp.y + CHASSIS_Y - susp, hp.z);
      w.rotation.set(0, c.wheelSteering(i) ?? 0, 0);
      const spin = w.getObjectByName('spin');
      this.wheelSpin[i] = c.wheelRotation(i) ?? this.wheelSpin[i];
      if (spin) spin.rotation.x = this.wheelSpin[i];
    }
    const occupied = s.occupied;
    this.parts.headMat.emissiveIntensity = this.lightsOn ? 2.2 : 0.2;
    this.parts.brakeMat.emissiveIntensity = s.braking ? 6 : this.lightsOn && occupied ? 1.2 : 0.35;
    this.parts.reverseMat.emissiveIntensity = s.reversing && occupied ? 3 : 0;
    void dt;
  }
}

/** One pair of headlight spotlights shared by all cars; follows the driven car. */
export class HeadlightRig {
  readonly spots: THREE.SpotLight[] = [];
  private attached: Vehicle | null = null;

  constructor(scene: THREE.Scene) {
    for (const s of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff2dc, 0, 70, 0.42, 0.45, 1.4);
      spot.position.set(s * 0.7, 0.7, CAR_DIMS.length / 2 - 0.05);
      spot.target.position.set(s * 0.9, 0.0, CAR_DIMS.length / 2 + 18);
      spot.castShadow = false;
      scene.add(spot, spot.target);
      this.spots.push(spot);
    }
  }

  update(v: Vehicle | null): void {
    if (v && v !== this.attached) {
      for (const s of this.spots) v.object.add(s, s.target);
      this.attached = v;
    }
    const on = !!v && v.lightsOn;
    for (const s of this.spots) s.intensity = on ? 60 : 0;
  }
}
