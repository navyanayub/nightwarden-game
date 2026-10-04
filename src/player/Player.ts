/**
 * The player: Quaternius base character, dressed either as a civilian (bind-space clothing
 * shader) or as the Nightwarden (HeroSuit + Verlet Cape; V toggles), driven by a Rapier
 * kinematic character controller and a small traversal state machine:
 *
 *   move     walk / run / sprint / jump / fall (phase-synced locomotion blending)
 *   vault    automatic vault over thin low obstacles while running; mantle onto deep ones
 *   hang     ledge grab (from a jump or a fall), shimmy with A/D, climb (W/Space), drop (S)
 *   climb    scripted pull-up onto the ledge
 *   glide    hold Space in the air (hero): pitch W/S trades height for speed, A/D bank;
 *            updrafts lift; landing fast and steep from a dive is a dive-bomb
 *   grapple  (hero) aim-assisted zip to a roof edge with momentum, launch boost at the top
 *   warp     combat lunge towards a target (motion warping, set by Combat)
 *   dodge    combat roll with invulnerability frames
 *   stagger  short knock-back after a heavy hit
 *   ragdoll  physics knock-down / knockout, then a get-up from front or back
 *
 * Health and armour live here (armour soaks most damage; both regenerate out of combat);
 * falls above ~14 m/s (about 4 m) hurt unless gliding.
 */
import * as THREE from 'three';
import { assets } from '../core/AssetLoader';
import { physics, RAPIER, GROUPS_PLAYER, G_PLAYER, GROUPS_PROBE } from '../core/Physics';
import { events } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { CameraRig } from './CameraRig';
import { HeroSuit } from './HeroSuit';
import { Cape, capeHalfWidth, WING_ROW, type CapeFrame } from './Cape';
import { probeLedge, probeObstacle, findGrappleTarget, Rope, type Ledge, type GrappleTarget } from './Traversal';
import { RagdollRig } from '../physics/RagdollRig';
import { twoBoneIK } from '../ai/AnimBaker';
import { wind } from '../systems/Weather';

const RADIUS = 0.3;
const HALF = 0.58;
const GRAVITY = 24;
const JUMP_V = 6.6;
const SPEED = { walk: 1.7, run: 4.3, sprint: 7.2 };
/** Feet below the hands when hanging from a ledge. */
const HANG_DROP = 2.02;

export type PlayerState = 'move' | 'vault' | 'hang' | 'climb' | 'glide' | 'grapple' | 'warp' | 'dodge' | 'stagger' | 'ragdoll';

export interface PlayerContext {
  inCombat: boolean;
  /** Upward air speed (updrafts) at a point. */
  lift: (x: number, y: number, z: number) => number;
}

interface LocoClip {
  action: THREE.AnimationAction;
  speed: number;
}

