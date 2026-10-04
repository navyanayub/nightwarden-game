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
${SKY_GLSL}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (depth >= 0.99999) { outputColor = vec4(inputColor.rgb * uExposure, inputColor.a); return; }
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = uInvProj * clip;
  view /= view.w;
  vec3 world = (uCamWorld * vec4(view.xyz, 1.0)).xyz;
  vec3 ray = world - uCamPos;
  float dist = length(ray);
  vec3 rd = ray / max(dist, 1e-4);

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

  vec3 horizonDir = normalize(vec3(rd.x, max(rd.y, 0.0) * 0.5 + 0.07, rd.z));
  vec3 fogCol = skyRadiance(horizonDir) * uSkyExposure;
  fogCol *= min(1.0, 2.4 / max(max(fogCol.r, max(fogCol.g, fogCol.b)), 1e-3));
  float sunAmt = pow(max(dot(rd, normalize(uSunDir)), 0.0), 6.0);
  fogCol += uSunTint * sunAmt * 0.25;
  outputColor = vec4(mix(inputColor.rgb, fogCol, fogAmt) * uExposure, inputColor.a);
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
      ]),
    });
  }

  setCamera(camera: THREE.PerspectiveCamera): void {
    (this.uniforms.get('uInvProj')!.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (this.uniforms.get('uCamWorld')!.value as THREE.Matrix4).copy(camera.matrixWorld);
    (this.uniforms.get('uCamPos')!.value as THREE.Vector3).setFromMatrixPosition(camera.matrixWorld);
  }

  set(name: string, value: number | THREE.Vector3 | THREE.Color): void {
    const u = this.uniforms.get(name);
    if (!u) return;
    if (typeof value === 'number') u.value = value;
    else (u.value as THREE.Vector3 | THREE.Color).copy(value as never);
  }
}
