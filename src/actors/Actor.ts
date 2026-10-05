/**
 * Individually animated, ragdoll-capable humans: thugs, and pedestrians knocked over by a
 * vehicle or a fight (the crowd hands them over from its GPU instancing).
 *
 * Each Actor is a SkeletonUtils clone of the crowd body (shared geometry), dressed by the same
 * bind-space clothing shader as the crowd but with per-actor uniforms instead of instance
 * attributes. Animation uses one AnimationMixer with manually weighted layers:
 *   base loop (cross-faded) + one-shot overlay (attacks, hits, rolls) + additive "flinch"
 *   spring on the spine/head for physical-looking hit reactions.
 * Ragdolls and get-ups come from RagdollRig. Distance LOD hides eyes/brows and shadows.
 */
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { assets } from '../core/AssetLoader';
import { CLOTHES_COMMON, CLOTHES_FRAG, type ClipName, type Look } from '../ai/CrowdRender';
import { RagdollRig } from '../physics/RagdollRig';

export const ACTOR_CLIPS = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  jog: 'Jog_Fwd_Loop',
  sprint: 'Sprint_Loop',
  talk: 'Idle_Talking_Loop',
  formal: 'Walk_Formal_Loop',
  fight: 'Sword_Idle',
  jab: 'Punch_Jab',
  cross: 'Punch_Cross',
  swing: 'Sword_Attack',
  hitHead: 'Hit_Head',
  hitChest: 'Hit_Chest',
  roll: 'Roll',
  death: 'Death01',
  crouch: 'Crouch_Idle_Loop',
  crouchWalk: 'Crouch_Fwd_Loop',
  pistolIdle: 'Pistol_Idle_Loop',
  pistolShoot: 'Pistol_Shoot',
  aim: 'Pistol_Aim_Neutral',
  sit: 'Sitting_Idle_Loop',
  drive: 'Driving_Loop',
  push: 'Push_Loop',
  throw: 'Spell_Simple_Shoot',
  kneel: 'Fixing_Kneeling',
} as const;
export type ActorClip = keyof typeof ACTOR_CLIPS;

/** Crowd clip → actor clip (to continue a pedestrian's pose when it becomes an actor). */
export const CROWD_TO_ACTOR: Record<ClipName, ActorClip> = {
  idle: 'idle',
  walk: 'walk',
  walkFormal: 'formal',
  jog: 'jog',
  sprint: 'sprint',
  talk: 'talk',
  phone: 'idle',
  phoneWalk: 'walk',
  sit: 'sit',
  sitTalk: 'sit',
  cower: 'crouch',
  hit: 'hitChest',
  umbrella: 'idle',
  umbrellaWalk: 'walk',
  drive: 'drive',
};

export type WeaponKind = 'fists' | 'pipe' | 'knife' | 'pistol';
export type HatKind = 'none' | 'beanie' | 'cap' | 'helmet' | 'flatcap';
export type VestKind = 'none' | 'patrol' | 'plate';

/** Worn extras: hat (rigid on the head) and vest (rigid on the chest), tinted per faction. */
export interface Gear {
  hat?: HatKind;
  hatColor?: [number, number, number];
  vest?: VestKind;
}

interface Template {
  scene: THREE.Object3D;
  pelvisY: number;
}

