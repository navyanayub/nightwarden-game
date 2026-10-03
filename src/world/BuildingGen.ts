/**
 * Building geometry from BuildingSpecs.
 *  - buildDetail: full facade geometry (recessed windows with interior-mapped glass, sills,
 *    lintels, cornices, shopfronts, awnings, fire escapes, curtain walls, rooftop clutter).
 *  - buildFar: impostor box with the procedural far-facade shader.
 * All coordinates are local to the building (origin = footprint centre at baseY).
 */
import * as THREE from 'three';
import { Rng, hashN } from '../core/Random';
import type { MeshBuilder, V2, V3 } from './MeshBuilder';
import type { BuildingSpec, PropSpec, Side } from './CityLayout';
import { BRANDS, signs } from './Signage';

interface Frame {
  side: Side;
  ox: number;
  oz: number;
  tx: number;
  tz: number;
  nx: number;
  nz: number;
  len: number;
}

/** Facade frames for a w x d footprint centred at the origin (order: s, e, n, w). */
function frames(w: number, d: number): Frame[] {
  const hw = w / 2;
  const hd = d / 2;
  return [
    { side: 's', ox: -hw, oz: hd, tx: 1, tz: 0, nx: 0, nz: 1, len: w },
    { side: 'e', ox: hw, oz: hd, tx: 0, tz: -1, nx: 1, nz: 0, len: d },
    { side: 'n', ox: hw, oz: -hd, tx: -1, tz: 0, nx: 0, nz: -1, len: w },
    { side: 'w', ox: -hw, oz: -hd, tx: 0, tz: 1, nx: -1, nz: 0, len: d },
  ];
}

/** Facade-space point -> local 3D (u along facade, v up, o outward offset). */
const P = (f: Frame, u: number, v: number, o = 0): V3 => [f.ox + f.tx * u + f.nx * o, v, f.oz + f.tz * u + f.nz * o];

const footprintLoop = (w: number, d: number, inset = 0): V2[] => {
  const hw = w / 2 - inset;
  const hd = d / 2 - inset;
  return [
    [-hw, hd],
    [hw, hd],
    [hw, -hd],
    [-hw, -hd],
  ];
};

type OpeningKind = 'window' | 'shop' | 'door' | 'garage' | 'louver' | 'curtain';
interface Opening {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  kind: OpeningKind;
  depth: number;
  glass?: string;
  style?: number;
  frame?: string;
  sill?: string;
  lintel?: string;
  mullion?: boolean;
  color?: THREE.Color;
}

const tmpCol = new THREE.Color();
const white = new THREE.Color(1, 1, 1);

/** Wall with rectangular openings for one row (floor band) of one facade. */
function wallRow(mb: MeshBuilder, f: Frame, key: string, v0: number, v1: number, ops: Opening[], color: THREE.Color): void {
  const sorted = [...ops].sort((a, b) => a.u0 - b.u0);
  let u = 0;
  const q = (ua: number, ub: number, va: number, vb: number) => {
    if (ub - ua < 1e-3 || vb - va < 1e-3) return;
    mb.quad(key, P(f, ua, va), P(f, ub, va), P(f, ub, vb), P(f, ua, vb), { color, uvs: [[ua, va], [ub, va], [ub, vb], [ua, vb]] });
  };
  for (const o of sorted) {
    q(u, o.u0, v0, v1);
    q(o.u0, o.u1, v0, o.v0);
    q(o.u0, o.u1, o.v1, v1);
    u = o.u1;
  }
  q(u, f.len, v0, v1);
}

/** Reveal (recess sides) and contents for an opening. */
function opening(mb: MeshBuilder, f: Frame, o: Opening, wallKey: string, color: THREE.Color, seed: number): void {
  const dpt = o.depth;
  const { u0, u1, v0, v1 } = o;
  // Reveals: left, right, top, bottom — facing into the opening.
  mb.quad(wallKey, P(f, u0, v0, 0), P(f, u0, v0, -dpt), P(f, u0, v1, -dpt), P(f, u0, v1, 0), { color, uvs: [[0, v0], [dpt, v0], [dpt, v1], [0, v1]] });
  mb.quad(wallKey, P(f, u1, v0, -dpt), P(f, u1, v0, 0), P(f, u1, v1, 0), P(f, u1, v1, -dpt), { color, uvs: [[0, v0], [dpt, v0], [dpt, v1], [0, v1]] });
  mb.quad(wallKey, P(f, u0, v1, 0), P(f, u0, v1, -dpt), P(f, u1, v1, -dpt), P(f, u1, v1, 0), { color, uvs: [[u0, 0], [u0, dpt], [u1, dpt], [u1, 0]] });
  mb.quad(o.sill ? o.sill : wallKey, P(f, u1, v0, 0), P(f, u1, v0, -dpt), P(f, u0, v0, -dpt), P(f, u0, v0, 0), { color: o.sill ? white : color, uvs: [[u1, 0], [u1, dpt], [u0, dpt], [u0, 0]] });
  const w = u1 - u0;
  const h = v1 - v0;
  const back = -dpt;
  if (o.kind === 'window' || o.kind === 'shop' || o.kind === 'curtain') {
    const glassKey = o.glass ?? 'glass_window';
    const win: [number, number, number, number] = [(seed % 9973) + 0.5, w, h, o.style ?? 0];
    mb.quad(glassKey, P(f, u0, v0, back), P(f, u1, v0, back), P(f, u1, v1, back), P(f, u0, v1, back), {
      uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
      win,
    });
    if (o.frame) {
      const fr = o.frame;
      const t = o.kind === 'shop' ? 0.09 : 0.06;
      const fo = back + 0.06;
      const fc = o.color ?? white;
      // Frame border (shops / large openings only; small windows read fine with the reveal).
      if (o.kind === 'shop' || w > 2.5) {
        boxF(mb, fr, f, u0, u0 + t, v0, v1, back, fo, fc);
        boxF(mb, fr, f, u1 - t, u1, v0, v1, back, fo, fc);
        boxF(mb, fr, f, u0 + t, u1 - t, v1 - t, v1, back, fo, fc);
        boxF(mb, fr, f, u0 + t, u1 - t, v0, v0 + t, back, fo, fc);
      }
      if (o.mullion) {
        const mu = (u0 + u1) / 2;
        boxF(mb, fr, f, mu - t / 2, mu + t / 2, v0, v1, back, fo, fc);
        const mv = v0 + h * 0.68;
        boxF(mb, fr, f, u0, u1, mv - t / 2, mv + t / 2, back, fo, fc);
      }
      if (o.kind === 'shop') {
        const n = Math.max(1, Math.round(w / 2.2));
        for (let i = 1; i < n; i++) {
          const mu = u0 + (w / n) * i;
          boxF(mb, fr, f, mu - t / 2, mu + t / 2, v0, v1, back, fo, fc);
        }
      }
    }
  } else if (o.kind === 'door') {
    mb.quad('paint', P(f, u0, v0, back), P(f, u1, v0, back), P(f, u1, v1, back), P(f, u0, v1, back), { color: o.color ?? tmpCol.setRGB(0.25, 0.14, 0.08) });
    // Panel mouldings and handle.
    boxF(mb, 'paint', f, u0 + 0.12, u1 - 0.12, v0 + h * 0.55, v0 + h * 0.58, back, back + 0.03, o.color ?? white);
    boxF(mb, 'aluminium', f, u1 - 0.22, u1 - 0.15, v0 + h * 0.45, v0 + h * 0.5, back, back + 0.06, white);
  } else if (o.kind === 'garage') {
    mb.quad('shutter', P(f, u0, v0, back), P(f, u1, v0, back), P(f, u1, v1, back), P(f, u0, v1, back), { color: o.color ?? white, uvs: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]] });
  } else if (o.kind === 'louver') {
    mb.quad('steel_dark', P(f, u0, v0, back), P(f, u1, v0, back), P(f, u1, v1, back), P(f, u0, v1, back), { color: white });
    const n = Math.floor(h / 0.3);
    for (let i = 0; i < n; i++) {
      const vv = v0 + (i + 0.5) * (h / n);
      boxF(mb, 'steel_dark', f, u0, u1, vv - 0.03, vv + 0.03, back, back + 0.12, white);
    }
  }
}

