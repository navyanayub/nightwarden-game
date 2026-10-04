/**
 * Optional gore (pause menu, OFF by default): on extreme impacts only (high-speed vehicle hits,
 * explosions) a ragdolled actor can lose a limb at the joint.
 *
 * The limb's triangles (vertices whose dominant bone lies in the limb's bone subtree) are copied
 * into a rigid mesh in bind space; its matrix = detached body × bone offset × bone inverse ×
 * bind matrix, so the clothing shader still paints it correctly. On the body the limb bone is
 * scaled to ~0, collapsing the skin into the joint. Both ends get clean dark sealed caps — no
 * blood, no gore close-ups. Pieces are removed after 20 s.
 */
import * as THREE from 'three';
import type { Actor } from '../actors/Actor';
import type { RagdollPart } from '../physics/Ragdoll';
import { physics } from '../core/Physics';

interface Piece {
  mesh: THREE.Group;
  part: RagdollPart;
  matrix: THREE.Matrix4;
  t: number;
  stumpCap: THREE.Mesh;
}

const capMat = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.7, metalness: 0.1 });

export class Gore {
  private pieces: Piece[] = [];

  constructor(private readonly scene: THREE.Scene) {}

  /** Detach a limb from a ragdolled actor. Returns false if impossible. */
  detach(actor: Actor, name: 'lowerarm_l' | 'lowerarm_r' | 'calf_l' | 'calf_r'): boolean {
    const rd = actor.rig.ragdoll;
    if (!rd || actor.detached.has(name)) return false;
    const part = rd.detach(name);
    if (!part) return false;
    actor.detached.add(name);
    const body = actor.body;
    const skel = body.skeleton;
    const boneIdx = skel.bones.indexOf(part.bone);
    // Bone subtree.
    const sub = new Set<number>();
    part.bone.traverse((o) => {
      const i = skel.bones.indexOf(o as THREE.Bone);
      if (i >= 0) sub.add(i);
    });
    const g = body.geometry;
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const inLimb = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      let best = 0;
      let bi = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > best) {
          best = w;
          bi = si.getComponent(i, k);
        }
      }
      inLimb[i] = sub.has(bi) ? 1 : 0;
    }
    const idx = g.getIndex();
    const tri: number[] = [];
    const n = idx ? idx.count : pos.count;
    for (let t = 0; t < n; t += 3) {
      const a = idx ? idx.getX(t) : t;
      const b = idx ? idx.getX(t + 1) : t + 1;
      const c = idx ? idx.getX(t + 2) : t + 2;
      if (inLimb[a] && inLimb[b] && inLimb[c]) tri.push(a, b, c);
    }
    if (!tri.length) return false;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', pos);
    lg.setAttribute('normal', nrm);
    if (uv) lg.setAttribute('uv', uv);
    lg.setIndex(tri);
    const limb = new THREE.Mesh(lg, body.material);
    limb.castShadow = true;
    // Cap at the joint end of the flying limb (bind space: the bone's bind position).
    const bindPos = new THREE.Vector3().setFromMatrixPosition(skel.boneInverses[boneIdx].clone().invert());
    const r = part.def.r * 1.05;
    const cap = new THREE.Mesh(new THREE.CircleGeometry(r, 14), capMat);
    cap.position.copy(bindPos);
    const childDir = new THREE.Vector3();
    const child = part.bone.children.find((c) => (c as THREE.Bone).isBone);
    if (child) childDir.setFromMatrixPosition(skel.boneInverses[skel.bones.indexOf(child as THREE.Bone)].clone().invert()).sub(bindPos).normalize();
    else childDir.set(0, -1, 0);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), childDir.clone().negate());
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.add(limb, cap);
    this.scene.add(group);
    // Bind-space → world for the rigid limb.
    const m = new THREE.Matrix4().copy(skel.boneInverses[boneIdx]).premultiply(part.offset).multiply(body.bindMatrix);
    // Collapse the limb on the body and seal the stump.
    part.bone.scale.setScalar(0.001);
    part.bone.updateMatrixWorld(true);
    const stump = new THREE.Mesh(new THREE.CircleGeometry(r, 14), capMat);
    const parent = part.bone.parent!;
    parent.updateWorldMatrix(true, false);
    const jw = part.bone.getWorldPosition(new THREE.Vector3());
    stump.position.copy(parent.worldToLocal(jw.clone()));
    const pdir = jw.clone().sub(parent.getWorldPosition(new THREE.Vector3())).normalize();
    const pq = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    stump.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pdir.applyQuaternion(pq));
    stump.scale.divide(parent.getWorldScale(new THREE.Vector3()));
    parent.add(stump);
    // A little extra spin on the free limb.
    part.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * 0.4, y: (Math.random() - 0.5) * 0.4, z: (Math.random() - 0.5) * 0.4 }, true);
    this.pieces.push({ mesh: group, part, matrix: m, t: 0, stumpCap: stump });
    return true;
  }

  update(dt: number): void {
    const bm = new THREE.Matrix4();
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.t += dt;
      const t = p.part.body.translation();
      const q = p.part.body.rotation();
      bm.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(q.x, q.y, q.z, q.w), new THREE.Vector3(1, 1, 1));
      p.mesh.matrix.copy(bm).multiply(p.matrix);
      p.mesh.matrixWorldNeedsUpdate = true;
      if (p.t > 20) {
        p.mesh.removeFromParent();
        // (The limb geometry shares the body's attribute buffers: never dispose it.)
        p.stumpCap.removeFromParent();
        physics.world.removeRigidBody(p.part.body);
        this.pieces.splice(i, 1);
      }
    }
  }

  get count(): number {
    return this.pieces.length;
  }
}
