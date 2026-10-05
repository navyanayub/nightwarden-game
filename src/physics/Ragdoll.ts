/**
 * Jointed Rapier ragdoll for any character on the shared Quaternius skeleton
 * (player, thugs, pedestrians): 11 capsule bodies — pelvis, torso, head, upper/lower arms,
 * upper/lower legs.
 *
 * Built from the character's *current* animated pose, so the switch from animation to physics
 * is seamless; every body starts with the same world rotation (the capsule colliders carry the
 * limb orientation), which makes the creation pose the zero of every joint: spherical joints
 * get per-axis angular limits around it, elbows and knees are revolute hinges limited to their
 * anatomical range (straight .. fully bent).
 *
 * `apply()` writes the bodies back into the skeleton (bone world = body × stored offset), and
 * `detach()` breaks a limb off at its joint (gore option; see combat/Gore.ts).
 */
import * as THREE from 'three';
import { physics, RAPIER, GROUPS_RAGDOLL } from '../core/Physics';

interface PartDef {
  name: string;
  bone: string;
  /** Bone whose position ends the capsule (or a fixed length along the parent direction). */
  end: string | null;
  len?: number;
  r: number;
  parent: string | null;
  joint: 'sph' | 'hinge' | null;
  lim?: number;
  mass: number;
}

export const RAGDOLL_DEFS: PartDef[] = [
  { name: 'pelvis', bone: 'pelvis', end: 'spine_02', r: 0.12, parent: null, joint: null, mass: 12 },
  { name: 'torso', bone: 'spine_02', end: 'neck_01', r: 0.13, parent: 'pelvis', joint: 'sph', lim: 0.5, mass: 18 },
  { name: 'head', bone: 'Head', end: null, len: 0.2, r: 0.095, parent: 'torso', joint: 'sph', lim: 0.6, mass: 5 },
  { name: 'upperarm_l', bone: 'upperarm_l', end: 'lowerarm_l', r: 0.05, parent: 'torso', joint: 'sph', lim: 1.3, mass: 2.5 },
  { name: 'lowerarm_l', bone: 'lowerarm_l', end: 'hand_l', len: 0.12, r: 0.042, parent: 'upperarm_l', joint: 'hinge', mass: 2 },
  { name: 'upperarm_r', bone: 'upperarm_r', end: 'lowerarm_r', r: 0.05, parent: 'torso', joint: 'sph', lim: 1.3, mass: 2.5 },
  { name: 'lowerarm_r', bone: 'lowerarm_r', end: 'hand_r', len: 0.12, r: 0.042, parent: 'upperarm_r', joint: 'hinge', mass: 2 },
  { name: 'thigh_l', bone: 'thigh_l', end: 'calf_l', r: 0.075, parent: 'pelvis', joint: 'sph', lim: 1.0, mass: 8 },
  { name: 'calf_l', bone: 'calf_l', end: 'foot_l', len: 0.1, r: 0.055, parent: 'thigh_l', joint: 'hinge', mass: 4.5 },
  { name: 'thigh_r', bone: 'thigh_r', end: 'calf_r', r: 0.075, parent: 'pelvis', joint: 'sph', lim: 1.0, mass: 8 },
  { name: 'calf_r', bone: 'calf_r', end: 'foot_r', len: 0.1, r: 0.055, parent: 'thigh_r', joint: 'hinge', mass: 4.5 },
];

