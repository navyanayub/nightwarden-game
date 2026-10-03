/**
 * Ground layer geometry: roads, junctions, markings, crossings, kerbs, pavements,
 * plazas, gardens and park paths. Every vertex follows the baked terrain height.
 */
import * as THREE from 'three';
import type { MeshBuilder, V2 } from './MeshBuilder';
import type { Block, PathSpec, RoadNode, RoadSeg } from './CityLayout';
import { heightAt } from './Terrain';
import { KERB } from './WorldConfig';

const ROAD_LIFT = 0.04;
const CORNER_R = 3;

/** Subdivided ground-following rectangle. */
export function groundPatch(mb: MeshBuilder, key: string, x0: number, z0: number, x1: number, z1: number, lift: number, cell = 6, color?: THREE.Color): void {
  if (x1 - x0 < 0.01 || z1 - z0 < 0.01) return;
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell));
  const nz = Math.max(1, Math.ceil((z1 - z0) / cell));
  const buf = mb.get(key);
  const base = buf.vertexCount;
  const c = color ?? new THREE.Color(1, 1, 1);
  for (let j = 0; j <= nz; j++) {
    const z = z0 + ((z1 - z0) * j) / nz;
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const y = heightAt(x, z) + lift;
      buf.pos.push(x, y, z);
      buf.nor.push(0, 1, 0);
      buf.uv.push(x, -z);
      buf.col.push(c.r, c.g, c.b);
      if (buf.extra) buf.extra.push(0, 0, 0, 0);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i;
      const b = a + 1;
      const d = a + (nx + 1);
      const e = d + 1;
      buf.idx.push(a, d, b, b, d, e);
    }
  }
  recomputeNormals(buf, base);
}

/** Recompute smooth normals for vertices appended since `from` (grid patches on slopes). */
function recomputeNormals(buf: { pos: number[]; nor: number[]; idx: number[] }, from: number): void {
  const firstTri = buf.idx.findIndex((i) => i >= from);
  if (firstTri < 0) return;
  for (let i = from * 3; i < buf.nor.length; i++) buf.nor[i] = 0;
  for (let t = firstTri - (firstTri % 3); t < buf.idx.length; t += 3) {
    const [a, b, c] = [buf.idx[t], buf.idx[t + 1], buf.idx[t + 2]];
    if (a < from) continue;
    const ax = buf.pos[a * 3], ay = buf.pos[a * 3 + 1], az = buf.pos[a * 3 + 2];
    const e1x = buf.pos[b * 3] - ax, e1y = buf.pos[b * 3 + 1] - ay, e1z = buf.pos[b * 3 + 2] - az;
    const e2x = buf.pos[c * 3] - ax, e2y = buf.pos[c * 3 + 1] - ay, e2z = buf.pos[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      buf.nor[v * 3] += nx;
      buf.nor[v * 3 + 1] += ny;
      buf.nor[v * 3 + 2] += nz;
    }
  }
  for (let v = from; v < buf.nor.length / 3; v++) {
    const l = Math.hypot(buf.nor[v * 3], buf.nor[v * 3 + 1], buf.nor[v * 3 + 2]) || 1;
    buf.nor[v * 3] /= l;
    buf.nor[v * 3 + 1] /= l;
    buf.nor[v * 3 + 2] /= l;
  }
}

/** Flat-ish decal quad following terrain at its corners. */
function decal(mb: MeshBuilder, key: string, x0: number, z0: number, x1: number, z1: number, lift = ROAD_LIFT + 0.012): void {
  const y = (x: number, z: number) => heightAt(x, z) + lift;
  mb.quad(key, [x0, y(x0, z1), z1], [x1, y(x1, z1), z1], [x1, y(x1, z0), z0], [x0, y(x0, z0), z0], { normal: [0, 1, 0], uvs: [[x0, -z1], [x1, -z1], [x1, -z0], [x0, -z0]] });
}

export function buildRoadSegment(mb: MeshBuilder, r: RoadSeg, a: RoadNode | undefined, b: RoadNode | undefined): void {
  const key = r.surface === 'cobble' ? 'cobble' : 'asphalt';
  const hw = r.width / 2;
  if (r.axis === 'x') {
    const xa = r.x0 + (a?.hx ?? 0);
    const xb = r.x1 - (b?.hx ?? 0);
    if (xb - xa < 0.1) return;
    groundPatch(mb, key, xa, r.z0 - hw, xb, r.z0 + hw, ROAD_LIFT, 8);
    markings(mb, r, xa, xb, a, b);
  } else {
    const za = r.z0 + (a?.hz ?? 0);
    const zb = r.z1 - (b?.hz ?? 0);
    if (zb - za < 0.1) return;
    groundPatch(mb, key, r.x0 - hw, za, r.x0 + hw, zb, ROAD_LIFT, 8);
    markings(mb, r, za, zb, a, b);
  }
}

