/**
 * Traversal probes (DOM-free, physics ray casts against solid world + props):
 *  - ledges you can grab (wall in front + flat top within reach + room for the hands),
 *  - low obstacles to vault (thin) or mantle (deep),
 *  - grapple targets with aim assist: a fan of rays around the camera centre; wall hits are
 *    snapped up to the roof edge above them, roof hits are used directly; the best-scoring
 *    target in line of sight wins,
 *  - the grapple rope mesh.
 */
import * as THREE from 'three';
import { physics, GROUPS_PROBE } from '../core/Physics';

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

/** Ray cast that ignores hits from rays starting inside geometry (zero normal). */
function ray(o: THREE.Vector3, d: THREE.Vector3, max: number): ReturnType<typeof physics.rayHit> {
  const h = physics.rayHit(o, d, max, GROUPS_PROBE);
  return h && h.normal.lengthSq() > 0.5 ? h : null;
}

export interface Ledge {
  /** Point on the wall top edge. */
  edge: THREE.Vector3;
  /** Wall normal (horizontal, pointing out of the wall towards the player). */
  n: THREE.Vector3;
  top: number;
  /** Free head-room above the top (m). */
  room: number;
}

/** A grabbable ledge in front of `feet` along `dir`, with its top between lo..hi above the feet. */
export function probeLedge(feet: THREE.Vector3, dir: THREE.Vector3, lo: number, hi: number, reach = 0.75): Ledge | null {
  for (const h of [1.25, Math.min(hi - 0.15, 1.9), 0.75]) {
    const o = new THREE.Vector3(feet.x, feet.y + h, feet.z);
    const wall = ray(o, dir, reach);
    if (!wall || Math.abs(wall.normal.y) > 0.35) continue;
    const n = wall.normal.clone().setY(0).normalize();
    const inside = wall.point.clone().addScaledVector(n, -0.22);
    const from = new THREE.Vector3(inside.x, feet.y + hi + 0.6, inside.z);
    const top = ray(from, DOWN, hi - lo + 0.6);
    if (!top || top.normal.y < 0.75 || top.dist < 0.05) continue;
    const ty = top.point.y;
    if (ty < feet.y + lo || ty > feet.y + hi) continue;
    // Something above the top must leave room for hands / body.
    const room = ray(new THREE.Vector3(inside.x, ty + 0.05, inside.z), UP, 2.2);
    const r = room ? room.dist : 2.2;
    if (r < 0.5) continue;
    return { edge: new THREE.Vector3(wall.point.x, ty, wall.point.z), n, top: ty, room: r };
  }
  return null;
}

export interface Obstacle {
  kind: 'vault' | 'mantle';
  top: number;
  /** Landing spot (feet). */
  land: THREE.Vector3;
  edge: THREE.Vector3;
  n: THREE.Vector3;
}

/** Low obstacle ahead while running: vault it if thin, mantle onto it if deep. */
export function probeObstacle(feet: THREE.Vector3, dir: THREE.Vector3, ahead = 1.0): Obstacle | null {
  const o = new THREE.Vector3(feet.x, feet.y + 0.35, feet.z);
  const wall = ray(o, dir, ahead);
  if (!wall || Math.abs(wall.normal.y) > 0.4) return null;
  const n = wall.normal.clone().setY(0).normalize();
  const fwd = n.clone().negate();
  const inside = wall.point.clone().addScaledVector(fwd, 0.18);
  const top = ray(new THREE.Vector3(inside.x, feet.y + 1.9, inside.z), DOWN, 1.9);
  if (!top || top.normal.y < 0.7) return null;
  const h = top.point.y - feet.y;
  if (h < 0.4 || h > 1.3) return null;
  // Head room above the obstacle.
  if (ray(new THREE.Vector3(inside.x, top.point.y + 0.05, inside.z), UP, 1.6)) return null;
  // Thickness: find where the top ends.
  let depth = 0;
  for (let d = 0.3; d <= 1.6; d += 0.3) {
    const p = wall.point.clone().addScaledVector(fwd, d);
    const t = ray(new THREE.Vector3(p.x, top.point.y + 0.3, p.z), DOWN, 0.5);
    if (!t) break;
    depth = d;
  }
  const edge = new THREE.Vector3(wall.point.x, top.point.y, wall.point.z);
  if (depth < 1.2) {
    // Vault: land beyond the far side.
    const land = wall.point.clone().addScaledVector(fwd, depth + 0.9);
    const g = ray(new THREE.Vector3(land.x, top.point.y + 0.4, land.z), DOWN, 4);
    if (!g) return null;
    land.y = g.point.y;
    return { kind: 'vault', top: top.point.y, land, edge, n };
  }
  const land = wall.point.clone().addScaledVector(fwd, 0.45);
  land.y = top.point.y;
  return { kind: 'mantle', top: top.point.y, land, edge, n };
}