export interface RagdollPart {
  def: PartDef;
  bone: THREE.Bone;
  body: RAPIER.RigidBody;
  /** Body-space → bone-world offset. */
  offset: THREE.Matrix4;
  joint: RAPIER.ImpulseJoint | null;
  detached: boolean;
  /** Capsule half segment (m) and radius, for gore/limb meshes. */
  half: number;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class Ragdoll {
  readonly parts: RagdollPart[] = [];
  private byName = new Map<string, RagdollPart>();
  private disposed = false;
  /** Seconds the ragdoll has been almost still. */
  restTime = 0;
  age = 0;

  /**
   * @param root   character root (its world matrix must be current)
   * @param bones  name → bone lookup
   * @param vel    initial linear velocity for every part
   */
  constructor(root: THREE.Object3D, bones: Map<string, THREE.Bone>, vel: THREE.Vector3, scale = 1) {
    root.updateMatrixWorld(true);
    const w = physics.world;
    for (const d of RAGDOLL_DEFS) {
      const bone = bones.get(d.bone)!;
      bone.getWorldPosition(_a);
      if (d.end) {
        bones.get(d.end)!.getWorldPosition(_b);
        if (d.len) _b.add(_b.clone().sub(_a).normalize().multiplyScalar(d.len * scale));
      } else {
        // Head: along the neck → head direction.
        const neck = bones.get('neck_01')!.getWorldPosition(new THREE.Vector3());
        _b.copy(_a).addScaledVector(_a.clone().sub(neck).normalize(), (d.len ?? 0.2) * scale);
      }
      const r = d.r * scale;
      const seg = _b.clone().sub(_a);
      const len = Math.max(0.02, seg.length());
      const mid = _a.clone().add(_b).multiplyScalar(0.5);
      const half = Math.max(0.005, len / 2 - r * 0.6);
      const body = w.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(mid.x, mid.y, mid.z)
          .setLinvel(vel.x, vel.y, vel.z)
          .setLinearDamping(0.05)
          .setAngularDamping(1.2)
          .setCcdEnabled(d.name === 'torso' || d.name === 'pelvis'),
      );
      const rot = new THREE.Quaternion().setFromUnitVectors(UP, seg.clone().normalize());
      const vol = Math.PI * r * r * (half * 2 + (4 / 3) * r);
      w.createCollider(
        RAPIER.ColliderDesc.capsule(half, r)
          .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
          .setDensity((d.mass * scale * scale * scale) / vol)
          .setFriction(0.8)
          .setRestitution(0.05)
          .setCollisionGroups(GROUPS_RAGDOLL),
        body,
      );
      // Offset: body (identity rotation at mid) → bone world.
      _m.makeTranslation(mid.x, mid.y, mid.z).invert();
      const offset = _m.clone().multiply(bone.matrixWorld);
      const part: RagdollPart = { def: d, bone, body, offset, joint: null, detached: false, half };
      this.parts.push(part);
      this.byName.set(d.name, part);
    }
    // Joints at the child bone's origin.
    for (const p of this.parts) {
      if (!p.def.parent) continue;
      const parent = this.byName.get(p.def.parent)!;
      p.bone.getWorldPosition(_a);
      const pa = parent.body.translation();
      const ca = p.body.translation();
      const anc1 = { x: _a.x - pa.x, y: _a.y - pa.y, z: _a.z - pa.z };
      const anc2 = { x: _a.x - ca.x, y: _a.y - ca.y, z: _a.z - ca.z };
      let joint: RAPIER.ImpulseJoint;
      if (p.def.joint === 'hinge') {
        // Hinge axis from the current bend; positive rotation = more bend.
        const up = parent.bone.getWorldPosition(new THREE.Vector3());
        const u = _a.clone().sub(up).normalize();
        const tip = p.body.translation();
        const l = new THREE.Vector3(tip.x, tip.y, tip.z).sub(_a).normalize();
        let axis = u.clone().cross(l);
        const bend = Math.acos(THREE.MathUtils.clamp(u.dot(l), -1, 1));
        if (axis.lengthSq() < 1e-4) {
          // Straight limb: knees bend backwards, elbows forwards, relative to the torso.
          const torsoQ = this.byName.get('torso')!.bone.getWorldQuaternion(new THREE.Quaternion());
          const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(torsoQ);
          const knee = p.def.name.startsWith('calf');
          axis = u.clone().cross(knee ? fwd.negate() : fwd);
        }
        axis.normalize();
        const jd = RAPIER.JointData.revolute(anc1, anc2, { x: axis.x, y: axis.y, z: axis.z });
        joint = physics.world.createImpulseJoint(jd, parent.body, p.body, true);
        (joint as RAPIER.RevoluteImpulseJoint).setLimits(-bend + 0.03, 2.45 - bend);
      } else {
        joint = physics.world.createImpulseJoint(RAPIER.JointData.spherical(anc1, anc2), parent.body, p.body, true);
        const lim = p.def.lim ?? 0.8;
        const raw = (physics.world.impulseJoints as unknown as { raw: { jointSetLimits(h: number, axis: number, min: number, max: number): void } }).raw;
        raw.jointSetLimits(joint.handle, RAPIER.JointAxis.AngX, -lim, lim);
        raw.jointSetLimits(joint.handle, RAPIER.JointAxis.AngY, -lim * 0.6, lim * 0.6);
        raw.jointSetLimits(joint.handle, RAPIER.JointAxis.AngZ, -lim, lim);
      }
      joint.setContactsEnabled(false);
      p.joint = joint;
    }
  }

