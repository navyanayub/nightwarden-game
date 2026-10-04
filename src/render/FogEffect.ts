/**
 * Height fog + aerial perspective + scene exposure as a post effect (pmndrs postprocessing).
 * Reconstructs world position from depth, integrates exponential height fog along the
 * view ray and blends towards the *same* Preetham sky colour the sky dome uses, so
 * distant geometry dissolves seamlessly into the horizon.
 */
import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { SKY_GLSL } from './SkyShared';

const fragment = /* glsl */ `
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uDensity;
uniform float uFalloff;
uniform float uBaseHeight;
uniform float uMaxOpacity;
uniform vec3 uSunTint;
uniform float uExposure;
uniform float uBank;
uniform vec4 uBankArea;
uniform vec2 uBankDrift;
${SKY_GLSL}

float fbH(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fbN(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fbH(i), fbH(i + vec2(1.0, 0.0)), u.x), mix(fbH(i + vec2(0.0, 1.0)), fbH(i + vec2(1.0, 1.0)), u.x), u.y);
}
/** Optical depth of the low harbour fog bank along the ray (short raymarch through 2D noise). */
float fogBank(vec3 ro, vec3 rd, float dist) {
  float len = min(dist, 1600.0);
  float stepL = len / 10.0;
  float od = 0.0;
  float j = fbH(gl_FragCoord.xy) * stepL;
  for (int i = 0; i < 10; i++) {
    vec3 p = ro + rd * (j + stepL * float(i));
    vec2 q = (p.xz - uBankArea.xy) / uBankArea.zw;
    float area = 1.0 - smoothstep(0.55, 1.0, length(q));
    float h = exp(-max(p.y - 1.0, 0.0) / 9.0);
    vec2 np = p.xz * 0.006 + uBankDrift;
    float n = fbN(np) * 0.6 + fbN(np * 2.3 + 4.1) * 0.4;
    od += area * h * smoothstep(0.3, 0.75, n) * stepL;
  }
  return od * 0.012 * uBank;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  bool isSky = depth >= 0.99999;
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProj * clip;
  view /= view.w;
  vec3 world = (uCamWorld * vec4(view.xyz, 1.0)).xyz;
  vec3 ray = world - uCamPos;
  float dist = length(ray);
  vec3 rd = ray / max(dist, 1e-4);
  if (isSky) dist = 3000.0;

  // Analytic integral of density a*exp(-b*(y-h0)) along the ray.
  float a = uDensity;
  float b = uFalloff;
  float camH = max(uCamPos.y - uBaseHeight, -50.0);
  float ry = rd.y;
  float fogInt;
  if (abs(ry) < 1e-3) {
    fogInt = a * exp(-b * camH) * dist;
  } else {
    fogInt = a * exp(-b * camH) * (1.0 - exp(-b * ry * dist)) / (b * ry);
  }
  float fogAmt = clamp(1.0 - exp(-fogInt), 0.0, uMaxOpacity);
  if (isSky) fogAmt *= smoothstep(0.0, 1.0, fogAmt * 1.4) * 0.9;

  vec3 horizonDir = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.5 + 0.07, rd.z));
  vec3 fogCol = skyColor(horizonDir);
  fogCol *= min(1.0, 2.4 / max(max(fogCol.r, max(fogCol.g, fogCol.b)), 1e-3));
  float sunAmt = pow(max(dot(rd, normalize(uSunDir)), 0.0), 6.0);
  fogCol += uSunTint * sunAmt * 0.25 * (1.0 - uOvercast);
  vec3 col = mix(inputColor.rgb, fogCol, fogAmt);
  if (uBank > 0.01) {
    float bank = 1.0 - exp(-fogBank(uCamPos, rd, dist));
    col = mix(col, fogCol * 1.08 + vec3(0.01), clamp(bank, 0.0, 0.97));
  }
  outputColor = vec4(col * uExposure, inputColor.a);
  #ifdef FOG_DEBUG
  outputColor = vec4(fogAmt * 10.0, fogCol.g / 10.0, fogInt * 10.0, 1.0);
  #endif
}
`;

export class FogEffect extends Effect {
  constructor() {
    super('HeightFogEffect', (new URLSearchParams(location.search).has('fogdbg') ? '#define FOG_DEBUG\n' : '') + fragment, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uInvProj', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamPos', new THREE.Uniform(new THREE.Vector3())],
        ['uDensity', new THREE.Uniform(0.0006)],
        ['uFalloff', new THREE.Uniform(0.02)],
        ['uBaseHeight', new THREE.Uniform(0)],
        ['uMaxOpacity', new THREE.Uniform(0.85)],
        ['uSunTint', new THREE.Uniform(new THREE.Color(1.0, 0.85, 0.6))],
        ['uSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['uRayleigh', new THREE.Uniform(1.2)],
        ['uTurbidity', new THREE.Uniform(3.0)],
        ['uMie', new THREE.Uniform(0.005)],
        ['uMieG', new THREE.Uniform(0.8)],
        ['uSkyExposure', new THREE.Uniform(1)],
        ['uExposure', new THREE.Uniform(0.5)],
        ['uOvercast', new THREE.Uniform(0)],
        ['uSkyBright', new THREE.Uniform(1)],
        ['uNightSky', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['uCityGlow', new THREE.Uniform(new THREE.Color(0, 0, 0))],
        ['uFlash', new THREE.Uniform(0)],
        ['uBank', new THREE.Uniform(0)],
        ['uBankArea', new THREE.Uniform(new THREE.Vector4(380, 980, 900, 520))],
        ['uBankDrift', new THREE.Uniform(new THREE.Vector2())],
      ]),
    });
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    (this.uniforms.get('uInvProj')!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (this.uniforms.get('uCamWorld')!.value as THREE.Matrix4).copy(camera.matrixWorld);
    (this.uniforms.get('uCamPos')!.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
  }

  set(name: string, value: number | THREE.Vector2 | THREE.Vector3 | THREE.Vector4 | THREE.Color): void {
    const u = this.uniforms.get(name);
    if (!u) return;
    if (typeof value === 'number') u.value = value;
    else (u.value as THREE.Vector3 | THREE.Color).copy(value as never);
  }
}
