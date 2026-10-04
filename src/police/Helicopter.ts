/**
 * VPD air unit: a procedural light helicopter (navy with a white band and a light-blue stripe,
 * glazed nose, tail boom with fin and stabiliser, four-blade main rotor, skids, nose-mounted
 * searchlight) that flies in from the edge of town, orbits the search area at ~50 m and holds
 * its searchlight on the suspect.
 *
 * The searchlight is one SpotLight created at load (intensity 0 while idle, so the scene's light
 * count never changes and no shaders recompile) plus an additive light cone mesh that shows in
 * rain / fog / night. Meshes are merged per material (6 draws per helicopter).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt } from '../world/Terrain';
import { physics, GROUPS_PROBE } from '../core/Physics';

const ALT = 48;

function mats() {
  return {
    navy: new THREE.MeshPhysicalMaterial({ color: 0x0a1424, metalness: 0.45, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
    white: new THREE.MeshStandardMaterial({ color: 0xe6e8ea, metalness: 0.2, roughness: 0.4 }),
    blue: new THREE.MeshStandardMaterial({ color: 0x3d7fd6, metalness: 0.2, roughness: 0.4 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x0b1117, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.7, clearcoat: 1 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.6, roughness: 0.5 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.2 }),
  };
}

function build(): { body: THREE.Group; rotor: THREE.Mesh; tail: THREE.Mesh; navMat: THREE.MeshStandardMaterial; lampMat: THREE.MeshStandardMaterial; mount: THREE.Object3D } {
  const M = mats();
  const parts: Record<'navy' | 'white' | 'blue' | 'glass' | 'dark', THREE.BufferGeometry[]> = { navy: [], white: [], blue: [], glass: [], dark: [] };
  const add = (k: keyof typeof parts, g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    const gg = g.index ? g.toNonIndexed() : g;
    gg.applyMatrix4(m);
    for (const n of Object.keys(gg.attributes)) if (n !== 'position' && n !== 'normal') gg.deleteAttribute(n);
    parts[k].push(gg);
  };
  const T = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1, rx = 0, ry = 0, rz = 0) =>
    new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  // Fuselage: stretched sphere, nose forward (+Z).
  add('navy', new THREE.SphereGeometry(1, 24, 16), T(0, 1.45, 0.2, 1.05, 1.0, 2.1));
  // White belly band + blue pinstripe.
  add('white', new THREE.CylinderGeometry(1, 1, 0.34, 24, 1, true), T(0, 1.2, 0.2, 0.99, 1, 2.0));
  add('blue', new THREE.CylinderGeometry(1, 1, 0.06, 24, 1, true), T(0, 1.43, 0.2, 1.012, 1, 2.11));
  // Canopy.
  add('glass', new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), T(0, 1.55, 1.15, 0.92, 0.95, 1.25, 0.55, 0, 0));
  // Engine fairing + mast.
  add('navy', new THREE.CylinderGeometry(0.45, 0.6, 0.5, 16), T(0, 2.55, -0.2, 1, 1, 1.6));
  add('dark', new THREE.CylinderGeometry(0.1, 0.12, 0.45, 10), T(0, 2.95, 0.0));
  // Tail boom, fin, stabiliser.
  add('navy', new THREE.CylinderGeometry(0.16, 0.38, 5.2, 14), T(0, 1.85, -3.9, 1, 1, 1, Math.PI / 2 - 0.06, 0, 0));
  add('white', new THREE.BoxGeometry(0.08, 1.3, 0.75), T(0, 2.35, -6.35, 1, 1, 1, -0.35, 0, 0));
  add('navy', new THREE.BoxGeometry(1.6, 0.06, 0.45), T(0, 1.98, -5.6));
  // Skids.
  for (const sx of [-1, 1]) {
    add('dark', new THREE.CylinderGeometry(0.05, 0.05, 3.4, 8), T(sx * 0.95, 0.12, 0.25, 1, 1, 1, Math.PI / 2, 0, 0));
    for (const z of [-0.5, 1.0]) add('dark', new THREE.CylinderGeometry(0.035, 0.035, 0.95, 6), T(sx * 0.8, 0.55, z, 1, 1, 1, 0, 0, sx * 0.35));
  }
  // Searchlight gimbal under the nose.
  add('dark', new THREE.SphereGeometry(0.22, 12, 8), T(0, 0.55, 1.6));
  const body = new THREE.Group();
  for (const k of Object.keys(parts) as (keyof typeof parts)[]) {
    const g = mergeGeometries(parts[k], false);
    if (!g) continue;
    const m = new THREE.Mesh(g, M[k]);
    m.castShadow = k !== 'glass';
    m.name = `heli:${k}`;
    body.add(m);
  }
  // Main rotor (4 blades) and tail rotor spin separately.
  const blades: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const b = new THREE.BoxGeometry(0.28, 0.035, 5.2).toNonIndexed();
    b.translate(0, 0, 2.7);
    b.rotateY((i * Math.PI) / 2);
    blades.push(b);
  }
  const rotor = new THREE.Mesh(mergeGeometries(blades, false)!, M.dark);
  rotor.position.set(0, 3.18, 0);
  rotor.castShadow = true;
  const tg: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 2; i++) {
    const b = new THREE.BoxGeometry(0.03, 0.14, 0.75).toNonIndexed();
    b.translate(0, 0, 0.36);
    b.rotateX(i * Math.PI);
    tg.push(b);
  }
  const tail = new THREE.Mesh(mergeGeometries(tg, false)!, M.dark);
  tail.position.set(0.12, 2.3, -6.5);
  // Nav lights (red / green / white strobe) share one emissive material.
  const navG: THREE.BufferGeometry[] = [];
  for (const [x, y, z] of [
    [-1.0, 1.5, 0.2],
    [1.0, 1.5, 0.2],
    [0, 2.95, -6.7],
  ]) {
    const s = new THREE.SphereGeometry(0.06, 6, 4).toNonIndexed();
    s.translate(x, y, z);
    navG.push(s);
  }
  const navMat = M.lamp;
  const nav = new THREE.Mesh(mergeGeometries(navG, false)!, navMat);
  body.add(rotor, tail, nav);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(1, 0.97, 0.9), emissiveIntensity: 0 });
  const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), lampMat);
  const mount = new THREE.Object3D();
  mount.position.set(0, 0.55, 1.6);
  lamp.position.z = 0.2;
  mount.add(lamp);
  body.add(mount);
  return { body, rotor, tail, navMat, lampMat, mount };
}

export class Helicopter {
  readonly group = new THREE.Group();
  readonly spot: THREE.SpotLight;
  readonly target = new THREE.Object3D();
  private cone: THREE.Mesh;
  private coneMat: THREE.ShaderMaterial;
  private rotor: THREE.Mesh;
  private tail: THREE.Mesh;
  private navMat: THREE.MeshStandardMaterial;
  private lampMat: THREE.MeshStandardMaterial;
  private mount: THREE.Object3D;
  active = false;
  leaving = false;
  readonly pos = new THREE.Vector3(0, -500, 0);
  readonly vel = new THREE.Vector3();
  yaw = 0;
  /** Where the searchlight currently points (ground). */
  readonly aim = new THREE.Vector3();
  private time = 0;
  private sweep = 0;
  /** Seconds the beam has been on the suspect. */
  lit = 0;

  constructor(
    readonly index: number,
    scene: THREE.Scene,
  ) {
    const b = build();
    this.rotor = b.rotor;
    this.tail = b.tail;
    this.navMat = b.navMat;
    this.lampMat = b.lampMat;
    this.mount = b.mount;
    this.group.add(b.body);
    this.group.name = `Helicopter${index}`;
    this.group.visible = false;
    this.spot = new THREE.SpotLight(0xf4f6ff, 0, 0, 0.095, 0.45, 1.3);
    this.spot.castShadow = false;
    this.spot.target = this.target;
    scene.add(this.group, this.spot, this.target);
    this.coneMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uStrength: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vT; varying vec3 vN; varying vec3 vView;
        void main(){
          vT = 1.0 - (position.y + 0.5);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vView = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uStrength; varying float vT; varying vec3 vN; varying vec3 vView;
        void main(){
          float rim = pow(abs(dot(normalize(vN), vView)), 1.6);
          float a = rim * (1.0 - smoothstep(0.0, 1.0, vT)) * smoothstep(0.0, 0.04, vT) * uStrength;
          gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a, 1.0);
        }`,
    });
    // Unit cone: apex at y = +0.5, base radius 1 at y = -0.5 (scaled per frame).
    const cg = new THREE.CylinderGeometry(0.02, 1, 1, 24, 1, true);
    this.cone = new THREE.Mesh(cg, this.coneMat);
    this.cone.frustumCulled = false;
    this.cone.renderOrder = 5;
    this.cone.visible = false;
    scene.add(this.cone);
  }

  /** Enter from `from` (edge of the map) towards `toward`. */
  activate(from: THREE.Vector3, toward: THREE.Vector3): void {
    if (this.active && !this.leaving) return;
    this.active = true;
    this.leaving = false;
    if (this.pos.y < -100 || this.pos.distanceTo(toward) > 600) {
      this.pos.set(from.x, heightAt(from.x, from.z) + ALT + 25, from.z);
      this.vel.set(0, 0, 0);
      this.aim.copy(toward);
    }
    this.group.visible = true;
    this.cone.visible = true;
  }

  leave(): void {
    if (this.active) this.leaving = true;
  }

  /**
   * Fly: orbit `center` (the suspect if seen, else the search area); point the searchlight at
   * `suspect` when known, else sweep around `center`.
   */
  update(dt: number, center: THREE.Vector3, suspect: THREE.Vector3 | null, night: number): void {
    this.time += dt;
    if (!this.active) {
      this.spot.intensity = 0;
      this.cone.visible = false;
      return;
    }
    // Desired position: orbit (each helicopter on its own phase / radius).
    const R = 38 + this.index * 14;
    const w = 0.16 * (this.index % 2 ? -1 : 1);
    const ang = this.time * w + this.index * Math.PI;
    const ground = Math.max(heightAt(center.x, center.z), 2.5);
    const want = this.leaving
      ? new THREE.Vector3(this.pos.x + (this.pos.x - center.x) * 4, ground + ALT + 40, this.pos.z + (this.pos.z - center.z) * 4)
      : new THREE.Vector3(center.x + Math.cos(ang) * R, ground + ALT + this.index * 8, center.z + Math.sin(ang) * R);
    const to = want.clone().sub(this.pos);
    const maxV = this.leaving ? 34 : to.length() > 120 ? 38 : 22;
    const desV = to.clone().multiplyScalar(0.8);
    if (desV.length() > maxV) desV.setLength(maxV);
    const acc = desV.sub(this.vel);
    if (acc.length() > 9 * dt) acc.setLength(9 * dt);
    this.vel.add(acc);
    this.pos.addScaledVector(this.vel, dt);
    // Keep clear of terrain.
    const minY = heightAt(this.pos.x, this.pos.z) + 30;
    if (this.pos.y < minY) this.pos.y += (minY - this.pos.y) * Math.min(1, dt * 2);
    // Attitude: face the area of interest, pitch / bank with acceleration.
    const look = suspect ?? center;
    const faceYaw = to.length() > 80 ? Math.atan2(this.vel.x, this.vel.z) : Math.atan2(look.x - this.pos.x, look.z - this.pos.z);
    let dy = faceYaw - this.yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.yaw += dy * Math.min(1, dt * 1.2);
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const pitch = THREE.MathUtils.clamp(this.vel.dot(fwd) * 0.012 + acc.dot(fwd) * 0.8, -0.3, 0.3);
    const roll = THREE.MathUtils.clamp(this.vel.dot(right) * 0.012 + Math.sin(this.time * 0.7 + this.index) * 0.02, -0.3, 0.3);
    this.group.position.copy(this.pos);
    this.group.rotation.set(pitch, this.yaw, roll, 'YXZ');
    this.rotor.rotation.y += dt * 38;
    this.tail.rotation.x += dt * 60;
    const blink = (this.time * 1.2) % 1 < 0.08 ? 6 : 0.6;
    this.navMat.emissiveIntensity = blink;
    // Searchlight.
    let goal: THREE.Vector3;
    if (suspect) goal = suspect.clone();
    else {
      this.sweep += dt * 0.6;
      goal = center.clone().add(new THREE.Vector3(Math.cos(this.sweep * 1.3) * 22, 0, Math.sin(this.sweep) * 22));
      goal.y = heightAt(goal.x, goal.z);
    }
    this.aim.lerp(goal, 1 - Math.exp(-dt * (suspect ? 2.2 : 1.2)));
    const wobble = new THREE.Vector3(Math.sin(this.time * 2.3) * 0.6, 0, Math.cos(this.time * 1.9) * 0.6);
    this.target.position.copy(this.aim).add(wobble);
    this.target.updateMatrixWorld();
    this.group.updateMatrixWorld(true);
    const src = this.mount.getWorldPosition(new THREE.Vector3());
    this.mount.lookAt(this.target.position);
    this.spot.position.copy(src);
    const on = this.leaving ? 0 : 1;
    this.spot.intensity = on * (350 + 650 * night);
    this.lampMat.emissiveIntensity = on * 8;
    // Visible beam.
    const beam = this.target.position.clone().sub(src);
    const len = beam.length();
    const radius = Math.tan(this.spot.angle) * len * 0.9;
    this.cone.visible = on > 0;
    this.cone.position.copy(src).addScaledVector(beam, 0.5);
    this.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), beam.normalize());
    this.cone.scale.set(radius, len, radius);
    this.coneMat.uniforms.uStrength.value = 0.05 + 0.3 * night;
    if (this.leaving && this.pos.distanceTo(center) > 700) this.deactivate();
  }

  /** Is `p` inside the searchlight pool with a clear line from the helicopter? */
  sees(p: THREE.Vector3): boolean {
    if (!this.active || this.leaving) return false;
    if (Math.hypot(p.x - this.aim.x, p.z - this.aim.z) > 9) return false;
    const eye = this.pos.clone().setY(this.pos.y - 1);
    const to = p.clone().setY(p.y + 1).sub(eye);
    const len = to.length();
    return !physics.rayHit(eye, to.normalize(), len - 1, GROUPS_PROBE);
  }

  deactivate(): void {
    this.active = false;
    this.leaving = false;
    this.group.visible = false;
    this.cone.visible = false;
    this.spot.intensity = 0;
    this.pos.set(0, -500, 0);
  }
}
