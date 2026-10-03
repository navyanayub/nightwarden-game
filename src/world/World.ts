/**
 * World: builds Port Vellmoor from the seeded layout and streams detail around the camera.
 *
 * Layers per 200 m chunk:
 *  - terrain (LOD0 4 m grid near / LOD1 16 m grid far)
 *  - ground base (roads, pavements, kerbs) merged per 3x3-chunk region, always drawn
 *  - ground detail (markings, crossings, street signs) within markingDistance
 *  - far facades (impostor boxes, 1 draw call) beyond detailDistance
 *  - building detail (full facades) built lazily within detailDistance, disposed when far
 *  - minor features (containers, hedges, fences, rail yard) within detail * 1.6
 * Global landmarks (bridge, seawall, airfield) are separate frustum-culled meshes.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { events } from '../core/EventBus';
import { physics, GROUPS_PROP, GROUPS_WORLD, RAPIER } from '../core/Physics';
import { settings, type QualitySettings } from '../core/Settings';
import { hashN } from '../core/Random';
import { MeshBuilder } from './MeshBuilder';
import { materials, shared } from './Materials';
import { generateCity, type BuildingSpec, type CityData, type Feature, type PropSpec, type RoadNode } from './CityLayout';
import { buildDetail, buildFar, buildingColliders } from './BuildingGen';
import { buildBlockGround, buildNode, buildPath, buildRoadSegment } from './RoadGen';
import { buildFeature, type FeatureResult } from './Landmarks';
import { PropSystem, gltfModel, lampModel, oldLampModel, parkLampModel, signalModel, bollardModel, type PropModel } from './Props';
import { buildTrees, impostorModel } from './Trees';
import { createHeightTexture, createTerrainCollider, heightAt, heightfield, terrainSplat } from './Terrain';
import { Water } from './Water';
import { CHUNK_SIZE, LAKE, TERRAIN } from './WorldConfig';
import { signs } from './Signage';

const BASE_KEYS = new Set(['asphalt', 'cobble', 'pavement', 'plaza', 'grass', 'gravel', 'kerb']);
const MAJOR_FEATURES = new Set(['clocktower', 'lighthouse', 'crane', 'chimney', 'tank', 'pavilion']);
const GLOBAL_FEATURES = new Set(['seawall', 'bridge', 'airport']);
const WALKABLE_KEYS = new Set(['pavement', 'plaza', 'kerb', 'grass', 'cobble', 'gravel']);

interface Chunk {
  key: string;
  ix: number;
  iz: number;
  cx: number;
  cz: number;
  buildings: BuildingSpec[];
  features: Feature[];
  props: PropSpec[];
  terrain0?: THREE.Mesh;
  terrain1?: THREE.Mesh;
  far?: THREE.Object3D;
  groundNear?: THREE.Object3D;
  minor?: THREE.Object3D;
  major?: THREE.Object3D;
  detail?: THREE.Object3D;
  detailState: 'none' | 'built';
  lastNear: number;
}

export class World {
  readonly root = new THREE.Group();
  readonly city: CityData;
  readonly props = new PropSystem();
  private chunks = new Map<string, Chunk>();
  private water!: Water;
  private lake!: Water;
  private animated: THREE.Object3D[] = [];
  private signalMats: THREE.MeshStandardMaterial[] = [];
  private lampMat!: THREE.MeshStandardMaterial;
  private buildQueue: Chunk[] = [];
  private frame = 0;
  /** In-game clock in hours (Stage 2 adds a day/night cycle). */
  clockHours = 14.5;
  stats = { chunks: 0, detail: 0, buildings: 0 };

  constructor(private readonly scene: THREE.Scene, private readonly renderer: THREE.WebGLRenderer) {
    this.root.name = 'World';
    scene.add(this.root);
    heightfield.bake();
    this.city = generateCity();
    this.stats.buildings = this.city.buildings.length;
  }

  private chunkAt(x: number, z: number): Chunk {
    const ix = Math.floor(x / CHUNK_SIZE);
    const iz = Math.floor(z / CHUNK_SIZE);
    const key = `${ix},${iz}`;
    let c = this.chunks.get(key);
    if (!c) {
      c = { key, ix, iz, cx: (ix + 0.5) * CHUNK_SIZE, cz: (iz + 0.5) * CHUNK_SIZE, buildings: [], features: [], props: [], detailState: 'none', lastNear: 0 };
      this.chunks.set(key, c);
    }
    return c;
  }

  async init(onProgress: (label: string) => Promise<void>): Promise<void> {
    await materials.load();
    await onProgress('Shaping the coastline');
    createTerrainCollider();
    // Ocean & lake.
    const heightTex = createHeightTexture();
    this.water = new Water(heightTex, 0);
    this.root.add(this.water.mesh);
    this.lake = new Water(heightTex, LAKE.level, LAKE.rx * 3, 60);
    this.lake.material.envMapIntensity = 0.8;
    this.lake.mesh.position.set(LAKE.x, LAKE.level, LAKE.z);
    this.lake.follow = () => undefined;
    this.root.add(this.lake.mesh);
    // Assign content to chunks.
    for (const b of this.city.buildings) this.chunkAt(b.cx, b.cz).buildings.push(b);
    for (const f of this.city.features) if (!GLOBAL_FEATURES.has(f.type)) this.chunkAt(f.x, f.z).features.push(f);
    for (const p of this.city.props) this.chunkAt(p.x, p.z).props.push(p);
    for (let x = TERRAIN.minX; x < TERRAIN.maxX; x += CHUNK_SIZE) for (let z = TERRAIN.minZ; z < TERRAIN.maxZ; z += CHUNK_SIZE) this.chunkAt(x + 1, z + 1);
    await onProgress('Raising the terrain');
    this.buildTerrain();
    await onProgress('Paving the streets');
    this.buildGround();
    await onProgress('Raising the skyline');
    this.buildFarFacades();
    this.buildColliders();
    await onProgress('Placing street furniture');
    await this.buildProps();
    await onProgress('Building landmarks');
    this.buildFeatures();
    this.applyPreset(settings.q);
    this.stats.chunks = this.chunks.size;
  }

  // ---------------------------------------------------------------- terrain

  private buildTerrain(): void {
    const mat = materials.m.terrain as THREE.MeshStandardMaterial;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 6;
    for (const c of this.chunks.values()) {
      const x0 = c.ix * CHUNK_SIZE;
      const z0 = c.iz * CHUNK_SIZE;
      if (x0 < TERRAIN.minX - 1 || z0 < TERRAIN.minZ - 1 || x0 + CHUNK_SIZE > TERRAIN.maxX + 1 || z0 + CHUNK_SIZE > TERRAIN.maxZ + 1) continue;
      // Skip open sea chunks.
      let maxH = -Infinity;
      for (let x = x0; x <= x0 + CHUNK_SIZE; x += 8) for (let z = z0; z <= z0 + CHUNK_SIZE; z += 8) maxH = Math.max(maxH, heightAt(x, z));
      if (maxH < -6) continue;
      c.terrain0 = this.terrainMesh(x0, z0, TERRAIN.cell, mat);
      c.terrain1 = this.terrainMesh(x0, z0, TERRAIN.cell * 4, mat);
      this.root.add(c.terrain0, c.terrain1);
    }
  }

  private terrainMesh(x0: number, z0: number, step: number, mat: THREE.Material): THREE.Mesh {
    const n = Math.round(CHUNK_SIZE / step);
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        const h = heightAt(x, z);
        const e = TERRAIN.cell;
        const nx = heightAt(x - e, z) - heightAt(x + e, z);
        const nz = heightAt(x, z - e) - heightAt(x, z + e);
        const nl = Math.hypot(nx, 2 * e, nz);
        pos.push(x, h, z);
        nor.push(nx / nl, (2 * e) / nl, nz / nl);
        uv.push(x, -z);
        const slope = 1 - (2 * e) / nl;
        const [g, s, r] = terrainSplat(x, z, h, slope * 3);
        col.push(g, s, r);
      }
    }
    // Match the physics/heightfield triangle split (anti-diagonal).
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + 1;
        const d = a + (n + 1);
        const e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.castShadow = false;
    m.matrixAutoUpdate = false;
    m.name = `terrain${step}`;
    return m;
  }

  // ---------------------------------------------------------------- ground

  private buildGround(): void {
    const nodeAt = new Map<string, RoadNode>();
    for (const n of this.city.nodes) nodeAt.set(`${Math.round(n.x * 10)},${Math.round(n.z * 10)}`, n);
    const node = (x: number, z: number) => nodeAt.get(`${Math.round(x * 10)},${Math.round(z * 10)}`);
    const builders = new Map<string, MeshBuilder>();
    const mbFor = (x: number, z: number) => {
      const c = this.chunkAt(x, z);
      let mb = builders.get(c.key);
      if (!mb) {
        mb = new MeshBuilder();
        builders.set(c.key, mb);
      }
      return mb;
    };
    for (const r of this.city.roads) buildRoadSegment(mbFor((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2), r, node(r.x0, r.z0), node(r.x1, r.z1));
    for (const n of this.city.nodes) buildNode(mbFor(n.x, n.z), n);
    for (const b of this.city.blocks) buildBlockGround(mbFor((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2), b);
    for (const p of this.city.paths) buildPath(mbFor(p.pts[0][0], p.pts[0][1]), p);
    // Street name signs (one per junction) go into the detail ground.
    for (const p of this.city.props) {
      if (p.type === 'street_sign' || p.type === 'stop_sign') streetSign(mbFor(p.x, p.z), p, this.city);
    }
    // Split each chunk builder into base (merged per region) and near (per chunk).
    const regionParts = new Map<string, Map<string, THREE.BufferGeometry[]>>();
    for (const [key, mb] of builders) {
      const c = this.chunks.get(key)!;
      const near = new MeshBuilder();
      for (const [k, buf] of mb.buffers) if (!BASE_KEYS.has(k)) near.buffers.set(k, buf);
      if (near.buffers.size) {
        c.groundNear = near.build(materials.m, { castShadow: false, name: `groundNear:${key}` });
        this.root.add(c.groundNear);
      }
      const rk = `${Math.floor(c.ix / 3)},${Math.floor(c.iz / 3)}`;
      let parts = regionParts.get(rk);
      if (!parts) {
        parts = new Map();
        regionParts.set(rk, parts);
      }
      // Walkable collision surface (pavements, kerbs, lawns) per chunk.
      const verts: number[] = [];
      const inds: number[] = [];
      for (const [k, buf] of mb.buffers) {
        if (!BASE_KEYS.has(k)) continue;
        const g = buf.toGeometry();
        g.deleteAttribute('aWin');
        const arr = parts.get(k) ?? [];
        arr.push(g);
        parts.set(k, arr);
        if (WALKABLE_KEYS.has(k)) {
          const base = verts.length / 3;
          for (const v of buf.pos) verts.push(v);
          for (const i of buf.idx) inds.push(i + base);
        }
      }
      if (inds.length) physics.addTrimesh(new Float32Array(verts), new Uint32Array(inds), GROUPS_WORLD);
    }
    for (const [rk, parts] of regionParts) {
      const grp = new THREE.Group();
      grp.name = `groundBase:${rk}`;
      for (const [k, geos] of parts) {
        const merged = mergeGeometries(geos, false);
        if (!merged) continue;
        merged.computeBoundingSphere();
        const m = new THREE.Mesh(merged, materials.m[k]);
        m.receiveShadow = true;
        m.castShadow = k === 'kerb';
        m.matrixAutoUpdate = false;
        grp.add(m);
        geos.forEach((g) => g.dispose());
      }
      this.root.add(grp);
    }
  }

  // ---------------------------------------------------------------- buildings

  private buildFarFacades(): void {
    for (const c of this.chunks.values()) {
      if (!c.buildings.length) continue;
      const mb = new MeshBuilder();
      for (const b of c.buildings) buildFar(mb, b);
      c.far = mb.build(materials.m, { castShadow: false, name: `far:${c.key}` });
      this.root.add(c.far);
    }
  }

  private buildColliders(): void {
    for (const b of this.city.buildings) {
      for (const [x, y, z, hx, hy, hz] of buildingColliders(b)) physics.addStaticBox(x, y, z, hx, hy, hz, 0, GROUPS_WORLD);
    }
  }

  private buildChunkDetail(c: Chunk): void {
    const mb = new MeshBuilder();
    for (const b of c.buildings) {
      const res = buildDetail(mb, b);
      for (const p of res.props) this.props.add(p, c.key);
    }
    c.detail = mb.build(materials.m, { name: `detail:${c.key}` });
    this.root.add(c.detail);
    c.detailState = 'built';
    events.emit('world:chunkBuilt', { key: c.key });
  }

  private disposeChunkDetail(c: Chunk): void {
    if (!c.detail) return;
    this.root.remove(c.detail);
    c.detail.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    c.detail = undefined;
    c.detailState = 'none';
    this.props.removeTag(c.key);
  }

  // ---------------------------------------------------------------- features

  private buildFeatures(): void {
    const res: FeatureResult = { props: [], boxes: [], trimeshes: [], animated: [] };
    for (const c of this.chunks.values()) {
      if (!c.features.length) continue;
      const major = new MeshBuilder();
      const minor = new MeshBuilder();
      for (const f of c.features) buildFeature(MAJOR_FEATURES.has(f.type) ? major : minor, f, res);
      if (major.buffers.size) {
        c.major = major.build(materials.m, { name: `major:${c.key}` });
        this.root.add(c.major);
      }
      if (minor.buffers.size) {
        c.minor = minor.build(materials.m, { name: `minor:${c.key}` });
        this.root.add(c.minor);
      }
    }
    // Global landmarks.
    for (const f of this.city.features) {
      if (!GLOBAL_FEATURES.has(f.type)) continue;
      const mb = new MeshBuilder();
      buildFeature(mb, f, res);
      const g = mb.build(materials.m, { name: `landmark:${f.type}` });
      this.root.add(g);
    }
    for (const [x, y, z, hx, hy, hz, yaw] of res.boxes) physics.addStaticBox(x, y, z, hx, hy, hz, yaw, GROUPS_WORLD);
    for (const t of res.trimeshes) physics.addTrimesh(new Float32Array(t.v), new Uint32Array(t.i), GROUPS_WORLD);
    for (const p of res.props) this.props.add(p);
    for (const a of res.animated) {
      this.root.add(a);
      this.animated.push(a);
    }
  }

  // ---------------------------------------------------------------- props

  private async buildProps(): Promise<void> {
    const P = this.props;
    const reg = (name: string, m: PropModel) => P.register(name, m);
    const load = async (name: string, path: string, opts: Parameters<typeof gltfModel>[1]) => {
      try {
        reg(name, await gltfModel(path, opts));
      } catch (e) {
        console.warn('prop failed', name, e);
      }
    };
    await Promise.all([
      load('hydrant', 'models/props/fire_hydrant.glb', { radius: 0.2, height: 0.8, range: 0.7 }),
      load('bin', 'models/props/metal_trash_can.glb', { radius: 0.3, height: 0.9, range: 0.7 }),
      load('bench', 'models/props/painted_wooden_bench.glb', { radius: 0, range: 0.7, yaw: Math.PI / 2 }),
      load('aircon', 'models/props/exterior_aircon_unit.glb', { firstMeshOnly: true, scale: 1.6, range: 1.2 }),
      load('utility_box', 'models/props/utility_box_01.glb', { radius: 0.35, height: 1.2, range: 0.7 }),
      load('barrier', 'models/props/concrete_road_barrier.glb', { radius: 0.4, height: 0.8, range: 0.8 }),
      load('crate', 'models/props/wooden_crate_01.glb', { radius: 0.5, height: 1, range: 0.7, scale: 1.4 }),
      load('barrel', 'models/props/Barrel_01.glb', { radius: 0.35, height: 1, range: 0.7 }),
      load('sea_marker', 'models/props/lateral_sea_marker.glb', { range: 3, scale: 1.4 }),
      load('planter', 'models/props/planter_box_01.glb', { radius: 0.5, height: 0.6, range: 0.8, scale: 1.6 }),
      load('picnic', 'models/props/wooden_picnic_table.glb', { radius: 0.8, height: 0.8, range: 0.7 }),
      load('manhole', 'models/props/water_manhole_cover.glb', { range: 0.5, shadow: false }),
    ]);
    reg('lamp', lampModel());
    reg('lamp_old', oldLampModel());
    reg('lamp_park', parkLampModel());
    reg('signal', signalModel());
    reg('bollard', bollardModel());
    this.lampMat = materials.m.lamp_glow as THREE.MeshStandardMaterial;
    this.signalMats = ['light_red', 'light_amber', 'light_green'].map((k) => materials.m[k] as THREE.MeshStandardMaterial);
    // Trees + impostors.
    const kit = buildTrees(this.renderer, this.scene.environment);
    kit.models.forEach((m, i) => {
      m.band = 'tree';
      reg(`tree${i}`, m);
      const imp = impostorModel(kit, i);
      imp.band = 'impostor';
      reg(`timp${i}`, imp);
    });
    // Place static props (signals carry a phase variant; trees pick a variant).
    for (const p of this.city.props) {
      if (p.type === 'street_sign' || p.type === 'stop_sign') continue;
      if (p.type === 'tree' || p.type === 'tree_small') {
        const v = p.type === 'tree_small' ? 3 : hashN(Math.round(p.x * 10), Math.round(p.z * 10)) % 3;
        const s = (p.s ?? 1) * (p.type === 'tree_small' ? 0.85 : 0.9 + (hashN(Math.round(p.z), 3) % 30) / 100);
        P.add({ ...p, type: `tree${v}`, s });
        P.add({ ...p, type: `timp${v}`, s });
        continue;
      }
      if (p.type === 'signal') {
        P.add(p);
        continue;
      }
      P.add(p);
    }
    // Static colliders for props.
    for (const c of P.colliders()) {
      physics.world.createCollider(RAPIER.ColliderDesc.cylinder(c.h / 2, c.r).setTranslation(c.x, c.y + c.h / 2, c.z).setCollisionGroups(GROUPS_PROP));
    }
    this.root.add(P.group);
  }

  // ---------------------------------------------------------------- runtime

  applyPreset(q: QualitySettings): void {
    this.props.range = q.propDistance;
    this.props.treeRange = q.treeDistance;
    this.props.farRange = q.drawDistance;
    this.props.update(new THREE.Vector3(1e9, 0, 0), true);
    for (const c of this.chunks.values()) if (c.detailState === 'built') c.lastNear = 0;
  }

  /** Synchronously build all detail chunks around a point (used by loading / tests). */
  prime(pos: THREE.Vector3): void {
    for (const c of this.chunks.values()) {
      if (c.detailState === 'none' && c.buildings.length && this.chunkDist(c, pos) < settings.q.detailDistance) this.buildChunkDetail(c);
    }
    this.update(0, pos, true);
  }

  private chunkDist(c: Chunk, p: THREE.Vector3): number {
    const half = CHUNK_SIZE / 2;
    const dx = Math.max(Math.abs(p.x - c.cx) - half, 0);
    const dz = Math.max(Math.abs(p.z - c.cz) - half, 0);
    return Math.hypot(dx, dz);
  }

  update(dt: number, cam: THREE.Vector3, force = false): void {
    this.frame++;
    shared.time.value += dt;
    const q = settings.q;
    this.water.follow(cam);
    // Chunk visibility & detail streaming.
    if (force || this.frame % 4 === 0) {
      this.buildQueue = [];
      for (const c of this.chunks.values()) {
        const d = this.chunkDist(c, cam);
        const inDraw = d < q.drawDistance;
        if (c.terrain0) {
          c.terrain0.visible = inDraw && d < 420;
          c.terrain1!.visible = inDraw && d >= 420;
        }
        if (c.groundNear) c.groundNear.visible = d < Math.max(450, q.detailDistance * 1.3);
        if (c.minor) c.minor.visible = d < q.detailDistance * 1.6;
        if (c.major) c.major.visible = inDraw;
        const wantDetail = d < q.detailDistance && c.buildings.length > 0;
        if (wantDetail && c.detailState === 'none') this.buildQueue.push(c);
        if (c.detailState === 'built') {
          if (d < q.detailDistance + 60) c.lastNear = this.frame;
          else if (this.frame - c.lastNear > 240) this.disposeChunkDetail(c);
        }
        const detailShown = c.detailState === 'built' && d < q.detailDistance + 30;
        if (c.detail) c.detail.visible = detailShown;
        if (c.far) c.far.visible = inDraw && !detailShown;
      }
      this.buildQueue.sort((a, b) => this.chunkDist(a, cam) - this.chunkDist(b, cam));
    }
    if (this.buildQueue.length) {
      const t0 = performance.now();
      while (this.buildQueue.length && (performance.now() - t0 < q.buildBudgetMs || force)) {
        const c = this.buildQueue.shift()!;
        if (c.detailState === 'none') this.buildChunkDetail(c);
        if (!force) break;
      }
    }
    this.props.update(cam, force);
    this.animate();
  }

  /** Sky-matched reflection probe for the ocean and lake. */
  setWaterEnv(env: THREE.Texture): void {
    for (const w of [this.water, this.lake]) {
      w.material.envMap = env;
      w.material.needsUpdate = true;
    }
  }

  /** Number of chunks still waiting for detail around the camera. */
  get pendingDetail(): number {
    return this.buildQueue.length;
  }

  private animate(): void {
    // Clock hands from the in-game clock.
    const h = this.clockHours % 12;
    const mins = (this.clockHours * 60) % 60;
    for (const a of this.animated) {
      if (a.name !== 'clockHands') continue;
      for (const pivot of a.children) {
        const hour = pivot.getObjectByName('hour');
        const minute = pivot.getObjectByName('minute');
        if (hour) hour.rotation.z = -(h / 12) * Math.PI * 2;
        if (minute) minute.rotation.z = -(mins / 60) * Math.PI * 2;
      }
    }
    // Traffic lights: 0 = red, 1 = amber, 2 = green; the props share one phase for clarity.
    const t = shared.time.value % 24;
    const phase = t < 10 ? 2 : t < 13 ? 1 : 0;
    this.signalMats.forEach((m, i) => (m.emissiveIntensity = i === phase ? 6 : 0.12));
    // Lamps glow at dusk/night only.
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.15 + 3.0 * (1 - shared.daylight.value);
  }
}

/** Street name blade or stop sign built into the ground-detail layer. */
function streetSign(mb: MeshBuilder, p: PropSpec, city: CityData): void {
  const y = p.y;
  mb.cylinder('steel_light', p.x, y, p.z, 0.05, 0.05, 3.2, 8, { capTop: true });
  const atlas = signs();
  if (p.type === 'stop_sign') {
    const uv = atlas.extraUV('stop');
    mb.pushTRS(p.x, y + 2.2, p.z, p.yaw);
    mb.quad('signs', [-0.4, 0, 0.06], [0.4, 0, 0.06], [0.4, 0.4, 0.06], [-0.4, 0.4, 0.06], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
    mb.popTransform();
    return;
  }
  // Find the nearest N-S and E-W road names.
  let ns = '';
  let ew = '';
  let dns = Infinity;
  let dew = Infinity;
  for (const r of city.roads) {
    if (r.axis === 'z' && p.z >= r.z0 - 2 && p.z <= r.z1 + 2) {
      const d = Math.abs(r.x0 - p.x);
      if (d < dns) {
        dns = d;
        ns = r.name;
      }
    }
    if (r.axis === 'x' && p.x >= r.x0 - 2 && p.x <= r.x1 + 2) {
      const d = Math.abs(r.z0 - p.z);
      if (d < dew) {
        dew = d;
        ew = r.name;
      }
    }
  }
  const blade = (name: string, yaw: number, yy: number) => {
    const uv = atlas.streetUV(name);
    mb.pushTRS(p.x, yy, p.z, yaw);
    mb.box('paint', -0.02, -0.13, -0.6, 0.02, 0.13, 0.6, { color: new THREE.Color(0.12, 0.36, 0.23) });
    mb.quad('signs', [0.025, -0.12, 0.58], [0.025, -0.12, -0.58], [0.025, 0.12, -0.58], [0.025, 0.12, 0.58], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
    mb.quad('signs', [-0.025, -0.12, -0.58], [-0.025, -0.12, 0.58], [-0.025, 0.12, 0.58], [-0.025, 0.12, -0.58], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
    mb.popTransform();
  };
  if (ns) blade(ns, 0, y + 3.0);
  if (ew) blade(ew, Math.PI / 2, y + 2.7);
}
