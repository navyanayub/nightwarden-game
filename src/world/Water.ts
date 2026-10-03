/**
 * Ocean: a camera-following grid using MeshStandardMaterial (for PBR sun specular, env
 * reflections, shadows and fog) patched with: gentle vertex swell, analytic multi-wave
 * normals + procedural detail normals, depth-based shallow/deep colour from the terrain
 * height texture, and shoreline foam.
 */
import * as THREE from 'three';
import { TERRAIN } from './WorldConfig';
import { shared } from './Materials';

const WAVES = /* glsl */ `
// Sum of directional waves: returns height and analytic slope (dh/dx, dh/dz).
vec3 nwWaves(vec2 p, float t) {
  vec3 acc = vec3(0.0);
  const int N = 6;
  vec2 dirs[6];
  dirs[0] = normalize(vec2(1.0, 0.35));
  dirs[1] = normalize(vec2(0.7, 1.0));
  dirs[2] = normalize(vec2(-0.4, 1.0));
  dirs[3] = normalize(vec2(1.0, -0.6));
  dirs[4] = normalize(vec2(-1.0, 0.2));
  dirs[5] = normalize(vec2(0.2, -1.0));
  float amp = 0.32;
  float wl = 38.0;
  for (int i = 0; i < N; i++) {
    float k = 6.2831 / wl;
    float c = sqrt(9.81 / k);
    float ph = k * dot(dirs[i], p) - c * k * t * 0.35;
    acc.x += amp * sin(ph);
    acc.yz += amp * k * cos(ph) * dirs[i];
    amp *= 0.62;
    wl *= 0.58;
  }
  return acc;
}
`;

export class Water {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private uniforms: Record<string, THREE.IUniform> = {};

  constructor(heightTex: THREE.DataTexture, level = 0, size = 9000, segments = 220) {
    const geo = new THREE.PlaneGeometry(size, size, segments, segments);
    geo.rotateX(-Math.PI / 2);
    // Concentrate vertices near the centre (camera) for swell detail.
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z) / (size / 2);
      const k = r < 1e-6 ? 1 : (Math.pow(r, 2.2) / r);
      pos.setX(i, x * k);
      pos.setZ(i, z * k);
    }
    geo.computeBoundingSphere();
    this.material = new THREE.MeshStandardMaterial({ color: 0x0b2c38, roughness: 0.1, metalness: 0.0, envMapIntensity: 0.6 });
    this.uniforms = {
      uTime: shared.time,
      uHeight: { value: heightTex },
      uTerr: { value: new THREE.Vector4(TERRAIN.minX, TERRAIN.minZ, TERRAIN.maxX - TERRAIN.minX, TERRAIN.maxZ - TERRAIN.minZ) },
      uLevel: { value: level },
      uDeep: { value: new THREE.Color(0.008, 0.05, 0.07) },
      uShallow: { value: new THREE.Color(0.06, 0.24, 0.24) },
      uFoam: { value: 1 },
    };
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying vec3 vWPos;\n${WAVES}`)
        .replace(
          '#include <begin_vertex>',
          `vec3 transformed = vec3(position);
           vec4 wp0 = modelMatrix * vec4(transformed, 1.0);
           float fade = 1.0 - smoothstep(150.0, 600.0, length(wp0.xz - cameraPosition.xz));
           transformed.y += nwWaves(wp0.xz, uTime).x * fade;`,
        )
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uTime;
          uniform sampler2D uHeight;
          uniform vec4 uTerr;
          uniform float uLevel;
          uniform vec3 uDeep;
          uniform vec3 uShallow;
          uniform float uFoam;
          varying vec3 vWPos;
          ${WAVES}
          float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float wNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(wHash(i), wHash(i + vec2(1, 0)), u.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), u.x), u.y); }
          vec2 wDetail(vec2 p, float t) {
            float e = 0.12;
            float h0 = wNoise(p + t * vec2(0.3, 0.2)) + 0.5 * wNoise(p * 2.3 - t * vec2(0.25, 0.4));
            float hx = wNoise(p + vec2(e, 0.0) + t * vec2(0.3, 0.2)) + 0.5 * wNoise((p + vec2(e, 0.0)) * 2.3 - t * vec2(0.25, 0.4));
            float hz = wNoise(p + vec2(0.0, e) + t * vec2(0.3, 0.2)) + 0.5 * wNoise((p + vec2(0.0, e)) * 2.3 - t * vec2(0.25, 0.4));
            return vec2(hx - h0, hz - h0) / e;
          }
          float wDepth;
          float wFoamAmt;`,
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec2 tuv = (vWPos.xz - uTerr.xy) / uTerr.zw;
            float ground = (tuv.x < 0.0 || tuv.y < 0.0 || tuv.x > 1.0 || tuv.y > 1.0) ? -30.0 : texture2D(uHeight, tuv).r;
            wDepth = max(uLevel - ground, 0.0);
            float shallow = exp(-wDepth * 0.28);
            diffuseColor.rgb = mix(uDeep, uShallow, shallow);
            float fn = wNoise(vWPos.xz * 0.35 + uTime * 0.2) * 0.6 + wNoise(vWPos.xz * 1.3 - uTime * 0.3) * 0.4;
            float shore = smoothstep(1.4, 0.0, wDepth);
            float band = 0.5 + 0.5 * sin(wDepth * 6.0 - uTime * 1.6);
            wFoamAmt = clamp(shore * (0.45 + 0.55 * band) * smoothstep(0.35, 0.7, fn + shore * 0.4) * uFoam, 0.0, 1.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.9, 0.9), wFoamAmt);
          }`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float dist = length(vWPos.xz - cameraPosition.xz);
            vec3 w = nwWaves(vWPos.xz, uTime);
            vec2 slope = w.yz;
            float dfade = 1.0 - smoothstep(60.0, 900.0, dist);
            slope += wDetail(vWPos.xz * 0.45, uTime) * 0.1 * dfade;
            slope += wDetail(vWPos.xz * 1.7 + 11.0, uTime * 1.6) * 0.05 * (1.0 - smoothstep(20.0, 220.0, dist));
            slope *= mix(1.0, 0.45, smoothstep(200.0, 1500.0, dist));
            vec3 nW = normalize(vec3(-slope.x, 1.0, -slope.y));
            normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
          }`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, wFoamAmt);');
    };
    this.material.customProgramCacheKey = () => 'nwWater';
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = level;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'Ocean';
    this.mesh.frustumCulled = false;
  }

  setFoam(v: number): void {
    this.uniforms.uFoam.value = v;
  }

  /** Keep the grid centred under the camera (snapped to avoid swimming). */
  follow(cam: THREE.Vector3): void {
    const snap = 20;
    this.mesh.position.x = Math.round(cam.x / snap) * snap;
    this.mesh.position.z = Math.round(cam.z / snap) * snap;
  }
}
