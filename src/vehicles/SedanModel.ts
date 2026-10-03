/**
 * Procedural four-door sedan ("Corvane Strata" — a fictional model).
 * The body is lofted from ~110 cross-sections whose bottom edge follows the wheel-arch
 * curves; the glasshouse, pillars and roof come from the same loft so surfaces stay smooth.
 * Front = +Z, up = +Y, origin on the ground under the centre of the wheelbase.
 */
import * as THREE from 'three';
import { MeshBuilder, type V3 } from '../world/MeshBuilder';
import { CAR_DIMS } from './VehicleSim';
import { signs } from '../world/Signage';

export const SEDAN = { ...CAR_DIMS, wheelBase: CAR_DIMS.frontAxle - CAR_DIMS.rearAxle };

export interface SedanParts {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Group[];
  /** Emissive materials toggled by the vehicle. */
  brakeMat: THREE.MeshStandardMaterial;
  reverseMat: THREE.MeshStandardMaterial;
  headMat: THREE.MeshStandardMaterial;
  paint: THREE.MeshPhysicalMaterial;
  seat: THREE.Object3D;
}

const L = SEDAN.length / 2;

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Half width in plan view, rounded at both ends. */
function halfWidth(z: number): number {
  const w = SEDAN.width / 2;
  const front = 1 - smoothstep(L - 0.42, L, z);
  const rear = 1 - smoothstep(L - 0.36, L, -z);
  const round = (t: number) => Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  return w * (0.74 + 0.26 * Math.min(round(front), round(rear))) - 0.01 * Math.max(0, z) / L;
}

function archBottom(z: number): number {
  let y = 0.2 + 0.1 * smoothstep(L - 0.8, L, z) + 0.12 * smoothstep(L - 0.7, L, -z);
  for (const a of [SEDAN.frontAxle, SEDAN.rearAxle]) {
    const r = 0.405;
    const d = z - a;
    if (Math.abs(d) < r) y = Math.max(y, SEDAN.wheelRadius + Math.sqrt(r * r - d * d) - 0.02);
  }
  return y;
}

function beltY(z: number): number {
  return 0.96 + 0.06 * smoothstep(1.2, -1.6, z);
}

/** Top of the body (hood / deck) where there is no glasshouse. */
function deckY(z: number): number {
  if (z > 0.9) return 0.97 - 0.17 * smoothstep(0.9, L, z) - 0.06 * smoothstep(L - 0.25, L, z);
  if (z < -1.3) return 1.03 - 0.04 * smoothstep(-1.3, -L + 0.2, z) - 0.2 * smoothstep(-L + 0.25, -L, z);
  return 1.0;
}

/** Glasshouse top line (windshield, roof, rear window). */
function roofY(z: number): number {
  const ws0 = 0.92;
  const ws1 = 0.02;
  const rw0 = -0.78;
  const rw1 = -1.42;
  if (z >= ws0 || z <= rw1) return -1;
  if (z > ws1) return 1.0 + 0.44 * Math.pow(smoothstep(ws0, ws1, z), 0.8);
  if (z < rw0) return 1.02 + 0.41 * Math.pow(smoothstep(rw1, rw0, z), 0.85);
  return 1.44 - 0.012 * Math.pow((z - (ws1 + rw0) / 2) / 0.4, 2);
}

