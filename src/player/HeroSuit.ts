/**
 * The Nightwarden's suit, built on the player's rigged base body.
 *
 * - The body itself is re-shaded (bind-space masks, like the civilian clothes) as a matte
 *   slate-grey tactical undersuit with sheen, panel seams, quilted sides, gloves and boots;
 *   only the jaw stays bare under the half-mask.
 * - Armour plates, hood, cowl, half-mask, visor lenses and the silver crescent emblem are
 *   generated here as curved shells in bind space (T-pose, metres, facing +Z) and merged into
 *   ONE SkinnedMesh rigidly weighted to the body's bones: five material groups = five draws.
 * - Everything reacts to `shared.wetness`: fabric darkens and turns glossy, armour beads up.
 *
 * Original design: layered slate plates, storm-grey hood and cape, pale-blue visor, crescent.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { shared } from '../world/Materials';

/** Material slots of the armour mesh. */
const M_ARMOUR = 0;
const M_FABRIC = 1;
const M_MASK = 2;
const M_SILVER = 3;
const M_VISOR = 4;

type V3 = [number, number, number];

interface Piece {
  geo: THREE.BufferGeometry;
  bone: string;
  mat: number;
}

/**
 * Closed-thickness surface patch: `fn(u, v)` gives the outer surface, the inner surface is
 * offset towards `center` (axis-relative) by `t`, and the four rims are stitched.
 */
function shellSurface(fn: (u: number, v: number) => THREE.Vector3, nu: number, nv: number, t: number, inward: (p: THREE.Vector3) => THREE.Vector3): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const grid = (inner: boolean) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const p = fn(i / nu, j / nv);
        if (inner) p.addScaledVector(inward(p), t);
        pos.push(p.x, p.y, p.z);
        uv.push(i / nu, j / nv);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i;
        const b = a + 1;
        const c = a + nu + 1;
        const d = c + 1;
        if (inner) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
  };
  grid(false);
  grid(true);
  // Rims: separate vertices so the edges get crisp normals.
  const rim = (pts: [number, number][]) => {
    const base = pos.length / 3;
    for (const [u, v] of pts) {
      const p = fn(u, v);
      const q = p.clone().addScaledVector(inward(p), t);
      pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
      uv.push(u, v, u, v);
    }
    for (let k = 0; k < pts.length - 1; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  const line = (n: number, f: (k: number) => [number, number]) => Array.from({ length: n + 1 }, (_, k) => f(k / n));
  rim(line(nu, (s) => [s, 0]));
  rim(line(nv, (s) => [1, s]));
  rim(line(nu, (s) => [1 - s, 1]));
  rim(line(nv, (s) => [0, 1 - s]));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

interface BandOpts {
  /** Axis through the limb/torso: 'y' (torso, legs) or 'x' (arms in T-pose). */
  axis: 'x' | 'y';
  c: V3;
  /** Radii: for axis y (x-dir, z-dir); for axis x (y-dir, z-dir). */
  r: [number, number];
  /** Angular span. Axis y: 0 = front (+Z), + towards +X. Axis x: 0 = up (+Y), + towards +Z. */
  a: [number, number];
  /** Extent along the axis (start, end); radii scale linearly by `taper` towards the end. */
  l: [number, number];
  t?: number;
  taper?: number;
  bulge?: number;
  nu?: number;
  nv?: number;
}

/** Curved armour band around an axis. */
function band(o: BandOpts): THREE.BufferGeometry {
  const taper = o.taper ?? 1;
  const fn = (u: number, v: number) => {
    const a = o.a[0] + (o.a[1] - o.a[0]) * u;
    const l = o.l[0] + (o.l[1] - o.l[0]) * v;
    const s = (1 + (taper - 1) * v) * (1 + (o.bulge ?? 0) * Math.sin(v * Math.PI));
    if (o.axis === 'y') return new THREE.Vector3(o.c[0] + Math.sin(a) * o.r[0] * s, l, o.c[2] + Math.cos(a) * o.r[1] * s);
    return new THREE.Vector3(l, o.c[1] + Math.cos(a) * o.r[0] * s, o.c[2] + Math.sin(a) * o.r[1] * s);
  };
  const inward = (p: THREE.Vector3) => (o.axis === 'y' ? new THREE.Vector3(o.c[0] - p.x, 0, o.c[2] - p.z) : new THREE.Vector3(0, o.c[1] - p.y, o.c[2] - p.z)).normalize();
  return shellSurface(fn, o.nu ?? 12, o.nv ?? 4, o.t ?? 0.012, inward);
}

function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = g.clone();
  m.scale(-1, 1, 1);
  // Mirroring flips the winding: swap two indices per triangle.
  const idx = m.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  m.computeVertexNormals();
  return m;
}

/** The silver crescent emblem (extruded), centred at the origin facing +Z. */
function crescent(size: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.absarc(0, 0, size, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(size * 0.5, size * 0.26, size * 0.84, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0012, bevelSegments: 1, curveSegments: 20 });
  g.rotateZ(0.5);
  return g;
}

/** Visor lens: an almond with an angled brow edge, facing +Z. */
function lens(side: 1 | -1): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const w = 0.021;
  // Authored for the left eye; the right eye is a mirrored copy (winding fixed below).
  s.moveTo(-w, 0.0);
  s.quadraticCurveTo(0, 0.012, w, 0.008);
  s.quadraticCurveTo(0.006, -0.011, -w, 0.0);
  const g = new THREE.ShapeGeometry(s, 10);
  if (side < 0) {
    g.scale(-1, 1, 1);
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, a);
    }
    g.computeVertexNormals();
  }
  return g;
}

