/**
 * Bakes skeletal animation clips into a float texture of bone matrices (one row per frame,
 * 4 RGBA texels per bone), so thousands of instanced characters can be skinned on the GPU
 * without per-character AnimationMixers.
 *
 * Extra "pose layers" are produced at bake time with a two-bone IK on the right arm:
 * holding a phone to the ear and holding an umbrella above the head, layered over idle / walk.
 */
import * as THREE from 'three';

export const BAKE_FPS = 30;

export interface BakedClip {
  start: number;
  frames: number;
  duration: number;
  loop: boolean;
}

export interface BakeSpec {
  name: string;
  clip: THREE.AnimationClip;
  loop: boolean;
  arm?: 'phone' | 'umbrella';
  /** Playback speed factor for the baked clip. */
  speed?: number;
}

export interface BakedAnimations {
  texture: THREE.DataTexture;
  clips: Record<string, BakedClip>;
  boneCount: number;
  boneIndex: (name: string) => number;
  /** Bind-pose (mesh space) position of a bone. */
  bindPos: (name: string) => THREE.Vector3;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/** Rotate `bone` (in world space) so its child direction `from` points along `to`. */
export function aimBone(bone: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3): void {
  const rot = _q.setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  const parentQ = new THREE.Quaternion();
  bone.parent!.getWorldQuaternion(parentQ);
  const worldQ = bone.getWorldQuaternion(_q2);
  const newWorld = rot.multiply(worldQ);
  bone.quaternion.copy(parentQ.invert().multiply(newWorld));
  bone.updateMatrixWorld(true);
}

/** Analytic two-bone IK in world space with a pole direction. */
export function twoBoneIK(upper: THREE.Bone, lower: THREE.Bone, hand: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3): void {
  const S = upper.getWorldPosition(new THREE.Vector3());
  const E = lower.getWorldPosition(new THREE.Vector3());
  const H = hand.getWorldPosition(new THREE.Vector3());
  const a = S.distanceTo(E);
  const b = E.distanceTo(H);
  const toT = target.clone().sub(S);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const dir = toT.normalize();
  const cosA = (a * a + d * d - b * b) / (2 * a * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const n = pole.clone().sub(dir.clone().multiplyScalar(pole.dot(dir))).normalize();
  const elbow = S.clone().addScaledVector(dir, a * cosA).addScaledVector(n, a * sinA);
  aimBone(upper, E.clone().sub(S), elbow.clone().sub(S));
  const E2 = lower.getWorldPosition(new THREE.Vector3());
  const H2 = hand.getWorldPosition(new THREE.Vector3());
  const T2 = S.clone().addScaledVector(dir, d);
  aimBone(lower, H2.clone().sub(E2), T2.clone().sub(E2));
}

export function bakeAnimations(root: THREE.Object3D, mesh: THREE.SkinnedMesh, specs: BakeSpec[], pelvisScale = 1): BakedAnimations {
  const skeleton = mesh.skeleton;
  const bones = skeleton.bones;
  const nb = bones.length;
  const byName = (n: string) => bones.find((b) => b.name === n)!;
  // Frame rows.
  const clips: Record<string, BakedClip> = {};
  let rows = 0;
  for (const s of specs) {
    const dur = s.clip.duration / (s.speed ?? 1);
    const frames = Math.max(2, Math.round(dur * BAKE_FPS));
    clips[s.name] = { start: rows, frames, duration: dur, loop: s.loop };
    rows += frames;
  }
  const width = nb * 4;
  const data = new Float32Array(width * rows * 4);
  const mixer = new THREE.AnimationMixer(root);
  const bindM = mesh.bindMatrix;
  const bindInv = mesh.bindMatrixInverse;
  const m = new THREE.Matrix4();
  const upper = byName('upperarm_r');
  const lower = byName('lowerarm_r');
  const hand = byName('hand_r');
  const head = byName('Head');
  const spine = byName('spine_03');
  for (const s of specs) {
    // Scale pelvis translation for this body (clips were retargeted to the male base body).
    let clip = s.clip;
    if (pelvisScale !== 1) {
      clip = s.clip.clone();
      for (const t of clip.tracks) if (t.name.endsWith('.position')) for (let i = 0; i < t.values.length; i++) t.values[i] *= pelvisScale;
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(s.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    action.clampWhenFinished = true;
    action.play();
    const c = clips[s.name];
    for (let f = 0; f < c.frames; f++) {
      const t = (f / (c.loop ? c.frames : c.frames - 1)) * s.clip.duration;
      mixer.setTime(Math.min(t, s.clip.duration - 1e-4));
      root.updateMatrixWorld(true);
      if (s.arm) {
        // Body frame from the upper spine.
        const sp = spine.getWorldPosition(new THREE.Vector3());
        const hp = head.getWorldPosition(new THREE.Vector3());
        const fwd = new THREE.Vector3(0, 0, 1);
        const right = new THREE.Vector3(-1, 0, 0);
        const up = new THREE.Vector3(0, 1, 0);
        if (s.arm === 'phone') {
          const target = hp.clone().addScaledVector(right, 0.09).addScaledVector(fwd, 0.03).addScaledVector(up, -0.02);
          twoBoneIK(upper, lower, hand, target, right.clone().addScaledVector(up, -1.2));
        } else {
          const target = sp.clone().addScaledVector(right, 0.2).addScaledVector(fwd, 0.28).addScaledVector(up, 0.12);
          twoBoneIK(upper, lower, hand, target, right.clone().addScaledVector(up, -1).addScaledVector(fwd, -0.3));
        }
      }
      skeleton.update();
      for (let bi = 0; bi < nb; bi++) {
        m.fromArray(skeleton.boneMatrices!, bi * 16);
        m.premultiply(bindInv).multiply(bindM);
        const base = ((c.start + f) * width + bi * 4) * 4;
        data.set(m.elements, base);
      }
    }
  }
  mixer.stopAllAction();
  const tex = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  // Restore bind pose.
  skeleton.pose();
  root.updateMatrixWorld(true);
  const bindPosOf = (name: string) => {
    const i = bones.findIndex((b) => b.name === name);
    const inv = skeleton.boneInverses[i].clone().invert();
    return new THREE.Vector3().setFromMatrixPosition(bindInv.clone().multiply(inv));
  };
  return { texture: tex, clips, boneCount: nb, boneIndex: (n) => bones.findIndex((b) => b.name === n), bindPos: bindPosOf };
}