/** Lane markings, median, crossings and stop lines along one segment. a0..a1 = along-axis extent. */
function markings(mb: MeshBuilder, r: RoadSeg, a0: number, a1: number, na: RoadNode | undefined, nb: RoadNode | undefined): void {
  if (r.kind === 'lane') return;
  const c = r.axis === 'x' ? r.z0 : r.x0;
  // Decal in (along, across) space.
  const d = (s0: number, s1: number, t0: number, t1: number, key = 'markings') => {
    if (s1 - s0 < 0.05) return;
    if (r.axis === 'x') decal(mb, key, s0, c + t0, s1, c + t1);
    else decal(mb, key, c + t0, s0, c + t1, s1);
  };
  const hw = r.width / 2;
  const startPad = na && na.arms >= 3 ? 5.5 : 0;
  const endPad = nb && nb.arms >= 3 ? 5.5 : 0;
  const s0 = a0 + startPad;
  const s1 = a1 - endPad;
  const dashed = (t: number, dash = 3, gap = 6) => {
    for (let s = s0 + 1; s < s1 - 1; s += dash + gap) d(s, Math.min(s + dash, s1 - 1), t - 0.075, t + 0.075);
  };
  if (r.kind === 'avenue') {
    // Raised median island.
    const mw = 1.4;
    median(mb, r, s0, s1, mw);
    const lane = (hw - mw) / 2 + mw;
    dashed(lane);
    dashed(-lane);
    d(s0, s1, mw + 0.25, mw + 0.4, 'markings_yellow');
    d(s0, s1, -mw - 0.4, -mw - 0.25, 'markings_yellow');
  } else if (r.width >= 15) {
    d(s0, s1, -0.22, -0.08, 'markings_yellow');
    d(s0, s1, 0.08, 0.22, 'markings_yellow');
    dashed(hw / 2);
    dashed(-hw / 2);
  } else {
    dashed(0);
  }
  // Edge lines.
  d(s0, s1, hw - 0.5, hw - 0.38);
  d(s0, s1, -hw + 0.38, -hw + 0.5);
  // Crossings + stop lines (right-hand traffic).
  const crossing = (edge: number, dir: 1 | -1, node: RoadNode) => {
    if (node.arms < 3) return;
    const z0 = edge + dir * 0.8;
    const z1 = edge + dir * 3.8;
    const [ca, cb] = dir > 0 ? [z0, z1] : [z1, z0];
    for (let t = -hw + 0.6; t < hw - 0.6; t += 1.1) d(ca, cb, t, t + 0.55);
    const sl = edge + dir * 4.6;
    const [sa, sb] = dir > 0 ? [sl, sl + 0.4] : [sl - 0.4, sl];
    // Incoming lane side: at the start node traffic arrives travelling "backwards".
    const incoming = dir > 0 ? (r.axis === 'x' ? [-hw + 0.4, 0] : [0, hw - 0.4]) : r.axis === 'x' ? [0, hw - 0.4] : [-hw + 0.4, 0];
    d(sa, sb, incoming[0], incoming[1]);
  };
  if (na) crossing(a0, 1, na);
  if (nb) crossing(a1, -1, nb);
}

function median(mb: MeshBuilder, r: RoadSeg, s0: number, s1: number, mw: number): void {
  const c = r.axis === 'x' ? r.z0 : r.x0;
  const pts: V2[] =
    r.axis === 'x'
      ? [
          [s0 + 1, c + mw],
          [s1 - 1, c + mw],
          [s1 - 1, c - mw],
          [s0 + 1, c - mw],
        ]
      : [
          [c - mw, s1 - 1],
          [c + mw, s1 - 1],
          [c + mw, s0 + 1],
          [c - mw, s0 + 1],
        ];
  const loop = pts;
  const ys = loop.map(([x, z]) => heightAt(x, z) + ROAD_LIFT);
  mb.extrude('kerb', loop, true, [[0, -0.1], [0, KERB - 0.03], [-0.04, KERB], [-0.25, KERB]], { yOffsets: ys });
  if (r.axis === 'x') groundPatch(mb, 'grass', s0 + 1.2, c - mw + 0.24, s1 - 1.2, c + mw - 0.24, ROAD_LIFT + KERB - 0.01, 8);
  else groundPatch(mb, 'grass', c - mw + 0.24, s0 + 1.2, c + mw - 0.24, s1 - 1.2, ROAD_LIFT + KERB - 0.01, 8);
}

export function buildNode(mb: MeshBuilder, n: RoadNode): void {
  if (n.hx <= 0 || n.hz <= 0) return;
  const cobble = [n.n, n.s, n.e, n.w].every((r) => !r || r.surface === 'cobble');
  groundPatch(mb, cobble ? 'cobble' : 'asphalt', n.x - n.hx, n.z - n.hz, n.x + n.hx, n.z + n.hz, ROAD_LIFT, 8);
}

