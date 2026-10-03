/**
 * Shared material library for the generated city.
 * - PBR sets (Poly Haven) with world-metre tiling and macro variation to hide repetition.
 * - Interior-mapped window glass (fake rooms behind every window).
 * - Far-LOD facade shader for impostor boxes (procedural windows, 1 draw call per chunk).
 * - Terrain splat material.
 */
import * as THREE from 'three';
import { assets, type PbrSet } from '../core/AssetLoader';
import { settings } from '../core/Settings';
import { signs } from './Signage';

export const shared = {
  /** 0 = deep night .. 1 = full day; read by window/lamp shaders. */
  daylight: { value: 1 },
  interiorStrength: { value: 1 },
  time: { value: 0 },
};

const NOISE_GLSL = /* glsl */ `
float nwHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float nwNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(nwHash(i), nwHash(i + vec2(1.0, 0.0)), u.x), mix(nwHash(i + vec2(0.0, 1.0)), nwHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float nwFbm(vec2 p) { return nwNoise(p) * 0.5 + nwNoise(p * 2.07 + 13.1) * 0.3 + nwNoise(p * 4.3 + 7.7) * 0.2; }
`;

const WORLDPOS_VERT = /* glsl */ `
  vec4 nwWorld = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  nwWorld = instanceMatrix * nwWorld;
  #endif
  nwWorld = modelMatrix * nwWorld;
  vNwWorld = nwWorld.xyz;
  vec3 nwN = objectNormal;
  #ifdef USE_INSTANCING
  nwN = mat3(instanceMatrix) * nwN;
  #endif
  vNwNormal = normalize(mat3(modelMatrix) * nwN);
`;

interface MacroOpts {
  /** World-size (m) of the low-frequency variation. */
  scale: number;
  /** Albedo variation amount (0..1). */
  amount: number;
  /** Roughness variation amount. */
  rough?: number;
  /** Darken surfaces near their base (street grime) up to this height (m). 0 = off. */
  grime?: number;
}

/** Inject world-space macro variation into a standard material. */
export function patchMacro(mat: THREE.MeshStandardMaterial, o: MacroOpts): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uMacro = { value: new THREE.Vector4(o.scale, o.amount, o.rough ?? 0.1, o.grime ?? 0) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNwWorld;\nvarying vec3 vNwNormal;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + WORLDPOS_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNwWorld;\nvarying vec3 vNwNormal;\nuniform vec4 uMacro;\n' + NOISE_GLSL)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec2 mp = (abs(vNwNormal.y) > 0.6 ? vNwWorld.xz : vec2(vNwWorld.x + vNwWorld.z, vNwWorld.y)) / uMacro.x;
          float m = nwFbm(mp) - 0.5;
          diffuseColor.rgb *= 1.0 + m * uMacro.y * 2.0;
          if (uMacro.w > 0.0 && abs(vNwNormal.y) < 0.6) {
            float above = vNwWorld.y - 2.5;
            diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(0.0, uMacro.w, above));
            float streak = nwNoise(vec2((vNwWorld.x + vNwWorld.z) * 1.3, vNwWorld.y * 0.02));
            diffuseColor.rgb *= 1.0 - 0.07 * smoothstep(0.55, 0.9, streak);
          }
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (nwNoise(vNwWorld.xz / (uMacro.x * 0.37)) - 0.5) * uMacro.z * 2.0, 0.02, 1.0);`,
      );
  };
  mat.customProgramCacheKey = () => `macro-${o.scale}-${o.amount}-${o.rough ?? 0.1}-${o.grime ?? 0}`;
}

function pbr(set: PbrSet, tile: number, params: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const clone = (t: THREE.Texture) => {
    const c = t.clone();
    c.repeat.set(1 / tile, 1 / tile);
    c.anisotropy = settings.q.anisotropy;
    c.needsUpdate = true;
    return c;
  };
  const arm = clone(set.armMap);
  return new THREE.MeshStandardMaterial({
    map: clone(set.map),
    normalMap: clone(set.normalMap),
    aoMap: arm,
    roughnessMap: arm,
    metalnessMap: arm,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
    ...params,
  });
}

// ------------------------------------------------------------------ interior mapping

const INTERIOR_GLSL = /* glsl */ `
varying vec4 vWin;
varying vec2 vWinUv;
uniform float uInteriorStrength;
uniform float uDaylight;