export class ActorKit {
  private templates: Template[] = [];
  private hairs: THREE.Object3D[][] = [];
  clips = new Map<string, THREE.AnimationClip>();
  private malePelvis = 1;
  /** Bind-space skull boxes per gender (from the buzzed hair meshes), to fit hats. */
  private skulls: THREE.Box3[] = [];
  private gearMats = new Map<string, THREE.MeshStandardMaterial>();
  readonly weaponMats = {
    steel: new THREE.MeshStandardMaterial({ color: 0x6c7076, metalness: 0.9, roughness: 0.38 }),
    rust: new THREE.MeshStandardMaterial({ color: 0x5a3e2c, metalness: 0.6, roughness: 0.7 }),
    grip: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.8 }),
    gun: new THREE.MeshStandardMaterial({ color: 0x1b1d20, metalness: 0.7, roughness: 0.42 }),
    shield: new THREE.MeshStandardMaterial({ color: 0x1d252c, roughness: 0.18, metalness: 0.2, transparent: true, opacity: 0.72, side: THREE.DoubleSide, envMapIntensity: 0.6 }),
    shieldRim: new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.4 }),
  };

  async load(): Promise<void> {
    const [m, f, anims, ...hairs] = await Promise.all([
      assets.loadGLTF('models/characters/crowd_male.glb'),
      assets.loadGLTF('models/characters/crowd_female.glb'),
      assets.loadGLTF('models/characters/anim_locomotion.glb'),
      assets.loadGLTF('models/characters/hair_simpleparted.glb'),
      assets.loadGLTF('models/characters/hair_buzzed.glb'),
      assets.loadGLTF('models/characters/hair_beard.glb'),
      assets.loadGLTF('models/characters/hair_long.glb'),
      assets.loadGLTF('models/characters/hair_buns.glb'),
      assets.loadGLTF('models/characters/hair_buzzedfemale.glb'),
    ]);
    for (const c of anims.animations) this.clips.set(c.name, c);
    for (const [gi, g] of [m, f].entries()) {
      g.scene.updateMatrixWorld(true);
      let pelvisY = 1;
      g.scene.traverse((o) => {
        if ((o as THREE.Bone).isBone && o.name === 'pelvis') pelvisY = o.getWorldPosition(new THREE.Vector3()).y;
      });
      if (gi === 0) this.malePelvis = pelvisY;
      this.templates.push({ scene: g.scene, pelvisY });
    }
    // Same style indexing as the crowd (male 2 = buzzed + beard).
    this.hairs = [
      [hairs[0].scene, hairs[1].scene, hairs[1].scene, hairs[2].scene],
      [hairs[3].scene, hairs[4].scene, hairs[5].scene],
    ];
    for (const h of [hairs[1].scene, hairs[5].scene]) {
      h.updateMatrixWorld(true);
      this.skulls.push(new THREE.Box3().setFromObject(h));
    }
  }

  gearMat(key: string, color: [number, number, number], rough = 0.8, metal = 0): THREE.MeshStandardMaterial {
    const k = `${key}:${color.map((c) => c.toFixed(3)).join(',')}`;
    let m = this.gearMats.get(k);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: new THREE.Color(...color), roughness: rough, metalness: metal });
      this.gearMats.set(k, m);
    }
    return m;
  }

  /** Hat mesh in the model's bind space, fitted to the gender's skull box. */
  hatMesh(kind: HatKind, gender: 0 | 1, color: [number, number, number]): THREE.Object3D | null {
    if (kind === 'none') return null;
    const b = this.skulls[gender];
    const c = b.getCenter(new THREE.Vector3());
    const sz = b.getSize(new THREE.Vector3());
    const g = new THREE.Group();
    const top = b.max.y;
    const rx = sz.x * 0.56;
    const rz = sz.z * 0.56;
    const cloth = this.gearMat('cloth', color, 0.92);
    const dark = this.gearMat('dark', [0.02, 0.02, 0.025], 0.4, 0.1);
    if (kind === 'beanie' || kind === 'helmet' || kind === 'flatcap') {
      const k = kind === 'helmet' ? 1.14 : kind === 'flatcap' ? 1.06 : 1.05;
      const base = top - sz.y * (kind === 'helmet' ? 0.62 : kind === 'flatcap' ? 0.32 : 0.55);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2), kind === 'helmet' ? this.gearMat('helmet', color, 0.55, 0.15) : cloth);
      dome.scale.set(rx * k, (top - base) * (kind === 'flatcap' ? 1.05 : 1.12) + 0.012, rz * k);
      dome.position.set(c.x, base, c.z + (kind === 'flatcap' ? 0.008 : 0));
      g.add(dome);
      if (kind === 'beanie') {
        const cuff = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 18, 1, true), cloth);
        cuff.scale.set(rx * k + 0.008, 0.045, rz * k + 0.008);
        cuff.position.set(c.x, base + 0.018, c.z);
        g.add(cuff);
      } else if (kind === 'helmet') {
        const visor = new THREE.Mesh(new THREE.BoxGeometry(rx * 1.7, 0.035, 0.02), dark);
        visor.position.set(c.x, base + 0.035, c.z + rz * k + 0.004);
        g.add(visor);
      } else {
        const brim = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.012, 16, 1, false, -Math.PI / 2, Math.PI), cloth);
        brim.scale.set(rx * 0.9, 1, rz * 0.7);
        brim.position.set(c.x, base + 0.012, c.z + rz * 0.75);
        g.add(brim);
      }
    } else if (kind === 'cap') {
      // Peaked patrol cap: flared crown, band, black visor and a badge.
      const crownH = 0.085;
      const y0 = top - 0.055;
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1, crownH, 20), cloth);
      crown.scale.set(rx * 1.02, 1, rz * 1.04);
      crown.position.set(c.x, y0 + crownH / 2, c.z);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.03, 20, 1, true), this.gearMat('band', [0.05, 0.06, 0.08], 0.6));
      band.scale.set(rx * 1.03, 1, rz * 1.05);
      band.position.set(c.x, y0 + 0.016, c.z);
      const visor = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.01, 16, 1, false, -Math.PI / 2, Math.PI), dark);
      visor.scale.set(rx * 0.95, 1, rz * 0.62);
      visor.position.set(c.x, y0 + 0.004, c.z + rz * 0.72);
      visor.rotation.x = 0.18;
      const badge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.008), this.gearMat('badge', [0.8, 0.78, 0.7], 0.25, 0.9));
      badge.position.set(c.x, y0 + 0.05, c.z + rz * 1.06);
      g.add(crown, band, visor, badge);
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }

  /** Vest in bind space around the chest (patrol: dark with reflective bands; plate: tactical carrier). */
  vestMesh(kind: VestKind, bones: Map<string, THREE.Bone>): THREE.Object3D | null {
    if (kind === 'none') return null;
    const p = (n: string) => bones.get(n)!.getWorldPosition(new THREE.Vector3());
    const s2 = p('spine_02');
    const neck = p('neck_01');
    const shoulderW = p('upperarm_l').distanceTo(p('upperarm_r'));
    const y0 = s2.y - 0.1;
    const y1 = neck.y - 0.07;
    const h = y1 - y0;
    const g = new THREE.Group();
    const plate = kind === 'plate';
    const mat = plate ? this.gearMat('plate', [0.07, 0.075, 0.07], 0.85) : this.gearMat('vest', [0.025, 0.03, 0.05], 0.75);
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, h, 14, 1, false), mat);
    shell.scale.set(shoulderW * (plate ? 0.47 : 0.43), 1, plate ? 0.16 : 0.135);
    shell.position.set(s2.x, y0 + h / 2, s2.z + 0.015);
    g.add(shell);
    if (plate) {
      const pouchMat = this.gearMat('pouch', [0.09, 0.09, 0.08], 0.9);
      for (const px of [-0.09, 0, 0.09]) {
        const pouch = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.05), pouchMat);
        pouch.position.set(s2.x + px, y0 + 0.07, s2.z + 0.17);
        g.add(pouch);
      }
      const radio = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.11, 0.04), this.gearMat('dark', [0.02, 0.02, 0.025], 0.4, 0.1));
      radio.position.set(s2.x + 0.12, y0 + h * 0.7, s2.z + 0.16);
      g.add(radio);
    } else {
      // Reflective bands catch headlights / torches.
      const refl = this.gearMat('reflect', [0.75, 0.78, 0.8], 0.3, 0.2);
      for (const yy of [0.28, 0.55]) {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.035, 14, 1, true), refl);
        band.scale.set(shoulderW * 0.435, 1, 0.137);
        band.position.set(s2.x, y0 + h * yy, s2.z + 0.015);
        g.add(band);
      }
    }
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }

  clip(name: ActorClip | string): THREE.AnimationClip {
    const n = (ACTOR_CLIPS as Record<string, string>)[name] ?? name;
    const c = this.clips.get(n);
    if (!c) throw new Error(`missing clip ${n}`);
    return c;
  }

  create(look: Look, weapon: WeaponKind = 'fists', shield = false, gear: Gear = {}): Actor {
    const t = this.templates[look.gender];
    const model = skeletonClone(t.scene);
    const hs = t.pelvisY / this.malePelvis;
    return new Actor(this, model, look, hs, this.hairs[look.gender], { weapon, shield, gear });
  }

  /** Weapon / shield meshes, authored in the model's bind space around the right/left hand. */
  weaponMesh(kind: WeaponKind | 'shield', hand: THREE.Vector3): THREE.Object3D | null {
    const g = new THREE.Group();
    const M = this.weaponMats;
    if (kind === 'pipe') {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 8), M.rust);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(hand.x - 0.07, hand.y - 0.02, hand.z + 0.24);
      const tape = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.16, 8), M.grip);
      tape.rotation.x = Math.PI / 2;
      tape.position.set(hand.x - 0.07, hand.y - 0.02, hand.z - 0.04);
      g.add(pipe, tape);
    } else if (kind === 'knife') {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.028, 0.17), M.steel);
      blade.position.set(hand.x - 0.07, hand.y - 0.02, hand.z + 0.15);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.11), M.grip);
      grip.position.set(hand.x - 0.07, hand.y - 0.02, hand.z + 0.01);
      g.add(blade, grip);
    } else if (kind === 'pistol') {
      const slide = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.03, 0.026), M.gun);
      slide.position.set(hand.x - 0.1, hand.y + 0.035, hand.z + 0.0);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.09, 0.024), M.grip);
      grip.position.set(hand.x - 0.05, hand.y - 0.01, hand.z);
      grip.rotation.z = 0.25;
      g.add(slide, grip);
    } else if (kind === 'shield') {
      // Riot shield on the left forearm: clear polycarbonate with a dark rim and a viewport band.
      const shape = new THREE.Shape();
      const w = 0.3;
      const h = 0.52;
      shape.moveTo(-w, -h + 0.06);
      shape.quadraticCurveTo(-w, -h, -w + 0.06, -h);
      shape.lineTo(w - 0.06, -h);
      shape.quadraticCurveTo(w, -h, w, -h + 0.06);
      shape.lineTo(w, h - 0.06);
      shape.quadraticCurveTo(w, h, w - 0.06, h);
      shape.lineTo(-w + 0.06, h);
      shape.quadraticCurveTo(-w, h, -w, h - 0.06);
      const panel = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false }), M.shield);
      const rim = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false, curveSegments: 6 }), M.shieldRim);
      rim.scale.set(1.04, 1.03, 1);
      rim.position.z = -0.012;
      const band = new THREE.Mesh(new THREE.BoxGeometry(w * 1.8, 0.07, 0.016), M.shieldRim);
      band.position.set(0, -0.12, 0.012);
      g.add(rim, panel, band);
      g.position.set(hand.x - 0.13, hand.y, hand.z + 0.09);
      return g;
    } else return null;
    g.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return g;
  }
}

