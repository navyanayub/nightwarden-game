/**
 * Subtle raindrops on the "lens" for the driving camera: procedural drops in a jittered grid
 * that appear, slowly slide and fade; each drop refracts the image behind it. Runs in its own
 * EffectPass (it samples the pass input at an offset UV) and is disabled when dry.
 */
import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const fragment = /* glsl */ `
uniform float uAmount;
uniform float uTime;
uniform float uAspect;

float dh(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }

vec3 dropLayer(vec2 uv, float scale, float t, float seed) {
  vec2 p = vec2(uv.x * uAspect, uv.y) * scale;
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  float h = dh(id + seed);
  float life = fract(t * (0.08 + h * 0.07) + h * 7.0);
  vec2 c = (vec2(dh(id + seed + 1.3), dh(id + seed + 2.7)) - 0.5) * 0.6;
  c.y += life * 0.25 * step(0.6, h); // some drops slide down
  vec2 d = f - c;
  d.y *= 1.0 + 0.4 * step(0.6, h);
  float r = 0.12 + 0.12 * dh(id + seed + 4.1);
  float m = smoothstep(r, r * 0.6, length(d)) * step(0.35, h) * smoothstep(1.0, 0.7, life) * smoothstep(0.0, 0.05, life);
  return vec3(d / max(r, 1e-3), m);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 a = dropLayer(uv, 9.0, uTime, 0.0);
  vec3 b = dropLayer(uv + 0.37, 15.0, uTime * 1.2, 11.0);
  vec2 off = (a.xy * a.z + b.xy * b.z * 0.7) * -0.012 * uAmount;
  float mask = max(a.z, b.z * 0.8) * uAmount;
  vec3 refr = texture2D(inputBuffer, uv + off).rgb;
  vec3 col = mix(inputColor.rgb, refr * 1.04 + 0.01, mask);
  outputColor = vec4(col, inputColor.a);
}
`;

export class ScreenDropsEffect extends Effect {
  constructor() {
    super('ScreenDropsEffect', fragment, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uAmount', new THREE.Uniform(0)],
        ['uTime', new THREE.Uniform(0)],
        ['uAspect', new THREE.Uniform(1.7)],
      ]),
    });
  }

  update(_renderer: THREE.WebGLRenderer, _input: THREE.WebGLRenderTarget, dt?: number): void {
    const t = this.uniforms.get('uTime')!;
    t.value += dt ?? 0.016;
  }

  set amount(v: number) {
    this.uniforms.get('uAmount')!.value = v;
  }

  set aspect(v: number) {
    this.uniforms.get('uAspect')!.value = v;
  }
}
