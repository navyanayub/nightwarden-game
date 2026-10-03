/**
 * Procedural geometry accumulator. Primitives are emitted in *local* coordinates and
 * transformed by the current matrix; output is one merged BufferGeometry per material key
 * (so a whole chunk renders with ~1 draw call per material).
 *
 * UV convention: UVs are in metres (world-scale); materials set texture.repeat = 1 / tileSize.
 */
import * as THREE from 'three';

export type V3 = [number, number, number];
export type V2 = [number, number];

export class GeoBuffer {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** Optional 4-component custom attribute (e.g. window params for interior mapping). */
  extra: number[] | null = null;
  get vertexCount(): number {
    return this.pos.length / 3;
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.extra) g.setAttribute('aWin', new THREE.Float32BufferAttribute(this.extra, 4));
    const vc = this.vertexCount;
    g.setIndex(vc > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

export interface QuadOpts {
  color?: THREE.Color;
  /** Explicit UVs for the 4 corners (else world-metre projection). */
  uvs?: [V2, V2, V2, V2];
  /** Window/room parameters written to the aWin attribute (vec4). */
  win?: [number, number, number, number];
  /** Normal override (else computed from the quad). */
  normal?: V3;
}

const WHITE = new THREE.Color(1, 1, 1);

export class MeshBuilder {
  readonly buffers = new Map<string, GeoBuffer>();
  private matrix = new THREE.Matrix4();
  private normalMatrix = new THREE.Matrix3();
  private stack: THREE.Matrix4[] = [];
  private identity = true;

  get(key: string): GeoBuffer {
    let b = this.buffers.get(key);
    if (!b) {
      b = new GeoBuffer();
      this.buffers.set(key, b);
    }
    return b;
  }

  pushTransform(m: THREE.Matrix4): void {
    this.stack.push(this.matrix.clone());
    this.matrix = this.matrix.clone().multiply(m);
    this.normalMatrix.getNormalMatrix(this.matrix);
    this.identity = false;
  }

  /** Convenience: translate + rotate about Y. */
  pushTRS(x: number, y: number, z: number, yaw = 0): void {
    const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(x, y, z);
    this.pushTransform(m);
  }

  popTransform(): void {
    this.matrix = this.stack.pop() ?? new THREE.Matrix4();
    this.normalMatrix.getNormalMatrix(this.matrix);
    this.identity = this.stack.length === 0;
  }

  private vtx(b: GeoBuffer, p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: THREE.Color, win?: [number, number, number, number]): number {
    if (!this.identity) {
      p.applyMatrix4(this.matrix);
      n.applyMatrix3(this.normalMatrix).normalize();
    }
    b.pos.push(p.x, p.y, p.z);
    b.nor.push(n.x, n.y, n.z);
    b.uv.push(u, v);
    b.col.push(c.r, c.g, c.b);
    if (win) {
      if (!b.extra) b.extra = new Array((b.vertexCount - 1) * 4).fill(0);
      b.extra.push(win[0], win[1], win[2], win[3]);
    } else if (b.extra) b.extra.push(0, 0, 0, 0);
    return b.vertexCount - 1;
  }

  /** Quad from 4 local corners, counter-clockwise when seen from the front. */
  quad(key: string, a: V3, b: V3, c: V3, d: V3, opts: QuadOpts = {}): void {
    const buf = this.get(key);
    _a.set(a[0], a[1], a[2]);
    _b.set(b[0], b[1], b[2]);
    _c.set(c[0], c[1], c[2]);
    _d.set(d[0], d[1], d[2]);
    if (opts.normal) _n.set(opts.normal[0], opts.normal[1], opts.normal[2]);
    else {
      _e1.subVectors(_b, _a);
      _e2.subVectors(_d, _a);
      _n.crossVectors(_e1, _e2).normalize();
      if (_n.lengthSq() < 1e-8) {
        _e1.subVectors(_c, _b);
        _e2.subVectors(_a, _b);
        _n.crossVectors(_e1, _e2).normalize();
      }
    }
    const col = opts.color ?? WHITE;
    let uvs = opts.uvs;
    if (!uvs) uvs = [projUV(_a, _n), projUV(_b, _n), projUV(_c, _n), projUV(_d, _n)];
    const n = _n.clone();
    const i0 = this.vtx(buf, _p.copy(_a), _n.copy(n), uvs[0][0], uvs[0][1], col, opts.win);
    const i1 = this.vtx(buf, _p.copy(_b), _n.copy(n), uvs[1][0], uvs[1][1], col, opts.win);
    const i2 = this.vtx(buf, _p.copy(_c), _n.copy(n), uvs[2][0], uvs[2][1], col, opts.win);
    const i3 = this.vtx(buf, _p.copy(_d), _n.copy(n), uvs[3][0], uvs[3][1], col, opts.win);
    buf.idx.push(i0, i1, i2, i0, i2, i3);
  }

  /** Vertical wall quad on the plane from (x0,z0) to (x1,z1), facing right of the direction. */
  wall(key: string, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, opts: QuadOpts & { uOffset?: number } = {}): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const u0 = opts.uOffset ?? 0;
    this.quad(key, [x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0], {
      ...opts,
      uvs: opts.uvs ?? [
        [u0, y0],
        [u0 + len, y0],
        [u0 + len, y1],
        [u0, y1],
      ],
    });
  }

  /** Axis-aligned box in local space. `skip` omits faces: 'px','nx','py','ny','pz','nz'. */
  box(key: string, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, opts: { color?: THREE.Color; skip?: string[] } = {}): void {
    const s = opts.skip ?? [];
    const c = opts.color;
    if (!s.includes('pz')) this.quad(key, [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ], { color: c, uvs: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]] });
    if (!s.includes('nz')) this.quad(key, [maxX, minY, minZ], [minX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ], { color: c, uvs: [[-maxX, minY], [-minX, minY], [-minX, maxY], [-maxX, maxY]] });
    if (!s.includes('px')) this.quad(key, [maxX, minY, maxZ], [maxX, minY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], { color: c, uvs: [[-maxZ, minY], [-minZ, minY], [-minZ, maxY], [-maxZ, maxY]] });
    if (!s.includes('nx')) this.quad(key, [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, maxZ], [minX, maxY, minZ], { color: c, uvs: [[minZ, minY], [maxZ, minY], [maxZ, maxY], [minZ, maxY]] });
    if (!s.includes('py')) this.quad(key, [minX, maxY, maxZ], [maxX, maxY, maxZ], [maxX, maxY, minZ], [minX, maxY, minZ], { color: c, uvs: [[minX, -maxZ], [maxX, -maxZ], [maxX, -minZ], [minX, -minZ]] });
    if (!s.includes('ny')) this.quad(key, [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ], { color: c, uvs: [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]] });
  }

  /** Box centred at (cx, cz) rotated by yaw, spanning y0..y1. */
  boxYaw(key: string, cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, yaw: number, opts: { color?: THREE.Color; skip?: string[] } = {}): void {
    this.pushTRS(cx, 0, cz, yaw);
    this.box(key, -hx, y0, -hz, hx, y1, hz, opts);
    this.popTransform();
  }

  /** Box between two arbitrary points (beam / strut) with square section. */
  beam(key: string, a: V3, b: V3, size: number, opts: { color?: THREE.Color; height?: number } = {}): void {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const dir = B.clone().sub(A);
    const len = dir.length();
    if (len < 1e-4) return;
    dir.divideScalar(len);
    const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const up2 = new THREE.Vector3().crossVectors(side, dir).normalize();
    const m = new THREE.Matrix4().makeBasis(side, up2, dir).setPosition(A);
    this.pushTransform(m);
    const h = (opts.height ?? size) / 2;
    const w = size / 2;
    this.box(key, -w, -h, 0, w, h, len, { color: opts.color });
    this.popTransform();
  }

  /** Cylinder (or cone) along +Y from y0 to y1. */
  cylinder(key: string, cx: number, y0: number, cz: number, rBottom: number, rTop: number, height: number, segs: number, opts: { color?: THREE.Color; capTop?: boolean; capBottom?: boolean; uvScale?: number } = {}): void {
    this.lathe(key, cx, cz, [[rBottom, y0], [rTop, y0 + height]], segs, { color: opts.color, capTop: opts.capTop ?? true, capBottom: opts.capBottom ?? false });
  }

  /**
   * Surface of revolution around the local Y axis through (cx, cz).
   * profile: [radius, y] from bottom to top. Smooth normals around and along the profile.
   */
  lathe(key: string, cx: number, cz: number, profile: V2[], segs: number, opts: { color?: THREE.Color; capTop?: boolean; capBottom?: boolean; flatProfile?: boolean } = {}): void {
    const buf = this.get(key);
    const col = opts.color ?? WHITE;
    const np = profile.length;
    // Profile normals in (r, y) space.
    const pn: V2[] = [];
    for (let i = 0; i < np; i++) {
      const prev = profile[Math.max(0, i - 1)];
      const next = profile[Math.min(np - 1, i + 1)];
      const dr = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const l = Math.hypot(dr, dy) || 1;
      pn.push([dy / l, -dr / l]);
    }
    // Arc length along profile for v.
    const vlen: number[] = [0];
    for (let i = 1; i < np; i++) vlen.push(vlen[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
    const maxR = Math.max(...profile.map((p) => p[0]));
    const circ = Math.PI * 2 * maxR;
    if (opts.flatProfile) {
      for (let i = 0; i < np - 1; i++) this.lathe(key, cx, cz, [profile[i], profile[i + 1]], segs, { color: opts.color });
    } else {
      const base: number[][] = [];
      for (let s = 0; s <= segs; s++) {
        const ang = (s / segs) * Math.PI * 2;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const row: number[] = [];
        for (let i = 0; i < np; i++) {
          const [r, y] = profile[i];
          _p.set(cx + ca * r, y, cz + sa * r);
          _n.set(ca * pn[i][0], pn[i][1], sa * pn[i][0]);
          row.push(this.vtx(buf, _p, _n, (s / segs) * circ, vlen[i], col));
        }
        base.push(row);
      }
      for (let s = 0; s < segs; s++) {
        for (let i = 0; i < np - 1; i++) {
          const a = base[s][i];
          const b = base[s + 1][i];
          const c = base[s + 1][i + 1];
          const d = base[s][i + 1];
          buf.idx.push(a, c, b, a, d, c);
        }
      }
    }
    const cap = (r: number, y: number, up: boolean) => {
      if (r <= 1e-4) return;
      const center = this.vtx(buf, _p.set(cx, y, cz), _n.set(0, up ? 1 : -1, 0), cx, cz, col);
      const ring: number[] = [];
      for (let s = 0; s <= segs; s++) {
        const ang = (s / segs) * Math.PI * 2;
        const x = cx + Math.cos(ang) * r;
        const z = cz + Math.sin(ang) * r;
        ring.push(this.vtx(buf, _p.set(x, y, z), _n.set(0, up ? 1 : -1, 0), x, z, col));
      }
      for (let s = 0; s < segs; s++) {
        if (up) buf.idx.push(center, ring[s + 1], ring[s]);
        else buf.idx.push(center, ring[s], ring[s + 1]);
      }
    };
    if (opts.capTop) cap(profile[np - 1][0], profile[np - 1][1], true);
    if (opts.capBottom) cap(profile[0][0], profile[0][1], false);
  }

  /**
   * Extrude a 2D profile along a path in the XZ plane (mitred corners).
   * profile: [outwardOffset, y] points. "Outward" is to the LEFT of the path direction,
   * i.e. the same side `wall()` faces — so the facade loop
   * (minX,maxZ) -> (maxX,maxZ) -> (maxX,minZ) -> (minX,minZ) extrudes outwards.
   */
  extrude(key: string, path: V2[], closed: boolean, profile: V2[], opts: { color?: THREE.Color; yOffsets?: number[] } = {}): void {
    const col = opts.color ?? WHITE;
    const n = path.length;
    if (n < 2) return;
    const outs: V2[] = [];
    const scales: number[] = [];
    for (let i = 0; i < n; i++) {
      const prev = closed ? path[(i - 1 + n) % n] : path[Math.max(0, i - 1)];
      const next = closed ? path[(i + 1) % n] : path[Math.min(n - 1, i + 1)];
      const cur = path[i];
      const d0 = norm2([cur[0] - prev[0], cur[1] - prev[1]]);
      const d1 = norm2([next[0] - cur[0], next[1] - cur[1]]);
      const din = i === 0 && !closed ? d1 : d0;
      const dout = i === n - 1 && !closed ? d0 : d1;
      const o0: V2 = [-din[1], din[0]];
      const o1: V2 = [-dout[1], dout[0]];
      const m = norm2([o0[0] + o1[0], o0[1] + o1[1]]);
      const cosHalf = Math.max(0.25, m[0] * o1[0] + m[1] * o1[1]);
      outs.push(m);
      scales.push(1 / cosHalf);
    }
    const segCount = closed ? n : n - 1;
    const np = profile.length;
    const pnorm: V2[] = [];
    for (let k = 0; k < np - 1; k++) {
      const dx = profile[k + 1][0] - profile[k][0];
      const dy = profile[k + 1][1] - profile[k][1];
      const l = Math.hypot(dx, dy) || 1;
      pnorm.push([dy / l, -dx / l]);
    }
    let along = 0;
    for (let s = 0; s < segCount; s++) {
      const i0 = s;
      const i1 = (s + 1) % n;
      const a = path[i0];
      const b = path[i1];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const dir = norm2([b[0] - a[0], b[1] - a[1]]);
      const out: V2 = [-dir[1], dir[0]];
      const ya = opts.yOffsets ? opts.yOffsets[i0] : 0;
      const yb = opts.yOffsets ? opts.yOffsets[i1] : 0;
      for (let k = 0; k < np - 1; k++) {
        const p0 = profile[k];
        const p1 = profile[k + 1];
        const nn = pnorm[k];
        const A: V3 = [a[0] + outs[i0][0] * p0[0] * scales[i0], p0[1] + ya, a[1] + outs[i0][1] * p0[0] * scales[i0]];
        const B: V3 = [b[0] + outs[i1][0] * p0[0] * scales[i1], p0[1] + yb, b[1] + outs[i1][1] * p0[0] * scales[i1]];
        const C: V3 = [b[0] + outs[i1][0] * p1[0] * scales[i1], p1[1] + yb, b[1] + outs[i1][1] * p1[0] * scales[i1]];
        const D: V3 = [a[0] + outs[i0][0] * p1[0] * scales[i0], p1[1] + ya, a[1] + outs[i0][1] * p1[0] * scales[i0]];
        const v0 = p0[1] + p0[0];
        const v1 = p1[1] + p1[0];
        // Profile normal (outward, up) is (dy, -dx) of the profile edge when profile runs bottom->top.
        this.quad(key, A, B, C, D, {
          color: col,
          normal: [out[0] * nn[0], nn[1], out[1] * nn[0]],
          uvs: [
            [along, v0],
            [along + segLen, v0],
            [along + segLen, v1],
            [along, v1],
          ],
        });
      }
      along += segLen;
    }
  }

  /** Flat horizontal polygon (convex or simple) at height y, fan-triangulated via earcut. */
  polygon(key: string, pts: V2[], y: number, opts: { color?: THREE.Color; down?: boolean } = {}): void {
    const buf = this.get(key);
    const col = opts.color ?? WHITE;
    const contour = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base: number[] = [];
    for (const p of pts) base.push(this.vtx(buf, _p.set(p[0], y, p[1]), _n.set(0, opts.down ? -1 : 1, 0), p[0], -p[1], col));
    for (const t of tris) {
      const [p0, p1, p2] = [pts[t[0]], pts[t[1]], pts[t[2]]];
      // y-component of (p1-p0) x (p2-p0) in 3D (x, 0, z) space.
      const ny = (p1[1] - p0[1]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[1] - p0[1]);
      const up = ny > 0;
      if (up !== !!opts.down) buf.idx.push(base[t[0]], base[t[1]], base[t[2]]);
      else buf.idx.push(base[t[0]], base[t[2]], base[t[1]]);
    }
  }

  /** Build meshes, one per material key that exists in `materials`. */
  build(materials: Record<string, THREE.Material>, opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {}): THREE.Group {
    const group = new THREE.Group();
    group.name = opts.name ?? 'built';
    for (const [key, buf] of this.buffers) {
      if (buf.idx.length === 0) continue;
      const mat = materials[key];
      if (!mat) {
        console.warn(`MeshBuilder: no material for key "${key}"`);
        continue;
      }
      const mesh = new THREE.Mesh(buf.toGeometry(), mat);
      mesh.name = key;
      mesh.castShadow = opts.castShadow ?? true;
      mesh.receiveShadow = opts.receiveShadow ?? true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
    }
    return group;
  }

  clear(): void {
    this.buffers.clear();
  }
}

function norm2(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

/** World-metre planar projection UV from a face normal. */
function projUV(p: THREE.Vector3, n: THREE.Vector3): V2 {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  if (ay >= ax && ay >= az) return [p.x, -p.z];
  if (ax >= az) return [n.x > 0 ? -p.z : p.z, p.y];
  return [n.z > 0 ? p.x : -p.x, p.y];
}
