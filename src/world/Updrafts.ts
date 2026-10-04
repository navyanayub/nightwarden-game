/**
 * Hot-air updrafts for gliding: every industrial chimney plus big roof exhaust vents on a
 * deterministic subset of flat-roofed buildings. Each is a vertical column (radius, height,
 * strength fading with height); `lift(x, y, z)` returns the upward air speed there.
 *
 * Visuals: one instanced mesh for the vent housings and one instanced mesh of soft rising
 * steam/heat puffs around the nearest columns (camera-sorted, recycled), so the updrafts are
 * readable from the air at night.
 */
import * as THREE from 'three';
import type { CityData } from './CityLayout';
import { hashFloat } from '../core/Random';
import { physics, GROUPS_WORLD } from '../core/Physics';

export interface Updraft {
  x: number;
  z: number;
  y0: number;
  height: number;
  r: number;
  strength: number;
  kind: 'chimney' | 'vent';
}

const PUFFS_PER = 26;
const MAX_ACTIVE = 8;

export class Updrafts {
  readonly list: Updraft[] = [];
  readonly group = new THREE.Group();
  private puffs: THREE.InstancedMesh;
  private puffMat: THREE.ShaderMaterial;
  private time = 0;
  private dummy = new THREE.Object3D();

  constructor(city: CityData) {
    for (const f of city.features) {
      if (f.type !== 'chimney') continue;
      const h = f.p?.h ?? 40;
      this.list.push({ x: f.x, z: f.z, y0: f.y + h, height: 70, r: 6, strength: 11, kind: 'chimney' });
    }
    // Roof vents on a subset of flat roofs (taller industrial / office buildings).
    const vents: Updraft[] = [];
    for (const b of city.buildings) {
      if (b.roof !== 'flat' || b.height < 14) continue;
      const ok = b.style === 'factory' || b.style === 'warehouse' || b.style === 'office' || b.style === 'glass';
      if (!ok || hashFloat(b.id, 913) > (b.style === 'factory' || b.style === 'warehouse' ? 0.35 : 0.1)) continue;
      const top = b.tiers.length ? b.tiers[b.tiers.length - 1] : { w: b.w, d: b.d, h: b.height };
      if (top.w < 10 || top.d < 10) continue;
      const ox = (hashFloat(b.id, 914) - 0.5) * (top.w - 8) * 0.6;
      const oz = (hashFloat(b.id, 915) - 0.5) * (top.d - 8) * 0.6;
      vents.push({ x: b.cx + ox, z: b.cz + oz, y0: b.baseY + b.height, height: 55, r: 4.5, strength: 9, kind: 'vent' });
    }
    this.list.push(...vents);
    // Vent housings: a squat cylinder with a grille cap.
    const housing = new THREE.CylinderGeometry(1.25, 1.4, 1.3, 16);
    housing.translate(0, 0.65, 0);
    const cap = new THREE.CylinderGeometry(1.32, 1.32, 0.12, 16);
    cap.translate(0, 1.36, 0);
    const vMesh = new THREE.InstancedMesh(housing, new THREE.MeshStandardMaterial({ color: 0x6d7378, metalness: 0.75, roughness: 0.4 }), Math.max(1, vents.length));
    const cMesh = new THREE.InstancedMesh(cap, new THREE.MeshStandardMaterial({ color: 0x2a2d30, metalness: 0.6, roughness: 0.55 }), Math.max(1, vents.length));
    vents.forEach((v, i) => {
      this.dummy.position.set(v.x, v.y0, v.z);
      this.dummy.updateMatrix();
      vMesh.setMatrixAt(i, this.dummy.matrix);
      cMesh.setMatrixAt(i, this.dummy.matrix);
      physics.addStaticCylinder(v.x, v.y0 + 0.7, v.z, 0.7, 1.3, GROUPS_WORLD);
    });
    vMesh.count = cMesh.count = vents.length;
    for (const m of [vMesh, cMesh]) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.computeBoundingSphere();
      this.group.add(m);
    }
    // Rising puffs.
    this.puffMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        attribute float aFade;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          vUv = uv;
          vFade = aFade;
          vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(instanceMatrix[0].xyz);
          c.xy += position.xy * s;
          gl_Position = projectionMatrix * c;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uLight;
        varying vec2 vUv;
        varying float vFade;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.1, d) * vFade * 0.16;
          gl_FragColor = vec4(uLight, a);
        }`,
    });
    const quad = new THREE.PlaneGeometry(1, 1);
    this.puffs = new THREE.InstancedMesh(quad, this.puffMat, PUFFS_PER * MAX_ACTIVE);
    this.puffs.geometry.setAttribute('aFade', new THREE.InstancedBufferAttribute(new Float32Array(PUFFS_PER * MAX_ACTIVE), 1));
    this.puffs.frustumCulled = false;
    this.puffs.count = 0;
    this.group.add(this.puffs);
    this.group.name = 'Updrafts';
  }

  /** Upward air speed (m/s) at a point. */
  lift(x: number, y: number, z: number): number {
    let best = 0;
    for (const u of this.list) {
      const dx = x - u.x;
      const dz = z - u.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > u.r * u.r) continue;
      const h = y - u.y0;
      if (h < -3 || h > u.height) continue;
      const radial = 1 - Math.sqrt(d2) / u.r;
      const vert = 1 - Math.max(0, h) / u.height;
      best = Math.max(best, u.strength * Math.min(1, radial * 1.6) * (0.35 + 0.65 * vert));
    }
    return best;
  }

  nearest(x: number, z: number): Updraft | null {
    let best: Updraft | null = null;
    let bd = Infinity;
    for (const u of this.list) {
      const d = (u.x - x) ** 2 + (u.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  update(dt: number, cam: THREE.Vector3, daylight: number): void {
    this.time += dt;
    const near = this.list
      .map((u) => ({ u, d: (u.x - cam.x) ** 2 + (u.z - cam.z) ** 2 }))
      .filter((e) => e.d < 400 * 400)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_ACTIVE);
    const fade = this.puffs.geometry.getAttribute('aFade') as THREE.InstancedBufferAttribute;
    let n = 0;
    near.forEach(({ u }, k) => {
      for (let i = 0; i < PUFFS_PER; i++) {
        const seed = k * 97 + i;
        const life = 7;
        const t = (this.time / life + hashFloat(seed, u.x | 0)) % 1;
        const ang = hashFloat(seed, 2) * Math.PI * 2 + t * 2;
        const rr = u.r * 0.35 * (0.3 + t) * hashFloat(seed, 3);
        this.dummy.position.set(u.x + Math.cos(ang) * rr, u.y0 + 1 + t * u.height * 0.55, u.z + Math.sin(ang) * rr);
        const s = (u.kind === 'chimney' ? 4 : 2.5) * (0.5 + t * 2.5);
        this.dummy.scale.set(s, s, s);
        this.dummy.updateMatrix();
        this.puffs.setMatrixAt(n, this.dummy.matrix);
        fade.setX(n, Math.sin(t * Math.PI) * (u.kind === 'chimney' ? 1 : 0.6));
        n++;
      }
    });
    this.puffs.count = n;
    this.puffs.instanceMatrix.needsUpdate = true;
    fade.needsUpdate = true;
    const l = 0.12 + daylight * 0.75;
    (this.puffMat.uniforms.uLight.value as THREE.Color).setRGB(l, l, l * 1.03);
  }
}