/** Cross-section (right half, x >= 0) from bottom centre to roof centre. */
function section(z: number): { pts: [number, number][]; glassFrom: number } {
  const w = halfWidth(z);
  const yb = archBottom(z);
  const ys = beltY(z);
  const yd = deckY(z);
  const yr = roofY(z);
  const y2 = Math.max(yb + 0.06, Math.min(0.42, ys - 0.2));
  const y3 = Math.max(y2 + 0.04, Math.min(0.62, ys - 0.12));
  const y4 = Math.max(y3 + 0.03, ys - 0.05);
  const pts: [number, number][] = [
    [0, yb],
    [w - 0.1, yb],
    [w - 0.015, y2],
    [w, y3],
    [w - 0.012, y4],
    [w - 0.04, Math.max(ys, y4 + 0.01)],
  ];
  // Glasshouse: seal, four window rows, roof rail (collapses where there is no cabin).
  const glassFrom = pts.length;
  const top = yr > 0 ? Math.max(yr, yd) : yd;
  const base = pts[pts.length - 1][1];
  const gh = Math.max(0, top - base);
  const cabin = yr > 0;
  const inset = (t: number) => (cabin ? 0.045 + 0.3 * t * t : 0.05 + 0.12 * t);
  for (const t of [0.06, 0.2, 0.42, 0.66, 0.9, 1.0]) pts.push([w - inset(t) - 0.04, base + gh * t]);
  const edgeX = pts[pts.length - 1][0];
  const crown = cabin ? 0.03 : 0.035;
  pts.push([edgeX * 0.55, top + crown * 0.75]);
  pts.push([0, top + crown]);
  return { pts, glassFrom };
}