interface Tween {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  kind: 'vault' | 'mantle' | 'climb' | 'hangjump';
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class Player {
  readonly object = new THREE.Group();
  private model!: THREE.Object3D;
  private body!: THREE.SkinnedMesh;
  private mixer!: THREE.AnimationMixer;
  private loco: LocoClip[] = [];
  private actions: Record<string, THREE.AnimationAction> = {};
  private clips = new Map<string, THREE.AnimationClip>();
  private rb!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;
  private controller!: RAPIER.KinematicCharacterController;
  readonly position = new THREE.Vector3();
  private prevPos = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private heading = 0;
  private grounded = true;
  private airTime = 0;
  private landTimer = 0;
  private jumpTimer = 0;
  private phase = 0;
  private wantJump = false;
  private speedSmoothed = 0;
  private airW = 0;
  private landW = 0;
  private _driving = false;
  hidden = false;
  // ---- Stage 3
  readonly bones = new Map<string, THREE.Bone>();
  suit!: HeroSuit;
  readonly cape = new Cape();
  readonly rope = new Rope();
  rig!: RagdollRig;
  private hairRoot: THREE.Object3D | null = null;
  hero = false;
  state: PlayerState = 'move';
  private stateT = 0;
  time = 0;
  health = 100;
  armour = 60;
  readonly maxHealth = 100;
  readonly maxArmour = 60;
  private lastHurt = -99;
  private iFrames = 0;
  private ctx: PlayerContext = { inCombat: false, lift: () => 0 };
  // glide
  readonly glide = { speed: 0, pitch: 0.25, yaw: 0, bank: 0, lift: 0 };
  private glideW = 0;
  private tilt = { pitch: 0, roll: 0 };
  // ledge / tween
  ledge: Ledge | null = null;
  private ledgeCooldown = 0;
  private tween: Tween | null = null;
  private hangW = 0;
  private climbW = 0;
  // grapple
  grappleTarget: GrappleTarget | null = null;
  private grapple: { target: GrappleTarget; t: number; blocked: number } | null = null;
  private grappleCooldown = 0;
  private aimFrame = 0;
  // combat motion
  private warp: { to: THREE.Vector3; t: number; dur: number; yaw: number } | null = null;
  private dodgeDir = new THREE.Vector3();
  private overlay: { a: THREE.AnimationAction; t: number; dur: number; fade: number } | null = null;
  private fallVy = 0;
  private groundY = 0;
  private wallProbeT = 0;
  private walls: { n: THREE.Vector3; d: number; p: THREE.Vector3 }[] = [];
  private capeFrame: CapeFrame | null = null;
  private capeColK = 1;
  private spineIdx = 0;
  /** Grapple launch: keep driving over the edge for a moment. */
  private launch: { dir: THREE.Vector3; t: number } | null = null;
  /** Seconds since the jump key was pressed (glide only from a held press, after the jump). */
  private jumpHeldT = 0;

  async load(): Promise<void> {
    const [char, hair, anims] = await Promise.all([
      assets.loadGLTF('models/characters/civilian_male.glb'),
      assets.loadGLTF('models/characters/hair_simpleparted.glb'),
      assets.loadGLTF('models/characters/anim_locomotion.glb'),
    ]);
    this.model = char.scene;
    for (const c of anims.animations) this.clips.set(c.name, c);
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.name === 'MI_Superhero_Male') {
        dressCivilian(mat);
        this.body = m;
      }
      if (mat.name === 'MI_Hair_1') {
        mat.alphaTest = 0.4;
        mat.transparent = false;
        mat.side = THREE.DoubleSide;
      }
    });
    // Attach the hair to the head bone (hair mesh is authored in bind-pose model space).
    this.model.updateMatrixWorld(true);
    const head = this.model.getObjectByName('Head');
    if (head) {
      hair.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.alphaTest = 0.4;
        mat.side = THREE.DoubleSide;
        mat.color.setRGB(0.42, 0.3, 0.2);
      });
      this.hairRoot = hair.scene;
      this.hairRoot.updateMatrixWorld(true);
      head.attach(this.hairRoot);
    }
    this.suit = new HeroSuit(this.body, this.hairRoot);
    this.spineIdx = this.body.skeleton.bones.findIndex((b) => b.name === 'spine_03');
    this.object.add(this.model);
    this.object.name = 'Player';
    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (name: string) => this.clips.get(name);
    const act = (name: string, loop = true) => {
      const c = clip(name);
      if (!c) throw new Error(`missing animation ${name}`);
      const a = this.mixer.clipAction(c);
      a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      a.clampWhenFinished = !loop;
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      return a;
    };
    this.loco = [
      { action: act('Idle_Loop'), speed: 0 },
      { action: act('Walk_Loop'), speed: SPEED.walk },
      { action: act('Jog_Fwd_Loop'), speed: SPEED.run },
      { action: act('Sprint_Loop'), speed: SPEED.sprint },
    ];
    for (const l of this.loco) l.action.timeScale = 0;
    this.actions.jumpStart = act('Jump_Start', false);
    this.actions.fall = act('Jump_Loop');
    this.actions.land = act('Jump_Land', false);
    this.actions.drive = act('Driving_Loop');
    this.actions.tpose = act('A_TPose');
    this.actions.crouch = act('Crouch_Idle_Loop');
    this.actions.fight = act('Sword_Idle');
    this.loco[0].action.setEffectiveWeight(1);
    this.rig = new RagdollRig(this.object, this.model, this.bones, this.mixer, { death: clip('Death01')!, crouch: clip('Crouch_Idle_Loop')!, stand: clip('Idle_Loop')! });
    this.rig.onStand = () => {
      this.setState('move');
      this.collider.setEnabled(true);
      const p = this.object.position;
      this.teleport(p.x, p.y + 0.05, p.z, this.object.rotation.y);
      if (this.health <= 0) {
        this.health = 45;
        this.armour = 0;
      }
    };
  }

  spawn(x: number, y: number, z: number, yaw: number): void {
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + HALF + RADIUS + 0.05, z);
    this.rb = physics.world.createRigidBody(desc);
    this.collider = physics.world.createCollider(RAPIER.ColliderDesc.capsule(HALF, RADIUS).setCollisionGroups(GROUPS_PLAYER), this.rb);
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.4, 0.2, false);
    this.controller.enableSnapToGround(0.35);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);
    this.heading = yaw;
    this.position.set(x, y, z);
    this.prevPos.copy(this.position);
  }

  /** Teleport (feet position). */
  teleport(x: number, y: number, z: number, yaw?: number): void {
    if (this.rig?.active || this.state === 'ragdoll') {
      this.rig.stop();
      this.state = 'move';
      this.collider.setEnabled(true);
    }
    this.rb.setNextKinematicTranslation({ x, y: y + HALF + RADIUS + 0.02, z });
    this.rb.setTranslation({ x, y: y + HALF + RADIUS + 0.02, z }, true);
    this.velocity.set(0, 0, 0);
    this.position.set(x, y, z);
    this.prevPos.copy(this.position);
    this.object.position.copy(this.position);
    if (yaw !== undefined) this.heading = yaw;
    this.tween = null;
    this.grapple = null;
    this.rope.hide();
    this.walls.length = 0;
    this.wallProbeT = 0;
  }

  setEnabled(enabled: boolean): void {
    this.collider.setEnabled(enabled);
  }

  get driving(): boolean {
    return this._driving;
  }

  set driving(v: boolean) {
    this._driving = v;
    this.cape.setVisible(this.hero && !v);
    if (v) {
      this.setState('move');
      this.rope.hide();
    }
  }

  setHero(on: boolean): void {
    this.hero = on;
    this.suit.set(on);
    this.cape.setVisible(on && !this._driving);
    if (!on && this.state === 'glide') this.setState('move');
    events.emit('player:hero', { on });
  }

  setContext(ctx: PlayerContext): void {
    this.ctx = ctx;
  }

  private setState(s: PlayerState): void {
    this.state = s;
    this.stateT = 0;
  }

  // ---------------------------------------------------------------- health

  get invulnerable(): boolean {
    return this.iFrames > 0 || this.state === 'ragdoll';
  }

  get dodging(): boolean {
    return this.state === 'dodge';
  }

  /** Apply damage; returns false if dodged. */
  hurt(amount: number, from: THREE.Vector3, heavy = false): boolean {
    if (this.invulnerable || this._driving) return false;
    const soak = Math.min(this.armour, amount * 0.7);
    this.armour -= soak;
    this.health = Math.max(0, this.health - (amount - soak));
    this.lastHurt = this.time;
    events.emit('player:hurt', { amount, health: this.health });
    const away = this.position.clone().sub(from).setY(0).normalize();
    if (this.health <= 0) {
      this.knockDown(away.multiplyScalar(4).setY(2), 3.5);
      events.emit('player:ko');
    } else if (heavy) {
      this.knockDown(away.multiplyScalar(6).setY(2.5), 0.4);
    } else {
      this.playOnce(Math.random() < 0.5 ? 'Hit_Chest' : 'Hit_Head', 1.3, 0.06);
      if (this.state === 'move' && this.grounded) {
        this.velocity.addScaledVector(away, 2.5);
      }
    }
    return true;
  }

  /** Physics knock-down; `stayDown` seconds on the ground before getting up. */
  knockDown(vel: THREE.Vector3, stayDown: number): void {
    if (this._driving || this.state === 'ragdoll') return;
    this.overlay?.a.stop();
    this.overlay = null;
    this.grapple = null;
    this.rope.hide();
    this.tween = null;
    this.setState('ragdoll');
    this.collider.setEnabled(false);
    this.object.updateMatrixWorld(true);
    this.rig.start(this.velocity.clone().add(vel), stayDown);
    for (const l of this.loco) l.action.setEffectiveWeight(0);
    for (const a of Object.values(this.actions)) a.setEffectiveWeight(0);
  }

  // ---------------------------------------------------------------- combat hooks

  /** Lunge towards a point (feet) over `dur` seconds, facing `yaw`. */
  startWarp(to: THREE.Vector3, dur: number, yaw: number): void {
    if (this.state !== 'move' && this.state !== 'warp') return;
    this.warp = { to: to.clone(), t: 0, dur: Math.max(0.05, dur), yaw };
    this.setState('warp');
  }

  face(yaw: number): void {
    this.heading = yaw;
  }

  /** Combat roll in a world direction. */
  startDodge(dir: THREE.Vector3): void {
    if (this.state !== 'move' && this.state !== 'warp') return;
    this.dodgeDir.copy(dir).setY(0).normalize();
    this.heading = Math.atan2(this.dodgeDir.x, this.dodgeDir.z);
    this.iFrames = 0.5;
    this.setState('dodge');
    this.playOnce('Roll', 1.5, 0.05);
  }

  /** One-shot overlay animation (strikes, hits, throws); returns its duration. */
  playOnce(name: string, speed = 1, fade = 0.08, from = 0): number {
    const c = this.clips.get(name);
    if (!c) return 0;
    if (this.overlay) this.overlay.a.stop();
    const a = this.mixer.clipAction(c);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.time = from;
    a.play();
    const dur = (c.duration - from) / speed;
    this.overlay = { a, t: 0, dur, fade };
    return dur;
  }

  get busy(): boolean {
    return this.state === 'warp' || this.state === 'dodge' || this.state === 'ragdoll' || this.state === 'stagger';
  }

  get onGround(): boolean {
    return this.grounded;
  }

  // ---------------------------------------------------------------- simulation

  fixedUpdate(dt: number, input: Input, cam: CameraRig): void {
    if (this._driving) return;
    this.time += dt;
    this.stateT += dt;
    this.iFrames = Math.max(0, this.iFrames - dt);
    this.ledgeCooldown = Math.max(0, this.ledgeCooldown - dt);
    this.grappleCooldown = Math.max(0, this.grappleCooldown - dt);
    // Regeneration out of combat.
    if (!this.ctx.inCombat && this.time - this.lastHurt > 5 && this.health > 0) {
      this.armour = Math.min(this.maxArmour, this.armour + 9 * dt);
      this.health = Math.min(this.maxHealth, this.health + 6 * dt);
    }
    if (input.held('jump')) this.jumpHeldT += dt;
    else this.jumpHeldT = 0;
    this.prevPos.copy(this.position);
    switch (this.state) {
      case 'ragdoll':
        this.followRagdoll();
        return;
      case 'hang':
        this.fixedHang(dt, input);
        return;
      case 'vault':
      case 'climb':
        this.fixedTween(dt);
        return;
      case 'glide':
        this.fixedGlide(dt, input);
        return;
      case 'grapple':
        this.fixedGrapple(dt, input);
        return;
      case 'warp':
        this.fixedWarp(dt);
        return;
      case 'dodge':
      case 'stagger':
        this.fixedDodge(dt);
        return;
      default:
        this.fixedMove(dt, input, cam);
    }
  }

  /** KCC move by `delta`; updates position / grounded and returns the executed movement. */
  private kcc(delta: THREE.Vector3): THREE.Vector3 {
    this.controller.computeColliderMovement(this.collider, delta, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (c) => ((c.collisionGroups() >>> 16) & G_PLAYER) === 0 && ((c.collisionGroups() >>> 16) & 0x0030) === 0);
    const mv = this.controller.computedMovement();
    const p = this.rb.translation();
    const next = { x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z };
    this.rb.setNextKinematicTranslation(next);
    this.position.set(next.x, next.y - HALF - RADIUS, next.z);
    return _v2.set(mv.x, mv.y, mv.z);
  }

  private setFeet(p: THREE.Vector3): void {
    const next = { x: p.x, y: p.y + HALF + RADIUS + 0.01, z: p.z };
    this.rb.setNextKinematicTranslation(next);
    this.rb.setTranslation(next, true);
    this.position.copy(p);
  }

  private fixedMove(dt: number, input: Input, cam: CameraRig): void {
    if (input.consume('jump')) this.wantJump = true;
    // Grapple (hero, out of combat).
    if (input.consume('grapple') && this.hero && !this.ctx.inCombat) {
      if (this.grappleTarget && this.grappleCooldown <= 0) {
        this.startGrapple(this.grappleTarget);
        return;
      }
    }
    // Desired horizontal velocity relative to the camera.
    const fwd = cam.forward(new THREE.Vector3());
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3().addScaledVector(fwd, input.moveY).addScaledVector(right, input.moveX);
    const mag = Math.min(1, move.length());
    if (mag > 0.01) move.normalize();
    const sprint = input.held('sprint');
    const target = mag * (sprint ? SPEED.sprint : mag > 0.6 ? SPEED.run : SPEED.walk + (SPEED.run - SPEED.walk) * Math.max(0, (mag - 0.3) / 0.3));
    const hv = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const desired = move.clone().multiplyScalar(this.ctx.inCombat && !sprint ? Math.min(target, SPEED.run) : target);
    const accel = this.grounded ? (target > hv.length() ? 14 : 22) : 3.5;
    const dv = desired.sub(hv);
    const maxDv = accel * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    hv.add(dv);
    this.velocity.x = hv.x;
    this.velocity.z = hv.z;
    const facing = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    // Space in combat = dodge.
    if (this.wantJump && this.grounded && this.ctx.inCombat) {
      this.wantJump = false;
      this.startDodge(mag > 0.1 ? move : facing.clone().negate());
      return;
    }
    // Jump: towards a reachable ledge → grab it; low obstacle → vault/mantle; else a normal jump.
    if (this.wantJump && this.grounded) {
      const dir = mag > 0.1 ? move : facing;
      const ledge = probeLedge(this.position, dir, 1.3, 2.6, 0.9);
      if (ledge) {
        this.wantJump = false;
        this.startHangJump(ledge);
        return;
      }
      const ob = probeObstacle(this.position, dir, 0.9);
      if (ob) {
        this.wantJump = false;
        this.startVault(ob);
        return;
      }
    }
    // Automatic vault while running into a low obstacle.
    const hs = hv.length();
    if (this.grounded && hs > 3.2 && mag > 0.5 && !this.ctx.inCombat) {
      const ob = probeObstacle(this.position, hv.clone().normalize(), 0.5 + hs * 0.1);
      if (ob && (ob.kind === 'vault' || ob.top - this.position.y < 1.05)) {
        this.startVault(ob);
        return;
      }
    }
    // Jump & gravity.
    if (this.grounded) {
      this.velocity.y = -2;
      if (this.wantJump) {
        this.velocity.y = JUMP_V;
        this.grounded = false;
        this.jumpTimer = 0.35;
        this.actions.jumpStart.reset().play();
      }
    } else {
      this.velocity.y -= GRAVITY * dt;
      this.velocity.y = Math.max(this.velocity.y, -45);
    }
    this.wantJump = false;
    // Glide: hold Space in the air (hero).
    if (this.hero && !this.grounded && input.held('jump') && this.airTime > 0.3 && (this.velocity.y < 1.5 || this.jumpHeldT > 0.45)) {
      this.startGlide();
      return;
    }
    // Ledge grab while airborne, moving into a wall.
    if (!this.grounded && this.ledgeCooldown <= 0 && this.velocity.y < 3 && this.velocity.y > -18 && (this.airTime > 0.05 || this.velocity.y < -1)) {
      const dir = hv.lengthSq() > 0.5 ? hv.clone().normalize() : facing;
      // Hands catch anything from chest height to a little above full reach.
      const ledge = probeLedge(this.position, dir, 1.4, 2.6, 0.65);
      if (ledge) {
        this.startHang(ledge);
        return;
      }
    }
    this.fallVy = this.velocity.y;
    const mv = this.kcc(this.velocity.clone().multiplyScalar(dt));
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded() && this.velocity.y <= 0.5;
    if (this.grounded) {
      if (!wasGrounded) this.onLanded(-this.fallVy, false);
      this.airTime = 0;
    } else this.airTime += dt;
    // Blocked by walls: kill horizontal velocity components we couldn't execute.
    if (dt > 0) {
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, mv.x / dt, 0.5);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, mv.z / dt, 0.5);
    }
    if (this.launch) {
      this.launch.t -= dt;
      if (this.launch.t <= 0 || this.grounded) this.launch = null;
      else {
        const along = this.velocity.x * this.launch.dir.x + this.velocity.z * this.launch.dir.z;
        if (along < 4.5) {
          this.velocity.x += this.launch.dir.x * (4.5 - along);
          this.velocity.z += this.launch.dir.z * (4.5 - along);
        }
      }
    }
    if (this.jumpTimer > 0) this.jumpTimer -= dt;
    if (this.landTimer > 0) this.landTimer -= dt;
    // Face movement direction.
    if (mag > 0.05 && hv.lengthSq() > 0.2) {
      const want = Math.atan2(hv.x, hv.z);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * (1 - Math.exp(-12 * dt));
    }
  }

  private onLanded(impact: number, dive: boolean): void {
    if (impact > 6) {
      this.landTimer = Math.min(0.45, 0.2 + this.airTime * 0.15);
      this.actions.land.reset().play();
    }
    const p = this.position;
    events.emit('player:land', { x: p.x, y: p.y, z: p.z, speed: impact, dive });
    if (dive) return;
    // Fall damage (not gliding).
    if (impact > 14) {
      const dmg = (impact - 14) * 4.5;
      const heavy = impact > 24;
      this.hurt(dmg, p.clone().add(new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading))), heavy);
    }
  }

  // ---- ledges

  private hangFeet(l: Ledge): THREE.Vector3 {
    return new THREE.Vector3(l.edge.x + l.n.x * (RADIUS + 0.04), l.top - HANG_DROP, l.edge.z + l.n.z * (RADIUS + 0.04));
  }

  private startHang(l: Ledge): void {
    this.ledge = l;
    this.velocity.set(0, 0, 0);
    this.heading = Math.atan2(-l.n.x, -l.n.z);
    this.setFeet(this.hangFeet(l));
    this.setState('hang');
    this.grounded = false;
  }

  private startHangJump(l: Ledge): void {
    this.ledge = l;
    this.heading = Math.atan2(-l.n.x, -l.n.z);
    this.tween = { from: this.position.clone(), to: this.hangFeet(l), t: 0, dur: 0.32, kind: 'hangjump' };
    this.actions.jumpStart.reset().play();
    this.jumpTimer = 0.3;
    this.setState('climb');
  }

  private fixedHang(dt: number, input: Input): void {
    const l = this.ledge!;
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    const climb = input.consume('jump') || (input.moveY > 0.6 && this.stateT > 0.35);
    if (climb && l.room > 1.75) {
      const to = l.edge.clone().addScaledVector(l.n, -0.45);
      to.y = l.top;
      this.tween = { from: this.position.clone(), to, t: 0, dur: 0.85, kind: 'climb' };
      this.setState('climb');
      return;
    }
    if (input.moveY < -0.6 && this.stateT > 0.25) {
      this.setState('move');
      this.ledgeCooldown = 0.6;
      this.velocity.copy(l.n).multiplyScalar(1.5);
      this.airTime = 0.2;
      return;
    }
    if (input.consume('grapple') && this.hero && this.grappleTarget) {
      this.startGrapple(this.grappleTarget);
      return;
    }
    if (Math.abs(input.moveX) > 0.2) {
      const facing = l.n.clone().negate();
      const right = new THREE.Vector3(-facing.z, 0, facing.x);
      const step = right.multiplyScalar(input.moveX * 1.1 * dt);
      const feet = this.position.clone().add(step);
      const nl = probeLedge(feet, facing, HANG_DROP - 0.35, HANG_DROP + 0.35, 0.8);
      if (nl && Math.abs(nl.top - l.top) < 0.35 && nl.n.dot(l.n) > 0.8) {
        // Corner check: nothing solid in the shimmy direction at chest height.
        const side = physics.rayHit(new THREE.Vector3(feet.x, feet.y + 1.4, feet.z), step.clone().normalize(), 0.45, GROUPS_PROBE);
        if (!side) {
          this.ledge = nl;
          this.heading = Math.atan2(-nl.n.x, -nl.n.z);
          this.setFeet(this.hangFeet(nl));
        }
      }
    }
    this.setFeet(this.position);
  }

  // ---- vault / climb tweens

  private startVault(ob: ReturnType<typeof probeObstacle> & object): void {
    const to = ob.land.clone();
    this.heading = Math.atan2(-ob.n.x, -ob.n.z);
    this.tween = { from: this.position.clone(), to, t: 0, dur: ob.kind === 'vault' ? 0.55 : 0.6, kind: ob.kind };
    this.ledge = { edge: ob.edge, n: ob.n, top: ob.top, room: 2 };
    this.setState(ob.kind === 'vault' ? 'vault' : 'climb');
    this.playOnce(ob.kind === 'vault' ? 'Jump_Start' : 'Jump_Land', 1.4, 0.06);
  }

  private fixedTween(dt: number): void {
    const tw = this.tween;
    if (!tw) {
      this.setState('move');
      return;
    }
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    const p = new THREE.Vector3();
    if (tw.kind === 'climb' || tw.kind === 'mantle') {
      // Up first, then over the edge.
      const up = THREE.MathUtils.smoothstep(k, 0, 0.6);
      const over = THREE.MathUtils.smoothstep(k, 0.45, 1);
      p.set(THREE.MathUtils.lerp(tw.from.x, tw.to.x, over), THREE.MathUtils.lerp(tw.from.y, tw.to.y + 0.05, up), THREE.MathUtils.lerp(tw.from.z, tw.to.z, over));
    } else if (tw.kind === 'vault') {
      const top = (this.ledge?.top ?? tw.from.y + 1) + 0.15;
      p.lerpVectors(tw.from, tw.to, k);
      const arc = Math.sin(k * Math.PI);
      p.y = THREE.MathUtils.lerp(tw.from.y, tw.to.y, k) + Math.max(0, top - Math.max(tw.from.y, tw.to.y)) * arc + 0.1 * arc;
    } else {
      p.lerpVectors(tw.from, tw.to, THREE.MathUtils.smoothstep(k, 0, 1));
    }
    this.setFeet(p);
    if (k >= 1) {
      this.tween = null;
      if (tw.kind === 'hangjump' && this.ledge) {
        this.startHang(this.ledge);
        return;
      }
      this.setState('move');
      this.grounded = true;
      this.velocity.set(0, -2, 0);
      if (tw.kind === 'vault') {
        const d = tw.to.clone().sub(tw.from).setY(0).normalize();
        this.velocity.addScaledVector(d, 4.5);
      }
    }
  }

  // ---- glide

  private startGlide(): void {
    const hv = Math.hypot(this.velocity.x, this.velocity.z);
    this.glide.speed = Math.max(9, hv * 1.05 + 2);
    this.glide.yaw = hv > 1 ? Math.atan2(this.velocity.x, this.velocity.z) : this.heading;
    this.glide.pitch = 0.3;
    this.glide.bank = 0;
    this.setState('glide');
  }

  private fixedGlide(dt: number, input: Input): void {
    const g = this.glide;
    if (!input.held('jump') || !this.hero) {
      this.setState('move');
      this.velocity.set(Math.sin(g.yaw) * g.speed * 0.8, -Math.sin(g.pitch) * g.speed * 0.5, Math.cos(g.yaw) * g.speed * 0.8);
      this.airTime = 0.4;
      return;
    }
    const want = THREE.MathUtils.clamp(0.22 + input.moveY * 0.72, -0.5, 1.0);
    g.pitch += (want - g.pitch) * (1 - Math.exp(-2.6 * dt));
    if (g.speed < 6.5) g.pitch += (0.55 - g.pitch) * (1 - Math.exp(-3 * dt));
    const turn = -input.moveX * 1.45;
    g.yaw += turn * dt;
    g.bank += (-input.moveX * 0.55 - g.bank) * (1 - Math.exp(-4 * dt));
    g.speed += (9.81 * Math.sin(g.pitch) - 0.0135 * g.speed * g.speed) * dt;
    g.speed = THREE.MathUtils.clamp(g.speed, 3, 42);
    const lift = this.ctx.lift(this.position.x, this.position.y, this.position.z);
    g.lift += (lift - g.lift) * (1 - Math.exp(-2.5 * dt));
    const cp = Math.cos(g.pitch);
    this.velocity.set(Math.sin(g.yaw) * cp * g.speed + wind.vector.x * 0.12, -Math.sin(g.pitch) * g.speed + g.lift - 0.6, Math.cos(g.yaw) * cp * g.speed + wind.vector.z * 0.12);
    // Updraft energy: rising air also adds a little speed.
    if (g.lift > 1) g.speed += g.lift * 0.05 * dt;
    this.heading = g.yaw;
    const desired = this.velocity.clone().multiplyScalar(dt);
    const mv = this.kcc(desired);
    this.grounded = this.controller.computedGrounded();
    if (this.grounded) {
      const dive = g.speed > 15 && g.pitch > 0.45;
      const impact = Math.max(0, Math.sin(g.pitch) * g.speed - g.lift);
      this.setState('move');
      this.velocity.set(Math.sin(g.yaw) * g.speed * 0.4, -2, Math.cos(g.yaw) * g.speed * 0.4);
      this.airTime = 0.5;
      this.onLanded(dive ? g.speed : Math.min(impact, 8), dive);
      if (dive) this.playOnce('Jump_Land', 0.9, 0.05);
      else if (g.speed > 10) this.playOnce('Roll', 1.4, 0.06);
      return;
    }
    // Hit a wall: grab a ledge if there is one, otherwise drop out of the glide.
    const hd = Math.hypot(desired.x, desired.z);
    const hm = Math.hypot(mv.x, mv.z);
    if (hd > 0.05 && hm < hd * 0.35) {
      const dir = new THREE.Vector3(Math.sin(g.yaw), 0, Math.cos(g.yaw));
      const ledge = probeLedge(this.position, dir, 1.2, 2.5, 0.9);
      if (ledge) {
        this.startHang(ledge);
        return;
      }
      this.setState('move');
      this.velocity.set(-Math.sin(g.yaw) * 2, -1, -Math.cos(g.yaw) * 2);
      this.airTime = 0.4;
    }
  }

  // ---- grapple

  /** Recompute the aim-assisted grapple target (hero, on foot). */
  updateAim(cam: THREE.Camera): void {
    if (!this.hero || this._driving || this.state === 'ragdoll' || this.state === 'grapple' || this.ctx.inCombat) {
      this.grappleTarget = null;
      return;
    }
    if (++this.aimFrame % 3 !== 0) return;
    const chest = this.position.clone().add(new THREE.Vector3(0, 1.4, 0));
    this.grappleTarget = findGrappleTarget(cam, chest);
  }

  private startGrapple(t: GrappleTarget): void {
    this.grapple = { target: t, t: 0, blocked: 0 };
    this.setState('grapple');
    this.ledge = null;
    this.playOnce('Spell_Simple_Shoot', 1.6, 0.05);
    this.heading = Math.atan2(t.anchor.x - this.position.x, t.anchor.z - this.position.z);
    events.emit('player:grapple', { x: t.anchor.x, y: t.anchor.y, z: t.anchor.z });
  }

  private grappleAim(): THREE.Vector3 {
    const t = this.grapple!.target;
    return t.roof ? t.anchor.clone().add(new THREE.Vector3(0, 0.6, 0)) : t.anchor.clone().addScaledVector(t.n, 0.45).add(new THREE.Vector3(0, -0.6, 0));
  }

  private fixedGrapple(dt: number, input: Input): void {
    const gr = this.grapple!;
    gr.t += dt;
    if (input.consume('jump') && gr.t > 0.3) {
      // Let go mid-zip (keeps momentum: chain into a glide).
      this.endGrapple(false);
      return;
    }
    const chest = this.position.clone().add(new THREE.Vector3(0, 1.3, 0));
    if (gr.t < 0.18) {
      // Rope flies out; the hero hangs in place (keeps momentum, light gravity).
      this.velocity.y -= GRAVITY * 0.4 * dt;
      this.kcc(this.velocity.clone().multiplyScalar(dt));
      return;
    }
    const aim = this.grappleAim();
    const to = aim.clone().sub(chest);
    const dist = to.length();
    const dir = to.normalize();
    // Momentum-preserving pull: accelerate along the rope, bleed off sideways motion.
    const along = this.velocity.dot(dir);
    const side = this.velocity.clone().addScaledVector(dir, -along);
    side.multiplyScalar(Math.exp(-2.5 * dt));
    const sp = Math.min(34, Math.max(along, 6) + 48 * dt);
    this.velocity.copy(side).addScaledVector(dir, sp);
    this.heading = Math.atan2(dir.x, dir.z);
    const desired = this.velocity.clone().multiplyScalar(dt);
    const mv = this.kcc(desired);
    if (mv.length() < desired.length() * 0.3) gr.blocked += dt;
    else gr.blocked = 0;
    if (dist < 1.6 || chest.y > aim.y + 0.3) {
      this.endGrapple(true);
      return;
    }
    if (gr.t > 4.5 || gr.blocked > 0.3) this.endGrapple(false);
  }

  private endGrapple(launch: boolean): void {
    const gr = this.grapple;
    this.grapple = null;
    this.rope.hide();
    this.grappleCooldown = 0.35;
    this.setState('move');
    this.grounded = false;
    this.airTime = 0.31;
    if (launch && gr) {
      // Launch boost: enough to lift the feet ~0.7 m above the edge, then carry over it.
      const over = gr.target.roof ? new THREE.Vector3(this.velocity.x, 0, this.velocity.z).normalize() : gr.target.n.clone().negate();
      const rise = Math.max(0.8, gr.target.anchor.y + 0.7 - this.position.y);
      const vy = Math.max(9.5, Math.sqrt(2 * GRAVITY * rise));
      this.velocity.set(over.x * 6, vy, over.z * 6).addScaledVector(this.velocity.clone().setY(0), 0.25);
      this.launch = { dir: over.clone(), t: 0.9 };
      this.jumpTimer = 0.3;
      this.actions.jumpStart.reset().play();
    }
  }

  // ---- combat motion

  private fixedWarp(dt: number): void {
    const w = this.warp!;
    w.t += dt;
    const left = Math.max(1e-3, w.dur - w.t + dt);
    const d = w.to.clone().sub(this.position).setY(0);
    const step = d.clone().multiplyScalar(Math.min(1, dt / left));
    this.velocity.set(step.x / dt, 0, step.z / dt);
    this.kcc(step.setY(-0.05));
    this.grounded = this.controller.computedGrounded();
    let dy = w.yaw - this.heading;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.heading += dy * (1 - Math.exp(-25 * dt));
    if (w.t >= w.dur) {
      this.heading = w.yaw;
      this.warp = null;
      this.velocity.set(0, 0, 0);
      this.setState('move');
    }
  }

  private fixedDodge(dt: number): void {
    const dur = this.state === 'dodge' ? 0.55 : 0.4;
    const k = 1 - this.stateT / dur;
    const speed = this.state === 'dodge' ? 7.5 * Math.max(0, k) + 1 : 4 * Math.max(0, k);
    const dir = this.state === 'dodge' ? this.dodgeDir : this.velocity.clone().setY(0).normalize();
    const v = dir.clone().multiplyScalar(speed);
    v.y = this.grounded ? -2 : this.velocity.y - GRAVITY * dt;
    this.velocity.copy(v);
    this.kcc(v.clone().multiplyScalar(dt));
    this.grounded = this.controller.computedGrounded();
    if (this.stateT >= dur) this.setState('move');
  }

  private followRagdoll(): void {
    const rd = this.rig.ragdoll;
    if (!rd) return;
    const p = rd.pelvis.translation();
    // Keep the (disabled-for-queries) capsule near the body so the camera and AI track it.
    this.object.position.set(p.x, p.y - 0.95, p.z);
    this.position.copy(this.object.position);
    this.prevPos.copy(this.position);
    this.rb.setNextKinematicTranslation({ x: p.x, y: p.y + 0.3, z: p.z });
  }

  // ---------------------------------------------------------------- visuals

  /** Visual update: interpolated transform + animation blending + IK + cape. */
  update(dt: number, alpha: number): void {
    if (this.state === 'ragdoll' || this.rig.active) {
      this.rig.update(dt);
      if (this.rig.state === 'getup') {
        this.mixer.update(dt);
        this.rig.postMixer(dt);
      }
      this.model.rotation.set(0, 0, 0);
      this.model.position.set(0, 0, 0);
      this.updateCape(dt);
      return;
    }
    if (!this._driving) {
      this.object.position.lerpVectors(this.prevPos, this.position, alpha);
      this.object.rotation.set(0, this.heading, 0);
    }
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    const st = this.state;
    const locoSpeed = st === 'move' || st === 'warp' ? hs : 0;
    this.speedSmoothed += (locoSpeed - this.speedSmoothed) * (1 - Math.exp(-10 * dt));
    const s = this.speedSmoothed;
    // Locomotion weights (piecewise linear between clip speeds).
    const w = [0, 0, 0, 0];
    if (s <= 0.15) w[0] = 1;
    else {
      for (let i = 0; i < 3; i++) {
        const a = this.loco[i].speed;
        const b = this.loco[i + 1].speed;
        if (s <= b || i === 2) {
          const t = THREE.MathUtils.clamp((s - Math.max(a, 0.15)) / (b - Math.max(a, 0.15)), 0, 1);
          w[i] = 1 - t;
          w[i + 1] = t;
          break;
        }
      }
    }
    // Phase-synced locomotion so blended feet stay in step.
    let freq = 0;
    for (let i = 1; i < 4; i++) freq += w[i] * (1 / this.loco[i].action.getClip().duration) * (s / this.loco[i].speed);
    freq += w[0] * (1 / this.loco[0].action.getClip().duration);
    this.phase = (this.phase + freq * dt) % 1;
    // Special poses.
    const k = (target: number, cur: number, rate: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
    this.glideW = k(st === 'glide' ? 1 : 0, this.glideW, 9);
    this.hangW = k(st === 'hang' || st === 'grapple' || (st === 'climb' && this.tween?.kind === 'hangjump') ? 1 : 0, this.hangW, 12);
    const climbK = st === 'climb' && this.tween && this.tween.kind !== 'hangjump' ? this.tween.t / this.tween.dur : 0;
    this.climbW = k(climbK > 0.35 ? 1 : 0, this.climbW, 12);
    const special = Math.min(1, this.glideW + this.hangW + this.climbW);
    // Air / land layers.
    const inAir = !this.grounded && !this._driving && (st === 'move' || st === 'vault');
    const airTarget = (inAir && (this.airTime > 0.12 || this.jumpTimer > 0)) || st === 'vault' ? 1 : 0;
    this.airW += (airTarget - this.airW) * (1 - Math.exp(-14 * dt));
    const landTarget = this.landTimer > 0 && !inAir ? 1 : 0;
    this.landW += (landTarget - this.landW) * (1 - Math.exp(-18 * dt));
    const driveW = this._driving ? 1 : 0;
    // One-shot overlay.
    let ow = 0;
    if (this.overlay) {
      const o = this.overlay;
      o.t += dt;
      ow = Math.min(1, o.t / o.fade) * Math.min(1, Math.max(0, (o.dur - o.t) / Math.max(o.fade, 0.1)));
      if (o.t >= o.dur) {
        o.a.stop();
        this.overlay = null;
        ow = 0;
      } else o.a.setEffectiveWeight(ow * (1 - driveW));
    }
    const rest = (1 - ow) * (1 - driveW) * (1 - special);
    const fightW = this.ctx.inCombat && st === 'move' && s < 1.5 ? 1 - s / 1.5 : 0;
    const locoW = Math.max(0, 1 - this.airW - this.landW * 0.7) * rest;
    this.loco.forEach((l, i) => {
      l.action.setEffectiveWeight(w[i] * locoW * (i === 0 ? 1 - fightW : 1));
      l.action.time = this.phase * l.action.getClip().duration;
    });
    this.actions.fight.setEffectiveWeight(w[0] * locoW * fightW);
    const js = this.jumpTimer > 0 ? 1 : 0;
    this.actions.jumpStart.setEffectiveWeight(this.airW * js * rest);
    this.actions.fall.setEffectiveWeight(this.airW * (1 - js) * rest + this.hangW * (1 - ow) * (1 - driveW));
    this.actions.land.setEffectiveWeight(this.landW * 0.7 * rest);
    this.actions.drive.setEffectiveWeight(driveW);
    this.actions.tpose.setEffectiveWeight(this.glideW * (1 - ow) * (1 - driveW));
    this.actions.crouch.setEffectiveWeight(this.climbW * (1 - driveW));
    this.mixer.update(dt);
    // Body tilt (glide): pitch forward around the hips, bank into turns.
    const g = this.glide;
    const wantPitch = st === 'glide' ? 1.22 + g.pitch * 0.32 : 0;
    const wantRoll = st === 'glide' ? g.bank : 0;
    this.tilt.pitch = k(wantPitch, this.tilt.pitch, wantPitch > this.tilt.pitch ? 6 : 9);
    this.tilt.roll = k(wantRoll, this.tilt.roll, 6);
    this.model.rotation.set(this.tilt.pitch, 0, this.tilt.roll);
    const pivot = _v.set(0, 1.0, 0);
    this.model.position.copy(pivot).sub(pivot.clone().applyEuler(this.model.rotation));
    this.object.updateMatrixWorld(true);
    this.applyIK();
    this.updateCape(dt);
    // Rope.
    if (this.grapple) {
      const hand = this.bones.get('hand_r')!.getWorldPosition(new THREE.Vector3());
      this.rope.set(hand, this.grapple.target.anchor, Math.min(1, this.grapple.t / 0.18));
    }
    this.suit.update(this.time, 1);
  }

  private applyIK(): void {
    const B = (n: string) => this.bones.get(n)!;
    const ik = (side: 'l' | 'r', target: THREE.Vector3, pole: THREE.Vector3) => twoBoneIK(B(`upperarm_${side}`), B(`lowerarm_${side}`), B(`hand_${side}`), target, pole);
    const l = this.ledge;
    if ((this.state === 'hang' || (this.state === 'climb' && this.tween && this.tween.t / this.tween.dur < 0.5)) && l && this.hangW + this.climbW > 0.3) {
      const facing = l.n.clone().negate();
      const right = new THREE.Vector3(-facing.z, 0, facing.x);
      const base = l.edge.clone().addScaledVector(l.n, 0.02);
      base.y += 0.03;
      const pole = l.n.clone().multiplyScalar(1).add(new THREE.Vector3(0, -1, 0));
      const chest = B('spine_03').getWorldPosition(new THREE.Vector3());
      ik('l', base.clone().addScaledVector(right, -0.24), chest.clone().add(pole).addScaledVector(right, -1));
      ik('r', base.clone().addScaledVector(right, 0.24), chest.clone().add(pole).addScaledVector(right, 1));
    } else if (this.glideW > 0.3) {
      // Glide: arms down and out, gripping the cape's edges to form the wing.
      const m = this.model.matrixWorld;
      const hx = capeHalfWidth(WING_ROW) * 1.05;
      const hy = 1.5 - WING_ROW * 1.2;
      for (const side of ['l', 'r'] as const) {
        const sx = side === 'l' ? 1 : -1;
        const target = new THREE.Vector3(sx * hx, hy, -0.12).applyMatrix4(m);
        const pole = new THREE.Vector3(sx * 1.2, 1.3, -0.8).applyMatrix4(m);
        const cur = B(`hand_${side}`).getWorldPosition(new THREE.Vector3());
        ik(side, cur.lerp(target, Math.min(1, (this.glideW - 0.3) / 0.5)), pole);
      }
    } else if (this.grapple) {
      const sh = B('upperarm_r').getWorldPosition(new THREE.Vector3());
      const dir = this.grapple.target.anchor.clone().sub(sh).normalize();
      ik('r', sh.clone().addScaledVector(dir, 0.62), sh.clone().add(new THREE.Vector3(0, -1, 0)));
      const shl = B('upperarm_l').getWorldPosition(new THREE.Vector3());
      ik('l', shl.clone().addScaledVector(dir, 0.45).add(new THREE.Vector3(0, -0.1, 0)), shl.clone().add(new THREE.Vector3(0, -1, 0)));
    }
  }

  private updateCape(dt: number): void {
    if (!this.cape.mesh.visible) return;
    this.model.updateMatrixWorld(true);
    const B = (n: string) => this.bones.get(n)!.getWorldPosition(new THREE.Vector3());
    const skel = this.body.skeleton;
    const spine = new THREE.Matrix4().multiplyMatrices(skel.bones[this.spineIdx].matrixWorld, skel.boneInverses[this.spineIdx]).multiply(this.body.bindMatrix);
    const pelvis = B('pelvis');
    const sp2 = B('spine_02');
    const neck = B('neck_01');
    const head = B('Head');
    const headTop = head.clone().add(head.clone().sub(neck).normalize().multiplyScalar(0.16));
    // Arm capsules start a little out from the shoulder joint (the cape is pinned there) and
    // are skipped while gliding (the arms hold the wing's edges).
    const ua = (side: 'l' | 'r') => B(`upperarm_${side}`).lerp(B(`lowerarm_${side}`), 0.25);
    // While the glide wing holds the cloth (shape matching), only the head collides: the
    // body tipping forward would otherwise drag the hanging cloth through itself.
    const caps: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [{ a: head, b: headTop, r: 0.13 }];
    if (this.glideW < 0.05 && this.tilt.pitch < 0.25) caps.push({ a: pelvis, b: sp2, r: 0.15 }, { a: sp2, b: neck, r: 0.14 });
    if (this.glideW < 0.05 && this.tilt.pitch < 0.25) {
      caps.push(
        { a: ua('l'), b: B('lowerarm_l'), r: 0.07 },
        { a: ua('r'), b: B('lowerarm_r'), r: 0.07 },
        { a: B('lowerarm_l'), b: B('hand_l'), r: 0.055 },
        { a: B('lowerarm_r'), b: B('hand_r'), r: 0.055 },
      );
    }
    // Legs swing up through the cloth when tipping into a glide: no leg collisions then.
    if (this.glideW < 0.05 && this.tilt.pitch < 0.25) {
      caps.push(
        { a: B('thigh_l').lerp(B('calf_l'), 0.22), b: B('calf_l'), r: 0.09 },
        { a: B('thigh_r').lerp(B('calf_r'), 0.22), b: B('calf_r'), r: 0.09 },
        { a: B('calf_l'), b: B('foot_l'), r: 0.065 },
        { a: B('calf_r'), b: B('foot_r'), r: 0.065 },
      );
    }
    // Body collisions ease back in after a glide.
    const bodyOn = this.glideW < 0.05 && this.tilt.pitch < 0.25 && this.state !== 'dodge';
    this.capeColK = bodyOn ? Math.min(1, this.capeColK + dt * 2.5) : 0.15;
    // Ground and nearby walls (probed a few times per second).
    this.wallProbeT -= dt;
    if (this.wallProbeT <= 0) {
      this.wallProbeT = 0.12;
      const g = physics.rayHit(sp2.clone().add(new THREE.Vector3(0, 0.3, 0)), new THREE.Vector3(0, -1, 0), 6, GROUPS_PROBE);
      this.groundY = g ? g.point.y : this.position.y - 50;
      this.walls.length = 0;
      const back = new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
      const side = new THREE.Vector3(back.z, 0, -back.x);
      for (const d of [back, side, side.clone().negate()]) {
        const h = physics.rayHit(sp2, d, 1.6, GROUPS_PROBE);
        if (h && Math.abs(h.normal.y) < 0.5 && this.state !== 'glide') this.walls.push({ n: h.normal.clone(), d: h.normal.dot(h.point), p: h.point.clone() });
      }
    }
    this.capeFrame = {
      spine,
      model: this.model.matrixWorld,
      capsules: caps,
      hands: [B('hand_l'), B('hand_r')],
      groundY: this.groundY,
      walls: this.walls,
      glide: this.glideW,
      extraWind: new THREE.Vector3(0, this.state === 'glide' ? this.glide.lift * 0.6 : 0, 0),
      velocity: this.velocity,
      collideK: this.capeColK,
    };
    this.cape.update(dt, this.capeFrame);
  }

  /** Locomotion cycle phase (0..1; feet strike near 0 and 0.5) and on-ground speed, for footsteps. */
  get stepPhase(): number {
    return this.phase;
  }

  get groundSpeed(): number {
    return this.grounded && !this._driving && this.state === 'move' ? this.speedSmoothed : 0;
  }

  get feet(): THREE.Vector3 {
    return this.object.position;
  }

  get yaw(): number {
    return this.heading;
  }

  /** Tests / screenshots: start gliding immediately (hold 'jump' via input.forced to keep it). */
  debugGlide(yaw: number, speed = 16): void {
    this.glide.speed = speed;
    this.glide.yaw = yaw;
    this.glide.pitch = 0.25;
    this.heading = yaw;
    this.grounded = false;
    this.airTime = 1;
    this.setState('glide');
  }

  /** World position of a bone. */
  bonePos(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    return this.bones.get(name)!.getWorldPosition(out);
  }
}