function boxAt(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function buildPieces(): Piece[] {
  const P: Piece[] = [];
  const add = (geo: THREE.BufferGeometry, bone: string, mat: number, mirror?: string) => {
    P.push({ geo, bone, mat });
    if (mirror) P.push({ geo: mirrorX(geo), bone: mirror, mat });
  };
  // Chest: two layered pectoral plates, an upper gorget plate and a back plate.
  add(band({ axis: 'y', c: [0.066, 0, -0.012], r: [0.118, 0.146], a: [0.1, 1.15], l: [1.27, 1.43], taper: 0.94, bulge: 0.04, t: 0.014 }), 'spine_03', M_ARMOUR, 'spine_03');
  add(band({ axis: 'y', c: [0.05, 0, -0.012], r: [0.14, 0.152], a: [0.12, 1.0], l: [1.405, 1.47], taper: 0.88, t: 0.012, nv: 2 }), 'spine_03', M_ARMOUR, 'spine_03');
  add(band({ axis: 'y', c: [0, 0, -0.012], r: [0.172, 0.168], a: [Math.PI - 1.0, Math.PI + 1.0], l: [1.25, 1.46], taper: 0.95, bulge: 0.03, nu: 16 }), 'spine_03', M_ARMOUR);
  // Abdomen: three overlapping bands (lowest on the pelvis-side spine bone).
  const abs: [number, number, string][] = [
    [1.035, 1.115, 'spine_01'],
    [1.11, 1.19, 'spine_02'],
    [1.185, 1.265, 'spine_02'],
  ];
  for (const [a, b, bone] of abs) add(band({ axis: 'y', c: [0, 0, -0.006], r: [0.168, 0.132], a: [-1.0, 1.0], l: [a, b], taper: 0.97, bulge: 0.05, t: 0.011, nu: 14, nv: 2 }), bone, M_ARMOUR);
  // Belt with buckle and pouches.
  add(band({ axis: 'y', c: [0, 0, -0.01], r: [0.168, 0.13], a: [-Math.PI, Math.PI], l: [0.93, 0.99], t: 0.01, nu: 28, nv: 1 }), 'pelvis', M_MASK);
  add(boxAt(0.05, 0.04, 0.012, 0, 0.96, 0.124), 'pelvis', M_SILVER);
  for (const s of [1, -1]) {
    add(boxAt(0.05, 0.06, 0.035, s * 0.125, 0.94, 0.07), 'pelvis', M_MASK);
    add(boxAt(0.045, 0.055, 0.035, s * 0.158, 0.94, -0.03), 'pelvis', M_MASK);
  }
  // Shoulders: two layered pauldrons per side.
  add(band({ axis: 'x', c: [0, 1.458, -0.064], r: [0.098, 0.102], a: [-1.65, 1.65], l: [0.15, 0.3], taper: 0.84, bulge: 0.05, t: 0.013, nu: 14, nv: 3 }), 'upperarm_l', M_ARMOUR);
  add(band({ axis: 'x', c: [0, 1.458, -0.064], r: [0.088, 0.092], a: [-1.45, 1.45], l: [0.25, 0.35], taper: 0.85, t: 0.012, nu: 12, nv: 2 }), 'upperarm_l', M_ARMOUR);
  add(band({ axis: 'x', c: [0, 1.458, -0.064], r: [0.098, 0.102], a: [-1.65, 1.65], l: [-0.15, -0.3], taper: 0.84, bulge: 0.05, t: 0.013, nu: 14, nv: 3 }), 'upperarm_r', M_ARMOUR);
  add(band({ axis: 'x', c: [0, 1.458, -0.064], r: [0.088, 0.092], a: [-1.45, 1.45], l: [-0.25, -0.35], taper: 0.85, t: 0.012, nu: 12, nv: 2 }), 'upperarm_r', M_ARMOUR);
  // Forearm bracers with three fins on the outer edge.
  for (const s of [1, -1] as const) {
    const bone = s > 0 ? 'lowerarm_l' : 'lowerarm_r';
    add(band({ axis: 'x', c: [0, 1.456, -0.07], r: [0.053, 0.052], a: [-2.5, 2.5], l: [s * 0.5, s * 0.665], taper: 0.82, t: 0.01, nu: 16, nv: 3 }), bone, M_ARMOUR);
    for (let k = 0; k < 3; k++) {
      const fin = new THREE.BoxGeometry(0.03, 0.004, 0.022);
      fin.rotateZ(-s * 0.25);
      fin.translate(s * (0.535 + k * 0.04), 1.456 - 0.002, -0.07 - 0.055);
      add(fin, bone, M_ARMOUR);
    }
  }
  // Legs: thigh plates, knee caps and shin guards.
  add(band({ axis: 'y', c: [0.1, 0, -0.03], r: [0.09, 0.094], a: [-1.0, 1.15], l: [0.9, 0.62], taper: 0.88, bulge: 0.04, t: 0.012 }), 'thigh_l', M_ARMOUR);
  add(band({ axis: 'y', c: [0.113, 0, -0.022], r: [0.07, 0.078], a: [-1.0, 1.0], l: [0.6, 0.49], taper: 0.9, bulge: 0.12, t: 0.012, nv: 3 }), 'calf_l', M_ARMOUR);
  add(band({ axis: 'y', c: [0.114, 0, -0.036], r: [0.06, 0.07], a: [-1.1, 1.1], l: [0.47, 0.17], taper: 0.78, bulge: 0.05, t: 0.01 }), 'calf_l', M_ARMOUR);
  P.push(...P.filter((p) => p.bone === 'thigh_l' || p.bone === 'calf_l').map((p) => ({ geo: mirrorX(p.geo), bone: p.bone.replace('_l', '_r'), mat: p.mat })));
  // Emblem: a small silver crescent on the sternum.
  const em = crescent(0.03);
  em.translate(0, 1.372, 0.126);
  add(em, 'spine_03', M_SILVER);
  // Cowl / collar around the neck and trapezius.
  const cowl = shellSurface(
    (u, v) => {
      const a = (u - 0.5) * Math.PI * 2;
      const y = 1.575 - v * 0.115;
      const front = Math.max(0, Math.cos(a));
      const rx = 0.085 + v * v * 0.1;
      const rz = 0.088 + v * v * 0.07 - front * 0.012;
      return new THREE.Vector3(Math.sin(a) * rx, y - front * v * 0.035, -0.035 + Math.cos(a) * rz);
    },
    28,
    4,
    0.01,
    (p) => new THREE.Vector3(-p.x, 0, -0.035 - p.z).normalize(),
  );
  add(cowl, 'spine_03', M_FABRIC);
  // Hood: ellipsoid shell around the head with a face opening and a peaked brim.
  const HC = new THREE.Vector3(0, 1.705, -0.014);
  const hoodPt = (theta: number, phi: number) => {
    const brim = Math.exp(-theta * theta * 6) * Math.max(0, 1 - Math.abs(phi - 0.75) * 2.5) * 0.014;
    const lower = Math.max(0, phi - 2.0) * 0.06;
    return new THREE.Vector3(Math.sin(phi) * Math.sin(theta) * (0.12 + lower), HC.y + Math.cos(phi) * 0.138 + brim, HC.z + Math.sin(phi) * Math.cos(theta) * (0.133 + lower) + brim * 0.5);
  };
  const hoodIn = (p: THREE.Vector3) => HC.clone().sub(p).normalize();
  // Crown (full circle) and back/sides (skipping the face opening).
  add(shellSurface((u, v) => hoodPt((u - 0.5) * Math.PI * 2, 0.05 + v * 0.72), 28, 5, 0.012, hoodIn), 'Head', M_FABRIC);
  add(shellSurface((u, v) => hoodPt(0.92 + u * (Math.PI * 2 - 1.84), 0.75 + v * 1.65), 24, 8, 0.012, hoodIn), 'Head', M_FABRIC);
  // Half-mask: forehead, eyes, nose bridge and cheekbones; the jaw stays bare.
  const MC = new THREE.Vector3(0, 1.705, -0.006);
  const maskPt = (u: number, v: number) => {
    const th = -1.3 + u * 2.6;
    const yb = 1.668 + 0.012 * Math.abs(th) - Math.exp(-th * th * 30) * 0.008;
    const y = 1.768 + (yb - 1.768) * v;
    const s = Math.sqrt(Math.max(0.05, 1 - ((y - MC.y) / 0.118) ** 2));
    const nose = Math.exp(-th * th * 28) * 0.02 * THREE.MathUtils.smoothstep(v, 0.2, 1);
    return new THREE.Vector3(Math.sin(th) * 0.096 * s, y, MC.z + Math.cos(th) * 0.118 * s + nose);
  };
  add(shellSurface(maskPt, 20, 6, 0.006, (p) => MC.clone().sub(p).setY(0).normalize()), 'Head', M_MASK);
  // Visor lenses, laid on the mask surface over each eye.
  for (const side of [1, -1] as const) {
    const g = lens(side);
    const th = side * 0.36;
    const u = (th + 1.3) / 2.6;
    const v = (1.768 - 1.699) / (1.768 - 1.672);
    const p = maskPt(u, v);
    const n = p.clone().sub(MC).setY(0).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    g.applyQuaternion(q);
    g.translate(p.x + n.x * 0.0015, p.y, p.z + n.z * 0.0015);
    add(g, 'Head', M_VISOR);
  }
  return P;
}

const SUIT_GLSL_COMMON = /* glsl */ `
varying vec3 vBind;
uniform float uWet;
float suHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float suNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(suHash(i), suHash(i + vec2(1, 0)), u.x), mix(suHash(i + vec2(0, 1)), suHash(i + vec2(1, 1)), u.x), u.y); }
float suLine(float x, float w) { return 1.0 - smoothstep(0.0, w, abs(x)); }
`;

function bindVarying(shader: { vertexShader: string }): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
}

