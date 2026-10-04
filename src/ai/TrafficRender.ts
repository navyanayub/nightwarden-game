/**
 * Instanced rendering for traffic: per vehicle kind, one InstancedMesh each for paint
 * (per-instance colour), glass, dark trim (vertex colours), lamps (per-instance head / brake /
 * indicator levels via an instanced attribute) and wheels (4 instances per car). So 60-100
 * visible cars cost ~45 draw calls regardless of count. Also draws fake headlight beams on the
 * road at night (one additive instanced quad per car).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshBuilder } from '../world/MeshBuilder';
import { buildBody, buildWheel, LAMP_KEYS, PART_COLORS, SPECS, smoothNormals, type VehicleKind } from '../vehicles/VehicleModels';

export const RENDER_KINDS: VehicleKind[] = ['compact', 'hatchback', 'sedan', 'estate', 'suv', 'pickup', 'van', 'taxi', 'bus'];

export interface CarRenderState {
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  color: THREE.Color;
  wheelSpin: number;
  steer: number;
  head: number;
  brake: number;
  indL: number;
  indR: number;
  visible: boolean;
}

interface KindMeshes {
  paint: THREE.InstancedMesh;
  glass: THREE.InstancedMesh;
  trim: THREE.InstancedMesh;
  lamps: THREE.InstancedMesh;
  wheels: THREE.InstancedMesh;
  lampAttr: THREE.InstancedBufferAttribute;
  count: number;
  wheelPos: [number, number, number][];
  radius: number;
}

function colored(geos: { g: THREE.BufferGeometry; c: [number, number, number]; lamp?: number }[]): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const { g, c, lamp } of geos) {
    const n = g.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set(c, i * 3);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', g.getAttribute('position'));
    gg.setAttribute('normal', g.getAttribute('normal'));
    gg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (lamp !== undefined) gg.setAttribute('aLampId', new THREE.BufferAttribute(new Float32Array(n).fill(lamp), 1));
    gg.setIndex(g.getIndex());
    parts.push(gg.index ? gg.toNonIndexed() : gg);
  }
  if (!parts.length) return null;
  return mergeGeometries(parts, false);
}

export class TrafficRender {
  readonly group = new THREE.Group();
  private kinds: KindMeshes[] = [];
  private paintMat: THREE.MeshStandardMaterial;
  private glassMat: THREE.MeshStandardMaterial;
  private trimMat: THREE.MeshStandardMaterial;
  private lampMat: THREE.MeshStandardMaterial;
  private wheelMat: THREE.MeshStandardMaterial;
  private beamGeo: THREE.InstancedBufferGeometry;
  private beamAttr: THREE.InstancedBufferAttribute;
  private beamMat: THREE.ShaderMaterial;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private v = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);

  constructor(readonly capacity: number) {
    this.group.name = 'Traffic';
    this.paintMat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.3 });
    this.glassMat = new THREE.MeshStandardMaterial({ color: 0x0a0d10, metalness: 0.3, roughness: 0.05 });
    this.trimMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.42 });
    this.wheelMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.5, roughness: 0.55 });
    this.lampMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, emissive: 0xffffff });
    this.lampMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aLampId;\nattribute vec4 aLamps;\nvarying float vLampLevel;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          float lv = 0.6;
          if (aLampId > 0.5 && aLampId < 1.5) lv = aLamps.x;
          else if (aLampId > 1.5 && aLampId < 2.5) lv = aLamps.y;
          else if (aLampId > 2.5 && aLampId < 3.5) lv = 0.0;
          else if (aLampId > 3.5 && aLampId < 4.5) lv = aLamps.z;
          else if (aLampId > 4.5) lv = aLamps.w;
          vLampLevel = lv;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vLampLevel;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vColor.rgb * vLampLevel;');
    };
    this.lampMat.customProgramCacheKey = () => 'trafficLamps';
    for (const kind of RENDER_KINDS) this.kinds.push(this.buildKind(kind));
    // Headlight beams.
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 0, 1, -1, 0, 1], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    this.beamAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4 * 2), 4);
    g.setAttribute('aBeam', this.beamAttr);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.beamGeo = g;
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      uniforms: { uStrength: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute vec4 aBeam; // x, y, z, yaw
        varying vec2 vUv;
        void main() {
          float len = 15.0;
          float w = mix(0.6, 3.2, position.z);
          vec2 local = vec2(position.x * w, position.z * len + 0.3);
          float c = cos(aBeam.w); float s = sin(aBeam.w);
          vec2 xz = vec2(local.x * c + local.y * s, -local.x * s + local.y * c);
          vUv = vec2(position.x, position.z);
          gl_Position = projectionMatrix * viewMatrix * vec4(aBeam.x + xz.x, aBeam.y + 0.05, aBeam.z + xz.y, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          float side = 1.0 - vUv.x * vUv.x;
          float a = side * side * smoothstep(0.0, 0.12, vUv.y) * pow(1.0 - vUv.y, 1.6) * uStrength;
          gl_FragColor = vec4(vec3(1.0, 0.92, 0.78) * a, 1.0);
        }`,
    });
    const beams = new THREE.Mesh(g, this.beamMat);
    beams.frustumCulled = false;
    beams.renderOrder = 4;
    beams.name = 'headlightBeams';
    this.group.add(beams);
  }

  private buildKind(kind: VehicleKind): KindMeshes {
    const spec = SPECS[kind];
    const mb = new MeshBuilder();
    buildBody(spec, mb);
    const geo = (k: string) => {
      const b = mb.buffers.get(k);
      return b && b.idx.length ? b.toGeometry() : null;
    };
    const paintG = geo('car_paint')!;
    smoothNormals(paintG);
    const glassParts = ['car_glass', 'car_glass_mirror'].map(geo).filter((g): g is THREE.BufferGeometry => !!g);
    glassParts.forEach((g) => smoothNormals(g));
    const glassG = mergeGeometries(glassParts.map((g) => (g.deleteAttribute('aWin'), g.deleteAttribute('uv'), g.deleteAttribute('color'), g)), false)!;
    const trimList: { g: THREE.BufferGeometry; c: [number, number, number] }[] = [];
    const lampList: { g: THREE.BufferGeometry; c: [number, number, number]; lamp: number }[] = [];
    for (const [k] of mb.buffers) {
      if (k === 'car_paint' || k === 'car_glass' || k === 'car_glass_mirror') continue;
      const g = geo(k);
      if (!g) continue;
      const c = PART_COLORS[k] ?? [0.1, 0.1, 0.1];
      if (k in LAMP_KEYS) lampList.push({ g, c, lamp: LAMP_KEYS[k] });
      else trimList.push({ g, c });
    }
    const trimG = colored(trimList)!;
    const lampG = colored(lampList)!;
    const wmb = new MeshBuilder();
    buildWheel(spec.wheelRadius, wmb, kind === 'bus' || kind === 'van');
    const wheelList: { g: THREE.BufferGeometry; c: [number, number, number] }[] = [];
    for (const [k, b] of wmb.buffers) wheelList.push({ g: b.toGeometry(), c: PART_COLORS[k] ?? [0.1, 0.1, 0.1] });
    const wheelG = colored(wheelList)!;
    const cap = kind === 'bus' ? 8 : this.capacity;
    const mk = (g: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow: boolean) => {
      const im = new THREE.InstancedMesh(g, mat, n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = shadow;
      im.receiveShadow = true;
      im.name = `traffic:${kind}`;
      this.group.add(im);
      return im;
    };
    const paint = mk(paintG, this.paintMat, cap, true);
    paint.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    paint.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const glass = mk(glassG, this.glassMat, cap, false);
    const trim = mk(trimG, this.trimMat, cap, true);
    const lampAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    lampAttr.setUsage(THREE.DynamicDrawUsage);
    lampG.setAttribute('aLamps', lampAttr);
    const lamps = mk(lampG, this.lampMat, cap, false);
    const wheels = mk(wheelG, this.wheelMat, cap * 4, true);
    const wheelPos: [number, number, number][] = [
      [spec.track / 2, spec.wheelRadius, spec.frontAxle],
      [-spec.track / 2, spec.wheelRadius, spec.frontAxle],
      [spec.track / 2, spec.wheelRadius, spec.rearAxle],
      [-spec.track / 2, spec.wheelRadius, spec.rearAxle],
    ];
    return { paint, glass, trim, lamps, wheels, lampAttr, count: 0, wheelPos, radius: spec.wheelRadius };
  }

  /** Upload all visible cars for this frame. */
  update(cars: CarRenderState[], night: number, cam: THREE.Vector3): void {
    for (const k of this.kinds) k.count = 0;
    let beams = 0;
    const beamArr = this.beamAttr.array as Float32Array;
    const wm = new THREE.Matrix4();
    const wq = new THREE.Quaternion();
    const we = new THREE.Euler();
    const wp = new THREE.Vector3();
    for (const c of cars) {
      if (!c.visible) continue;
      const K = this.kinds[c.kind];
      const cap = K.paint.instanceMatrix.count;
      if (K.count >= cap) continue;
      const i = K.count++;
      this.e.set(c.pitch, c.yaw, c.roll, 'YXZ');
      this.q.setFromEuler(this.e);
      this.v.set(c.x, c.y, c.z);
      this.m.compose(this.v, this.q, this.one);
      K.paint.setMatrixAt(i, this.m);
      K.glass.setMatrixAt(i, this.m);
      K.trim.setMatrixAt(i, this.m);
      K.lamps.setMatrixAt(i, this.m);
      K.paint.instanceColor!.setXYZ(i, c.color.r, c.color.g, c.color.b);
      K.lampAttr.setXYZW(i, c.head, c.brake, c.indL, c.indR);
      // Wheels (skip spin/steer detail far away).
      const near = (c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 < 140 * 140;
      for (let w = 0; w < 4; w++) {
        const [lx, ly, lz] = K.wheelPos[w];
        we.set(near ? c.wheelSpin : 0, (w < 2 ? c.steer : 0) + (lx < 0 ? Math.PI : 0), 0, 'YXZ');
        if (lx < 0) we.x = -we.x;
        wq.setFromEuler(we);
        wm.compose(wp.set(lx, ly, lz), wq, this.one);
        wm.premultiply(this.m);
        K.wheels.setMatrixAt(i * 4 + w, wm);
      }
      if (night > 0.05 && c.head > 0.5 && beams < this.capacity * 2) {
        const sx = Math.sin(c.yaw);
        const sz = Math.cos(c.yaw);
        const L = SPECS[RENDER_KINDS[c.kind]].length / 2;
        beamArr.set([c.x + sx * L, c.y, c.z + sz * L, c.yaw], beams * 4);
        beams++;
      }
    }
    for (const K of this.kinds) {
      for (const im of [K.paint, K.glass, K.trim, K.lamps]) {
        im.count = K.count;
        im.instanceMatrix.needsUpdate = true;
      }
      K.wheels.count = K.count * 4;
      K.wheels.instanceMatrix.needsUpdate = true;
      K.paint.instanceColor!.needsUpdate = true;
      K.lampAttr.needsUpdate = true;
    }
    this.beamGeo.instanceCount = beams;
    this.beamAttr.needsUpdate = true;
    this.beamMat.uniforms.uStrength.value = THREE.MathUtils.smoothstep(night, 0.1, 0.6) * 0.16;
  }
}