export function buildSedan(color: THREE.Color): SedanParts {
  const mats = sedanMaterials(color);
  const mb = new MeshBuilder();
  // ---------------------------------------------------------------- body loft
  const stations: number[] = [];
  for (let z = -L; z <= L + 1e-6; z += 0.045) stations.push(Math.min(z, L));
  if (stations[stations.length - 1] < L) stations.push(L);
  const secs = stations.map((z) => section(z));
  const np = secs[0].pts.length;
  const gf = secs[0].glassFrom;
  const glassAt = (z: number, k: number): 'glass' | 'paint' | 'trim' => {
    const yr = roofY(z);
    if (k < gf - 1 || yr < 0) return 'paint';
    if (k === gf - 1) return 'trim';
    const windshield = z > 0.06;
    const rearWindow = z < -0.84;
    if (k >= gf + 5) return windshield || rearWindow ? 'glass' : 'paint';
    if (k === gf + 4) return 'paint';
    // Side glass rows.
    if (z > 0.72) return 'paint';
    if (z < -0.98) return 'paint';
    if (Math.abs(z + 0.22) < 0.07 || Math.abs(z + 0.76) < 0.05) return 'trim';
    return 'glass';
  };
  for (let i = 0; i < stations.length - 1; i++) {
    const za = stations[i];
    const zb = stations[i + 1];
    const A = secs[i].pts;
    const B = secs[i + 1].pts;
    for (let k = 0; k < np - 1; k++) {
      const zm = (za + zb) / 2;
      const kind = glassAt(zm, k);
      const key = kind === 'glass' ? 'car_glass' : kind === 'trim' ? 'car_trim' : 'car_paint';
      for (const side of [1, -1]) {
        const p0: V3 = [A[k][0] * side, A[k][1], za];
        const p1: V3 = [B[k][0] * side, B[k][1], zb];
        const p2: V3 = [B[k + 1][0] * side, B[k + 1][1], zb];
        const p3: V3 = [A[k + 1][0] * side, A[k + 1][1], za];
        if (side > 0) mb.quad(key, p1, p0, p3, p2);
        else mb.quad(key, p0, p1, p2, p3);
      }
    }
  }
  // End caps (front fascia / rear panel).
  for (const [idx, sign] of [
    [0, -1],
    [stations.length - 1, 1],
  ] as [number, number][]) {
    const pts = secs[idx].pts;
    const z = stations[idx];
    for (let k = 0; k < np - 1; k++) {
      for (const side of [1, -1]) {
        const a: V3 = [0, pts[k][1], z];
        const b: V3 = [pts[k][0] * side, pts[k][1], z];
        const c: V3 = [pts[k + 1][0] * side, pts[k + 1][1], z];
        const d: V3 = [0, pts[k + 1][1], z];
        if (sign * side > 0) mb.quad('car_paint', a, b, c, d);
        else mb.quad('car_paint', b, a, d, c);
      }
    }
  }
  // ---------------------------------------------------------------- details
  const fz = L;
  const rz = -L;
  // Grille + lower intake.
  mb.box('car_black', -0.5, 0.38, fz - 0.06, 0.5, 0.6, fz + 0.012);
  for (let k = 0; k < 6; k++) mb.box('car_chrome', -0.48, 0.4 + k * 0.035, fz, 0.48, 0.41 + k * 0.035, fz + 0.02);
  mb.box('car_black', -0.62, 0.22, fz - 0.12, 0.62, 0.33, fz + 0.03);
  // Headlights (slanted clusters).
  for (const s of [-1, 1]) {
    const x0 = s * 0.56;
    const x1 = s * 0.84;
    mb.pushTRS((x0 + x1) / 2, 0.69, fz - 0.1, 0);
    mb.box('car_chrome', -0.15, -0.06, -0.08, 0.15, 0.06, 0.1);
    mb.box('car_headlight', -0.13, -0.045, 0.06, 0.13, 0.045, 0.11);
    mb.box('car_drl', -0.14, -0.065, 0.085, 0.14, -0.05, 0.115);
    mb.popTransform();
    // Fog light.
    mb.cylinder('car_headlight', s * 0.68, 0.27, fz - 0.02, 0.05, 0.05, 0.001, 12);
  }
  // Taillights: full-width bar + corner clusters.
  mb.box('car_brake', -0.62, 0.86, rz - 0.035, 0.62, 0.9, rz + 0.06);
  for (const s of [-1, 1]) {
    mb.box('car_brake', s * 0.78 - 0.14, 0.78, rz - 0.04, s * 0.78 + 0.14, 0.92, rz + 0.12);
    mb.box('car_reverse', s * 0.55 - 0.06, 0.8, rz - 0.035, s * 0.55 + 0.06, 0.85, rz + 0.05);
  }
  // Bumpers / diffuser / exhausts.
  mb.box('car_black', -0.8, 0.25, rz - 0.04, 0.8, 0.36, rz + 0.18);
  for (const s of [-1, 1]) mb.cylinder('car_chrome', s * 0.5, 0.28, rz + 0.05, 0.045, 0.045, 0.001, 12);
  for (const s of [-1, 1]) {
    mb.pushTRS(s * 0.5, 0.28, rz + 0.05, 0);
    mb.pushTransform(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    mb.lathe('car_chrome', 0, 0, [[0.045, -0.1], [0.045, 0.12]], 12);
    mb.popTransform();
    mb.popTransform();
  }
  // License plates.
  const plate = signs().extraUV('plate');
  const plateQuad = (z: number, front: boolean) => {
    const x = 0.26;
    const y0 = front ? 0.3 : 0.5;
    const y1 = y0 + 0.11;
    const zz = front ? z + 0.035 : z - 0.045;
    if (front) mb.quad('car_plate', [-x, y0, zz], [x, y0, zz], [x, y1, zz], [-x, y1, zz], { uvs: [[plate[0], plate[1]], [plate[2], plate[1]], [plate[2], plate[3]], [plate[0], plate[3]]] });
    else mb.quad('car_plate', [x, y0, zz], [-x, y0, zz], [-x, y1, zz], [x, y1, zz], { uvs: [[plate[0], plate[1]], [plate[2], plate[1]], [plate[2], plate[3]], [plate[0], plate[3]]] });
  };
  plateQuad(fz, true);
  mb.box('car_black', -0.28, 0.48, rz - 0.04, 0.28, 0.63, rz + 0.02);
  plateQuad(rz, false);
  // Badge.
  mb.lathe('car_chrome', 0, 0, [[0.0, 0], [0.05, 0]], 4);
  mb.pushTRS(0, 0.63, fz + 0.012, 0);
  mb.pushTransform(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  mb.lathe('car_chrome', 0, 0, [[0.07, 0], [0.07, 0.015], [0.0, 0.02]], 16, { capTop: true });
  mb.popTransform();
  mb.popTransform();
  // Mirrors, door handles, seams, window trim.
  for (const s of [-1, 1]) {
    const mx = s * (halfWidth(0.75) + 0.08);
    mb.pushTRS(mx, beltY(0.75) + 0.12, 0.72, s * 0.15);
    mb.box('car_paint', -0.09, -0.06, -0.07, 0.09, 0.07, 0.06);
    mb.box('car_glass_mirror', -0.075, -0.05, -0.075, 0.075, 0.055, -0.068);
    mb.popTransform();
    mb.box('car_black', mx - s * 0.08 - 0.015, beltY(0.75) + 0.08, 0.68, mx - s * 0.08 + 0.015, beltY(0.75) + 0.1, 0.76);
    for (const hz of [0.32, -0.62]) {
      const hx = s * (halfWidth(hz) + 0.004);
      mb.box('car_chrome', hx - 0.012, 0.86, hz - 0.1, hx + 0.012, 0.885, hz + 0.05);
    }
    for (const sz of [0.86, -0.22, -1.02]) {
      const x = s * (halfWidth(sz) + 0.002);
      mb.box('car_black', x - 0.003, archBottom(sz) + 0.05, sz - 0.004, x + 0.003, beltY(sz) - 0.02, sz + 0.004);
    }
    // Chrome window line.
    mb.beam('car_chrome', [s * (halfWidth(0.85) - 0.035), beltY(0.85) + 0.012, 0.85], [s * (halfWidth(-1.2) - 0.035), beltY(-1.2) + 0.012, -1.2], 0.018);
    // Side skirt.
    mb.beam('car_black', [s * (halfWidth(0.9) - 0.04), 0.24, 0.92], [s * (halfWidth(-1.0) - 0.04), 0.24, -0.98], 0.07, { height: 0.08 });
  }
  // Wheel arch liners.
  for (const az of [SEDAN.frontAxle, SEDAN.rearAxle]) {
    for (const s of [-1, 1]) {
      const segs = 10;
      for (let k = 0; k < segs; k++) {
        const a0 = (k / segs) * Math.PI;
        const a1 = ((k + 1) / segs) * Math.PI;
        const r = 0.39;
        const y0 = SEDAN.wheelRadius + Math.sin(a0) * r;
        const y1 = SEDAN.wheelRadius + Math.sin(a1) * r;
        const z0 = az + Math.cos(a0) * r;
        const z1 = az + Math.cos(a1) * r;
        const xo = s * (SEDAN.width / 2 - 0.02);
        const xi = s * (SEDAN.width / 2 - 0.34);
        if (s > 0) mb.quad('car_black', [xi, y0, z0], [xo, y0, z0], [xo, y1, z1], [xi, y1, z1]);
        else mb.quad('car_black', [xo, y0, z0], [xi, y0, z0], [xi, y1, z1], [xo, y1, z1]);
      }
    }
  }
  // Underbody.
  mb.box('car_black', -0.82, 0.16, -L + 0.4, 0.82, 0.24, L - 0.35, { skip: ['py'] });
  // Interior: seats, dashboard, steering wheel, rear bench.
  mb.box('car_interior', -0.85, 0.42, -1.45, 0.85, 0.55, 1.0);
  for (const sx of [-0.4, 0.4]) {
    mb.box('car_seat', sx - 0.25, 0.55, 0.0, sx + 0.25, 0.68, 0.48);
    mb.pushTRS(sx, 0.68, -0.02, 0);
    mb.pushTransform(new THREE.Matrix4().makeRotationX(-0.25));
    mb.box('car_seat', -0.25, 0, -0.08, 0.25, 0.62, 0.06);
    mb.box('car_seat', -0.13, 0.64, -0.06, 0.13, 0.8, 0.04);
    mb.popTransform();
    mb.popTransform();
  }
  mb.box('car_seat', -0.75, 0.55, -1.05, 0.75, 0.68, -0.6);
  mb.box('car_seat', -0.75, 0.68, -1.12, 0.75, 1.18, -1.02);
  mb.box('car_interior', -0.82, 0.68, 0.72, 0.82, 0.98, 1.0);
  mb.box('car_trim', -0.8, 0.96, 0.82, 0.8, 0.99, 0.9);
  const seat = new THREE.Object3D();
  seat.position.set(0.4, 0.5, 0.2);
  mb.pushTRS(0.4, 0.93, 0.62, 0);
  mb.pushTransform(new THREE.Matrix4().makeRotationX(-1.15));
  mb.lathe('car_black', 0, 0, [[0.18, -0.02], [0.2, 0.0], [0.18, 0.02], [0.16, 0.0], [0.18, -0.02]], 18);
  mb.cylinder('car_black', 0, -0.25, 0, 0.03, 0.03, 0.25, 8);
  mb.popTransform();
  mb.popTransform();
  const body = mb.build(mats.byKey, { name: 'sedanBody' });
  // Smooth shading for the paint loft: merge vertices & recompute normals.
  for (const child of body.children) {
    const m = child as THREE.Mesh;
    if (m.name === 'car_paint' || m.name === 'car_glass' || m.name === 'car_trim') smoothNormals(m.geometry);
    if (m.name === 'car_glass') {
      m.castShadow = false;
      m.renderOrder = 2;
    }
  }
  const root = new THREE.Group();
  root.name = 'Sedan';
  root.add(body);
  root.add(seat);
  // ---------------------------------------------------------------- wheels
  const wheels: THREE.Group[] = [];
  const wheelGeo = buildWheel(mats.byKey);
  for (const [x, z] of [
    [SEDAN.track / 2, SEDAN.frontAxle],
    [-SEDAN.track / 2, SEDAN.frontAxle],
    [SEDAN.track / 2, SEDAN.rearAxle],
    [-SEDAN.track / 2, SEDAN.rearAxle],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, SEDAN.wheelRadius, z);
    const spin = new THREE.Group();
    spin.name = 'spin';
    const w = wheelGeo.clone();
    if (x < 0) w.rotation.y = Math.PI;
    spin.add(w);
    pivot.add(spin);
    root.add(pivot);
    wheels.push(pivot);
  }
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      if (m.name !== 'car_glass') m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return { root, body, wheels, brakeMat: mats.brake, reverseMat: mats.reverse, headMat: mats.head, paint: mats.paint, seat };
}

function buildWheel(mats: Record<string, THREE.Material>): THREE.Group {
  const mb = new MeshBuilder();
  const R = SEDAN.wheelRadius;
  // Lathe around the local Y axis, then rotate so the axle is X. Outer face = +X.
  const tyre: [number, number][] = [
    [0.235, -0.11],
    [0.27, -0.118],
    [0.31, -0.115],
    [0.33, -0.1],
    [R, -0.075],
    [R + 0.002, 0],
    [R, 0.075],
    [0.33, 0.1],
    [0.31, 0.115],
    [0.27, 0.118],
    [0.235, 0.11],
  ];
  mb.lathe('car_tyre', 0, 0, tyre, 36);
  // Rim barrel, lip and dish.
  mb.lathe('car_rim', 0, 0, [[0.235, 0.112], [0.24, 0.1], [0.232, 0.08], [0.225, -0.09], [0.21, -0.1]], 28);
  mb.lathe('car_rim', 0, 0, [[0.2, 0.06], [0.07, 0.085], [0.06, 0.1], [0.0, 0.1]], 24, { capTop: true });
  // Spokes (twin 5-spoke).
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + (k % 2) * 0.12;
    const p0: V3 = [Math.cos(a) * 0.06, 0.088, Math.sin(a) * 0.06];
    const p1: V3 = [Math.cos(a) * 0.222, 0.075, Math.sin(a) * 0.222];
    mb.beam('car_rim', p0, p1, 0.026, { height: 0.035 });
  }
  // Lug nuts & brake disc / caliper.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    mb.cylinder('car_chrome', Math.cos(a) * 0.04, 0.1, Math.sin(a) * 0.04, 0.009, 0.009, 0.012, 6);
  }
  mb.lathe('car_disc', 0, 0, [[0.19, -0.02], [0.19, 0.02], [0.06, 0.02], [0.06, -0.02]], 28);
  mb.box('car_caliper', 0.12, -0.04, -0.06, 0.2, 0.035, 0.06);
  const g = mb.build(mats, { name: 'wheel' });
  for (const c of g.children) smoothNormals((c as THREE.Mesh).geometry, 0.6);
  // Axle along X: rotate lathe Y axis to X.
  g.rotation.z = -Math.PI / 2;
  const outer = new THREE.Group();
  outer.add(g);
  return outer;
}

