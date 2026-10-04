/**
 * A drivable vehicle: VehicleSim physics + full-detail procedural visuals (any VehicleKind),
 * wheel animation and emissive head/brake/reverse/indicator lamps. Real spotlights come from
 * the shared HeadlightRig, which attaches to whichever vehicle is being driven (keeps the
 * scene light count constant).
 */
import * as THREE from 'three';
import { buildVehicle, SPECS, type VehicleParts, type VehicleSpec } from './VehicleModels';
import { TUNING, VehicleSim, type DriveInput } from './VehicleSim';

export type { DriveInput };

export class Vehicle {
  readonly parts: VehicleParts;
  readonly sim: VehicleSim;
  readonly name: string;
  readonly spec: VehicleSpec;
  readonly color: THREE.Color;
  lightsOn = true;
  /** Hazard / indicator state (-1 left, 1 right, 2 hazards, 0 off). */
  indicator = 0;
  /** Set when this vehicle came from traffic (so it can be recycled later). */
  fromTraffic = false;
  private wheelSpin = [0, 0, 0, 0];
  constructor(name: string, color: THREE.Color, x: number, y: number, z: number, yaw: number, spec: VehicleSpec = SPECS.sedan) {
    this.name = name;
    this.spec = spec;
    this.color = color.clone();
    this.sim = new VehicleSim(x, y, z, yaw, spec);
    this.parts = buildVehicle(spec, color);
    this.parts.root.name = name;
    this.update(0, 1);
  }

  /** Display name, e.g. "Corvane Strata". */
  get label(): string {
    return `${this.spec.make} ${this.spec.model}`;
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
    return out.set(this.spec.width / 2 + 0.75, 0, this.parts.seat.position.z).applyQuaternion(this.parts.root.quaternion).add(this.parts.root.position);
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
    root.position.add(new THREE.Vector3(0, -s.chassisY, 0).applyQuaternion(root.quaternion));
    const c = s.controller;
    for (let i = 0; i < 4; i++) {
      const w = this.parts.wheels[i];
      const susp = c.wheelSuspensionLength(i) ?? TUNING.suspensionRest;
      const hp = c.wheelChassisConnectionPointCs(i);
      if (hp) w.position.set(hp.x, hp.y + s.chassisY - susp, hp.z);
      w.rotation.set(0, c.wheelSteering(i) ?? 0, 0);
      const spin = w.getObjectByName('spin');
      this.wheelSpin[i] = c.wheelRotation(i) ?? this.wheelSpin[i];
      if (spin) spin.rotation.x = this.wheelSpin[i];
    }
    const occupied = s.occupied;
    this.parts.headMat.emissiveIntensity = this.lightsOn ? 2.2 : 0.2;
    this.parts.brakeMat.emissiveIntensity = s.braking ? 6 : this.lightsOn && occupied ? 1.2 : 0.35;
    this.parts.reverseMat.emissiveIntensity = s.reversing && occupied ? 3 : 0;
    const blink = Math.floor(performance.now() / 380) % 2 === 0;
    this.parts.indicatorMat.emissiveIntensity = this.indicator !== 0 && blink ? 4 : 0;
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
      spot.position.set(s * 0.7, 0.7, 2.3);
      spot.target.position.set(s * 0.9, 0.0, 2.3 + 18);
      spot.castShadow = false;
      scene.add(spot, spot.target);
      this.spots.push(spot);
    }
  }

  update(v: Vehicle | null): void {
    if (v && v !== this.attached) {
      const L = v.spec.length / 2;
      const y = v.spec.nose - 0.05;
      this.spots.forEach((s, i) => {
        const sx = i === 0 ? -1 : 1;
        s.position.set(sx * (v.spec.width / 2 - 0.25), y, L - 0.05);
        s.target.position.set(sx * 0.9, 0, L + 18);
        v.object.add(s, s.target);
      });
      this.attached = v;
    }
    const on = !!v && v.lightsOn;
    for (const s of this.spots) s.intensity = on ? 60 : 0;
  }
}
