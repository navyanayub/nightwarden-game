/**
 * Night lighting for street lamps, kept cheap at city scale:
 *  - a small fixed pool of real PointLights (count per preset) re-assigned to the lamps
 *    nearest the player; the light count never changes, so shaders never recompile;
 *  - every other lamp gets a soft additive light pool on the ground, a glow sprite at its head
 *    and, when the streets are wet, a reflection streak stretched towards the camera.
 * All three decal layers are single instanced draw calls.
 * Also owns the rotating lighthouse beam.
 */
import * as THREE from 'three';
import type { CityData } from './CityLayout';

interface Lamp {
  x: number;
  y: number; // head height (world)
  z: number;
  gy: number; // ground height
  kind: 0 | 1 | 2; // modern / old lantern / park
}

const KIND = {
  0: { intensity: 46, range: 30, pool: 9, color: new THREE.Color(1.0, 0.88, 0.72) },
  1: { intensity: 16, range: 18, pool: 6.5, color: new THREE.Color(1.0, 0.72, 0.42) },
  2: { intensity: 13, range: 16, pool: 6, color: new THREE.Color(1.0, 0.8, 0.55) },
} as const;

function gradientTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grd.addColorStop(0.7, 'rgba(255,255,255,0.15)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class NightLights {
  readonly group = new THREE.Group();
  private lamps: Lamp[] = [];
  private grid = new Map<string, number[]>();
  private lights: THREE.PointLight[] = [];
  private assigned: (number | -1)[] = [];
  private level: number[] = [];
  private timer = 0;
  private poolMat: THREE.ShaderMaterial;
  private streakMat: THREE.ShaderMaterial;
  private glowMat: THREE.ShaderMaterial;
  private beam: THREE.Group | null = null;
  private beamMat: THREE.ShaderMaterial | null = null;
  /** Radius (m) covered by real lights; decals fade in beyond it. */
  private realRadius = 0;

  constructor(city: CityData, lightCount: number) {
    this.group.name = 'NightLights';
    for (const p of city.props) {
      if (p.type === 'lamp') this.lamps.push({ x: p.x + Math.sin(p.yaw) * 2.2, y: p.y + 8.45, z: p.z + Math.cos(p.yaw) * 2.2, gy: p.y - 0.15, kind: 0 });
      else if (p.type === 'lamp_old') this.lamps.push({ x: p.x, y: p.y + 3.85, z: p.z, gy: p.y, kind: 1 });
      else if (p.type === 'lamp_park') this.lamps.push({ x: p.x, y: p.y + 3.65, z: p.z, gy: p.y, kind: 2 });
    }
    this.lamps.forEach((l, i) => {
      const k = `${Math.floor(l.x / 50)},${Math.floor(l.z / 50)}`;
      const arr = this.grid.get(k) ?? [];
      arr.push(i);
      this.grid.set(k, arr);
    });
    const tex = gradientTexture();
    const n = this.lamps.length;
    // Per-lamp instance data: position (head), ground y, kind.
    const aLamp = new Float32Array(n * 4);
    const aCol = new Float32Array(n * 4);
    this.lamps.forEach((l, i) => {
      aLamp.set([l.x, l.y, l.z, l.gy], i * 4);
      const k = KIND[l.kind];
      aCol.set([k.color.r, k.color.g, k.color.b, k.pool], i * 4);
    });
    const common = {
      uNight: { value: 0 },
      uWet: { value: 0 },
      uNear: { value: 30 },
      uTex: { value: tex },
    };
    const mkGeo = (verts: number[], uvs: number[], idx: number[]) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx);
      g.setAttribute('aLamp', new THREE.InstancedBufferAttribute(aLamp, 4));
      g.setAttribute('aCol', new THREE.InstancedBufferAttribute(aCol, 4));
      g.instanceCount = n;
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      return g;
    };
    const quad = mkGeo([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], [0, 0, 1, 0, 1, 1, 0, 1], [0, 2, 1, 0, 3, 2]);
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false } as const;
    // Ground light pools.
    this.poolMat = new THREE.ShaderMaterial({
      ...additive,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      uniforms: common,
      vertexShader: /* glsl */ `
        attribute vec4 aLamp; attribute vec4 aCol;
        uniform float uNear;
        varying vec2 vUv; varying vec3 vCol; varying float vFade;
        void main() {
          vUv = uv;
          float r = aCol.w;
          vec3 p = vec3(aLamp.x + position.x * r, aLamp.w + 0.06, aLamp.z + position.z * r);
          float d = distance(p, cameraPosition);
          vFade = smoothstep(uNear * 0.75, uNear * 1.05, d) * (1.0 - smoothstep(500.0, 800.0, d));
          vCol = aCol.rgb;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform float uNight; uniform float uWet;
        varying vec2 vUv; varying vec3 vCol; varying float vFade;
        void main() {
          float a = texture2D(uTex, vUv).r;
          gl_FragColor = vec4(vCol * a * a * a * 0.055 * uNight * vFade * (1.0 + uWet * 0.8), 1.0);
        }`,
    });
    const pools = new THREE.Mesh(quad, this.poolMat);
    pools.frustumCulled = false;
    pools.renderOrder = 5;
    pools.name = 'lampPools';
    // Wet reflection streaks: ground quads from the lamp base stretched towards the camera.
    const strip = mkGeo([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], [0, 0, 1, 0, 1, 1, 0, 1], [0, 1, 2, 0, 2, 3]);
    this.streakMat = new THREE.ShaderMaterial({
      ...additive,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -10,
      uniforms: common,
      vertexShader: /* glsl */ `
        attribute vec4 aLamp; attribute vec4 aCol;
        varying vec2 vUv; varying vec3 vCol; varying float vFade;
        void main() {
          vUv = uv;
          vec2 toCam = cameraPosition.xz - aLamp.xz;
          float dc = length(toCam);
          vec2 dir = toCam / max(dc, 1e-3);
          vec2 perp = vec2(-dir.y, dir.x);
          float h = aLamp.y - aLamp.w;
          float len = min(h * 1.8 + 4.0, dc * 0.8);
          vec2 xz = aLamp.xz + dir * (0.4 + position.y * len) + perp * position.x * (0.35 + 0.2 * position.y);
          vec3 p = vec3(xz.x, aLamp.w + 0.07, xz.y);
          vFade = smoothstep(4.0, 12.0, dc) * (1.0 - smoothstep(180.0, 320.0, dc));
          vCol = aCol.rgb;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight; uniform float uWet;
        varying vec2 vUv; varying vec3 vCol; varying float vFade;
        float h1(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          float u = vUv.x * 2.0 - 1.0;
          float along = vUv.y;
          float side = exp(-u * u * 5.0);
          float fall = pow(1.0 - along, 1.6);
          float ripple = 0.65 + 0.35 * sin(along * 38.0 + h1(floor(along * 9.0)) * 6.0);
          float a = side * fall * ripple * uWet * uNight * vFade;
          gl_FragColor = vec4(vCol * a * 0.55, 1.0);
        }`,
    });
    const streaks = new THREE.Mesh(strip, this.streakMat);
    streaks.frustumCulled = false;
    streaks.renderOrder = 6;
    streaks.name = 'lampStreaks';
    // Glow sprites at lamp heads (keep distant streets readable at night).
    this.glowMat = new THREE.ShaderMaterial({
      ...additive,
      uniforms: common,
      vertexShader: /* glsl */ `
        attribute vec4 aLamp; attribute vec4 aCol;
        varying vec2 vUv; varying vec3 vCol; varying float vFade;
        void main() {
          vUv = uv;
          vec4 mv = viewMatrix * vec4(aLamp.xyz, 1.0);
          float d = -mv.z;
          float s = 0.45 + d * 0.0035;
          mv.xy += vec2(position.x, position.z) * s;
          vFade = smoothstep(15.0, 40.0, d) * (1.0 - smoothstep(1400.0, 2200.0, d));
          vCol = aCol.rgb;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex; uniform float uNight;
        varying vec2 vUv; varying vec3 vCol; varying float vFade;
        void main() {
          float a = texture2D(uTex, vUv).r;
          gl_FragColor = vec4(vCol * a * a * 1.6 * uNight * vFade, 1.0);
        }`,
    });
    const glows = new THREE.Mesh(quad, this.glowMat);
    glows.frustumCulled = false;
    glows.renderOrder = 7;
    glows.name = 'lampGlows';
    this.group.add(pools, streaks, glows);
    this.setLightCount(lightCount);
    // Lighthouse beam.
    const lh = city.features.find((f) => f.type === 'lighthouse');
    if (lh) this.buildBeam(lh.x, lh.y + 1.5 + 30 + 2.3, lh.z);
  }

  private buildBeam(x: number, y: number, z: number): void {
    const len = 520;
    const geo = new THREE.ConeGeometry(34, len, 24, 1, true);
    geo.translate(0, -len / 2, 0);
    geo.rotateZ(Math.PI / 2); // apex at origin, opening towards +X
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uNight: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          vT = clamp(position.x / ${len.toFixed(1)}, 0.0, 1.0);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
          float a = edge * pow(1.0 - vT, 2.0) * smoothstep(0.0, 0.02, vT) * uNight * 0.09;
          gl_FragColor = vec4(vec3(1.0, 0.95, 0.82) * a, 1.0);
        }`,
    });
    const g = new THREE.Group();
    g.position.set(x, y, z);
    for (const s of [0, Math.PI]) {
      const m = new THREE.Mesh(geo, this.beamMat);
      m.rotation.y = s;
      m.rotation.z = -0.02;
      m.frustumCulled = false;
      g.add(m);
    }
    g.name = 'lighthouseBeam';
    this.group.add(g);
    this.beam = g;
  }

  /** Change the size of the real-light pool (graphics preset); recompiles lit shaders once. */
  setLightCount(n: number): void {
    while (this.lights.length > n) {
      const l = this.lights.pop()!;
      this.group.remove(l);
      l.dispose();
      this.assigned.pop();
      this.level.pop();
    }
    while (this.lights.length < n) {
      const l = new THREE.PointLight(0xffe0b8, 0, 28, 2);
      l.castShadow = false;
      this.group.add(l);
      this.lights.push(l);
      this.assigned.push(-1);
      this.level.push(0);
    }
  }

  /** Lamp head positions (for pedestrians/other systems). */
  get count(): number {
    return this.lamps.length;
  }

  update(dt: number, focus: THREE.Vector3, night: number, wetness: number, time: number): void {
    const lit = THREE.MathUtils.smoothstep(night, 0.15, 0.6);
    this.poolMat.uniforms.uNight.value = lit;
    this.poolMat.uniforms.uWet.value = wetness;
    this.streakMat.uniforms.uWet.value = wetness;
    this.group.children.forEach((c) => {
      if (c.name === 'lampStreaks') c.visible = wetness > 0.05 && lit > 0.01;
      if (c.name === 'lampPools' || c.name === 'lampGlows') c.visible = lit > 0.01;
    });
    if (this.beam && this.beamMat) {
      this.beam.rotation.y = time * 0.9;
      this.beamMat.uniforms.uNight.value = lit;
      this.beam.visible = lit > 0.01;
    }
    // Re-pick the nearest lamps a few times per second.
    this.timer -= dt;
    if (this.timer <= 0 && this.lights.length) {
      this.timer = 0.2;
      const want = this.nearest(focus, this.lights.length);
      this.realRadius = want.length ? Math.sqrt(want[want.length - 1].d2) : 0;
      const wanted = new Set(want.map((w) => w.i));
      // Release lights whose lamp is no longer wanted (they fade out first).
      for (let k = 0; k < this.lights.length; k++) {
        const a = this.assigned[k];
        if (a >= 0 && !wanted.has(a)) this.assigned[k] = -2 - a; // fading out (encodes the lamp)
      }
      const have = new Set(this.assigned.filter((a) => a >= 0));
      for (const w of want) {
        if (have.has(w.i)) continue;
        const k = this.assigned.findIndex((a, j) => a === -1 || (a <= -2 && this.level[j] < 0.02));
        if (k < 0) break;
        this.assigned[k] = w.i;
        this.level[k] = 0;
        const l = this.lamps[w.i];
        const spec = KIND[l.kind];
        this.lights[k].position.set(l.x, l.y - 0.3, l.z);
        this.lights[k].color.copy(spec.color);
        this.lights[k].distance = spec.range;
      }
    }
    const nearR = Math.max(12, this.realRadius);
    this.poolMat.uniforms.uNear.value = nearR;
    for (let k = 0; k < this.lights.length; k++) {
      const a = this.assigned[k];
      const target = a >= 0 ? 1 : 0;
      this.level[k] += (target - this.level[k]) * Math.min(1, dt * 5);
      const lampIdx = a >= 0 ? a : a <= -2 ? -2 - a : -1;
      const spec = lampIdx >= 0 ? KIND[this.lamps[lampIdx].kind] : KIND[0];
      this.lights[k].intensity = spec.intensity * this.level[k] * lit;
      if (a <= -2 && this.level[k] < 0.02) this.assigned[k] = -1;
    }
    this.glowMat.uniforms.uNight.value = lit;
  }

  private nearest(p: THREE.Vector3, n: number): { i: number; d2: number }[] {
    const out: { i: number; d2: number }[] = [];
    const cx = Math.floor(p.x / 50);
    const cz = Math.floor(p.z / 50);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const arr = this.grid.get(`${cx + dx},${cz + dz}`);
        if (!arr) continue;
        for (const i of arr) {
          const l = this.lamps[i];
          const d2 = (l.x - p.x) ** 2 + (l.z - p.z) ** 2 + ((l.y - p.y) * 0.5) ** 2;
          out.push({ i, d2 });
        }
      }
    }
    out.sort((a, b) => a.d2 - b.d2);
    return out.slice(0, n);
  }
}