float ih(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }

vec3 nwInterior(vec2 uv, vec3 viewPos, vec3 nV, vec4 win, out float blindMask) {
  float seed = win.x;
  float ww = max(win.y, 0.4);
  float wh = max(win.z, 0.4);
  float style = win.w; // 0 office, 1 residential, 2 shop
  vec3 up = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vec3 T = normalize(cross(up, nV));
  vec3 B = normalize(cross(nV, T));
  vec3 rdV = normalize(-viewPos);
  vec3 rd = vec3(dot(rdV, T), dot(rdV, B), dot(rdV, -nV));
  rd.z = max(rd.z, 0.02);
  float padX = 0.5 * ww + 0.6;
  float sill = style > 1.5 ? 0.25 : 0.9;
  float head = style > 1.5 ? 0.6 : 0.45;
  float depth = 3.0 + 3.5 * ih(seed + 1.0);
  vec3 bmin = vec3(-padX, -sill, 0.0);
  vec3 bmax = vec3(ww + padX, wh + head, depth);
  vec3 p0 = vec3(uv.x * ww, uv.y * wh, 0.0);
  vec3 tA = (bmin - p0) / rd;
  vec3 tB = (bmax - p0) / rd;
  vec3 tF = max(tA, tB);
  float t = min(min(tF.x, tF.y), tF.z);
  vec3 h = p0 + rd * t;

  float lightOn = step(ih(seed + 7.0), style > 1.5 ? 0.92 : (0.25 + 0.55 * (1.0 - uDaylight)));
  vec3 wallCol = mix(vec3(0.62, 0.6, 0.56), vec3(0.75, 0.68, 0.55), ih(seed + 2.0));
  if (ih(seed + 3.0) > 0.7) wallCol = mix(vec3(0.38, 0.47, 0.5), vec3(0.55, 0.42, 0.38), ih(seed + 4.0));
  vec3 floorCol = mix(vec3(0.24, 0.16, 0.1), vec3(0.32, 0.32, 0.34), step(0.5, ih(seed + 5.0)));
  vec3 ceilCol = vec3(0.82);
  vec3 col;
  float shade;
  if (t == tF.z) {
    col = wallCol;
    shade = 0.8;
    // Door / artwork on the back wall.
    vec2 q = vec2((h.x - bmin.x) / (bmax.x - bmin.x), (h.y - bmin.y) / (bmax.y - bmin.y));
    float art = step(abs(q.x - (0.3 + 0.4 * ih(seed + 6.0))), 0.12) * step(abs(q.y - 0.55), 0.12);
    col = mix(col, mix(vec3(0.6, 0.25, 0.15), vec3(0.15, 0.35, 0.55), ih(seed + 8.0)), art * step(0.4, ih(seed + 9.0)));
    float door = step(abs(q.x - 0.82), 0.07) * step(q.y, 0.62);
    col = mix(col, vec3(0.35, 0.24, 0.16), door * step(style, 1.5));
    if (style > 1.5) {
      // Shop shelving on the back wall.
      float shelf = step(0.75, fract(q.y * 6.0)) * step(q.y, 0.75);
      vec3 goods = vec3(ih(floor(q.x * 14.0) + seed), ih(floor(q.x * 14.0) + seed + 3.0), ih(floor(q.x * 14.0) + seed + 5.0));
      col = mix(goods * 0.8 + 0.1, vec3(0.2), shelf);
    }
  } else if (t == tF.x) {
    col = wallCol * 0.9;
    shade = 0.65;
  } else if (rd.y < 0.0) {
    col = floorCol * (0.85 + 0.15 * step(0.5, fract(h.x * 1.6)));
    shade = 0.6;
  } else {
    col = ceilCol;
    shade = 0.9;
    float panel = step(abs(fract(h.x / 2.4) - 0.5), 0.18) * step(abs(fract(h.z / 2.4) - 0.5), 0.18);
    col += panel * lightOn * vec3(3.0, 2.7, 2.2);
  }
  // Furniture block (desk / sofa / counter).
  vec3 fmin = vec3(-padX * 0.3 + ww * ih(seed + 10.0) * 0.4, -sill, depth * (0.35 + 0.2 * ih(seed + 11.0)));
  vec3 fmax = fmin + vec3(1.2 + ih(seed + 12.0) * 1.2, 0.75 + 0.3 * ih(seed + 13.0), 0.8);
  vec3 fa = (fmin - p0) / rd;
  vec3 fb = (fmax - p0) / rd;
  vec3 fn = min(fa, fb);
  vec3 fx = max(fa, fb);
  float tin = max(max(fn.x, fn.y), fn.z);
  float tout = min(min(fx.x, fx.y), fx.z);
  if (tin < tout && tin > 0.0 && tin < t) {
    col = mix(vec3(0.18, 0.12, 0.08), vec3(0.25, 0.27, 0.3), ih(seed + 14.0));
    shade = tin == fn.y ? 0.9 : 0.55;
    t = tin;
  }
  // Light: lamps when on, else daylight falling off with depth.
  float day = uDaylight * 0.55 * exp(-t * 0.28);
  vec3 lamp = lightOn * mix(vec3(1.0, 0.82, 0.6), vec3(0.85, 0.92, 1.0), ih(seed + 15.0)) * (style > 1.5 ? 1.6 : 0.9);
  vec3 lit = col * shade * (day + lamp);
  // Blinds / curtains drawn on the glass plane.
  float blind = ih(seed + 16.0) * (style > 1.5 ? 0.0 : 0.9);
  blindMask = step(1.0 - blind * 0.7, uv.y);
  vec3 blindCol = mix(vec3(0.75, 0.72, 0.66), vec3(0.55, 0.6, 0.62), ih(seed + 17.0));
  blindCol *= 0.85 + 0.15 * step(0.5, fract(uv.y * wh * 14.0));
  lit = mix(lit, blindCol * (uDaylight * 0.5 + lightOn * 0.6), blindMask);
  return lit;
}
`;

function interiorGlass(params: THREE.MeshStandardMaterialParameters, tint: THREE.Color, strength: number): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.05, metalness: 0.0, ...params });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uInteriorStrength = { value: strength };
    shader.uniforms.uDaylight = shared.daylight;
    const enabled = settings.q.interiorMapping;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin;\nvarying vec4 vWin;\nvarying vec2 vWinUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvWin = aWin;\nvWinUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + INTERIOR_GLSL)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        ${
          enabled
            ? `if (vWin.y > 0.0) {
          float blindMask;
          vec3 ic = nwInterior(vWinUv, vViewPosition, normalize(vNormal), vWin, blindMask);
          float ndv = clamp(dot(normalize(vViewPosition), normalize(vNormal)), 0.0, 1.0);
          float fres = pow(1.0 - ndv, 4.0);
          totalEmissiveRadiance += ic * (1.0 - fres) * uInteriorStrength;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.0), 0.5 * (1.0 - blindMask));
        }`
            : ''
        }`,
      );
  };
  mat.customProgramCacheKey = () => `interior-${settings.q.interiorMapping}-${strength}`;
  return mat;
}