/** Re-shade the base body as the undersuit. Keeps the skin texture only for the bare jaw. */
function suitBodyMaterial(src: THREE.MeshStandardMaterial): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    map: src.map,
    normalMap: src.normalMap,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 0.78,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.42,
    sheenColor: new THREE.Color(0.2, 0.23, 0.26),
  });
  mat.name = 'nightwarden_suit';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = shared.wetness;
    bindVarying(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SUIT_GLSL_COMMON}\nfloat suFabric; float suGlove;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 b = vBind;
          float ax = abs(b.x);
          float skin = step(1.585, b.y) * step(b.y, 1.676) * step(0.0, b.z) * step(ax, 0.078);
          float glove = step(0.655, ax) * step(1.3, b.y);
          float boot = step(b.y, 0.3);
          vec3 suit = vec3(0.105, 0.115, 0.13) * (0.9 + 0.2 * suNoise(b.xy * 180.0));
          // Panel seams: torso front/back verticals, waist, sleeves and leg sides.
          float seam = 0.0;
          float torso = step(0.95, b.y) * step(b.y, 1.55) * step(ax, 0.2);
          seam += torso * suLine(ax - 0.088, 0.003);
          seam += torso * suLine(b.y - 1.02, 0.003);
          seam += step(0.2, ax) * step(ax, 0.66) * suLine(b.z + 0.07 + 0.045, 0.004);
          seam += step(b.y, 0.95) * suLine(abs(b.x) - 0.114 - 0.085, 0.004);
          // Quilted flanks and inner sleeves.
          vec2 qd = vec2(b.y * 40.0 + b.z * 40.0, b.y * 40.0 - b.z * 40.0);
          float quilt = torso * step(0.12, ax) * (suLine(fract(qd.x) - 0.5, 0.06) + suLine(fract(qd.y) - 0.5, 0.06));
          suit *= 1.0 - 0.35 * clamp(seam, 0.0, 1.0) - 0.18 * clamp(quilt, 0.0, 1.0);
          vec3 gloveC = vec3(0.045, 0.048, 0.054) * (0.85 + 0.3 * suNoise(b.xy * 300.0));
          vec3 bootC = vec3(0.05, 0.053, 0.06) * (0.8 + 0.4 * suNoise(b.xz * 90.0));
          bootC *= 1.0 - 0.5 * step(b.y, 0.025);
          vec3 c = mix(suit, gloveC, glove);
          c = mix(c, bootC, boot);
          // Bare jaw keeps the skin texture.
          c = mix(c, diffuseColor.rgb, skin);
          suFabric = 1.0 - skin;
          suGlove = max(glove, boot);
          c *= mix(1.0, 0.62, uWet * suFabric);
          diffuseColor.rgb = c;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, mix(0.8, 0.42, suGlove), suFabric);
        roughnessFactor = mix(roughnessFactor, 0.22, uWet * suFabric * 0.85);`,
      )
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, normalize(vNormal), suGlove * 0.6));')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= suFabric * (1.0 - 0.65 * uWet);\n#endif');
  };
  mat.customProgramCacheKey = () => 'nwSuitBody';
  return mat;
}

function armourMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.2, 0.215, 0.235), metalness: 0.35, roughness: 0.5, envMapIntensity: 0.55 });
  mat.name = 'nightwarden_armour';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = shared.wetness;
    bindVarying(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SUIT_GLSL_COMMON}\nfloat suScuff;`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 b = vBind * 60.0;
          // Scuffs: thin stretched scratches + mottled wear.
          float scratch = smoothstep(0.86, 0.97, suNoise(vec2(b.x * 0.4 + b.y * 3.0, b.z * 9.0 + b.y)));
          float wear = smoothstep(0.55, 0.8, suNoise(b.xz * 0.35 + b.y * 0.2));
          suScuff = clamp(scratch * 0.8 + wear * 0.35, 0.0, 1.0);
          diffuseColor.rgb *= 0.85 + 0.25 * suNoise(b.xy * 0.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.32, 0.33, 0.35), suScuff * 0.55);
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.28, suScuff * 0.6);
        roughnessFactor = mix(roughnessFactor, 0.12, uWet * 0.8);`,
      );
  };
  mat.customProgramCacheKey = () => 'nwArmour';
  return mat;
}

/** Storm-grey woven fabric (hood, cowl and the cape) with sheen; wet = darker and glossy. */
export function stormFabricMaterial(extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void, key = 'nwFabric'): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0.125, 0.13, 0.14),
    roughness: 0.88,
    metalness: 0,
    sheen: 1,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0.16, 0.18, 0.2),
    envMapIntensity: 0.7,
    side: THREE.DoubleSide,
  });
  mat.name = 'nightwarden_fabric';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = shared.wetness;
    if (!shader.vertexShader.includes('varying vec3 vBind;')) bindVarying(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SUIT_GLSL_COMMON}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 b = vBind * 400.0;
          float weave = 0.5 + 0.5 * sin(b.x + b.z) * sin(b.y * 1.1);
          diffuseColor.rgb *= 0.88 + 0.16 * weave + 0.12 * (suNoise(vBind.xy * 30.0 + vBind.z * 11.0) - 0.5);
          diffuseColor.rgb *= mix(1.0, 0.55, uWet);
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.26, uWet * 0.9);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= 1.0 - 0.7 * uWet;\n#endif');
    extra?.(shader);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export class HeroSuit {
  readonly mesh: THREE.SkinnedMesh;
  private body: THREE.SkinnedMesh;
  private civilianMat: THREE.Material;
  private suitMat: THREE.MeshPhysicalMaterial;
  private hair: THREE.Object3D | null;
  readonly visorMat: THREE.MeshStandardMaterial;
  private on = false;

  constructor(body: THREE.SkinnedMesh, hair: THREE.Object3D | null) {
    this.body = body;
    this.hair = hair;
    this.civilianMat = body.material as THREE.Material;
    this.suitMat = suitBodyMaterial(body.material as THREE.MeshStandardMaterial);
    const bones = body.skeleton.bones;
    const pieces = buildPieces();
    const geos: THREE.BufferGeometry[] = [];
    // Group by material so the merged mesh has one draw per material.
    for (let m = 0; m <= M_VISOR; m++) {
      const list = pieces.filter((p) => p.mat === m);
      const parts = list.map((p) => {
        const g = p.geo;
        const bi = Math.max(0, bones.findIndex((b) => b.name === p.bone));
        const n = g.getAttribute('position').count;
        const si = new Uint16Array(n * 4);
        const sw = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          si[i * 4] = bi;
          sw[i * 4] = 1;
        }
        const out = new THREE.BufferGeometry();
        out.setAttribute('position', g.getAttribute('position'));
        out.setAttribute('normal', g.getAttribute('normal'));
        out.setAttribute('uv', g.getAttribute('uv') ?? new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
        out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
        out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
        out.setIndex(g.getIndex() ?? Array.from({ length: n }, (_, i) => i));
        return out;
      });
      geos.push(mergeGeometries(parts, false)!);
    }
    const merged = mergeGeometries(geos, true)!;
    const visor = new THREE.MeshStandardMaterial({ color: 0x0a1418, emissive: new THREE.Color(0.55, 0.82, 1.0), emissiveIntensity: 3.2, roughness: 0.15, metalness: 0.2 });
    visor.name = 'nightwarden_visor';
    this.visorMat = visor;
    const mats: THREE.Material[] = [];
    mats[M_ARMOUR] = armourMaterial();
    mats[M_FABRIC] = stormFabricMaterial();
    mats[M_MASK] = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.06, 0.064, 0.07), roughness: 0.55, metalness: 0.15 });
    mats[M_SILVER] = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.82, 0.84, 0.88), roughness: 0.22, metalness: 1 });
    mats[M_VISOR] = visor;
    this.mesh = new THREE.SkinnedMesh(merged, mats);
    this.mesh.name = 'HeroArmour';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.position.copy(body.position);
    this.mesh.quaternion.copy(body.quaternion);
    this.mesh.scale.copy(body.scale);
    body.parent!.add(this.mesh);
    this.mesh.bind(body.skeleton, body.bindMatrix);
    this.mesh.visible = false;
  }

  get active(): boolean {
    return this.on;
  }

  set(on: boolean): void {
    this.on = on;
    this.mesh.visible = on;
    this.body.material = on ? this.suitMat : this.civilianMat;
    if (this.hair) this.hair.visible = !on;
  }

  /** Visor glow pulses gently; brighter at night. */
  update(time: number, night: number): void {
    this.visorMat.emissiveIntensity = (1.6 + night * 2.2) * (0.92 + 0.08 * Math.sin(time * 2.1));
  }
}
