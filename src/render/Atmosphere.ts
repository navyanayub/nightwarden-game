/**
 * Sky dome (Preetham + procedural clouds + stars + moon), the sun/moon directional light with
 * camera-following shadows, and image-based lighting from a *dynamic* sky probe.
 *
 * The probe is the sky dome itself (plus a ground hemisphere) rendered into a cube map and
 * prefiltered with PMREM; it is re-baked whenever the clock or weather has moved enough, so
 * ambient light, glass and water reflections follow sunrise, sunset, night and overcast skies.
 */
import * as THREE from 'three';
import { SKY_GLSL } from './SkyShared';
import type { FogEffect } from './FogEffect';
import { clock } from '../systems/Clock';
import { weather, wind } from '../systems/Weather';

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
uniform vec2 uCloudOffset;
uniform vec3 uMoonDir;
uniform float uStars;
uniform float uStarRot;
uniform float uProbe;
uniform vec3 uGround;
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
float shash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 Fex; vec3 Lin;
  vec3 d = vec3(dir.x, max(dir.y, 0.0), dir.z);
  vec3 col = skyRadianceFex(normalize(d + vec3(0.0, 0.001, 0.0)), Fex, Lin);
  vec3 sunDir = normalize(uSunDir);
  float cosTheta = dot(dir, sunDir);
  float sunE = skySunIntensity(sunDir.y);
  if (uProbe < 0.5) {
    float sundisc = smoothstep(0.99990, 0.99996, cosTheta);
    col += 760.0 * 0.04 * sundisc * min(sunE * Fex, 80.0) * 0.02;
  }

  float alpha = 0.0;
  if (dir.y > 0.0 && uCloudCoverage > 0.0) {
    vec2 uv = dir.xz / (dir.y * 0.55 + 0.02) * uCloudScale + uCloudOffset;
    float evolve = uTime * 0.01;
    float n = clamp(cfbm(uv, evolve) * 0.7 + 0.5, 0.0, 1.0);
    float region = cnoise(uv * 0.23) * 0.37 + 0.5;
    float cov = clamp(uCloudCoverage + (region - 0.5) * 0.6 * (1.0 - uCloudCoverage * 0.6), 0.0, 1.0);
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
    alpha = (1.0 - exp(-depthC * uCloudDensity * 12.0)) * horizonFade;
    alpha = max(alpha, smoothstep(0.82, 1.0, uCloudCoverage) * horizonFade * 0.96);
    col = mix(col, mix(col, cloudCol, Fex), alpha);
  }
  // Below the horizon: fade into a hazy sea-level colour (hidden by the ocean anyway).
  if (dir.y < 0.0) col = mix(col, col * 0.8, clamp(-dir.y * 4.0, 0.0, 1.0));

  vec3 outCol = skyWeather(col * uSkyExposure, dir, uOvercast * mix(0.75, 1.0, uProbe));
  // Night: clouds catch the orange glow of the city lights from below.
  outCol += uCityGlow * 1.0 * alpha * (0.4 + 0.6 * (1.0 - clamp(dir.y * 1.5, 0.0, 1.0)));

  // Stars (rotating slowly) and the moon, hidden by cloud.
  float clear = (1.0 - alpha) * (1.0 - uOvercast);
  if (uStars > 0.0 && dir.y > 0.0) {
    float cr = cos(uStarRot); float sr = sin(uStarRot);
    vec3 sd = vec3(cr * dir.x - sr * dir.y, sr * dir.x + cr * dir.y, dir.z);
    vec3 g = sd * 260.0;
    vec3 cell = floor(g);
    vec3 f = fract(g) - 0.5;
    float h = shash(cell);
    if (h > 0.965) {
      vec3 off = vec3(shash(cell + 3.1), shash(cell + 7.7), shash(cell + 1.3)) - 0.5;
      float dd = length(f - off * 0.55);
      float mag = pow((h - 0.965) / 0.035, 3.0);
      float tw = 0.75 + 0.25 * sin(uTime * (2.0 + h * 9.0) + h * 40.0);
      vec3 tint = mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.88, 0.72), shash(cell + 9.4));
      outCol += tint * smoothstep(0.16, 0.0, dd) * (0.4 + 3.0 * mag) * tw * uStars * clear * smoothstep(0.0, 0.2, dir.y);
    }
  }
  vec3 md = normalize(uMoonDir);
  float mc = dot(dir, md);
  if (md.y > -0.05) {
    float disc = smoothstep(0.99985, 0.99992, mc);
    vec2 mp = vec2(dot(dir, normalize(cross(md, vec3(0.0, 1.0, 0.0)))), dir.y - md.y) * 900.0;
    float maria = 0.75 + 0.25 * cnoise(mp * 0.35) + 0.1 * cnoise(mp * 1.3);
    float moonVis = (1.0 - alpha * 0.92) * (1.0 - uOvercast * 0.9) * smoothstep(-0.05, 0.05, md.y);
    outCol += vec3(0.85, 0.88, 0.95) * disc * maria * 2.2 * moonVis * (uProbe > 0.5 ? 0.0 : 1.0);
    outCol += vec3(0.25, 0.3, 0.42) * pow(max(mc, 0.0), 300.0) * 0.12 * moonVis * uStars;
  }
  if (uProbe > 0.5) {
    // Ambient from the city is less saturated than the open sky (multi-bounce off buildings).
    outCol = mix(outCol, vec3(dot(outCol, vec3(0.2126, 0.7152, 0.0722))), 0.4);
    if (dir.y < 0.02) outCol = mix(outCol, uGround, smoothstep(0.02, -0.08, dir.y));
  }
  gl_FragColor = vec4(outCol, 1.0);
}`;

export class Atmosphere {
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3(0, -1, 0);
  /** Direction of the active key light (sun by day, moon by night). */
  readonly lightDir = new THREE.Vector3();
  readonly sun: THREE.DirectionalLight;
  readonly sky: THREE.Mesh;
  readonly skyMaterial: THREE.ShaderMaterial;
  /** Linear key-light colour * intensity, exposed for other shaders (water glints). */
  readonly sunColor = new THREE.Color();
  /** Scene exposure (eye adaptation): brighter at night. */
  exposure = 0.5;
  /** Base IBL strength (the probe already contains the time-of-day / weather colour). */
  envIntensity = 0.62;
  private shadowRadius = 100;
  private probe: {
    scene: THREE.Scene;
    cubeRT: THREE.WebGLCubeRenderTarget;
    cam: THREE.CubeCamera;
    pmrem: THREE.PMREMGenerator;
    envRT: THREE.WebGLRenderTarget | null;
    lastHours: number;
    lastOvercast: number;
    lastClouds: number;
    timer: number;
  } | null = null;
  private cloudOffset = new THREE.Vector2();
  /** Called after each probe bake (glass / water materials re-point to the new map). */
  onProbe: ((tex: THREE.Texture) => void) | null = null;

  constructor(private readonly scene: THREE.Scene) {
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uMoonDir: { value: this.moonDir },
        uRayleigh: { value: 1.3 },
        uTurbidity: { value: 2.4 },
        uMie: { value: 0.0035 },
        uMieG: { value: 0.82 },
        uSkyExposure: { value: 0.42 },
        uOvercast: { value: 0 },
        uSkyBright: { value: 1 },
        uNightSky: { value: new THREE.Color(0, 0, 0) },
        uCityGlow: { value: new THREE.Color(0, 0, 0) },
        uFlash: { value: 0 },
        uTime: { value: 0 },
        uCloudCoverage: { value: 0.42 },
        uCloudDensity: { value: 0.55 },
        uCloudScale: { value: 1.1 },
        uCloudOffset: { value: this.cloudOffset },
        uStars: { value: 0 },
        uStarRot: { value: 0 },
        uProbe: { value: 0 },
        uGround: { value: new THREE.Color(0.1, 0.1, 0.1) },
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
    this.applyClock();
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

  /** Create the dynamic sky probe and use it as the scene environment. */
  initProbe(renderer: THREE.WebGLRenderer): void {
    const scene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { ...this.skyMaterial.uniforms, uProbe: { value: 1 } },
    });
    const mesh = new THREE.Mesh(this.sky.geometry, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    const cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    const cam = new THREE.CubeCamera(0.1, 500, cubeRT);
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileCubemapShader();
    this.probe = { scene, cubeRT, cam, pmrem, envRT: null, lastHours: -99, lastOvercast: -1, lastClouds: -1, timer: 0 };
    this.bakeProbe(renderer);
  }

  private bakeProbe(renderer: THREE.WebGLRenderer): void {
    const p = this.probe!;
    const u = this.skyMaterial.uniforms;
    const flash = u.uFlash.value;
    u.uFlash.value = 0;
    p.cam.update(renderer, p.scene);
    u.uFlash.value = flash;
    const first = !p.envRT;
    p.envRT = p.pmrem.fromCubemap(p.cubeRT.texture, p.envRT);
    p.lastHours = clock.hours + clock.day * 24;
    p.lastOvercast = u.uOvercast.value;
    p.lastClouds = u.uCloudCoverage.value;
    if (first) {
      this.scene.environment = p.envRT.texture;
      this.onProbe?.(p.envRT.texture);
    }
  }

  /** The current probe texture (glass and water reflect it). */
  get probeTexture(): THREE.Texture | null {
    return this.probe?.envRT?.texture ?? null;
  }

  /** Push clock + weather into sky uniforms and the key light. */
  private applyClock(): void {
    const u = this.skyMaterial.uniforms;
    const wp = weather.p;
    this.sunDir.copy(clock.sunDir);
    this.moonDir.copy(clock.moonDir);
    const overcast = THREE.MathUtils.clamp(wp.overcast, 0, 1);
    u.uOvercast.value = overcast;
    u.uSkyBright.value = 1 - 0.5 * overcast - 0.15 * wp.rain;
    u.uCloudCoverage.value = wp.clouds;
    u.uCloudDensity.value = wp.cloudDensity;
    // Hazier, redder sky around sunrise / sunset.
    u.uTurbidity.value = 2.4 + overcast * 3 + clock.golden * 2.6;
    u.uRayleigh.value = 1.3 + clock.golden * 0.9;
    const night = clock.night;
    const moonUp = THREE.MathUtils.smoothstep(this.moonDir.y, -0.05, 0.25);
    // Night sky: deep blue zenith (brighter with the moon up), warm city glow on the horizon.
    (u.uNightSky.value as THREE.Color).setRGB(0.0024, 0.0046, 0.012).multiplyScalar(night * (0.7 + 0.6 * moonUp) * (1 - overcast * 0.4));
    (u.uCityGlow.value as THREE.Color).setRGB(0.02, 0.011, 0.0055).multiplyScalar(night * (1 + overcast * 0.35 + Math.min(wp.fog, 4) * 0.03));
    u.uStars.value = night * (1 - overcast);
    u.uStarRot.value = (clock.hours / 24) * Math.PI * 2 * 0.25;
    u.uFlash.value = weather.flash * 0.35;
    // Key light: sun by day, moon by night (the shadow-casting light swaps at the horizon).
    const sunUp = THREE.MathUtils.smoothstep(this.sunDir.y, -0.03, 0.1);
    const cloudDim = 1 - 0.82 * overcast;
    const sunI = 4.2 * sunUp * cloudDim;
    const moonI = 0.42 * moonUp * (1 - 0.85 * overcast) * night;
    if (sunI >= moonI) {
      this.lightDir.copy(this.sunDir);
      const warm = THREE.MathUtils.clamp(1 - this.sunDir.y / 0.55, 0, 1);
      const w2 = warm * warm;
      this.sun.color.setRGB(1.0, 0.93 - 0.2 * w2, 0.84 - 0.42 * w2);
      this.sun.intensity = sunI;
    } else {
      this.lightDir.copy(this.moonDir);
      this.sun.color.setRGB(0.62, 0.72, 1.0);
      this.sun.intensity = moonI;
    }
    // Lightning lights the whole scene for a moment.
    if (weather.flash > 0.02) {
      this.sun.color.lerp(new THREE.Color(0.75, 0.82, 1.0), Math.min(1, weather.flash));
      this.sun.intensity += weather.flash * 2.2;
    }
    if (this.lightDir.y < 0.06) this.lightDir.y = 0.06;
    this.lightDir.normalize();
    this.sunColor.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    // Ground colour for the probe's lower hemisphere: sunlit / moonlit ground plus city light.
    const g = u.uGround.value as THREE.Color;
    g.setRGB(0.07, 0.068, 0.062).multiplyScalar(this.sun.intensity * Math.max(this.lightDir.y, 0) * 0.32 + 0.02);
    g.add(new THREE.Color(0.02, 0.014, 0.008).multiplyScalar(night));
    // Eye adaptation.
    // Eye adaptation follows how high the sun is (evenings open up gradually).
    const dl = clock.daylight;
    const sunH = THREE.MathUtils.smoothstep(this.sunDir.y, -0.1, 0.55);
    this.exposure = THREE.MathUtils.lerp(1.9, 0.5, sunH) * (1 + 0.3 * overcast * dl);
  }

  update(dt: number, focus: THREE.Vector3, fog: FogEffect | undefined, renderer: THREE.WebGLRenderer): void {
    const u = this.skyMaterial.uniforms;
    u.uTime.value += dt;
    this.cloudOffset.x += (wind.vector.x * 0.0009 + 0.0035) * dt;
    this.cloudOffset.y += (wind.vector.z * 0.0009 + 0.0035) * dt;
    this.applyClock();
    this.scene.environmentIntensity = this.envIntensity * (1 + weather.flash * 2.5);
    // Re-bake the probe when the sky has changed enough (at most twice a second).
    const p = this.probe;
    if (p) {
      p.timer -= dt;
      const hrs = clock.hours + clock.day * 24;
      if (p.timer <= 0 && (Math.abs(hrs - p.lastHours) > 0.06 || Math.abs(u.uOvercast.value - p.lastOvercast) > 0.02 || Math.abs(u.uCloudCoverage.value - p.lastClouds) > 0.03)) {
        this.bakeProbe(renderer);
        p.timer = 0.5;
      }
    }
    // Shadow box follows the focus point, snapped to shadow texels to avoid shimmering.
    const texel = (2 * this.shadowRadius) / this.sun.shadow.mapSize.x;
    const lightDir = this.lightDir;
    const up = Math.abs(lightDir.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, lightDir).normalize();
    const lup = new THREE.Vector3().crossVectors(lightDir, right).normalize();
    const r = Math.round(focus.dot(right) / texel) * texel;
    const uu = Math.round(focus.dot(lup) / texel) * texel;
    const d = focus.dot(lightDir);
    const snapped = new THREE.Vector3().addScaledVector(right, r).addScaledVector(lup, uu).addScaledVector(lightDir, d);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(lightDir, 500);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    if (fog) {
      for (const k of ['uSunDir', 'uRayleigh', 'uTurbidity', 'uMie', 'uMieG', 'uSkyExposure', 'uOvercast', 'uSkyBright', 'uNightSky', 'uCityGlow', 'uFlash']) fog.set(k, u[k].value);
      fog.set('uExposure', this.exposure);
      fog.set('uSunTint', this.sunColor.clone().multiplyScalar(0.24));
    }
  }
}
