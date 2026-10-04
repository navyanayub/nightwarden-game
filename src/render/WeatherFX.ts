/**
 * GPU weather visuals:
 *  - rain streaks: instanced quads animated entirely in the vertex shader inside a box that
 *    wraps around the camera (world-anchored, so drops don't swim when the camera turns),
 *    slanted by the global wind and stretched along their velocity;
 *  - splashes: short-lived crowns on the ground around the camera (height from the terrain
 *    height texture);
 *  - the lightning bolt (procedural branching ribbon, visible for a few frames).
 * Screen drops for the driving camera live in ScreenDropsEffect.
 */
import * as THREE from 'three';
import { TERRAIN } from '../world/WorldConfig';
import { wind } from '../systems/Weather';

export class WeatherFX {
  readonly group = new THREE.Group();
  private rain: THREE.Mesh;
  private rainGeo: THREE.InstancedBufferGeometry;
  private rainMat: THREE.ShaderMaterial;
  private splash: THREE.Mesh;
  private splashGeo: THREE.InstancedBufferGeometry;
  private splashMat: THREE.ShaderMaterial;
  private bolt: THREE.Mesh | null = null;
  private boltMat: THREE.MeshBasicMaterial;
  private boltTime = -1;
  private boltSeed = -1;
  readonly maxDrops: number;
  readonly maxSplashes = 2400;