  part(name: string): RagdollPart | undefined {
    return this.byName.get(name);
  }

  get pelvis(): RAPIER.RigidBody {
    return this.parts[0].body;
  }

  /** Linear impulse at a world point on the nearest part (or a named part). */
  impulse(j: THREE.Vector3, at?: THREE.Vector3, partName?: string): void {
    let best = this.parts[1];
    if (partName) best = this.byName.get(partName) ?? best;
    else if (at) {
      let bd = Infinity;
      for (const p of this.parts) {
        const t = p.body.translation();
        const d = (t.x - at.x) ** 2 + (t.y - at.y) ** 2 + (t.z - at.z) ** 2;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
    }
    const pt = at ?? best.body.translation();
    best.body.applyImpulseAtPoint({ x: j.x, y: j.y, z: j.z }, { x: pt.x, y: pt.y, z: pt.z }, true);
  }

  /** Spread an impulse over all parts (explosions, vehicle hits). */
  impulseAll(j: THREE.Vector3, spin = 0): void {
    for (const p of this.parts) {
      const m = p.body.mass();
      p.body.applyImpulse({ x: j.x * m * 0.0125, y: j.y * m * 0.0125, z: j.z * m * 0.0125 }, true);
      if (spin) p.body.applyTorqueImpulse({ x: (Math.sin(m) * spin * m) / 80, y: 0, z: (Math.cos(m) * spin * m) / 80 }, true);
    }
  }

  /** Write physics poses into the skeleton. */
  apply(): void {
    for (const p of this.parts) {
      // A detached limb keeps its last local pose (collapsed at the stump); its mesh copy flies.
      if (p.detached) continue;
      const t = p.body.translation();
      const r = p.body.rotation();
      _m.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s.set(1, 1, 1)).multiply(p.offset);
      const parent = p.bone.parent!;
      parent.updateWorldMatrix(true, false);
      _m2.copy(parent.matrixWorld).invert().multiply(_m);
      _m2.decompose(p.bone.position, p.bone.quaternion, _s);
      p.bone.scale.copy(_s);
      p.bone.updateMatrixWorld(true);
    }
  }

  /** Track stillness; returns true once settled. */
  update(dt: number): boolean {
    this.age += dt;
    const v = this.pelvis.linvel();
    const s = Math.hypot(v.x, v.y, v.z);
    const t = this.parts[1].body.linvel();
    const s2 = Math.hypot(t.x, t.y, t.z);
    if (s < 0.35 && s2 < 0.5) this.restTime += dt;
    else this.restTime = 0;
    return this.restTime > 0.3;
  }

  /** Pelvis world position and whether the character lies face down. */
  layout(): { pos: THREE.Vector3; faceDown: boolean; yaw: number } {
    const torso = this.byName.get('torso')!.bone;
    const pelvis = this.parts[0].bone;
    const q = torso.getWorldQuaternion(new THREE.Quaternion());
    // Character forward (+Z in bind space) in world.
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const pos = pelvis.getWorldPosition(new THREE.Vector3());
    const head = this.byName.get('head')!.bone.getWorldPosition(new THREE.Vector3());
    // Yaw from pelvis towards the head (body axis along the ground).
    const yaw = Math.atan2(head.x - pos.x, head.z - pos.z);
    return { pos, faceDown: fwd.y < 0, yaw };
  }

  /** Break a limb off at its joint (gore). Returns the freed part. */
  detach(name: string): RagdollPart | null {
    const p = this.byName.get(name);
    if (!p || p.detached || !p.joint) return null;
    physics.world.removeImpulseJoint(p.joint, true);
    p.joint = null;
    p.detached = true;
    return p;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Detached limbs are owned (and removed) by the gore system.
    for (const p of this.parts) if (!p.detached) physics.world.removeRigidBody(p.body);
  }
}
