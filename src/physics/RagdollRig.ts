/**
 * Animation ⇄ ragdoll transitions for one character (player, thug or pedestrian).
 *
 * start():   build a Ragdoll from the current animated pose (seamless hand-over) and let
 *            physics drive the skeleton.
 * update():  writes the bodies into the bones; once the body has settled (and any knockout
 *            timer has run out) it begins a get-up:
 *              - the root is moved under the pelvis and turned to match the lying direction,
 *              - the lying pose is snapshotted as bone-local transforms,
 *              - face up/down picks the get-up: the death clip played backwards for the side it
 *                ends on, a push-up into a crouch for the other,
 *              - the snapshot is blended into the clip over ~0.45 s (postMixer()).
 * The owner stops its own animation layers while `state !== 'off'`.
 */
import * as THREE from 'three';
import { Ragdoll } from './Ragdoll';
import { physics, GROUPS_PROBE } from '../core/Physics';
import { heightAt } from '../world/Terrain';

export interface GetupClips {
  death: THREE.AnimationClip;
  crouch: THREE.AnimationClip;
  /** Standing idle the crouch blends into. */
  stand: THREE.AnimationClip;
}

/** How the death clip ends: face up or down, and the yaw of pelvis→head relative to the root. */
interface DeathPose {
  faceUp: boolean;
  axisYaw: number;
}

const deathPoses = new WeakMap<THREE.AnimationClip, DeathPose>();
const copies = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();

/** One shared copy per source clip (so the death-pose analysis runs once). */
function clipCopy(c: THREE.AnimationClip): THREE.AnimationClip {
  let k = copies.get(c);
  if (!k) {
    k = c.clone();
    copies.set(c, k);
  }
  return k;
}

/** Sample the end of the death clip once on a throwaway copy of a rig. */
export function analyseDeathClip(model: THREE.Object3D, clip: THREE.AnimationClip, bones: Map<string, THREE.Bone>): void {
  if (deathPoses.has(clip)) return;
  const saved = new Map<THREE.Bone, [THREE.Vector3, THREE.Quaternion]>();
  for (const b of bones.values()) saved.set(b, [b.position.clone(), b.quaternion.clone()]);
  const mixer = new THREE.AnimationMixer(model);
  const a = mixer.clipAction(clip);
  a.play();
  a.time = clip.duration - 1e-3;
  mixer.update(0);
  model.updateMatrixWorld(true);
  const rootInv = model.matrixWorld.clone().invert();
  const pelvis = bones.get('pelvis')!.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv);
  const head = bones.get('Head')!.getWorldPosition(new THREE.Vector3()).applyMatrix4(rootInv);
  const q = bones.get('spine_02')!.getWorldQuaternion(new THREE.Quaternion());
  const mq = model.getWorldQuaternion(new THREE.Quaternion()).invert();
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(mq.multiply(q));
  deathPoses.set(clip, { faceUp: fwd.y > 0, axisYaw: Math.atan2(head.x - pelvis.x, head.z - pelvis.z) });
  a.stop();
  mixer.uncacheRoot(model);
  for (const [b, [p, qq]] of saved) {
    b.position.copy(p);
    b.quaternion.copy(qq);
  }
  model.updateMatrixWorld(true);
}

export type RigState = 'off' | 'ragdoll' | 'getup';

export class RagdollRig {
  ragdoll: Ragdoll | null = null;
  state: RigState = 'off';
  /** Seconds to stay down once settled (Infinity = knocked out). */
  stayDown = 1.2;
  private downT = 0;
  private ordered: THREE.Bone[];
  /** Rest (bind) local positions: only the pelvis is animated in translation, so every other
   * bone must get its exact local offset back after physics nudged it. */
  private restP: THREE.Vector3[];
  private posTracked: boolean[];
  private snapQ: THREE.Quaternion[] = [];
  private snapP: THREE.Vector3[] = [];
  private blendT = 0;
  private getupT = 0;
  private getupDur = 1;
  private action: THREE.AnimationAction | null = null;
  private action2: THREE.AnimationAction | null = null;
  private front = false;
  private readonly clips: GetupClips;
  /** Called when the character is back on its feet. */
  onStand: (() => void) | null = null;

  constructor(
    private readonly root: THREE.Object3D,
    private readonly model: THREE.Object3D,
    private readonly bones: Map<string, THREE.Bone>,
    private readonly mixer: THREE.AnimationMixer,
    clips: GetupClips,
    private readonly scale = 1,
  ) {
    // Private copies so the rig's actions never share state with the owner's own actions.
    this.clips = { death: clipCopy(clips.death), crouch: clipCopy(clips.crouch), stand: clipCopy(clips.stand) };
    // Bones sorted parents-first.
    const depth = (b: THREE.Object3D) => {
      let d = 0;
      for (let p = b.parent; p; p = p.parent) d++;
      return d;
    };
    this.ordered = [...bones.values()].sort((a, b) => depth(a) - depth(b));
    this.restP = this.ordered.map((b) => b.position.clone());
    const tracked = new Set<string>();
    for (const c of [clips.death, clips.crouch, clips.stand]) for (const t of c.tracks) if (t.name.endsWith('.position')) tracked.add(t.name.split('.')[0]);
    this.posTracked = this.ordered.map((b) => tracked.has(b.name));
    analyseDeathClip(model, this.clips.death, bones);
  }

  get active(): boolean {
    return this.state !== 'off';
  }

  /** Hand the current pose to physics. */
  start(vel: THREE.Vector3, stayDown: number): Ragdoll {
    this.stop();
    this.root.updateMatrixWorld(true);
    this.ragdoll = new Ragdoll(this.model, this.bones, vel, this.scale);
    this.state = 'ragdoll';
    this.stayDown = stayDown;
    this.downT = 0;
    return this.ragdoll;
  }