  constructor(heightTex: THREE.Texture, maxDrops: number) {
    this.group.name = 'WeatherFX';
    this.maxDrops = maxDrops;
    // ---------------------------------------------------------------- rain
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const seeds = new Float32Array(maxDrops * 4);
    for (let i = 0; i < maxDrops; i++) {
      // Deterministic pseudo-random seeds (no gameplay impact).
      const h = (n: number) => {
        const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
        return x - Math.floor(x);
      };
      seeds.set([h(1), h(2), h(3), h(4)], i * 4);
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.rainGeo = g;
    this.rainMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector3() },
        uColor: { value: new THREE.Color(0.6, 0.65, 0.7) },
        uBox: { value: new THREE.Vector3(46, 26, 46) },
        uAlpha: { value: 0.4 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime; uniform vec3 uWind; uniform vec3 uBox;
        varying float vV; varying float vA;
        void main() {
          float speed = 8.5 + aSeed.w * 3.5;
          vec3 vel = vec3(uWind.x * 0.75, -speed, uWind.z * 0.75);
          vec3 p = vec3(aSeed.x * uBox.x, 0.0, aSeed.z * uBox.z);
          float fall = mod(aSeed.y * uBox.y + uTime * speed, uBox.y);
          // Wrap the drop column around the camera (world-anchored).
          vec3 drift = vel * (fall / speed);
          p.xz = mod(p.xz + drift.xz - cameraPosition.xz + uBox.xz * 0.5, uBox.xz) - uBox.xz * 0.5 + cameraPosition.xz;
          p.y = cameraPosition.y + uBox.y * 0.5 - fall;
          vec3 dir = normalize(vel);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(dir, toCam));
          float len = length(vel) * 0.03;
          vec3 wp = p + side * position.x * 0.008 + dir * position.y * len;
          vV = position.y;
          float d = distance(p, cameraPosition);
          vA = smoothstep(0.6, 2.5, d) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, d));
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAlpha;
        varying float vV; varying float vA;
        void main() {
          float a = smoothstep(0.0, 0.25, vV) * smoothstep(1.0, 0.6, vV) * vA * uAlpha;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.rain = new THREE.Mesh(g, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 20;
    this.rain.name = 'rain';
    // ---------------------------------------------------------------- splashes
    const sg = new THREE.InstancedBufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    sg.setIndex([0, 1, 2, 0, 2, 3]);
    const ss = new Float32Array(this.maxSplashes * 4);
    for (let i = 0; i < this.maxSplashes; i++) {
      const h = (n: number) => {
        const x = Math.sin(i * 39.3467 + n * 11.135) * 24634.6345;
        return x - Math.floor(x);
      };
      ss.set([h(1), h(2), h(3), h(4)], i * 4);
    }
    sg.setAttribute('aSeed', new THREE.InstancedBufferAttribute(ss, 4));
    sg.instanceCount = 0;
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.splashGeo = sg;
    this.splashMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
        uHeight: { value: heightTex },
        uTerr: { value: new THREE.Vector4(TERRAIN.minX, TERRAIN.minZ, TERRAIN.maxX - TERRAIN.minX, TERRAIN.maxZ - TERRAIN.minZ) },
        uAlpha: { value: 0.3 },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime; uniform sampler2D uHeight; uniform vec4 uTerr;
        varying vec2 vUv; varying float vLife;
        float hh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
          float rate = 2.2 + aSeed.w * 1.5;
          float t = uTime * rate + aSeed.z * 10.0;
          float cyc = floor(t);
          vLife = fract(t);
          // New random position each cycle, within 22 m of the camera.
          vec2 r = vec2(hh(vec2(cyc, aSeed.x * 91.0)), hh(vec2(aSeed.y * 37.0, cyc))) * 2.0 - 1.0;
          vec2 xz = cameraPosition.xz + r * 22.0;
          vec2 tuv = (xz - uTerr.xy) / uTerr.zw;
          float y = texture2D(uHeight, tuv).r + 0.17;
          vec3 c = vec3(xz.x, y, xz.y);
          vec4 mv = viewMatrix * vec4(c, 1.0);
          float s = 0.03 + vLife * 0.07;
          mv.xy += vec2(position.x * s, position.y * s * 0.9);
          vUv = vec2(position.x * 0.5 + 0.5, position.y);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAlpha;
        varying vec2 vUv; varying float vLife;
        void main() {
          float x = vUv.x * 2.0 - 1.0;
          float crown = smoothstep(0.35, 0.0, abs(abs(x) - vUv.y * 0.9 - 0.05)) * (1.0 - vUv.y);
          float a = crown * (1.0 - vLife) * smoothstep(0.0, 0.1, vLife) * uAlpha;
          gl_FragColor = vec4(uColor, a);
        }`,
    });
    this.splash = new THREE.Mesh(sg, this.splashMat);
    this.splash.frustumCulled = false;
    this.splash.renderOrder = 19;
    this.splash.name = 'splashes';
    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 7, 10), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    this.group.add(this.rain, this.splash);
  }

  /** Number of rain drops currently drawn. */
  get rainCount(): number {
    return this.rainGeo.instanceCount;
  }

  update(dt: number, rain: number, cam: THREE.Camera, skyAmbient: number, night: number, bolt: { x: number; z: number; time: number; seed: number } | null, weatherTime: number, flash: number): void {
    const t = this.rainMat.uniforms.uTime.value + dt;
    this.rainMat.uniforms.uTime.value = t;
    this.splashMat.uniforms.uTime.value = t;
    (this.rainMat.uniforms.uWind.value as THREE.Vector3).copy(wind.vector);
    const lum = 0.05 + skyAmbient * 0.9 + flash * 0.8;
    const col = new THREE.Color(0.62, 0.68, 0.76).multiplyScalar(lum).add(new THREE.Color(0.05, 0.045, 0.04).multiplyScalar(night));
    (this.rainMat.uniforms.uColor.value as THREE.Color).copy(col);
    (this.splashMat.uniforms.uColor.value as THREE.Color).copy(col).multiplyScalar(0.9);
    this.rainMat.uniforms.uAlpha.value = 0.1 + 0.16 * rain;
    this.rainGeo.instanceCount = Math.floor(this.maxDrops * Math.min(1, rain * 1.05));
    this.splashGeo.instanceCount = Math.floor(this.maxSplashes * THREE.MathUtils.clamp((rain - 0.05) * 1.2, 0, 1));
    this.rain.visible = this.rainGeo.instanceCount > 0;
    this.splash.visible = this.splashGeo.instanceCount > 0;
    void cam;
    // Lightning bolt.
    if (bolt && bolt.seed !== this.boltSeed) {
      this.boltSeed = bolt.seed;
      this.boltTime = bolt.time;
      if (this.bolt) {
        this.group.remove(this.bolt);
        this.bolt.geometry.dispose();
      }
      const camPos = cam.position;
      const dx = bolt.x - camPos.x;
      const dz = bolt.z - camPos.z;
      const d = Math.hypot(dx, dz);
      const k = Math.min(1, 1700 / Math.max(d, 1));
      this.bolt = new THREE.Mesh(boltGeometry(bolt.seed, camPos.x + dx * k, camPos.z + dz * k, camPos), this.boltMat);
      this.bolt.frustumCulled = false;
      this.bolt.renderOrder = 30;
      this.group.add(this.bolt);
    }
    if (this.bolt) {
      const age = weatherTime - this.boltTime;
      const on = age < 0.45 && (age < 0.06 || (age > 0.18 && age < 0.3) || (age > 0.36 && age < 0.42));
      this.bolt.visible = on;
      if (age > 1) {
        this.group.remove(this.bolt);
        this.bolt.geometry.dispose();
        this.bolt = null;
      }
    }
  }
}

/** Branching lightning ribbon from cloud base to the ground, facing the camera. */
function boltGeometry(seed: number, x: number, z: number, cam: THREE.Vector3): THREE.BufferGeometry {
  let s = seed % 100000;
  const rnd = () => {
    s = (s * 16807 + 11) % 2147483647;
    return (s % 10000) / 10000;
  };
  const pos: number[] = [];
  const idx: number[] = [];
  const toCam = new THREE.Vector3(cam.x - x, 0, cam.z - z).normalize();
  const side = new THREE.Vector3(-toCam.z, 0, toCam.x);
  const ribbon = (pts: THREE.Vector3[], w: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const base = pos.length / 3;
      const ww = w * (1 - (i / pts.length) * 0.5);
      pos.push(a.x - side.x * ww, a.y, a.z - side.z * ww, a.x + side.x * ww, a.y, a.z + side.z * ww, b.x + side.x * ww, b.y, b.z + side.z * ww, b.x - side.x * ww, b.y, b.z - side.z * ww);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };
  const walk = (start: THREE.Vector3, endY: number, steps: number, spread: number): THREE.Vector3[] => {
    const pts = [start.clone()];
    const p = start.clone();
    const dy = (start.y - endY) / steps;
    for (let i = 0; i < steps; i++) {
      p.y -= dy;
      p.addScaledVector(side, (rnd() - 0.5) * spread);
      p.addScaledVector(toCam, (rnd() - 0.5) * spread * 0.5);
      pts.push(p.clone());
    }
    return pts;
  };
  const main = walk(new THREE.Vector3(x, 650, z), 0, 26, 60);
  ribbon(main, 3.2);
  for (let b = 0; b < 4; b++) {
    const from = main[3 + Math.floor(rnd() * 14)];
    ribbon(walk(from, from.y - 120 - rnd() * 160, 8, 45), 1.4);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