function clothesMaterial(src: THREE.MeshStandardMaterial, look: Look, hs: number): THREE.MeshStandardMaterial {
  const m = src.clone();
  m.vertexColors = false;
  const u = {
    uLook0: { value: new THREE.Vector4(...look.top) },
    uLook1: { value: new THREE.Vector4(...look.bottom) },
    uLook2: { value: new THREE.Vector4(...look.skin) },
    uHS: { value: hs },
  };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vBind;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vBind;\nuniform vec4 uLook0;\nuniform vec4 uLook1;\nuniform vec4 uLook2;\n#define vLook0 uLook0\n#define vLook1 uLook1\n#define vLook2 uLook2\nfloat clCloth = 0.0;\n${CLOTHES_COMMON}`,
      )
      .replace('#include <map_fragment>', CLOTHES_FRAG)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.82, clCloth);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, normalize(vNormal), clCloth * 0.85));');
  };
  m.customProgramCacheKey = () => 'actorClothes';
  return m;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

export class Actor {
  readonly root = new THREE.Group();
  readonly model: THREE.Object3D;
  body!: THREE.SkinnedMesh;
  readonly bones = new Map<string, THREE.Bone>();
  readonly mixer: THREE.AnimationMixer;
  readonly rig: RagdollRig;
  readonly look: Look;
  private details: THREE.Object3D[] = [];
  private mats: THREE.Material[] = [];
  private base: THREE.AnimationAction;
  private prevBase: THREE.AnimationAction | null = null;
  private baseBlend = 1;
  private baseFade = 0.25;
  private once: { a: THREE.AnimationAction; t: number; dur: number; fade: number } | null = null;
  private flinchAxis = new THREE.Vector3(1, 0, 0);
  private flinchAmp = 0;
  private flinchVel = 0;
  weapon: WeaponKind = 'fists';
  weaponObj: THREE.Object3D | null = null;
  shieldObj: THREE.Object3D | null = null;
  /** Bind-space hand positions (for weapon placement). */
  private handR = new THREE.Vector3();
  private handL = new THREE.Vector3();
  /** Extra procedural pose hook (shield guard, aim), run after the mixer. */
  postPose: ((a: Actor) => void) | null = null;
  baseName: ActorClip = 'idle';
  visible = true;
  /** Owner callback once back on its feet after a ragdoll. */
  onStand: (() => void) | null = null;
  detached = new Set<string>();