  /** Abort everything (despawn / teleport). */
  stop(): void {
    const was = this.state !== 'off';
    this.ragdoll?.dispose();
    this.ragdoll = null;
    this.action?.stop();
    this.action2?.stop();
    this.action = this.action2 = null;
    this.state = 'off';
    if (was) this.restorePositions();
  }

  /** Put every non-animated bone translation (and scale) back to the rest pose. */
  private restorePositions(): void {
    this.ordered.forEach((b, i) => {
      if (!this.posTracked[i]) b.position.copy(this.restP[i]);
      b.scale.set(1, 1, 1);
    });
  }

  update(dt: number): void {
    if (this.state === 'ragdoll' && this.ragdoll) {
      this.ragdoll.apply();
      const settled = this.ragdoll.update(dt);
      if (settled) this.downT += dt;
      // A ragdoll that fell out of the world ends too.
      const p = this.ragdoll.pelvis.translation();
      if (p.y < -20) this.downT = Infinity;
      if (this.downT > this.stayDown || (this.ragdoll.age > 12 && this.stayDown < 100)) this.beginGetup();
    } else if (this.state === 'getup') {
      this.getupT += dt;
      if (this.front && this.action && this.action2 && this.getupT > this.getupDur * 0.55) {
        // Crouch → stand.
        const k = THREE.MathUtils.clamp((this.getupT - this.getupDur * 0.55) / (this.getupDur * 0.45), 0, 1);
        this.action.setEffectiveWeight(1 - k);
        this.action2.setEffectiveWeight(k);
      }
      if (this.getupT >= this.getupDur) {
        this.action?.stop();
        this.action2?.stop();
        this.action = this.action2 = null;
        this.state = 'off';
        this.restorePositions();
        this.onStand?.();
      }
    }
  }

  /** Blend from the lying snapshot into the get-up clip; call right after mixer.update(). */
  postMixer(dt: number): void {
    if (this.state !== 'getup') return;
    this.blendT += dt;
    const w = THREE.MathUtils.smoothstep(this.blendT, 0, 0.45);
    this.ordered.forEach((b, i) => {
      // Untracked translations ease from the lying pose back to the rest offsets.
      const target = this.posTracked[i] ? _va.copy(b.position) : this.restP[i];
      if (w >= 1) {
        if (!this.posTracked[i]) b.position.copy(target);
        return;
      }
      _qa.copy(b.quaternion);
      b.quaternion.copy(this.snapQ[i]).slerp(_qa, w);
      b.position.lerpVectors(this.snapP[i], target, w);
    });
  }

  private beginGetup(): void {
    const rd = this.ragdoll;
    if (!rd) return;
    rd.apply();
    const lay = rd.layout();
    // World transforms of every bone in the lying pose.
    this.model.updateMatrixWorld(true);
    const worlds = this.ordered.map((b) => b.matrixWorld.clone());
    rd.dispose();
    this.ragdoll = null;
    const death = deathPoses.get(this.clips.death)!;
    const faceUp = !lay.faceDown;
    this.front = faceUp !== death.faceUp;
    // Ground under the pelvis.
    const hit = physics.rayHit(new THREE.Vector3(lay.pos.x, lay.pos.y + 0.8, lay.pos.z), new THREE.Vector3(0, -1, 0), 4, GROUPS_PROBE);
    const gy = hit ? hit.point.y : heightAt(lay.pos.x, lay.pos.z);
    this.root.position.set(lay.pos.x, gy, lay.pos.z);
    this.root.rotation.set(0, this.front ? lay.yaw : lay.yaw - death.axisYaw, 0);
    this.root.updateMatrixWorld(true);
    // Re-express the lying pose under the moved root.
    const inv = new THREE.Matrix4();
    const tmp = new THREE.Matrix4();
    const s = new THREE.Vector3();
    this.ordered.forEach((b, i) => {
      b.parent!.updateWorldMatrix(false, false);
      inv.copy(b.parent!.matrixWorld).invert();
      tmp.multiplyMatrices(inv, worlds[i]);
      this.snapP[i] = this.snapP[i] ?? new THREE.Vector3();
      this.snapQ[i] = this.snapQ[i] ?? new THREE.Quaternion();
      tmp.decompose(this.snapP[i], this.snapQ[i], s);
      b.position.copy(this.snapP[i]);
      b.quaternion.copy(this.snapQ[i]);
      b.scale.set(1, 1, 1);
      b.updateMatrixWorld(false);
    });
    this.blendT = 0;
    this.getupT = 0;
    if (!this.front) {
      // Death clip played backwards: lying → standing.
      const a = this.mixer.clipAction(this.clips.death);
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.timeScale = -2.1;
      a.time = this.clips.death.duration - 1e-3;
      a.setEffectiveWeight(1);
      a.play();
      this.action = a;
      this.getupDur = this.clips.death.duration / 2.1;
    } else {
      // Push up into a crouch, then stand.
      const a = this.mixer.clipAction(this.clips.crouch);
      a.reset();
      a.setEffectiveWeight(1);
      a.play();
      this.action = a;
      this.getupDur = 1.15;
      const st = this.mixer.clipAction(this.clips.stand);
      st.reset();
      st.setEffectiveWeight(0);
      st.play();
      this.action2 = st;
    }
    this.state = 'getup';
  }

  get faceDownGetup(): boolean {
    return this.front;
  }
}

const _qa = new THREE.Quaternion();
const _va = new THREE.Vector3();