// ------------------------------------------------------------------ far facade impostor

const FAR_GLSL = /* glsl */ `
varying vec4 vWin;
uniform float uDaylight;
`;

function farFacade(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDaylight = shared.daylight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aWin;\nvarying vec4 vWin;\nvarying vec3 vNwWorld;\nvarying vec3 vNwNormal;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvWin = aWin;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n' + WORLDPOS_VERT);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FAR_GLSL + 'varying vec3 vNwWorld;\nvarying vec3 vNwNormal;\n' + NOISE_GLSL)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float nwWin = 0.0;
        vec3 nwGlass = vec3(0.0);
        {
          vec3 nW = normalize(vNwNormal);
          if (abs(nW.y) < 0.5 && vWin.x > 0.0) {
            vec3 t = normalize(cross(vec3(0.0, 1.0, 0.0), nW));
            float u = dot(vNwWorld, t);
            float v = vNwWorld.y - 2.5;
            vec2 cell = vec2(u / vWin.y, v / vWin.x);
            vec2 f = fract(cell);
            float gi = floor(vWin.w);
            float wh = fract(vWin.w);
            float inX = step(abs(f.x - 0.5), vWin.z * 0.5);
            float inY = step(abs(f.y - 0.55), wh * 0.5);
            nwWin = inX * inY * step(0.6, cell.y);
            nwGlass = gi < 0.5 ? vec3(0.05, 0.07, 0.09) : (gi < 1.5 ? vec3(0.09, 0.15, 0.2) : vec3(0.12, 0.13, 0.12));
            float lit = step(0.82 - 0.4 * (1.0 - uDaylight), nwHash(floor(cell) + floor(vNwWorld.xz / 50.0)));
            totalEmissiveNw = nwGlass * 0.0 + vec3(1.0, 0.8, 0.55) * lit * 0.35 * nwWin * (1.2 - uDaylight);
            diffuseColor.rgb = mix(diffuseColor.rgb * (0.9 + 0.2 * nwNoise(vNwWorld.xy * 0.05 + vNwWorld.zy * 0.05)), nwGlass, nwWin);
          } else if (nW.y > 0.5) {
            diffuseColor.rgb *= 0.55 + 0.1 * nwNoise(vNwWorld.xz * 0.2);
          }
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.08, nwWin);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.35, nwWin);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += totalEmissiveNw;')
      .replace('void main() {', 'vec3 totalEmissiveNw = vec3(0.0);\nvoid main() {');
  };
  mat.customProgramCacheKey = () => 'farFacade';
  return mat;
}