/** Kerb loop (with rounded corners) in facade-loop order: (minX,maxZ) -> (maxX,maxZ) -> (maxX,minZ) -> (minX,minZ). */
function kerbLoop(b: { minX: number; maxX: number; minZ: number; maxZ: number }, r: number): V2[] {
  const out: V2[] = [];
  const arc = (cx: number, cz: number, a0: number, a1: number) => {
    for (let i = 0; i <= 4; i++) {
      const a = a0 + ((a1 - a0) * i) / 4;
      out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  };
  // Angles in the (x, z) plane: 0 = +x, PI/2 = +z.
  arc(b.minX + r, b.maxZ - r, Math.PI, Math.PI / 2);
  arc(b.maxX - r, b.maxZ - r, Math.PI / 2, 0);
  arc(b.maxX - r, b.minZ + r, 0, -Math.PI / 2);
  arc(b.minX + r, b.minZ + r, -Math.PI / 2, -Math.PI);
  return out;
}

export function buildBlockGround(mb: MeshBuilder, b: Block): void {
  const r = CORNER_R;
  const loop = kerbLoop(b, r);
  const ys = loop.map(([x, z]) => heightAt(x, z) + ROAD_LIFT);
  // Kerb stones.
  mb.extrude('kerb', loop, true, [[0, -0.12], [0, KERB - 0.03], [-0.03, KERB + 0.005], [-0.3, KERB + 0.005]], { yOffsets: ys });
  // Pavement: middle band + north/south bands + corner fans.
  const lift = ROAD_LIFT + KERB;
  const pav = b.district === 'oldtown' ? 'plaza' : 'pavement';
  const i = 0.3;
  groundPatch(mb, pav, b.minX + i, b.minZ + r, b.maxX - i, b.maxZ - r, lift, 6);
  groundPatch(mb, pav, b.minX + r, b.minZ + i, b.maxX - r, b.minZ + r, lift, 6);
  groundPatch(mb, pav, b.minX + r, b.maxZ - r, b.maxX - r, b.maxZ - i, lift, 6);
  const fan = (cx: number, cz: number, a0: number) => {
    const rr = r - i;
    const y0 = heightAt(cx, cz) + lift;
    for (let k = 0; k < 4; k++) {
      const a1 = a0 + (k / 4) * (Math.PI / 2);
      const a2 = a0 + ((k + 1) / 4) * (Math.PI / 2);
      const p1: [number, number] = [cx + Math.cos(a1) * rr, cz + Math.sin(a1) * rr];
      const p2: [number, number] = [cx + Math.cos(a2) * rr, cz + Math.sin(a2) * rr];
      mb.quad(pav, [cx, y0, cz], [p2[0], heightAt(p2[0], p2[1]) + lift, p2[1]], [p1[0], heightAt(p1[0], p1[1]) + lift, p1[1]], [p1[0], heightAt(p1[0], p1[1]) + lift, p1[1]], { normal: [0, 1, 0] });
    }
  };
  fan(b.minX + r, b.minZ + r, Math.PI);
  fan(b.maxX - r, b.minZ + r, -Math.PI / 2);
  fan(b.maxX - r, b.maxZ - r, 0);
  fan(b.minX + r, b.maxZ - r, Math.PI / 2);
  // Inner surface by block type.
  const sw = b.sidewalk;
  const ix0 = b.minX + sw;
  const ix1 = b.maxX - sw;
  const iz0 = b.minZ + sw;
  const iz1 = b.maxZ - sw;
  if (b.district === 'hills') {
    groundPatch(mb, 'grass', ix0, iz0, ix1, iz1, lift + 0.03, 6);
    // Low kerb edging around the lawns.
    const edge: V2[] = [
      [ix0, iz1],
      [ix1, iz1],
      [ix1, iz0],
      [ix0, iz0],
    ];
    mb.extrude('kerb', edge, true, [[0, lift - 0.02], [0, lift + 0.08], [-0.12, lift + 0.08]], { yOffsets: edge.map(([x, z]) => heightAt(x, z)) });
  } else if (b.kind === 'plaza' || b.kind === 'square') {
    groundPatch(mb, b.kind === 'square' ? 'cobble' : 'plaza', ix0, iz0, ix1, iz1, lift + 0.015, 6);
  } else if (b.kind === 'railyard') {
    groundPatch(mb, 'gravel', ix0, iz0, ix1, iz1, lift + 0.015, 8);
  } else if (b.district === 'harbour' || b.district === 'industrial') {
    groundPatch(mb, 'kerb', ix0, iz0, ix1, iz1, lift + 0.015, 8, new THREE.Color(0.75, 0.74, 0.72));
  }
}

/** Ribbon path (park footpaths) following terrain. */
export function buildPath(mb: MeshBuilder, p: PathSpec, key = 'plaza'): void {
  const pts = p.pts;
  const hw = p.width / 2;
  const buf = mb.get(key);
  const base = buf.vertexCount;
  let along = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    if (i > 0) along += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (const s of [-1, 1]) {
      const x = pts[i][0] + nx * hw * s;
      const z = pts[i][1] + nz * hw * s;
      buf.pos.push(x, heightAt(x, z) + 0.06, z);
      buf.nor.push(0, 1, 0);
      buf.uv.push(s * hw, along);
      buf.col.push(0.9, 0.85, 0.78);
      if (buf.extra) buf.extra.push(0, 0, 0, 0);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = base + i * 2;
    buf.idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}