export interface GrappleTarget {
  anchor: THREE.Vector3;
  /** Wall normal at the edge (or up for roof points). */
  n: THREE.Vector3;
  roof: boolean;
}

/** Aim-assisted grapple target from the camera. */
export function findGrappleTarget(cam: THREE.Camera, chest: THREE.Vector3, maxDist = 75): GrappleTarget | null {
  const fwd = new THREE.Vector3();
  cam.getWorldDirection(fwd);
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  let best: GrappleTarget | null = null;
  let bestScore = Infinity;
  const offsets: [number, number][] = [
    [0, 0],
    [0, 0.06],
    [0, 0.13],
    [-0.07, 0.04],
    [0.07, 0.04],
    [0, -0.05],
    [-0.13, 0.08],
    [0.13, 0.08],
    [0, 0.22],
  ];
  for (const [ox, oy] of offsets) {
    const d = fwd.clone().addScaledVector(right, ox).addScaledVector(up, oy).normalize();
    const hit = ray(cam.position, d, maxDist + 8);
    if (!hit) continue;
    let anchor: THREE.Vector3;
    let n: THREE.Vector3;
    let roof = false;
    if (hit.normal.y > 0.7) {
      anchor = hit.point.clone();
      n = UP.clone();
      roof = true;
    } else if (Math.abs(hit.normal.y) < 0.35) {
      n = hit.normal.clone().setY(0).normalize();
      const inside = hit.point.clone().addScaledVector(n, -0.25);
      const top = ray(new THREE.Vector3(inside.x, hit.point.y + 70, inside.z), DOWN, 70);
      if (!top || top.normal.y < 0.7) continue;
      // The roof edge above the hit (ignore if it is a different, much higher tier).
      if (top.point.y - hit.point.y > 45) continue;
      anchor = new THREE.Vector3(hit.point.x, top.point.y, hit.point.z);
    } else continue;
    const dist = anchor.distanceTo(chest);
    if (dist > maxDist || dist < 4 || anchor.y < chest.y - 1) continue;
    // Line of sight from the chest to just in front of the anchor.
    const aim = anchor.clone().addScaledVector(n, roof ? 0 : 0.35).add(new THREE.Vector3(0, roof ? 0.4 : -0.3, 0));
    const ld = aim.clone().sub(chest);
    const ll = ld.length();
    const block = ray(chest, ld.normalize(), ll - 0.4);
    if (block) continue;
    const score = Math.hypot(ox, oy) * 40 + dist * 0.02 + (roof ? 0.4 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { anchor, n, roof };
    }
  }
  return best;
}

/** Thin braided line from the gun hand to the anchor. */
export class Rope {
  readonly mesh: THREE.Mesh;
  constructor() {
    const g = new THREE.CylinderGeometry(0.008, 0.008, 1, 5, 1, true);
    g.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x23272c, roughness: 0.55, metalness: 0.4 }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = 'GrappleRope';
  }

  /** Show the rope from `a` towards `b`, extended by fraction `k` (0..1). */
  set(a: THREE.Vector3, b: THREE.Vector3, k: number): void {
    const d = b.clone().sub(a);
    const len = d.length() * k;
    this.mesh.visible = len > 0.05;
    this.mesh.position.copy(a);
    this.mesh.quaternion.setFromUnitVectors(UP, d.normalize());
    this.mesh.scale.set(1, len, 1);
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