// ------------------------------------------------------------------ terrain

function terrainMaterial(grass: PbrSet, sand: PbrSet, rock: PbrSet): THREE.MeshStandardMaterial {
  const mat = pbr(grass, 5);
  const sandMap = sand.map.clone();
  const rockMap = rock.map.clone();
  const sandNor = sand.normalMap.clone();
  [sandMap, rockMap, sandNor].forEach((t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
  });
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    shader.uniforms.tSand = { value: sandMap };
    shader.uniforms.tRock = { value: rockMap };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSplat;\nvarying vec2 vTerrUv;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvSplat = color.rgb;\nvTerrUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSplat;\nvarying vec2 vTerrUv;\nuniform sampler2D tSand;\nuniform sampler2D tRock;')
      .replace(
        '#include <map_fragment>',
        `vec4 gC = texture2D(map, vMapUv);
         vec4 sC = texture2D(tSand, vTerrUv / 9.0);
         vec4 rC = texture2D(tRock, vTerrUv / 4.0);
         vec3 w = vSplat / max(vSplat.r + vSplat.g + vSplat.b, 1e-3);
         diffuseColor.rgb *= gC.rgb * w.r + sC.rgb * w.g + rC.rgb * w.b;`,
      )
      .replace('#include <color_fragment>', '');
  };
  mat.customProgramCacheKey = () => 'terrain';
  return mat;
}

function picketMaterial(): THREE.MeshStandardMaterial {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 128);
  g.fillStyle = '#f2efe8';
  for (let i = 0; i < 6; i++) {
    const x = i * (256 / 6) + 8;
    const w = 256 / 6 - 16;
    g.fillRect(x, 18, w, 110);
    g.beginPath();
    g.moveTo(x, 18);
    g.lineTo(x + w / 2, 2);
    g.lineTo(x + w, 18);
    g.fill();
  }
  g.fillRect(0, 40, 256, 10);
  g.fillRect(0, 96, 256, 10);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6 });
  m.name = 'picket';
  return m;
}

// ------------------------------------------------------------------ library

export type MaterialKey = string;

export class MaterialLibrary {
  readonly m: Record<string, THREE.Material> = {};
  ready = false;

