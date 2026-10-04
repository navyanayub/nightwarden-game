/**
 * Instanced street furniture. One InstancedMesh per model part for the whole city;
 * every few frames the instance list is rebuilt with only the placements near the camera
 * (distance culling + small bounds => effective frustum culling).
 */
import * as THREE from 'three';
import { assets } from '../core/AssetLoader';
import { MeshBuilder } from './MeshBuilder';
import { materials } from './Materials';
import type { PropSpec } from './CityLayout';

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  matrix: THREE.Matrix4;
  castShadow: boolean;
}

export interface PropModel {
  parts: Part[];
  /** Collision cylinder radius (0 = none) and height. */
  radius: number;
  height: number;
  /** Max draw distance multiplier (relative to settings.q.propDistance). */
  range: number;
  /** 'tree' = drawn within treeRange; 'impostor' = drawn between treeRange and farRange. */
  band?: 'tree' | 'impostor';
}

interface Placement {
  m: THREE.Matrix4;
  x: number;
  z: number;
  tag: string;
}

class PropType {
  meshes: THREE.InstancedMesh[] = [];
  placements: Placement[] = [];
  capacity = 0;
  constructor(
    readonly name: string,
    readonly model: PropModel,
    private readonly scene: THREE.Object3D,
  ) {}

  ensureCapacity(n: number): void {
    if (n <= this.capacity) return;
    const cap = Math.max(64, Math.ceil(n * 1.5));
    for (const m of this.meshes) {
      this.scene.remove(m);
      m.dispose();
    }
    this.meshes = this.model.parts.map((p) => {
      const im = new THREE.InstancedMesh(p.geometry, p.material, cap);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = p.castShadow;
      im.receiveShadow = true;
      im.count = 0;
      im.name = `prop:${this.name}`;
      im.frustumCulled = true;
      this.scene.add(im);
      return im;
    });
    this.capacity = cap;
  }
}

const tmp = new THREE.Matrix4();

export class PropSystem {
  readonly types = new Map<string, PropType>();
  readonly group = new THREE.Group();
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private dirty = true;
  range = 200;
  treeRange = 240;
  farRange = 2000;

  constructor() {
    this.group.name = 'Props';
  }

  register(name: string, model: PropModel): void {
    this.types.set(name, new PropType(name, model, this.group));
  }

  has(name: string): boolean {
    return this.types.has(name);
  }

  add(spec: PropSpec, tag = 'static'): void {
    const t = this.types.get(spec.type);
    if (!t) return;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(spec.x, spec.y, spec.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.yaw),
      new THREE.Vector3(spec.s ?? 1, spec.s ?? 1, spec.s ?? 1),
    );
    t.placements.push({ m, x: spec.x, z: spec.z, tag });
    this.dirty = true;
  }

  removeTag(tag: string): void {
    for (const t of this.types.values()) {
      const before = t.placements.length;
      t.placements = t.placements.filter((p) => p.tag !== tag);
      if (t.placements.length !== before) this.dirty = true;
    }
  }

  /** Rebuild visible instance lists when the camera has moved enough. */
  update(cam: THREE.Vector3, force = false): void {
    if (!force && !this.dirty && cam.distanceToSquared(this.lastPos) < 64) return;
    this.lastPos.copy(cam);
    this.dirty = false;
    for (const t of this.types.values()) {
      const band = t.model.band;
      const r = band === 'tree' ? this.treeRange : band === 'impostor' ? this.farRange : this.range * t.model.range;
      const rMin = band === 'impostor' ? this.treeRange * 0.92 : 0;
      const r2 = r * r;
      const rMin2 = rMin * rMin;
      const visible: THREE.Matrix4[] = [];
      for (const p of t.placements) {
        const dx = p.x - cam.x;
        const dz = p.z - cam.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < r2 && d2 >= rMin2) visible.push(p.m);
      }
      t.ensureCapacity(visible.length);
      t.meshes.forEach((im, pi) => {
        const part = t.model.parts[pi];
        for (let i = 0; i < visible.length; i++) {
          tmp.multiplyMatrices(visible[i], part.matrix);
          im.setMatrixAt(i, tmp);
        }
        im.count = visible.length;
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
      });
    }
  }

  /** All placements of collidable types (for static physics colliders). */
  *colliders(): Generator<{ x: number; y: number; z: number; r: number; h: number }> {
    for (const t of this.types.values()) {
      if (t.model.radius <= 0) continue;
      for (const p of t.placements) {
        if (p.tag !== 'static') continue;
        const e = p.m.elements;
        yield { x: e[12], y: e[13], z: e[14], r: t.model.radius, h: t.model.height };
      }
    }
  }
}

// ------------------------------------------------------------------ model factories

/** Load a Poly Haven GLB as instancable parts, recentred to its base. */
export async function gltfModel(path: string, opts: { yaw?: number; radius?: number; height?: number; range?: number; scale?: number; firstMeshOnly?: boolean; shadow?: boolean } = {}): Promise<PropModel> {
  const gltf = await assets.loadGLTF(path);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshes.push(m);
  });
  const used = opts.firstMeshOnly ? meshes.filter((m) => m.name === meshes[0].name || m.parent === meshes[0].parent).slice(0, 2) : meshes;
  for (const m of used) box.expandByObject(m);
  const center = box.getCenter(new THREE.Vector3());
  const s = opts.scale ?? 1;
  const fix = new THREE.Matrix4()
    .makeRotationY(opts.yaw ?? 0)
    .multiply(new THREE.Matrix4().makeScale(s, s, s))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -box.min.y, -center.z));
  const parts: Part[] = used.map((m) => {
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.envMapIntensity = 1;
    return { geometry: m.geometry, material: mat, matrix: fix.clone().multiply(m.matrixWorld), castShadow: opts.shadow ?? true };
  });
  return { parts, radius: opts.radius ?? 0, height: opts.height ?? 1, range: opts.range ?? 1 };
}

