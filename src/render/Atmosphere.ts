/**
 * Sky dome (Preetham + procedural clouds), sun light with player-following shadows,
 * and image-based lighting from a Poly Haven HDRI aligned to the sun.
 */
import * as THREE from 'three';
import { SKY_GLSL } from './SkyShared';
import type { FogEffect } from './FogEffect';

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + position, 1.0);
  gl_Position = p.xyww;
}`;

// Cloud code adapted from three.js Sky.js (MIT).
const skyFragment = /* glsl */ `
varying vec3 vDir;
uniform float uTime;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudScale;
${SKY_GLSL}

vec2 cgrad(vec2 i) {
  vec3 p = fract(i.xyx * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.xx + p.yz) * p.zy) * 2.0 - 1.0;
}
float cnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(cgrad(i), f);
  float b = dot(cgrad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(cgrad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(cgrad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.6;
}
float cfbm(vec2 p, float drift) {
  float r = 0.0; float amp = 1.0;
  for (int i = 0; i < 5; i++) { r += amp * cnoise(p); amp *= 0.5; p = p * 2.03 + drift; }
  return r;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 Fex; vec3 Lin;
  vec3 d = vec3(dir.x, max(dir.y, 0.0), dir.z);
  vec3 col = skyRadianceFex(normalize(d + vec3(0.0, 0.001, 0.0)), Fex, Lin);
  vec3 sunDir = normalize(uSunDir);
  float cosTheta = dot(dir, sunDir);
  float sunE = skySunIntensity(sunDir.y);
  float sundisc = smoothstep(0.99990, 0.99996, cosTheta);
  col += 760.0 * 0.04 * sundisc * min(sunE * Fex, 80.0) * 0.02;

  if (dir.y > 0.0 && uCloudCoverage > 0.0) {
    vec2 uv = dir.xz / (dir.y * 0.55 + 0.02) * uCloudScale + uTime * 0.0035;
    float evolve = uTime * 0.01;
    float n = clamp(cfbm(uv, evolve) * 0.7 + 0.5, 0.0, 1.0);
    float region = cnoise(uv * 0.23) * 0.37 + 0.5;
    float cov = clamp(uCloudCoverage + (region - 0.5) * 0.6, 0.0, 1.0);
    float threshold = 1.0 - cov;
    float horizonFade = smoothstep(0.0, 0.12, dir.y);
    float depthC = max(0.0, n - threshold);
    float beer = exp(-depthC * 4.0);
    float powder = 1.0 - beer * beer;
    float shade = mix(0.5, 1.0, clamp(beer * powder * 2.6, 0.0, 1.0));
    float silver = clamp(0.51 / pow(1.49 - cosTheta * 1.4, 1.5), 0.0, 3.0);
    float mask = smoothstep(threshold, threshold + 0.3, n) * horizonFade;
    float edge = mask * (1.0 - mask) * 4.0;
    vec3 sunCol = sunE * Fex * 0.22 * 0.04;
    vec3 ambient = Lin * 0.04 + vec3(0.0, 0.0003, 0.00075);
    vec3 cloudCol = ambient * 1.3 + sunCol * shade + sunCol * silver * edge * 0.6;
    float alpha = (1.0 - exp(-depthC * uCloudDensity * 12.0)) * horizonFade;
    col = mix(col, mix(col, cloudCol, Fex), alpha);
  }
  // Below the horizon: fade into a hazy sea-level colour (hidden by the ocean anyway).
  if (dir.y < 0.0) col = mix(col, col * 0.8, clamp(-dir.y * 4.0, 0.0, 1.0));
  gl_FragColor = vec4(col * uSkyExposure, 1.0);
}`;

export interface SunParams {
  elevationDeg: number;
  azimuthDeg: number;
}

export class Atmosphere {
  readonly sunDir = new THREE.Vector3();
  readonly sun: THREE.DirectionalLight;
  readonly sky: THREE.Mesh;
  readonly skyMaterial: THREE.ShaderMaterial;
  private shadowRadius = 100;
  private envRotation = 0;
  hdriSunAzimuth = 0;
  /** Linear sun colour * intensity, exposed for other shaders (water glints). */
  readonly sunColor = new THREE.Color();

  constructor(private readonly scene: THREE.Scene) {
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uRayleigh: { value: 1.7 },
        uTurbidity: { value: 2.2 },
        uMie: { value: 0.0032 },
        uMieG: { value: 0.82 },
        uSkyExposure: { value: 3.6 },
        uTime: { value: 0 },
        uCloudCoverage: { value: 0.42 },
        uCloudDensity: { value: 0.55 },
        uCloudScale: { value: 1.1 },
      },
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), this.skyMaterial);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    this.sky.name = 'SkyDome';
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 4.2);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1200;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.setSun({ elevationDeg: 38, azimuthDeg: 218 });
  }

  /** Azimuth measured clockwise from north (-Z) towards east (+X). */
  setSun(p: SunParams): void {
    const el = THREE.MathUtils.degToRad(p.elevationDeg);
    const az = THREE.MathUtils.degToRad(p.azimuthDeg);
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    // Warm low sun, whiter high sun.
    const warm = THREE.MathUtils.clamp(1 - p.elevationDeg / 50, 0, 1);
    this.sun.color.setRGB(1.0, 0.93 - 0.12 * warm, 0.84 - 0.25 * warm);
    this.sunColor.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    this.alignEnvironment();
  }

  setShadowQuality(enabled: boolean, mapSize: number, radius: number): void {
    this.sun.castShadow = enabled;
    this.shadowRadius = radius;
    const cam = this.sun.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.updateProjectionMatrix();
    if (this.sun.shadow.mapSize.x !== mapSize) {
      this.sun.shadow.mapSize.set(mapSize, mapSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.radius = mapSize >= 4096 ? 2.5 : 2;
    this.sun.shadow.normalBias = 0.02 + (radius / mapSize) * 1.2;
  }

  /** Set IBL from an equirect HDRI; finds the HDRI's sun to align it with ours. */
  setEnvironment(renderer: THREE.WebGLRenderer, hdr: THREE.DataTexture): void {
    this.hdriSunAzimuth = findHdriSunAzimuth(hdr);
    // The directional light already provides (shadowed) sunlight: remove the HDRI's sun so the
    // IBL only contributes sky/bounce light and shadows keep their contrast.
    clampHdr(hdr, 4.0);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(hdr).texture;
    pmrem.dispose();
    this.scene.environment = env;
    this.scene.environmentIntensity = 1.0;
    this.alignEnvironment();
  }

  private alignEnvironment(): void {
    // Our azimuth of sunDir in three's equirect convention (u = atan(dir.z, dir.x)).
    const ourU = Math.atan2(this.sunDir.z, this.sunDir.x);
    this.envRotation = this.hdriSunAzimuth - ourU;
    this.scene.environmentRotation.set(0, this.envRotation, 0);
  }

  update(dt: number, focus: THREE.Vector3, fog?: FogEffect): void {
    this.skyMaterial.uniforms.uTime.value += dt;
    // Shadow box follows the focus point, snapped to shadow texels to avoid shimmering.
    const cam = this.sun.shadow.camera;
    const texel = (2 * this.shadowRadius) / this.sun.shadow.mapSize.x;
    const lightDir = this.sunDir;
    // Build light-space basis.
    const up = Math.abs(lightDir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, lightDir).normalize();
    const lup = new THREE.Vector3().crossVectors(lightDir, right).normalize();
    const r = Math.round(focus.dot(right) / texel) * texel;
    const u = Math.round(focus.dot(lup) / texel) * texel;
    const d = focus.dot(lightDir);
    const snapped = new THREE.Vector3().addScaledVector(right, r).addScaledVector(lup, u).addScaledVector(lightDir, d);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(lightDir, 500);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    void cam;
    if (fog) {
      fog.set('uSunDir', this.sunDir);
      const u2 = this.skyMaterial.uniforms;
      fog.set('uRayleigh', u2.uRayleigh.value);
      fog.set('uTurbidity', u2.uTurbidity.value);
      fog.set('uMie', u2.uMie.value);
      fog.set('uMieG', u2.uMieG.value);
      fog.set('uSkyExposure', u2.uSkyExposure.value);
    }
  }
}

/** Clamp HDR luminance (in place) to remove the sun's energy from an equirect map. */
function clampHdr(tex: THREE.DataTexture, maxLum: number): void {
  const img = tex.image as { data: Uint16Array | Float32Array };
  const data = img.data;
  const half = tex.type === THREE.HalfFloatType;
  const get = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  const set = (i: number, v: number) => (data[i] = half ? THREE.DataUtils.toHalfFloat(v) : v);
  for (let i = 0; i < data.length; i += 4) {
    const r = get(i);
    const g = get(i + 1);
    const b = get(i + 2);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (l > maxLum) {
      const k = maxLum / l;
      set(i, r * k);
      set(i + 1, g * k);
      set(i + 2, b * k);
    }
  }
  tex.needsUpdate = true;
}

/** Locate the brightest region of an equirect HDR and return its azimuth in three's u-angle. */
function findHdriSunAzimuth(tex: THREE.DataTexture): number {
  const img = tex.image as { data: ArrayLike<number>; width: number; height: number };
  const { width, height, data } = img;
  const isHalf = tex.type === THREE.HalfFloatType;
  const read = (i: number) => (isHalf ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  let best = -1;
  let bx = 0;
  for (let y = 0; y < height / 2; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const l = read(i) + read(i + 1) + read(i + 2);
      if (l > best) {
        best = l;
        bx = x;
      }
    }
  }
  // three.js equirect: u = atan(dir.z, dir.x) / (2PI) + 0.5
  return (bx / width - 0.5) * Math.PI * 2;
}