/** Weld coincident vertices and recompute smooth normals (keeps hard edges above angle). */
function smoothNormals(geo: THREE.BufferGeometry, creaseCos = 0.35): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
  const map = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
    const arr = map.get(k);
    if (arr) arr.push(i);
    else map.set(k, [i]);
  }
  const out = new Float32Array(nor.count * 3);
  const n = new THREE.Vector3();
  const m = new THREE.Vector3();
  for (const idxs of map.values()) {
    for (const i of idxs) {
      n.set(nor.getX(i), nor.getY(i), nor.getZ(i));
      const acc = new THREE.Vector3();
      for (const j of idxs) {
        m.set(nor.getX(j), nor.getY(j), nor.getZ(j));
        if (n.dot(m) > creaseCos) acc.add(m);
      }
      acc.normalize();
      out[i * 3] = acc.x;
      out[i * 3 + 1] = acc.y;
      out[i * 3 + 2] = acc.z;
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
}

function sedanMaterials(color: THREE.Color) {
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04, vertexColors: false });
  const brake = new THREE.MeshStandardMaterial({ color: 0x3a0303, emissive: new THREE.Color(1, 0.04, 0.02), emissiveIntensity: 0.6, roughness: 0.25 });
  const reverse = new THREE.MeshStandardMaterial({ color: 0x777777, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, roughness: 0.2 });
  const head = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: new THREE.Color(1, 0.97, 0.9), emissiveIntensity: 1.5, roughness: 0.1, metalness: 0.2 });
  const byKey: Record<string, THREE.Material> = {
    car_paint: paint,
    car_glass: new THREE.MeshPhysicalMaterial({ color: 0x0b0f12, metalness: 0.0, roughness: 0.02, transparent: true, opacity: 0.55, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide }),
    car_glass_mirror: new THREE.MeshStandardMaterial({ color: 0xbfcad0, metalness: 1, roughness: 0.02 }),
    car_trim: new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.35, metalness: 0.3 }),
    car_black: new THREE.MeshStandardMaterial({ color: 0x101112, roughness: 0.6, metalness: 0.1 }),
    car_chrome: new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.08, metalness: 1 }),
    car_headlight: head,
    car_drl: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(0.85, 0.92, 1), emissiveIntensity: 3, roughness: 0.2 }),
    car_brake: brake,
    car_reverse: reverse,
    car_plate: signs().material,
    car_interior: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.8 }),
    car_seat: new THREE.MeshStandardMaterial({ color: 0x2a2523, roughness: 0.75 }),
    car_tyre: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.88 }),
    car_rim: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, roughness: 0.25, metalness: 0.95 }),
    car_disc: new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.45, metalness: 0.9 }),
    car_caliper: new THREE.MeshStandardMaterial({ color: 0xa01818, roughness: 0.4, metalness: 0.3 }),
  };
  return { byKey, paint, brake, reverse, head };
}