/**
 * Dress the base body with casual clothes using bind-pose vertex positions (metres, Y-up,
 * T-pose, facing +Z): dark jeans, belt, jacket with zip and collar, T-shirt at the neckline,
 * and shoes. Clothed regions drop the anatomy normal map for smooth fabric with weave noise.
 */
function dressCivilian(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBind;
        float clHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        float clNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(clHash(i), clHash(i + vec2(1, 0)), u.x), mix(clHash(i + vec2(0, 1)), clHash(i + vec2(1, 1)), u.x), u.y); }
        float clCloth;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 b = vBind;
          float ax = abs(b.x);
          float shoe = step(b.y, 0.115);
          float legs = step(b.y, 0.985) * (1.0 - shoe);
          float belt = step(0.94, b.y) * step(b.y, 0.99) * step(ax, 0.2);
          float torso = step(0.985, b.y) * step(b.y, 1.5) * step(ax, 0.235);
          float arms = step(1.24, b.y) * step(b.y, 1.62) * step(0.2, ax) * step(ax, 0.66);
          float jacket = max(torso, arms);
          float shirt = torso * step(1.38, b.y) * step(ax, (b.y - 1.38) * 0.55 + 0.012) * step(0.02, b.z);
          float collar = step(1.44, b.y) * step(b.y, 1.53) * step(ax, 0.1) * step(b.z, 0.02);
          vec3 jeans = vec3(0.07, 0.1, 0.17) * (0.82 + 0.3 * clNoise(b.xy * vec2(220.0, 40.0)));
          jeans *= 1.0 - 0.25 * smoothstep(0.55, 0.3, b.y) * (0.5 + 0.5 * clNoise(b.xy * 9.0));
          vec3 jkt = vec3(0.16, 0.2, 0.16) * (0.9 + 0.15 * clNoise(b.xy * 120.0));
          vec3 tee = vec3(0.42, 0.42, 0.44);
          vec3 shoeC = mix(vec3(0.85, 0.84, 0.8), vec3(0.08), step(b.y, 0.03));
          vec3 c = diffuseColor.rgb;
          c = mix(c, jeans, legs);
          c = mix(c, vec3(0.12, 0.08, 0.05), belt);
          c = mix(c, jkt, jacket);
          c = mix(c, tee, shirt);
          c = mix(c, jkt * 0.8, collar);
          float zip = torso * step(ax, 0.005) * step(0.02, b.z) * (1.0 - step(1.38, b.y));
          c = mix(c, vec3(0.5), zip);
          c = mix(c, shoeC, shoe);
          clCloth = clamp(legs + jacket + shoe + belt, 0.0, 1.0);
          diffuseColor.rgb = c;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.82, clCloth);')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        normal = normalize(mix(normal, normalize(vNormal), clCloth * 0.85));`,
      );
  };
  mat.customProgramCacheKey = () => 'civilianClothes';
  mat.needsUpdate = true;
}