  constructor(
    readonly kit: ActorKit,
    model: THREE.Object3D,
    look: Look,
    readonly heightScale: number,
    hairs: THREE.Object3D[],
    gear: { weapon: WeaponKind; shield: boolean; gear?: Gear } = { weapon: 'fists', shield: false },
  ) {
    this.model = model;
    this.look = look;
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh) return;
      sm.frustumCulled = false;
      const src = sm.material as THREE.MeshStandardMaterial;
      if (/superhero/i.test(sm.name)) {
        this.body = sm;
        const mat = clothesMaterial(src, look, heightScale);
        sm.material = mat;
        this.mats.push(mat);
        sm.castShadow = true;
        sm.receiveShadow = true;
      } else {
        const mat = src.clone();
        mat.vertexColors = false;
        if (/brow/i.test(sm.name)) {
          mat.alphaTest = 0.4;
          mat.transparent = false;
          mat.side = THREE.DoubleSide;
          mat.color.setRGB(Math.min(1, look.hair[0] * 2.2), Math.min(1, look.hair[1] * 2.2), Math.min(1, look.hair[2] * 2.2));
        }
        sm.material = mat;
        this.mats.push(mat);
        this.details.push(sm);
      }
    });
    // Everything below is authored in bind pose.
    this.body.skeleton.pose();
    model.updateMatrixWorld(true);
    this.bones.get('hand_r')!.getWorldPosition(this.handR);
    this.bones.get('hand_l')!.getWorldPosition(this.handL);
    // Hair, rigid on the head (authored in bind space).
    const head = this.bones.get('Head')!;
    const styles = look.gender === 0 && look.hairStyle === 2 ? [hairs[2], hairs[3]] : [hairs[look.hairStyle] ?? hairs[0]];
    for (const h of styles) {
      const hc = h.clone(true);
      hc.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (!mm.isMesh) return;
        const mat = (mm.material as THREE.MeshStandardMaterial).clone();
        mat.alphaTest = 0.4;
        mat.transparent = false;
        mat.side = THREE.DoubleSide;
        mat.color.setRGB(Math.min(1, look.hair[0] * 2.2), Math.min(1, look.hair[1] * 2.2), Math.min(1, look.hair[2] * 2.2));
        mm.material = mat;
        mm.castShadow = true;
        this.mats.push(mat);
      });
      hc.updateMatrixWorld(true);
      head.attach(hc);
    }
    this.attachGear(gear.weapon, gear.shield);
    const worn = gear.gear ?? {};
    const hat = kit.hatMesh(worn.hat ?? 'none', look.gender, worn.hatColor ?? [0.05, 0.05, 0.06]);
    if (hat) {
      model.add(hat);
      hat.updateMatrixWorld(true);
      head.attach(hat);
    }
    const vest = kit.vestMesh(worn.vest ?? 'none', this.bones);
    if (vest) {
      model.add(vest);
      vest.updateMatrixWorld(true);
      this.bones.get('spine_03')!.attach(vest);
    }
    model.scale.set(look.girth * look.height, look.height, look.girth * look.height);
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    this.base = this.action('idle');
    this.base.play();
    this.base.setEffectiveWeight(1);
    this.rig = new RagdollRig(this.root, model, this.bones, this.mixer, { death: kit.clip('death'), crouch: kit.clip('crouch'), stand: kit.clip('idle') }, look.height);
    this.rig.onStand = () => {
      this.base.reset().play();
      this.base.setEffectiveWeight(1);
      this.baseBlend = 1;
      this.onStand?.();
    };
  }

  private action(name: ActorClip): THREE.AnimationAction {
    return this.mixer.clipAction(this.kit.clip(name));
  }

  /** Attach a weapon in the right hand and/or a shield on the left forearm (bind pose only). */
  private attachGear(kind: WeaponKind, shield: boolean): void {
    this.weapon = kind;
    const w = this.kit.weaponMesh(kind, this.handR);
    if (w) {
      this.model.add(w);
      w.updateMatrixWorld(true);
      this.bones.get('hand_r')!.attach(w);
      this.weaponObj = w;
    }
    if (shield) {
      const fore = this.bones.get('lowerarm_l')!.getWorldPosition(new THREE.Vector3());
      const s = this.kit.weaponMesh('shield', this.handL.clone().lerp(fore, 0.45))!;
      this.model.add(s);
      s.updateMatrixWorld(true);
      this.bones.get('lowerarm_l')!.attach(s);
      this.shieldObj = s;
    }
  }

  /** Zip-tie the wrists (captured criminals). */
  tie(): void {
    if (this.tied) return;
    this.tied = true;
    const mat = this.kit.gearMat('tie', [0.85, 0.55, 0.05], 0.5);
    for (const n of ['hand_l', 'hand_r']) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.042, 0.009, 5, 12), mat);
      r.rotation.y = Math.PI / 2;
      this.bones.get(n)!.add(r);
    }
  }

  tied = false;

  /** Remove the held weapon from the hand; returns its world transform (to drop or fly away). */
  dropWeapon(): THREE.Object3D | null {
    const w = this.weaponObj;
    if (!w) return null;
    w.updateMatrixWorld(true);
    const m = w.matrixWorld.clone();
    w.removeFromParent();
    m.decompose(w.position, w.quaternion, w.scale);
    this.weaponObj = null;
    this.weapon = 'fists';
    return w;
  }

  /** Change the base loop (cross-fade). */
  loop(name: ActorClip, timeScale = 1, fade = 0.25): void {
    const a = this.action(name);
    a.timeScale = timeScale;
    if (name === this.baseName && a === this.base) return;
    this.baseName = name;
    if (this.prevBase && this.prevBase !== a && this.prevBase !== this.base) this.prevBase.stop();
    this.prevBase = this.base === a ? null : this.base;
    this.base = a;
    a.setLoop(THREE.LoopRepeat, Infinity);
    if (!a.isRunning()) a.reset().play();
    this.baseBlend = 0;
    this.baseFade = Math.max(0.01, fade);
  }

  setBaseSpeed(ts: number): void {
    this.base.timeScale = ts;
  }

  /** One-shot overlay; returns its length in seconds. */
  play(name: ActorClip, speed = 1, fade = 0.1, from = 0): number {
    if (this.once) this.once.a.stop();
    const a = this.action(name);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.time = from;
    a.play();
    const dur = (a.getClip().duration - from) / speed;
    this.once = { a, t: 0, dur, fade };
    return dur;
  }

  get busy(): boolean {
    return !!this.once;
  }

  stopOnce(): void {
    if (this.once) this.once.a.stop();
    this.once = null;
  }

  /** Physical-looking flinch (spine/head spring) away from a hit direction. */
  flinch(dirWorld: THREE.Vector3, amp: number): void {
    this.flinchAxis.set(dirWorld.z, 0, -dirWorld.x).normalize();
    this.flinchVel += amp * 9;
  }

  /** Knock over into a ragdoll. stayDown = Infinity for a knockout. */
  knockDown(vel: THREE.Vector3, impulse: THREE.Vector3 | null, at: THREE.Vector3 | null, stayDown: number): void {
    this.stopOnce();
    this.root.updateMatrixWorld(true);
    const rd = this.rig.start(vel, stayDown);
    this.mixer.stopAllAction();
    if (impulse) rd.impulse(impulse, at ?? undefined);
  }

  get down(): boolean {
    return this.rig.active;
  }

  update(dt: number, cam: THREE.Vector3): void {
    const d = this.root.position.distanceTo(cam);
    this.visible = d < 150;
    this.root.visible = this.visible;
    for (const o of this.details) o.visible = d < 18;
    this.body.castShadow = d < 40;
    if (this.rig.state === 'ragdoll') {
      this.rig.update(dt);
      return;
    }
    if (this.rig.state === 'getup') {
      this.rig.update(dt);
      this.mixer.update(dt);
      this.rig.postMixer(dt);
      return;
    }
    if (!this.visible && d > 220) return;
    // Layer weights.
    this.baseBlend = Math.min(1, this.baseBlend + dt / this.baseFade);
    let onceW = 0;
    if (this.once) {
      const o = this.once;
      o.t += dt;
      onceW = Math.min(1, o.t / o.fade) * Math.min(1, Math.max(0, (o.dur - o.t) / Math.max(o.fade, 0.08)));
      if (o.t >= o.dur) {
        o.a.stop();
        this.once = null;
        onceW = 0;
      } else o.a.setEffectiveWeight(onceW);
    }
    this.base.setEffectiveWeight(this.baseBlend * (1 - onceW));
    if (this.prevBase) {
      this.prevBase.setEffectiveWeight((1 - this.baseBlend) * (1 - onceW));
      if (this.baseBlend >= 1) {
        this.prevBase.stop();
        this.prevBase = null;
      }
    }
    this.mixer.update(dt);
    // Flinch spring (critically damped-ish).
    this.flinchVel += (-this.flinchAmp * 140 - this.flinchVel * 16) * dt;
    this.flinchAmp += this.flinchVel * dt;
    if (Math.abs(this.flinchAmp) > 0.002 || this.postPose) {
      this.root.updateMatrixWorld(true);
      if (Math.abs(this.flinchAmp) > 0.002) {
        for (const [name, k] of [
          ['spine_02', 0.5],
          ['spine_03', 0.6],
          ['neck_01', 0.4],
          ['Head', 0.7],
        ] as [string, number][]) {
          const b = this.bones.get(name)!;
          b.getWorldQuaternion(_q2);
          _v.copy(this.flinchAxis).applyQuaternion(_q2.invert());
          b.quaternion.multiply(_q.setFromAxisAngle(_v, this.flinchAmp * k));
          b.updateMatrixWorld(true);
        }
      }
      this.postPose?.(this);
    }
  }

  /** World position of a bone. */
  bonePos(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    return this.bones.get(name)!.getWorldPosition(out);
  }

  dispose(): void {
    this.rig.stop();
    this.mixer.stopAllAction();
    this.root.removeFromParent();
    for (const m of this.mats) m.dispose();
  }
}