  async load(): Promise<void> {
    const ids = [
      'asphalt_02', 'concrete_pavement', 'herringbone_pavement', 'cobblestone_floor_08', 'red_brick_03', 'brown_brick_02',
      'large_red_bricks', 'large_sandstone_blocks', 'concrete_wall_008', 'concrete_panels', 'plaster_grey_04', 'white_plaster_02',
      'corrugated_iron_02', 'container_side', 'painted_metal_shutter', 'metal_plate', 'roof_slates_02', 'clay_roof_tiles_02',
      'leafy_grass', 'coast_sand_01', 'weathered_planks', 'granite_tile', 'rough_concrete', 'rusty_metal_02', 'bark_platanus',
    ];
    const sets: Record<string, PbrSet> = {};
    await Promise.all(ids.map(async (id) => (sets[id] = await assets.loadPbr(id))));
    const m = this.m;

    const mk = (key: string, id: string, tile: number, macro: MacroOpts | null, params: THREE.MeshStandardMaterialParameters = {}) => {
      const mat = pbr(sets[id], tile, params);
      if (macro) patchMacro(mat, macro);
      mat.name = key;
      m[key] = mat;
      return mat;
    };

    // Ground surfaces
    mk('asphalt', 'asphalt_02', 8, { scale: 40, amount: 0.12, rough: 0.12 }, { color: new THREE.Color(0.86, 0.86, 0.88) });
    mk('pavement', 'concrete_pavement', 3, { scale: 25, amount: 0.1, rough: 0.08 });
    mk('plaza', 'herringbone_pavement', 2.6, { scale: 30, amount: 0.12 });
    mk('cobble', 'cobblestone_floor_08', 2.8, { scale: 25, amount: 0.12 });
    mk('kerb', 'rough_concrete', 1.6, null, { color: new THREE.Color(0.86, 0.85, 0.82) });
    mk('grass', 'leafy_grass', 5, { scale: 18, amount: 0.18, rough: 0.05 });
    mk('sand', 'coast_sand_01', 8, { scale: 30, amount: 0.1 });
    mk('gravel', 'rough_concrete', 3, { scale: 12, amount: 0.25 }, { color: new THREE.Color(0.55, 0.5, 0.46) });
    // Facades
    mk('brick_red', 'red_brick_03', 2.3, { scale: 14, amount: 0.12, grime: 4 });
    mk('brick_brown', 'brown_brick_02', 2.3, { scale: 14, amount: 0.12, grime: 4 });
    mk('brick_factory', 'large_red_bricks', 2.8, { scale: 16, amount: 0.15, grime: 6 });
    mk('stone', 'large_sandstone_blocks', 3.4, { scale: 14, amount: 0.1, grime: 4 });
    mk('concrete', 'concrete_wall_008', 4.5, { scale: 20, amount: 0.12, grime: 5 });
    mk('concrete_panels', 'concrete_panels', 7, { scale: 30, amount: 0.08, grime: 3 });
    mk('plaster', 'white_plaster_02', 3, { scale: 10, amount: 0.1, grime: 3 });
    mk('plaster_grey', 'plaster_grey_04', 3, { scale: 12, amount: 0.1, grime: 3 });
    mk('corrugated', 'corrugated_iron_02', 3, { scale: 18, amount: 0.15, grime: 3 });
    mk('container', 'container_side', 6.1, null);
    mk('shutter', 'painted_metal_shutter', 3, null);
    mk('metal_plate', 'metal_plate', 2, null);
    mk('granite', 'granite_tile', 3.2, { scale: 20, amount: 0.06 });
    mk('wood', 'weathered_planks', 3, { scale: 10, amount: 0.15 });
    mk('rust', 'rusty_metal_02', 3, null);
    mk('bark', 'bark_platanus', 1.6, null);
    // Roofs
    mk('roof_slate', 'roof_slates_02', 3, { scale: 12, amount: 0.12 });
    mk('roof_tile', 'clay_roof_tiles_02', 3, { scale: 12, amount: 0.12 });
    mk('roof_flat', 'rough_concrete', 5, { scale: 15, amount: 0.15 }, { color: new THREE.Color(0.42, 0.42, 0.44) });

    // Plain PBR
    const std = (key: string, p: THREE.MeshStandardMaterialParameters) => {
      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, ...p });
      mat.name = key;
      m[key] = mat;
      return mat;
    };
    std('steel_dark', { color: 0x30353b, metalness: 0.85, roughness: 0.42 });
    std('steel_light', { color: 0x9aa4ad, metalness: 0.9, roughness: 0.3 });
    std('aluminium', { color: 0xc4c9cc, metalness: 0.95, roughness: 0.28 });
    std('paint_white', { color: 0xe9e6df, roughness: 0.55 });
    std('paint_dark', { color: 0x202326, roughness: 0.5, metalness: 0.4 });
    std('paint', { color: 0xffffff, roughness: 0.55, metalness: 0.15 });
    std('paint_bridge', { color: 0x58717f, roughness: 0.48, metalness: 0.55 });
    std('copper', { color: 0x5f9c8a, roughness: 0.62, metalness: 0.35 });
    std('fabric', { color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
    std('rubber', { color: 0x1a1a1a, roughness: 0.85 });
    std('dark_interior', { color: 0x0c0d0f, roughness: 0.9 });
    std('lamp_glow', { color: 0xffffff, emissive: new THREE.Color(1.0, 0.86, 0.62), emissiveIntensity: 2.2, roughness: 0.4 });
    std('light_red', { color: 0x200000, emissive: new THREE.Color(1, 0.05, 0.03), emissiveIntensity: 0.15, roughness: 0.3 });
    std('light_amber', { color: 0x201000, emissive: new THREE.Color(1, 0.5, 0.02), emissiveIntensity: 0.15, roughness: 0.3 });
    std('light_green', { color: 0x002010, emissive: new THREE.Color(0.05, 1, 0.45), emissiveIntensity: 0.15, roughness: 0.3 });
    const mark = std('markings', { color: 0xf2f0e8, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    patchMacro(mark, { scale: 6, amount: 0.25 });
    const markY = std('markings_yellow', { color: 0xe8b82a, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    patchMacro(markY, { scale: 6, amount: 0.25 });

    mk('rough_wall', 'rough_concrete', 3, { scale: 12, amount: 0.2 }, { color: new THREE.Color(0.7, 0.69, 0.66) });
    mk('hedge', 'leafy_grass', 1.2, { scale: 4, amount: 0.25 }, { color: new THREE.Color(0.55, 0.75, 0.45) });
    std('water', { color: 0x1d3b45, roughness: 0.04, metalness: 0.2, vertexColors: false });
    m.picket = picketMaterial();
    m.signs = signs().material;

    // Glass
    m.glass_window = interiorGlass({ vertexColors: false }, new THREE.Color(0.06, 0.07, 0.075), 1.0);
    m.glass_curtain = interiorGlass({ vertexColors: false, metalness: 0.55, roughness: 0.04 }, new THREE.Color(0.32, 0.42, 0.45), 0.45);
    m.glass_shop = interiorGlass({ vertexColors: false }, new THREE.Color(0.05, 0.05, 0.05), 0.75);
    m.glass_plain = new THREE.MeshStandardMaterial({ color: 0x223038, metalness: 0.6, roughness: 0.06 });

    // Far LOD & terrain
    m.far_facade = farFacade();
    m.terrain = terrainMaterial(sets.leafy_grass, sets.coast_sand_01, sets.rough_concrete);
    this.ready = true;
  }

  /** Apply a sky/city environment map to glass so reflections match the sky dome. */
  setReflectionEnv(env: THREE.Texture): void {
    for (const k of ['glass_window', 'glass_curtain', 'glass_shop', 'glass_plain']) {
      const mat = this.m[k] as THREE.MeshStandardMaterial;
      mat.envMap = env;
      mat.envMapIntensity = k === 'glass_curtain' ? 0.85 : 0.5;
      mat.needsUpdate = true;
    }
  }
}

export const materials = new MaterialLibrary();