/** Facade-aligned box (u0..u1, v0..v1, o0..o1 outward). */
function boxF(mb: MeshBuilder, key: string, f: Frame, u0: number, u1: number, v0: number, v1: number, o0: number, o1: number, color: THREE.Color = white, skipBack = true): void {
  const yaw = Math.atan2(-f.tz, f.tx);
  const cu = (u0 + u1) / 2;
  const co = (o0 + o1) / 2;
  const c = P(f, cu, 0, co);
  mb.pushTRS(c[0], 0, c[2], yaw);
  // In this local frame +x = facade tangent, +z = outward normal.
  mb.box(key, -(u1 - u0) / 2, v0, -(o1 - o0) / 2, (u1 - u0) / 2, v1, (o1 - o0) / 2, { color, skip: skipBack ? ['nz'] : [] });
  mb.popTransform();
}

// ------------------------------------------------------------------ public API

export interface BuildResult {
  props: PropSpec[];
}

export function buildDetail(mb: MeshBuilder, s: BuildingSpec): BuildResult {
  const it = buildDetailSteps(mb, s);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** Incremental variant: yields between facade sides of large towers so streaming stays smooth. */
export function* buildDetailSteps(mb: MeshBuilder, s: BuildingSpec): Generator<void, BuildResult> {
  const res: BuildResult = { props: [] };
  mb.pushTRS(s.cx, s.baseY, s.cz, 0);
  const rng = new Rng(s.seed);
  const tint = new THREE.Color(s.tint[0], s.tint[1], s.tint[2]);
  // Plinth hides any gap where the ground slopes.
  mb.box(s.style === 'house' ? 'stone' : 'concrete', -s.w / 2 - 0.05, -2.2, -s.d / 2 - 0.05, s.w / 2 + 0.05, 0.35, s.d / 2 + 0.05, { color: white, skip: ['py', 'ny'] });
  switch (s.style) {
    case 'brick':
    case 'stone':
    case 'plaster':
      oldTown(mb, s, rng, tint, res);
      break;
    case 'office':
      yield* office(mb, s, rng, tint, res);
      break;
    case 'glass':
      yield* glassTower(mb, s, rng, res);
      break;
    case 'warehouse':
      warehouse(mb, s, rng, tint);
      break;
    case 'factory':
      factory(mb, s, rng);
      break;
    case 'house':
      house(mb, s, rng, tint);
      break;
    default:
      mb.box(s.wall, -s.w / 2, 0, -s.d / 2, s.w / 2, s.height, s.d / 2, { color: tint });
  }
  mb.popTransform();
  // Convert local roof props to world.
  for (const p of res.props) {
    p.x += s.cx;
    p.z += s.cz;
    p.y += s.baseY;
  }
  return res;
}

// ------------------------------------------------------------------ Old Town

function oldTown(mb: MeshBuilder, s: BuildingSpec, rng: Rng, tint: THREE.Color, res: BuildResult): void {
  const fr = frames(s.w, s.d);
  const gh = s.floorH * 1.18;
  const H = gh + (s.floors - 1) * s.floorH;
  const wall = s.wall;
  const trim = s.trim;
  const bay = rng.range(2.8, 3.5);
  const winW = rng.range(1.15, 1.45);
  const winH = s.floorH * rng.range(0.5, 0.58);
  const sillH = 0.95;
  const plasterShutters = s.style === 'plaster' && rng.chance(0.45);
  const shutterCol = new THREE.Color().setHSL(rng.pick([0.33, 0.55, 0.6, 0.08]), 0.35, 0.3);
  const fireEscape = s.style === 'brick' && s.floors >= 4 && rng.chance(0.35);
  const brand = rng.int(0, BRANDS.length - 1);
  const stoneBase = s.style === 'brick' && rng.chance(0.45);
  const groundWall = stoneBase ? 'stone' : wall;
  const groundTint = stoneBase ? white : tint;
  for (const f of fr) {
    const party = s.party.includes(f.side);
    const isFront = f.side === s.front;
    const n = Math.max(1, Math.round((f.len - 1.2) / bay));
    const margin = (f.len - n * bay) / 2;
    // Ground floor.
    const gOps: Opening[] = [];
    if (!party) {
      if (isFront && s.shop && f.len > 6) {
        const doorW = 1.3;
        const sx0 = 0.7;
        const sx1 = f.len - 0.7;
        const doorU = sx0 + (sx1 - sx0) * rng.range(0.15, 0.85);
        gOps.push({ u0: sx0, u1: doorU - doorW / 2 - 0.15, v0: 0.55, v1: gh - 1.25, kind: 'shop', depth: 0.25, glass: 'glass_shop', style: 2, frame: 'paint', color: shutterCol, sill: trim });
        gOps.push({ u0: doorU - doorW / 2, u1: doorU + doorW / 2, v0: 0.05, v1: gh - 1.25, kind: 'door', depth: 0.3, color: new THREE.Color(0.12, 0.12, 0.13) });
        gOps.push({ u0: doorU + doorW / 2 + 0.15, u1: sx1, v0: 0.55, v1: gh - 1.25, kind: 'shop', depth: 0.25, glass: 'glass_shop', style: 2, frame: 'paint', color: shutterCol, sill: trim });
        // Sign fascia with brand.
        const uv = signs().brandUV(brand);
        const fv0 = gh - 1.15;
        const fv1 = gh - 0.35;
        const su0 = sx0 + 0.2;
        const su1 = sx1 - 0.2;
        boxF(mb, 'paint_dark', f, su0 - 0.1, su1 + 0.1, fv0 - 0.08, fv1 + 0.08, 0, 0.12);
        const o = 0.125;
        mb.quad('signs', P(f, su0, fv0, o), P(f, su1, fv0, o), P(f, su1, fv1, o), P(f, su0, fv1, o), { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
        if (rng.chance(0.55)) awning(mb, f, sx0, sx1, gh - 1.3, rng);
      } else {
        // Door + windows at street level.
        const doorBay = isFront ? rng.int(0, n - 1) : -1;
        for (let i = 0; i < n; i++) {
          const cu = margin + bay * (i + 0.5);
          if (i === doorBay) gOps.push({ u0: cu - 0.65, u1: cu + 0.65, v0: 0.05, v1: 2.6, kind: 'door', depth: 0.3, color: new THREE.Color().setHSL(rng.next(), 0.4, 0.22) });
          else gOps.push({ u0: cu - winW / 2, u1: cu + winW / 2, v0: sillH, v1: Math.min(gh - 0.6, sillH + winH * 1.1), kind: 'window', depth: 0.22, glass: 'glass_window', style: 1, frame: 'paint_white', mullion: true, sill: trim });
        }
      }
    }
    wallRow(mb, f, groundWall, 0, gh, gOps, groundTint);
    gOps.forEach((o, k) => opening(mb, f, o, groundWall, groundTint, hashN(s.seed, k, 0, fr.indexOf(f))));
    // Upper floors.
    for (let fl = 1; fl < s.floors; fl++) {
      const v0 = gh + (fl - 1) * s.floorH;
      const v1 = v0 + s.floorH;
      const ops: Opening[] = [];
      if (!party) {
        for (let i = 0; i < n; i++) {
          const cu = margin + bay * (i + 0.5);
          ops.push({ u0: cu - winW / 2, u1: cu + winW / 2, v0: v0 + sillH, v1: v0 + sillH + winH, kind: 'window', depth: 0.22, glass: 'glass_window', style: 1, frame: 'paint_white', mullion: true, sill: trim });
        }
      }
      wallRow(mb, f, wall, v0, v1, ops, tint);
      ops.forEach((o, k) => {
        opening(mb, f, o, wall, tint, hashN(s.seed, k, fl, fr.indexOf(f)));
        // Sill and lintel.
        boxF(mb, trim, f, o.u0 - 0.12, o.u1 + 0.12, o.v0 - 0.12, o.v0, 0, 0.12);
        if (s.style !== 'plaster' || fl % 2 === 0) boxF(mb, trim, f, o.u0 - 0.1, o.u1 + 0.1, o.v1, o.v1 + 0.22, 0, 0.06);
        if (plasterShutters) {
          boxF(mb, 'paint', f, o.u0 - 0.62, o.u0 - 0.04, o.v0, o.v1, 0, 0.05, shutterCol);
          boxF(mb, 'paint', f, o.u1 + 0.04, o.u1 + 0.62, o.v0, o.v1, 0, 0.05, shutterCol);
        }
      });
    }
    if (fireEscape && isFront && !party && n >= 3) fireEscapeOn(mb, f, margin + bay * Math.floor(n / 2 - 0.5), bay * 2, gh, s.floorH, s.floors);
  }
  // String course above ground floor and cornice.
  const loop = footprintLoop(s.w, s.d);
  mb.extrude(trim, loop, true, [[0, gh - 0.1], [0.12, gh - 0.1], [0.12, gh + 0.18], [0, gh + 0.18]]);
  const cornice: V2[] = [
    [0, H - 0.1],
    [0.1, H - 0.1],
    [0.1, H + 0.05],
    [0.22, H + 0.18],
    [0.4, H + 0.3],
    [0.45, H + 0.45],
    [0.45, H + 0.62],
    [0, H + 0.62],
  ];
  mb.extrude(trim, loop, true, cornice);
  if (s.roof === 'gable') {
    gableRoof(mb, s.w + 0.7, s.d + 0.7, H + 0.62, s.front === 'n' || s.front === 's' ? 'x' : 'z', Math.min(s.w, s.d) * 0.32, 'roof_slate', wall, tint, s.w, s.d);
    // Chimneys on the gable ends.
    const ridgeX = s.front === 'n' || s.front === 's';
    for (const e of [-1, 1]) {
      if (rng.chance(0.7)) {
        const cx = ridgeX ? e * (s.w / 2 - 0.6) : rng.range(-0.5, 0.5);
        const cz = ridgeX ? rng.range(-0.5, 0.5) : e * (s.d / 2 - 0.6);
        mb.box(s.style === 'brick' ? wall : 'brick_brown', cx - 0.45, H, cz - 0.35, cx + 0.45, H + Math.min(s.w, s.d) * 0.32 + 1.2, cz + 0.35, { color: tint });
        mb.box(trim, cx - 0.55, H + Math.min(s.w, s.d) * 0.32 + 1.2, cz - 0.45, cx + 0.55, H + Math.min(s.w, s.d) * 0.32 + 1.4, cz + 0.45);
      }
    }
  } else {
    // Parapet + flat roof.
    const pTop = H + 1.3;
    mb.extrude(wall, footprintLoop(s.w, s.d, 0.05), true, [[0, H + 0.62], [0, pTop]], { color: tint });
    mb.extrude(wall, footprintLoop(s.w, s.d, 0.32), true, [[0, pTop], [0, H + 0.62]], { color: tint });
    mb.extrude(trim, footprintLoop(s.w, s.d, 0.0), true, [[0.04, pTop], [0.04, pTop + 0.12], [-0.34, pTop + 0.12], [-0.34, pTop]]);
    mb.box('roof_flat', -s.w / 2 + 0.3, H + 0.6, -s.d / 2 + 0.3, s.w / 2 - 0.3, H + 0.7, s.d / 2 - 0.3, { skip: ['px', 'nx', 'pz', 'nz', 'ny'] });
    roofClutter(mb, s, rng, H + 0.7, res, s.floors >= 4 && rng.chance(0.4));
  }
}

function awning(mb: MeshBuilder, f: Frame, u0: number, u1: number, v: number, rng: Rng): void {
  const col = new THREE.Color().setHSL(rng.pick([0.0, 0.33, 0.58, 0.08, 0.95]), rng.range(0.4, 0.7), rng.range(0.25, 0.4));
  const out = 1.5;
  const drop = 0.7;
  mb.quad('fabric', P(f, u0, v + 0.5, 0.05), P(f, u0, v + 0.5 - drop, out), P(f, u1, v + 0.5 - drop, out), P(f, u1, v + 0.5, 0.05), { color: col });
  // Back face so it reads from below.
  mb.quad('fabric', P(f, u1, v + 0.5, 0.05), P(f, u1, v + 0.5 - drop, out), P(f, u0, v + 0.5 - drop, out), P(f, u0, v + 0.5, 0.05), { color: col.clone().multiplyScalar(0.6) });
  // Valance.
  mb.quad('fabric', P(f, u0, v + 0.5 - drop - 0.28, out), P(f, u1, v + 0.5 - drop - 0.28, out), P(f, u1, v + 0.5 - drop, out), P(f, u0, v + 0.5 - drop, out), { color: col });
  for (const u of [u0 + 0.05, u1 - 0.05]) {
    mb.beam('paint_dark', P(f, u, v + 0.45, 0.05), P(f, u, v + 0.5 - drop, out), 0.04);
  }
}

function fireEscapeOn(mb: MeshBuilder, f: Frame, u0: number, width: number, gh: number, floorH: number, floors: number): void {
  const depth = 1.25;
  const key = 'paint_dark';
  for (let fl = 1; fl < floors; fl++) {
    const v = gh + (fl - 1) * floorH + 0.05;
    // Platform slab + railings.
    boxF(mb, key, f, u0, u0 + width, v - 0.08, v, 0.05, depth, white);
    boxF(mb, key, f, u0, u0 + width, v + 1.0, v + 1.05, depth - 0.04, depth, white);
    boxF(mb, key, f, u0, u0 + width, v + 0.5, v + 0.53, depth - 0.04, depth, white);
    for (let k = 0; k <= Math.round(width / 0.9); k++) {
      const u = u0 + Math.min(width - 0.04, k * 0.9);
      boxF(mb, key, f, u, u + 0.04, v, v + 1.05, depth - 0.04, depth, white);
    }
    boxF(mb, key, f, u0, u0 + 0.04, v, v + 1.05, 0.05, depth, white);
    boxF(mb, key, f, u0 + width - 0.04, u0 + width, v, v + 1.05, 0.05, depth, white);
    // Stair to the floor above.
    if (fl < floors - 1) {
      const a = P(f, u0 + 0.3, v, depth * 0.55);
      const b = P(f, u0 + width - 0.4, v + floorH, depth * 0.55);
      mb.beam(key, [a[0] + f.nx * -0.3, a[1], a[2] + f.nz * -0.3], [b[0] + f.nx * -0.3, b[1], b[2] + f.nz * -0.3], 0.06, { height: 0.18 });
      mb.beam(key, [a[0] + f.nx * 0.3, a[1], a[2] + f.nz * 0.3], [b[0] + f.nx * 0.3, b[1], b[2] + f.nz * 0.3], 0.06, { height: 0.18 });
      const steps = Math.round(floorH / 0.25);
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const u = u0 + 0.3 + (width - 0.7) * t;
        boxF(mb, key, f, u - 0.12, u + 0.12, v + floorH * t - 0.03, v + floorH * t, depth * 0.55 - 0.3, depth * 0.55 + 0.3, white);
      }
    }
  }
  // Drop ladder.
  const v1 = gh + 0.05;
  for (const du of [0.25, 0.65]) boxF(mb, key, f, u0 + width - 1 + du, u0 + width - 1 + du + 0.04, v1 - 2.6, v1, depth - 0.3, depth - 0.26, white);
  for (let k = 0; k < 8; k++) boxF(mb, key, f, u0 + width - 0.75, u0 + width - 0.31, v1 - 2.5 + k * 0.32, v1 - 2.47 + k * 0.32, depth - 0.3, depth - 0.27, white);
}

/** Gable roof over a w x d rectangle; ridge along 'x' or 'z'. Gable-end triangles use wallKey. */
function gableRoof(mb: MeshBuilder, w: number, d: number, y: number, ridge: 'x' | 'z', rise: number, roofKey: string, wallKey: string, tint: THREE.Color, wallW: number, wallD: number): void {
  const hw = w / 2;
  const hd = d / 2;
  if (ridge === 'x') {
    mb.quad(roofKey, [-hw, y, hd], [hw, y, hd], [hw, y + rise, 0], [-hw, y + rise, 0], { uvs: [[-hw, 0], [hw, 0], [hw, Math.hypot(hd, rise)], [-hw, Math.hypot(hd, rise)]] });
    mb.quad(roofKey, [hw, y, -hd], [-hw, y, -hd], [-hw, y + rise, 0], [hw, y + rise, 0], { uvs: [[-hw, 0], [hw, 0], [hw, Math.hypot(hd, rise)], [-hw, Math.hypot(hd, rise)]] });
    // Underside of eaves.
    mb.quad('paint_white', [hw, y, hd], [-hw, y, hd], [-hw, y - 0.01, wallD / 2], [hw, y - 0.01, wallD / 2], {});
    mb.quad('paint_white', [-hw, y, -hd], [hw, y, -hd], [hw, y - 0.01, -wallD / 2], [-hw, y - 0.01, -wallD / 2], {});
    const ex = wallW / 2;
    const ed = wallD / 2;
    mb.quad(wallKey, [ex, y, ed], [ex, y, -ed], [ex, y + rise * (ed / hd), 0], [ex, y + rise * (ed / hd), 0], { color: tint, uvs: [[0, y], [2 * ed, y], [ed, y + rise], [ed, y + rise]] });
    mb.quad(wallKey, [-ex, y, -ed], [-ex, y, ed], [-ex, y + rise * (ed / hd), 0], [-ex, y + rise * (ed / hd), 0], { color: tint, uvs: [[0, y], [2 * ed, y], [ed, y + rise], [ed, y + rise]] });
    mb.box('roof_flat', -hw, y + rise - 0.08, -0.15, hw, y + rise + 0.12, 0.15);
  } else {
    mb.quad(roofKey, [hw, y, hd], [hw, y, -hd], [0, y + rise, -hd], [0, y + rise, hd], { uvs: [[-hd, 0], [hd, 0], [hd, Math.hypot(hw, rise)], [-hd, Math.hypot(hw, rise)]] });
    mb.quad(roofKey, [-hw, y, -hd], [-hw, y, hd], [0, y + rise, hd], [0, y + rise, -hd], { uvs: [[-hd, 0], [hd, 0], [hd, Math.hypot(hw, rise)], [-hd, Math.hypot(hw, rise)]] });
    mb.quad('paint_white', [hw, y, -hd], [hw, y, hd], [wallW / 2, y - 0.01, hd], [wallW / 2, y - 0.01, -hd], {});
    mb.quad('paint_white', [-hw, y, hd], [-hw, y, -hd], [-wallW / 2, y - 0.01, -hd], [-wallW / 2, y - 0.01, hd], {});
    const ex = wallW / 2;
    const ed = wallD / 2;
    mb.quad(wallKey, [-ex, y, ed], [ex, y, ed], [0, y + rise * (ex / hw), ed], [0, y + rise * (ex / hw), ed], { color: tint, uvs: [[0, y], [2 * ex, y], [ex, y + rise], [ex, y + rise]] });
    mb.quad(wallKey, [ex, y, -ed], [-ex, y, -ed], [0, y + rise * (ex / hw), -ed], [0, y + rise * (ex / hw), -ed], { color: tint, uvs: [[0, y], [2 * ex, y], [ex, y + rise], [ex, y + rise]] });
    mb.box('roof_flat', -0.15, y + rise - 0.08, -hd, 0.15, y + rise + 0.12, hd);
  }
}

function hipRoof(mb: MeshBuilder, w: number, d: number, y: number, rise: number, key: string): void {
  const hw = w / 2;
  const hd = d / 2;
  const r = Math.min(hw, hd);
  const along = hw >= hd;
  const rx = along ? hw - r : 0;
  const rz = along ? 0 : hd - r;
  const top: V3[] = along
    ? [
        [-rx, y + rise, 0],
        [rx, y + rise, 0],
      ]
    : [
        [0, y + rise, -rz],
        [0, y + rise, rz],
      ];
  const sl = Math.hypot(r, rise);
  if (along) {
    mb.quad(key, [-hw, y, hd], [hw, y, hd], top[1], top[0], { uvs: [[-hw, 0], [hw, 0], [rx, sl], [-rx, sl]] });
    mb.quad(key, [hw, y, -hd], [-hw, y, -hd], top[0], top[1], { uvs: [[-hw, 0], [hw, 0], [rx, sl], [-rx, sl]] });
    mb.quad(key, [hw, y, hd], [hw, y, -hd], top[1], top[1], { uvs: [[-hd, 0], [hd, 0], [0, sl], [0, sl]] });
    mb.quad(key, [-hw, y, -hd], [-hw, y, hd], top[0], top[0], { uvs: [[-hd, 0], [hd, 0], [0, sl], [0, sl]] });
  } else {
    mb.quad(key, [hw, y, hd], [hw, y, -hd], top[0], top[1], { uvs: [[-hd, 0], [hd, 0], [rz, sl], [-rz, sl]] });
    mb.quad(key, [-hw, y, -hd], [-hw, y, hd], top[1], top[0], { uvs: [[-hd, 0], [hd, 0], [rz, sl], [-rz, sl]] });
    mb.quad(key, [-hw, y, hd], [hw, y, hd], top[1], top[1], { uvs: [[-hw, 0], [hw, 0], [0, sl], [0, sl]] });
    mb.quad(key, [hw, y, -hd], [-hw, y, -hd], top[0], top[0], { uvs: [[-hw, 0], [hw, 0], [0, sl], [0, sl]] });
  }
}

/** Water tanks, hatches, vents, AC units and antennas on flat roofs. */
function roofClutter(mb: MeshBuilder, s: { w: number; d: number; seed: number }, rng: Rng, y: number, res: BuildResult, waterTank: boolean, w = s.w, d = s.d, ox = 0, oz = 0): void {
  const hw = w / 2 - 1.5;
  const hd = d / 2 - 1.5;
  if (hw < 1 || hd < 1) return;
  // Stair/lift housing.
  const bx = ox + rng.range(-hw * 0.5, hw * 0.5);
  const bz = oz + rng.range(-hd * 0.5, hd * 0.5);
  mb.box('concrete', bx - 1.6, y, bz - 1.4, bx + 1.6, y + 2.6, bz + 1.4);
  mb.box('roof_flat', bx - 1.75, y + 2.6, bz - 1.55, bx + 1.75, y + 2.8, bz + 1.55);
  // Vent stacks.
  for (let i = 0; i < 3; i++) mb.cylinder('steel_light', ox + rng.range(-hw, hw), y, oz + rng.range(-hd, hd), 0.18, 0.18, rng.range(0.8, 1.6), 8, { capTop: true });
  // AC units as instanced props.
  const nAc = Math.min(6, Math.floor((w * d) / 120) + 1);
  for (let i = 0; i < nAc; i++) {
    const px = ox + rng.range(-hw + 0.8, hw - 0.8);
    const pz = oz + rng.range(-hd + 0.8, hd - 0.8);
    if (Math.abs(px - bx) < 2.6 && Math.abs(pz - bz) < 2.4) continue;
    res.props.push({ type: 'aircon', x: px, z: pz, y, yaw: rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) });
  }
  if (waterTank) waterTankAt(mb, ox + rng.range(-hw * 0.6, hw * 0.6), oz + rng.range(-hd * 0.6, hd * 0.6), y, rng);
}

function waterTankAt(mb: MeshBuilder, x: number, z: number, y: number, rng: Rng): void {
  const r = rng.range(1.4, 2.0);
  const legH = rng.range(2.2, 3.2);
  const h = r * 1.9;
  for (const [lx, lz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    mb.box('paint_dark', x + lx * r * 0.65 - 0.08, y, z + lz * r * 0.65 - 0.08, x + lx * r * 0.65 + 0.08, y + legH, z + lz * r * 0.65 + 0.08);
  }
  mb.beam('paint_dark', [x - r * 0.65, y + 0.4, z - r * 0.65], [x + r * 0.65, y + legH - 0.2, z + r * 0.65], 0.06);
  mb.beam('paint_dark', [x + r * 0.65, y + 0.4, z - r * 0.65], [x - r * 0.65, y + legH - 0.2, z + r * 0.65], 0.06);
  mb.box('wood', x - r - 0.1, y + legH - 0.15, z - r - 0.1, x + r + 0.1, y + legH, z + r + 0.1);
  mb.lathe('wood', x, z, [[r, y + legH], [r * 1.02, y + legH + h * 0.5], [r, y + legH + h]], 16, { color: new THREE.Color(0.75, 0.65, 0.55) });
  for (const t of [0.2, 0.5, 0.8]) mb.lathe('paint_dark', x, z, [[r * 1.03, y + legH + h * t - 0.05], [r * 1.03, y + legH + h * t + 0.05]], 16);
  mb.lathe('roof_slate', x, z, [[r * 1.08, y + legH + h], [0.15, y + legH + h + r * 0.7], [0.0, y + legH + h + r * 0.75]], 16);
}

// ------------------------------------------------------------------ Midtown office (punched windows)

function* office(mb: MeshBuilder, s: BuildingSpec, rng: Rng, tint: THREE.Color, res: BuildResult): Generator<void, void> {
  const gh = 5.6;
  const bay = rng.range(3.0, 3.8);
  const winFrac = rng.range(0.55, 0.75);
  const winH = s.floorH * rng.range(0.52, 0.66);
  const deep = rng.range(0.25, 0.4);
  const banded = rng.chance(0.5);
  // Volumes: base + tiers.
  const vols: { w: number; d: number; y0: number; y1: number }[] = [];
  let y0 = 0;
  const totalH = s.height;
  const tiers = [...s.tiers].sort((a, b) => a.h - b.h);
  let w = s.w;
  let d = s.d;
  for (const t of tiers) {
    vols.push({ w, d, y0, y1: t.h });
    y0 = t.h;
    w = t.w;
    d = t.d;
  }
  vols.push({ w, d, y0, y1: totalH });
  for (const [vi, vol] of vols.entries()) {
    const fr = frames(vol.w, vol.d);
    for (const f of fr) {
      yield;
      const n = Math.max(1, Math.round((f.len - 1.6) / bay));
      const margin = (f.len - n * bay) / 2;
      // Floors in this volume.
      let v = vol.y0;
      let fl = Math.round(vol.y0 / s.floorH);
      if (vi === 0) {
        // Lobby / shops with granite piers.
        const ops: Opening[] = [];
        for (let i = 0; i < n; i++) {
          const cu = margin + bay * (i + 0.5);
          const isDoor = f.side === 's' && i === Math.floor(n / 2);
          ops.push({ u0: cu - bay * 0.42, u1: cu + bay * 0.42, v0: isDoor ? 0.05 : 0.45, v1: gh - 0.9, kind: 'shop', depth: 0.35, glass: 'glass_shop', style: 2, frame: 'steel_dark' });
        }
        wallRow(mb, f, 'granite', 0, gh, ops, white);
        ops.forEach((o, k) => opening(mb, f, o, 'granite', white, hashN(s.seed, k, 99, fr.indexOf(f))));
        v = gh;
        fl = 1;
        if (s.shop && f.side === 's' && f.len > 12) {
          // Brand fascia above the lobby.
          const uv = signs().brandUV(rng.int(0, BRANDS.length - 1));
          const su0 = f.len / 2 - 3;
          const su1 = f.len / 2 + 3;
          mb.quad('signs', P(f, su0, gh - 0.8, 0.06), P(f, su1, gh - 0.8, 0.06), P(f, su1, gh - 0.05, 0.06), P(f, su0, gh - 0.05, 0.06), { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
        }
        // Canopy over the entrance.
        if (f.side === 's') boxF(mb, 'steel_dark', f, f.len / 2 - 4, f.len / 2 + 4, gh - 0.7, gh - 0.45, 0, 2.6);
      }
      while (v < vol.y1 - 0.5) {
        const v1 = Math.min(vol.y1, v + s.floorH);
        const ops: Opening[] = [];
        const top = v1 >= vol.y1 - 0.01 && vi === vols.length - 1;
        for (let i = 0; i < n; i++) {
          const cu = margin + bay * (i + 0.5);
          const ww = bay * winFrac;
          const vv0 = v + (s.floorH - winH) * 0.45;
          ops.push({ u0: cu - ww / 2, u1: cu + ww / 2, v0: vv0, v1: vv0 + winH, kind: top && rng.chance(0.3) ? 'louver' : 'window', depth: deep, glass: 'glass_window', style: 0, frame: 'steel_dark' });
        }
        wallRow(mb, f, s.wall, v, v1, ops, tint);
        ops.forEach((o, k) => opening(mb, f, o, s.wall, tint, hashN(s.seed, k, fl, fr.indexOf(f))));
        v = v1;
        fl++;
      }
    }
    const loop = footprintLoop(vol.w, vol.d);
    if (vi === 0) mb.extrude('granite', loop, true, [[0, gh - 0.05], [0.18, gh - 0.05], [0.18, gh + 0.3], [0, gh + 0.3]]);
    if (banded) {
      for (let y = vol.y0 + gh + s.floorH * 4; y < vol.y1 - 3; y += s.floorH * 4) mb.extrude(s.trim, loop, true, [[0, y - 0.1], [0.1, y - 0.1], [0.1, y + 0.1], [0, y + 0.1]]);
    }
    // Parapet/cornice at the top of each volume.
    const top = vol.y1;
    mb.extrude(s.trim, loop, true, [[0, top - 0.2], [0.25, top - 0.2], [0.25, top + 1.1], [0, top + 1.1]]);
    mb.extrude(s.wall, footprintLoop(vol.w, vol.d, 0.3), true, [[0, top + 1.1], [0, top]], { color: tint });
    mb.box('roof_flat', -vol.w / 2 + 0.3, top - 0.05, -vol.d / 2 + 0.3, vol.w / 2 - 0.3, top + 0.05, vol.d / 2 - 0.3, { skip: ['px', 'nx', 'pz', 'nz', 'ny'] });
    if (vi === vols.length - 1) {
      // Mechanical penthouse with louvers and antenna.
      const pw = vol.w * 0.45;
      const pd = vol.d * 0.4;
      mb.box('concrete', -pw / 2, top, -pd / 2, pw / 2, top + 4.5, pd / 2, { color: tint });
      mb.box('roof_flat', -pw / 2 - 0.2, top + 4.5, -pd / 2 - 0.2, pw / 2 + 0.2, top + 4.75, pd / 2 + 0.2);
      for (let k = 0; k < 6; k++) mb.box('steel_dark', -pw / 2 - 0.05, top + 0.8 + k * 0.5, -pd / 2 - 0.12, pw / 2 + 0.05, top + 0.95 + k * 0.5, -pd / 2 + 0.02);
      roofClutter(mb, { w: vol.w, d: vol.d, seed: s.seed }, rng, top + 0.05, res, false);
      if (s.height > 110 || rng.chance(0.25)) antenna(mb, rng.range(-pw / 4, pw / 4), rng.range(-pd / 4, pd / 4), top + 4.75, rng.range(10, 26));
      if (rng.chance(0.3) && s.height < 90) billboard(mb, vol.w, vol.d, top, rng);
    }
  }
}

function antenna(mb: MeshBuilder, x: number, z: number, y: number, h: number): void {
  mb.cylinder('steel_light', x, y, z, 0.35, 0.12, h, 8);
  for (let k = 1; k < 4; k++) mb.box('steel_light', x - 0.9, y + h * k * 0.22, z - 0.04, x + 0.9, y + h * k * 0.22 + 0.06, z + 0.04);
  mb.cylinder('light_red', x, y + h, z, 0.18, 0.18, 0.3, 8);
}

function billboard(mb: MeshBuilder, w: number, d: number, top: number, rng: Rng): void {
  const bw = Math.min(14, w * 0.7);
  const bh = bw / 2;
  const z = rng.chance(0.5) ? d / 2 - 1.5 : -d / 2 + 1.5;
  const face = z > 0 ? 1 : -1;
  for (const x of [-bw * 0.35, bw * 0.35]) mb.box('paint_dark', x - 0.15, top, z - 0.15, x + 0.15, top + 3 + bh, z + 0.15);
  mb.box('paint_dark', -bw / 2 - 0.2, top + 3 - 0.2, z - 0.25, bw / 2 + 0.2, top + 3 + bh + 0.2, z + 0.05 * face);
  const uv = signs().adUV(rng.int(0, 5));
  const zz = z + 0.08 * face;
  const pts: V3[] = face > 0 ? [[-bw / 2, top + 3, zz], [bw / 2, top + 3, zz], [bw / 2, top + 3 + bh, zz], [-bw / 2, top + 3 + bh, zz]] : [[bw / 2, top + 3, zz], [-bw / 2, top + 3, zz], [-bw / 2, top + 3 + bh, zz], [bw / 2, top + 3 + bh, zz]];
  mb.quad('signs', pts[0], pts[1], pts[2], pts[3], { uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]] });
}

// ------------------------------------------------------------------ Midtown glass tower

function* glassTower(mb: MeshBuilder, s: BuildingSpec, rng: Rng, res: BuildResult): Generator<void, void> {
  const podH = rng.chance(0.7) ? 9.5 : 0;
  const pw = rng.range(1.5, 2.1);
  const spandrel = rng.range(0.9, 1.2);
  const vols: { w: number; d: number; y0: number; y1: number }[] = [];
  let y0 = podH;
  let w = podH > 0 ? s.w - 4 : s.w;
  let d = podH > 0 ? s.d - 4 : s.d;
  for (const t of [...s.tiers].sort((a, b) => a.h - b.h)) {
    vols.push({ w, d, y0, y1: t.h });
    y0 = t.h;
    w = Math.min(w, t.w);
    d = Math.min(d, t.d);
  }
  vols.push({ w, d, y0, y1: s.height });
  if (podH > 0) {
    // Stone podium with tall shop glazing.
    const fr = frames(s.w, s.d);
    for (const f of fr) {
      const n = Math.max(1, Math.round((f.len - 2) / 6));
      const bay = (f.len - 2) / n;
      const ops: Opening[] = [];
      for (let i = 0; i < n; i++) {
        const u0 = 1 + bay * i + 0.5;
        ops.push({ u0, u1: u0 + bay - 1, v0: 0.3, v1: podH - 1.6, kind: 'shop', depth: 0.45, glass: 'glass_shop', style: 2, frame: 'steel_dark' });
      }
      wallRow(mb, f, 'granite', 0, podH, ops, white);
      ops.forEach((o, k) => opening(mb, f, o, 'granite', white, hashN(s.seed, k, 0, fr.indexOf(f))));
    }
    mb.extrude('steel_dark', footprintLoop(s.w, s.d), true, [[0, podH - 0.3], [0.3, podH - 0.3], [0.3, podH + 0.4], [0, podH + 0.4]]);
    mb.box('roof_flat', -s.w / 2, podH - 0.1, -s.d / 2, s.w / 2, podH + 0.02, s.d / 2, { skip: ['px', 'nx', 'pz', 'nz', 'ny'] });
    // Planters on the podium roof.
    for (let i = 0; i < 4; i++) res.props.push({ type: 'planter', x: rng.range(-s.w / 2 + 1, s.w / 2 - 1), z: s.d / 2 - 1, y: podH, yaw: 0 });
  }
  const tintGlass = rng.next();
  for (const [vi, vol] of vols.entries()) {
    const fr = frames(vol.w, vol.d);
    for (const f of fr) {
      yield;
      const n = Math.max(2, Math.round(f.len / pw));
      const panel = f.len / n;
      let fl = 0;
      for (let v = vol.y0; v < vol.y1 - 0.5; v += s.floorH) {
        const v1 = Math.min(vol.y1, v + s.floorH);
        const gv0 = v + 0.02;
        const gv1 = v1 - spandrel;
        for (let i = 0; i < n; i++) {
          const u0 = panel * i;
          const u1 = u0 + panel;
          mb.quad('glass_curtain', P(f, u0, gv0, 0), P(f, u1, gv0, 0), P(f, u1, gv1, 0), P(f, u0, gv1, 0), {
            uvs: [[0, 0], [1, 0], [1, 1], [0, 1]],
            win: [(hashN(s.seed, i, fl, fr.indexOf(f)) % 9973) + 0.5, panel, gv1 - gv0, 0],
          });
        }
        // Spandrel band (opaque, slightly proud).
        mb.quad('glass_plain', P(f, 0, gv1, 0.01), P(f, f.len, gv1, 0.01), P(f, f.len, v1, 0.01), P(f, 0, v1, 0.01), {});
        // Transom.
        boxF(mb, 'steel_dark', f, 0, f.len, gv1 - 0.06, gv1 + 0.08, 0, 0.16);
        fl++;
      }
      // Mullion fins, full height of the volume (extend above the roof as a crown screen on top).
      const crown = vi === vols.length - 1 ? 3.5 + tintGlass * 3 : 0;
      for (let i = 1; i < n; i++) boxF(mb, 'aluminium', f, panel * i - 0.05, panel * i + 0.05, vol.y0, vol.y1 + crown, 0, 0.32);
      // Corner columns.
      boxF(mb, 'steel_dark', f, -0.2, 0.35, vol.y0, vol.y1 + crown, -0.2, 0.35);
    }
    const top = vol.y1;
    const loop = footprintLoop(vol.w, vol.d);
    mb.extrude('aluminium', loop, true, [[0, top - 0.3], [0.32, top - 0.3], [0.32, top + 0.5], [0, top + 0.5]]);
    mb.box('roof_flat', -vol.w / 2 + 0.2, top - 0.1, -vol.d / 2 + 0.2, vol.w / 2 - 0.2, top + 0.02, vol.d / 2 - 0.2, { skip: ['px', 'nx', 'pz', 'nz', 'ny'] });
    if (vi === vols.length - 1) {
      const crown = 3.5 + tintGlass * 3;
      mb.extrude('aluminium', loop, true, [[0, top + crown - 0.6], [0.34, top + crown - 0.6], [0.34, top + crown], [0, top + crown]]);
      mb.box('steel_light', -vol.w * 0.3, top, -vol.d * 0.3, vol.w * 0.3, top + crown - 1, vol.d * 0.3);
      roofClutter(mb, { w: vol.w, d: vol.d, seed: s.seed }, rng, top + 0.02, res, false);
      if (s.height > 150 && rng.chance(0.6)) antenna(mb, 0, 0, top + crown - 1, rng.range(18, 40));
    }
  }
}

// ------------------------------------------------------------------ Harbour warehouse

function warehouse(mb: MeshBuilder, s: BuildingSpec, rng: Rng, tint: THREE.Color): void {
  const H = s.height;
  const fr = frames(s.w, s.d);
  const brand = rng.chance(0.5) ? (rng.chance(0.5) ? 'atlas' : 'vellmar') : null;
  for (const f of fr) {
    // Concrete plinth.
    wallRow(mb, f, 'concrete', 0, 1.2, [], white);
    const ops: Opening[] = [];
    if (f.side === s.front || f.side === (s.front === 'n' ? 's' : 'n')) {
      const nd = Math.max(1, Math.floor(f.len / 14));
      for (let i = 0; i < nd; i++) {
        const cu = (f.len / nd) * (i + 0.5);
        ops.push({ u0: cu - 2.6, u1: cu + 2.6, v0: 1.2, v1: Math.min(H - 2.5, 6.4), kind: 'garage', depth: 0.25 });
      }
    } else {
      // High strip windows.
      const n = Math.floor(f.len / 6);
      for (let i = 0; i < n; i++) {
        const cu = (f.len / n) * (i + 0.5);
        ops.push({ u0: cu - 2, u1: cu + 2, v0: H - 3.2, v1: H - 1.8, kind: 'window', depth: 0.15, glass: 'glass_plain', style: 0, frame: 'steel_dark' });
      }
    }
    wallRow(mb, f, 'corrugated', 1.2, H, ops.map((o) => ({ ...o, v0: Math.max(o.v0, 1.2) })), tint);
    ops.forEach((o, k) => {
      opening(mb, f, o, 'steel_dark', white, hashN(s.seed, k, fr.indexOf(f)));
      if (o.kind === 'garage') {
        boxF(mb, 'paint', f, o.u0 - 0.2, o.u1 + 0.2, o.v1, o.v1 + 0.5, 0, 0.35, new THREE.Color(0.9, 0.75, 0.1));
        boxF(mb, 'concrete', f, o.u0 - 0.4, o.u0 - 0.1, 0, 1.0, 0, 0.4);
        boxF(mb, 'concrete', f, o.u1 + 0.1, o.u1 + 0.4, 0, 1.0, 0, 0.4);
      }
    });
    if (brand && f.side === s.front) {
      const uv = signs().extraUV(brand);
      const L = Math.min(f.len * 0.5, 16);
      const u0 = f.len / 2 - L / 2;
      mb.quad('signs', P(f, u0, H - 2.4, 0.05), P(f, u0 + L, H - 2.4, 0.05), P(f, u0 + L, H - 2.4 + L / 4, 0.05), P(f, u0, H - 2.4 + L / 4, 0.05), {
        uvs: [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]],
      });
    }
    // Downpipes at corners.
    mb.cylinder('steel_dark', P(f, 0.4, 0, 0.15)[0], 0, P(f, 0.4, 0, 0.15)[2], 0.08, 0.08, H, 6);
  }
  // Low-pitch gable roof with gutters.
  const ridgeX = s.w >= s.d;
  const rise = (ridgeX ? s.d : s.w) * 0.12;
  const roofCol = new THREE.Color(0.55, 0.57, 0.6);
  gableRoof(mb, s.w + 0.6, s.d + 0.6, H, ridgeX ? 'x' : 'z', rise, 'corrugated', 'corrugated', tint, s.w, s.d);
  void roofCol;
  const hw = s.w / 2 + 0.3;
  const hd = s.d / 2 + 0.3;
  if (ridgeX) {
    mb.box('steel_dark', -hw, H - 0.25, hd - 0.15, hw, H, hd + 0.1);
    mb.box('steel_dark', -hw, H - 0.25, -hd - 0.1, hw, H, -hd + 0.15);
  } else {
    mb.box('steel_dark', hw - 0.15, H - 0.25, -hd, hw + 0.1, H, hd);
    mb.box('steel_dark', -hw - 0.1, H - 0.25, -hd, -hw + 0.15, H, hd);
  }
  // Roof skylights.
  const ns = Math.floor((ridgeX ? s.w : s.d) / 10);
  for (let i = 0; i < ns; i++) {
    const t = -0.5 + (i + 0.5) / ns;
    if (ridgeX) mb.box('glass_plain', t * s.w - 1.2, H + rise * 0.45, s.d * 0.16, t * s.w + 1.2, H + rise * 0.55 + 0.1, s.d * 0.3);
    else mb.box('glass_plain', s.w * 0.16, H + rise * 0.45, t * s.d - 1.2, s.w * 0.3, H + rise * 0.55 + 0.1, t * s.d + 1.2);
  }
}

// ------------------------------------------------------------------ Industrial factory

function factory(mb: MeshBuilder, s: BuildingSpec, rng: Rng): void {
  const H = s.height;
  const fr = frames(s.w, s.d);
  const bay = 6;
  for (const f of fr) {
    wallRow(mb, f, 'concrete', 0, 1.0, [], white);
    const n = Math.max(1, Math.floor(f.len / bay));
    const margin = (f.len - n * bay) / 2;
    const ops: Opening[] = [];
    for (let i = 0; i < n; i++) {
      const cu = margin + bay * (i + 0.5);
      if (f.side === s.front && i === Math.floor(n / 2)) ops.push({ u0: cu - 2.4, u1: cu + 2.4, v0: 1.0, v1: 6, kind: 'garage', depth: 0.3 });
      else ops.push({ u0: cu - 2.0, u1: cu + 2.0, v0: 2.2, v1: H - 2.2, kind: 'window', depth: 0.3, glass: 'glass_plain', style: 0, frame: 'steel_dark' });
    }
    wallRow(mb, f, s.wall, 1.0, H, ops, white);
    ops.forEach((o, k) => {
      opening(mb, f, o, s.wall, white, hashN(s.seed, k, fr.indexOf(f)));
      if (o.kind === 'window') {
        // Steel glazing bars grid.
        const rows = Math.round((o.v1 - o.v0) / 0.9);
        for (let r = 1; r < rows; r++) {
          const vv = o.v0 + ((o.v1 - o.v0) / rows) * r;
          boxF(mb, 'steel_dark', f, o.u0, o.u1, vv - 0.03, vv + 0.03, -o.depth, -o.depth + 0.05);
        }
        for (const t of [1 / 3, 2 / 3]) {
          const uu = o.u0 + (o.u1 - o.u0) * t;
          boxF(mb, 'steel_dark', f, uu - 0.03, uu + 0.03, o.v0, o.v1, -o.depth, -o.depth + 0.05);
        }
        boxF(mb, 'concrete', f, o.u0 - 0.1, o.u1 + 0.1, o.v0 - 0.15, o.v0, 0, 0.15);
      }
    });
    // Pilasters between bays.
    for (let i = 0; i <= n; i++) boxF(mb, s.wall, f, margin + bay * i - 0.35, margin + bay * i + 0.35, 1.0, H + 0.6, 0, 0.3);
  }
  const loop = footprintLoop(s.w, s.d);
  mb.extrude('concrete', loop, true, [[0, H - 0.3], [0.32, H - 0.3], [0.32, H + 0.9], [0, H + 0.9]]);
  if (s.roof === 'sawtooth') {
    sawtooth(mb, s.w, s.d, H);
  } else {
    mb.box('roof_flat', -s.w / 2 + 0.3, H - 0.1, -s.d / 2 + 0.3, s.w / 2 - 0.3, H + 0.02, s.d / 2 - 0.3, { skip: ['px', 'nx', 'pz', 'nz', 'ny'] });
    // Roof vents and ducts.
    for (let i = 0; i < 4; i++) {
      const x = rng.range(-s.w / 2 + 3, s.w / 2 - 3);
      const z = rng.range(-s.d / 2 + 3, s.d / 2 - 3);
      mb.cylinder('steel_light', x, H, z, 0.8, 0.8, 2.5, 12);
      mb.lathe('steel_light', x, z, [[1.0, H + 2.5], [0.2, H + 3.2], [0, H + 3.25]], 12);
    }
  }
}

function sawtooth(mb: MeshBuilder, w: number, d: number, H: number): void {
  // Teeth run along X; each tooth spans a strip of depth td along Z.
  const teeth = Math.max(2, Math.floor(d / 8));
  const td = d / teeth;
  const th = 3.0;
  for (let i = 0; i < teeth; i++) {
    const z0 = -d / 2 + td * i; // north (glazed) edge
    const z1 = z0 + td; // south (low) edge
    // Sloped roof: from low south edge up to the high north edge.
    mb.quad('corrugated', [-w / 2, H, z1], [w / 2, H, z1], [w / 2, H + th, z0], [-w / 2, H + th, z0], { color: new THREE.Color(0.5, 0.52, 0.55), uvs: [[0, 0], [w, 0], [w, Math.hypot(td, th)], [0, Math.hypot(td, th)]] });
    // Vertical glazing facing north.
    mb.quad('glass_plain', [w / 2, H, z0], [-w / 2, H, z0], [-w / 2, H + th, z0], [w / 2, H + th, z0], {});
    // Triangular end caps.
    mb.quad('brick_factory', [w / 2, H, z1], [w / 2, H, z0], [w / 2, H + th, z0], [w / 2, H + th, z0], { uvs: [[z1, H], [z0, H], [z0, H + th], [z0, H + th]] });
    mb.quad('brick_factory', [-w / 2, H, z0], [-w / 2, H, z1], [-w / 2, H + th, z0], [-w / 2, H + th, z0], { uvs: [[z0, H], [z1, H], [z0, H + th], [z0, H + th]] });
  }
}

// ------------------------------------------------------------------ Northside house

function house(mb: MeshBuilder, s: BuildingSpec, rng: Rng, tint: THREE.Color): void {
  const H = s.floors * s.floorH;
  const fr = frames(s.w, s.d);
  const wall = s.wall;
  const doorCol = new THREE.Color().setHSL(rng.pick([0.0, 0.6, 0.33, 0.08, 0.75]), 0.45, 0.28);
  const garage = s.w > 11.5 && rng.chance(0.4);
  for (const f of fr) {
    const isFront = f.side === s.front;
    const n = Math.max(1, Math.floor((f.len - 1) / 3.2));
    const bay = (f.len - 1) / n;
    for (let fl = 0; fl < s.floors; fl++) {
      const v0 = 0.35 + fl * s.floorH;
      const v1 = v0 + s.floorH;
      const ops: Opening[] = [];
      for (let i = 0; i < n; i++) {
        const cu = 0.5 + bay * (i + 0.5);
        if (fl === 0 && isFront && i === 0 && garage) {
          ops.push({ u0: cu - 1.35, u1: cu + 1.35, v0: v0 + 0.02, v1: v0 + 2.3, kind: 'garage', depth: 0.15, color: new THREE.Color(0.92, 0.92, 0.9) });
        } else if (fl === 0 && isFront && i === Math.min(n - 1, garage ? 1 : Math.floor(n / 2))) {
          ops.push({ u0: cu - 0.5, u1: cu + 0.5, v0: v0 + 0.02, v1: v0 + 2.2, kind: 'door', depth: 0.15, color: doorCol });
        } else if (rng.chance(0.85) || isFront) {
          ops.push({ u0: cu - 0.6, u1: cu + 0.6, v0: v0 + 0.9, v1: v0 + 2.25, kind: 'window', depth: 0.14, glass: 'glass_window', style: 1, frame: 'paint_white', mullion: true });
        }
      }
      wallRow(mb, f, wall, v0, v1, ops, tint);
      ops.forEach((o, k) => {
        opening(mb, f, o, wall, tint, hashN(s.seed, k, fl, fr.indexOf(f)));
        if (o.kind === 'window') boxF(mb, 'paint_white', f, o.u0 - 0.08, o.u1 + 0.08, o.v0 - 0.08, o.v0, 0, 0.1);
        if (o.kind === 'door') {
          // Porch canopy on brackets + step.
          boxF(mb, 'paint_white', f, o.u0 - 0.5, o.u1 + 0.5, o.v1 + 0.15, o.v1 + 0.3, 0, 1.1);
          boxF(mb, 'stone', f, o.u0 - 0.4, o.u1 + 0.4, -0.2, v0, 0, 1.0);
          boxF(mb, 'paint_white', f, o.u0 - 0.45, o.u0 - 0.35, o.v1 - 0.4, o.v1 + 0.15, 0, 0.9);
          boxF(mb, 'paint_white', f, o.u1 + 0.35, o.u1 + 0.45, o.v1 - 0.4, o.v1 + 0.15, 0, 0.9);
        }
      });
    }
  }
  // Floor band between storeys and eaves.
  const loop = footprintLoop(s.w, s.d);
  if (s.floors > 1) mb.extrude('paint_white', loop, true, [[0, 0.35 + s.floorH - 0.08], [0.06, 0.35 + s.floorH - 0.08], [0.06, 0.35 + s.floorH + 0.08], [0, 0.35 + s.floorH + 0.08]]);
  const top = H + 0.35;
  mb.extrude('paint_white', loop, true, [[0, top - 0.25], [0.45, top - 0.25], [0.45, top], [0, top]]);
  const rise = Math.min(s.w, s.d) * rng.range(0.3, 0.42);
  const roofKey = rng.chance(0.65) ? 'roof_tile' : 'roof_slate';
  if (s.roof === 'gable') gableRoof(mb, s.w + 0.9, s.d + 0.9, top, s.front === 'n' || s.front === 's' ? 'x' : 'z', rise, roofKey, wall, tint, s.w, s.d);
  else hipRoof(mb, s.w + 0.9, s.d + 0.9, top, rise, roofKey);
  // Chimney.
  const cx = rng.range(-s.w / 3, s.w / 3);
  mb.box('brick_brown', cx - 0.4, top - 1, -0.4 + s.d * 0.15, cx + 0.4, top + rise + 0.9, 0.4 + s.d * 0.15);
  mb.box('stone', cx - 0.5, top + rise + 0.9, -0.5 + s.d * 0.15, cx + 0.5, top + rise + 1.05, 0.5 + s.d * 0.15);
}

// ------------------------------------------------------------------ far LOD

const FAR_COLORS: Record<string, [number, number, number]> = {
  brick_red: [0.42, 0.2, 0.15],
  brick_brown: [0.38, 0.26, 0.19],
  brick_factory: [0.4, 0.2, 0.14],
  stone: [0.6, 0.53, 0.43],
  concrete: [0.52, 0.51, 0.49],
  concrete_panels: [0.55, 0.53, 0.5],
  granite: [0.42, 0.42, 0.43],
  plaster: [0.78, 0.76, 0.72],
  plaster_grey: [0.55, 0.55, 0.55],
  corrugated: [0.55, 0.55, 0.55],
  steel_light: [0.38, 0.45, 0.5],
};

export function buildFar(mb: MeshBuilder, s: BuildingSpec): void {
  const base = FAR_COLORS[s.wall] ?? [0.5, 0.5, 0.5];
  const col = new THREE.Color(base[0] * s.tint[0], base[1] * s.tint[1], base[2] * s.tint[2]);
  const glass = s.style === 'glass';
  const bay = glass ? 1.8 : s.style === 'house' ? 3.2 : s.style === 'warehouse' || s.style === 'factory' ? 6 : 3.2;
  const winW = glass ? 0.96 : s.style === 'office' ? 0.62 : s.style === 'warehouse' ? 0.0 : 0.42;
  const winH = glass ? 0.72 : 0.55;
  const gi = glass ? 1 : s.style === 'factory' ? 2 : 0;
  const win: [number, number, number, number] = [s.floorH, bay, winW, gi + Math.min(0.99, winH)];
  const key = 'far_facade';
  const add = (w: number, d: number, y0: number, y1: number) => {
    mb.pushTRS(s.cx, s.baseY, s.cz, 0);
    const hw = w / 2;
    const hd = d / 2;
    const faces: [V3, V3, V3, V3][] = [
      [[-hw, y0, hd], [hw, y0, hd], [hw, y1, hd], [-hw, y1, hd]],
      [[hw, y0, hd], [hw, y0, -hd], [hw, y1, -hd], [hw, y1, hd]],
      [[hw, y0, -hd], [-hw, y0, -hd], [-hw, y1, -hd], [hw, y1, -hd]],
      [[-hw, y0, -hd], [-hw, y0, hd], [-hw, y1, hd], [-hw, y1, -hd]],
      [[-hw, y1, hd], [hw, y1, hd], [hw, y1, -hd], [-hw, y1, -hd]],
    ];
    for (const f of faces) mb.quad(key, f[0], f[1], f[2], f[3], { color: col, win });
    mb.popTransform();
  };
  if (s.style === 'glass' || s.style === 'office') {
    let y0 = -1.5;
    let w = s.w;
    let d = s.d;
    for (const t of [...s.tiers].sort((a, b) => a.h - b.h)) {
      add(w, d, y0, t.h);
      y0 = t.h;
      w = t.w;
      d = t.d;
    }
    add(s.style === 'glass' && y0 < 0 ? w - 4 : w, s.style === 'glass' && y0 < 0 ? d - 4 : d, y0, s.height + 1);
  } else if (s.style === 'house' || s.style === 'warehouse' || (s.roof === 'gable' && s.style !== 'factory')) {
    const H = s.style === 'house' ? s.height + 0.35 : s.style === 'warehouse' ? s.height : s.height + 0.6;
    add(s.w, s.d, -1.5, H);
    // Simple roof prism.
    const ridgeX = s.style === 'warehouse' ? s.w >= s.d : s.front === 'n' || s.front === 's';
    const rise = Math.min(s.w, s.d) * (s.style === 'warehouse' ? 0.12 : 0.35);
    mb.pushTRS(s.cx, s.baseY, s.cz, 0);
    const roofCol = s.style === 'house' ? new THREE.Color(0.35, 0.2, 0.15) : new THREE.Color(0.3, 0.32, 0.34);
    const hw = s.w / 2 + 0.3;
    const hd = s.d / 2 + 0.3;
    if (ridgeX) {
      mb.quad(key, [-hw, H, hd], [hw, H, hd], [hw, H + rise, 0], [-hw, H + rise, 0], { color: roofCol, win: [0, 0, 0, 0] });
      mb.quad(key, [hw, H, -hd], [-hw, H, -hd], [-hw, H + rise, 0], [hw, H + rise, 0], { color: roofCol, win: [0, 0, 0, 0] });
    } else {
      mb.quad(key, [hw, H, hd], [hw, H, -hd], [0, H + rise, -hd], [0, H + rise, hd], { color: roofCol, win: [0, 0, 0, 0] });
      mb.quad(key, [-hw, H, -hd], [-hw, H, hd], [0, H + rise, hd], [0, H + rise, -hd], { color: roofCol, win: [0, 0, 0, 0] });
    }
    mb.popTransform();
  } else {
    add(s.w, s.d, -1.5, s.height + (s.style === 'factory' ? 0.9 : 1.3));
  }
}

/** Collision boxes: [cx, cy, cz, hx, hy, hz]. */
export function buildingColliders(s: BuildingSpec): [number, number, number, number, number, number][] {
  const out: [number, number, number, number, number, number][] = [];
  const top = s.style === 'house' ? s.height + 0.35 : s.height + 0.6;
  if (s.style === 'glass' || s.style === 'office') {
    let y0 = -1;
    let w = s.w;
    let d = s.d;
    for (const t of [...s.tiers].sort((a, b) => a.h - b.h)) {
      out.push([s.cx, s.baseY + (y0 + t.h) / 2, s.cz, w / 2, (t.h - y0) / 2, d / 2]);
      y0 = t.h;
      w = t.w;
      d = t.d;
    }
    out.push([s.cx, s.baseY + (y0 + top) / 2, s.cz, w / 2, (top - y0) / 2, d / 2]);
  } else {
    out.push([s.cx, s.baseY + (top - 1) / 2, s.cz, s.w / 2, (top + 1) / 2, s.d / 2]);
  }
  return out;
}