function builtModel(mb: MeshBuilder, opts: { radius?: number; height?: number; range?: number; shadow?: boolean } = {}): PropModel {
  const g = mb.build(materials.m);
  const parts: Part[] = [];
  g.children.forEach((c) => {
    const m = c as THREE.Mesh;
    parts.push({ geometry: m.geometry, material: m.material as THREE.Material, matrix: new THREE.Matrix4(), castShadow: opts.shadow ?? true });
  });
  return { parts, radius: opts.radius ?? 0, height: opts.height ?? 1, range: opts.range ?? 1 };
}

/** Modern street lamp: tapered pole, curved arm, LED head. Head points along local +z. */
export function lampModel(): PropModel {
  const mb = new MeshBuilder();
  mb.lathe('paint_dark', 0, 0, [[0.16, 0], [0.16, 0.5], [0.11, 0.6], [0.085, 4.5], [0.065, 8.2]], 12, { capTop: true });
  mb.lathe('paint_dark', 0, 0, [[0.2, 0], [0.2, 0.06], [0.16, 0.12]], 12);
  // Arm: segments curving out over the road (+z).
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push([0, 8.1 + Math.sin(t * Math.PI * 0.5) * 0.5, t * 2.2]);
  }
  for (let i = 0; i < pts.length - 1; i++) mb.beam('paint_dark', pts[i], pts[i + 1], 0.08);
  const [hx, hy, hz] = pts[pts.length - 1];
  mb.box('paint_dark', hx - 0.2, hy - 0.12, hz - 0.2, hx + 0.2, hy + 0.06, hz + 0.55);
  mb.box('lamp_glow', hx - 0.16, hy - 0.14, hz - 0.15, hx + 0.16, hy - 0.11, hz + 0.5);
  return builtModel(mb, { radius: 0.18, height: 8, range: 1.4 });
}

/** Old Town lantern post. */
export function oldLampModel(): PropModel {
  const mb = new MeshBuilder();
  mb.lathe('paint_dark', 0, 0, [[0.22, 0], [0.22, 0.35], [0.14, 0.45], [0.14, 0.6], [0.09, 0.75], [0.07, 3.2], [0.1, 3.3], [0.06, 3.5]], 10, { capTop: true });
  // Lantern: tapered glass box with cap.
  mb.lathe('paint_dark', 0, 0, [[0.12, 3.5], [0.22, 3.62]], 4);
  mb.lathe('lamp_glow', 0, 0, [[0.2, 3.62], [0.26, 4.1]], 4, { capTop: false });
  mb.lathe('paint_dark', 0, 0, [[0.3, 4.1], [0.34, 4.16], [0.05, 4.45], [0.0, 4.55]], 4, { capTop: true });
  return builtModel(mb, { radius: 0.2, height: 4, range: 1.2 });
}

export function parkLampModel(): PropModel {
  const mb = new MeshBuilder();
  mb.lathe('paint_dark', 0, 0, [[0.12, 0], [0.12, 0.3], [0.06, 0.4], [0.05, 3.4]], 10, { capTop: true });
  mb.lathe('lamp_glow', 0, 0, [[0.05, 3.4], [0.22, 3.55], [0.24, 3.8], [0.18, 3.95]], 12, { capTop: true });
  mb.lathe('paint_dark', 0, 0, [[0.26, 3.95], [0.05, 4.1], [0.0, 4.15]], 12, { capTop: true });
  return builtModel(mb, { radius: 0.12, height: 3.5, range: 1 });
}

/** Traffic signal pole with a 3-lamp head facing local +z. Lamp materials cycle in World. */
export function signalModel(): PropModel {
  const mb = new MeshBuilder();
  mb.lathe('paint_dark', 0, 0, [[0.14, 0], [0.14, 0.3], [0.09, 0.4], [0.09, 3.8]], 10, { capTop: true });
  mb.box('paint_dark', -0.18, 2.3, 0.08, 0.18, 3.4, 0.36);
  // Visors.
  for (let i = 0; i < 3; i++) {
    const y = 3.2 - i * 0.36;
    mb.box('paint_dark', -0.15, y + 0.12, 0.36, 0.15, y + 0.14, 0.56);
  }
  mb.box('paint_white', -0.24, 2.25, 0.06, 0.24, 3.45, 0.075);
  const base = builtModel(mb, { radius: 0.14, height: 3.8, range: 1.2 });
  // Lenses as separate parts so their materials can switch.
  const lens = (key: string, y: number): Part => {
    const g = new THREE.CircleGeometry(0.12, 16);
    g.translate(0, y, 0.365);
    return { geometry: g, material: materials.m[key], matrix: new THREE.Matrix4(), castShadow: false };
  };
  base.parts.push(lens('light_red', 3.2), lens('light_amber', 2.84), lens('light_green', 2.48));
  return base;
}

export function bollardModel(): PropModel {
  const mb = new MeshBuilder();
  mb.lathe('paint_dark', 0, 0, [[0.22, 0], [0.22, 0.45], [0.26, 0.5], [0.18, 0.62], [0.0, 0.66]], 12, { capTop: true });
  return builtModel(mb, { radius: 0.24, height: 0.6, range: 0.8 });
}

/** A rotated copy of a model's parts (for re-using GLTF parts with different yaw). */
export function withYaw(model: PropModel, yaw: number): PropModel {
  const r = new THREE.Matrix4().makeRotationY(yaw);
  return { ...model, parts: model.parts.map((p) => ({ ...p, matrix: r.clone().multiply(p.matrix) })) };
}
