/**
 * The civilian player: Quaternius base character dressed by a bind-space clothing shader,
 * phase-synced locomotion blending (idle/walk/jog/sprint) plus jump/fall/land layers,
 * and a Rapier kinematic character controller.
 */
import * as THREE from 'three';
import { assets } from '../core/AssetLoader';
import { physics, RAPIER, GROUPS_PLAYER, G_PLAYER } from '../core/Physics';
import type { Input } from '../core/Input';
import type { CameraRig } from './CameraRig';

const RADIUS = 0.3;
const HALF = 0.58;
const GRAVITY = 24;
const JUMP_V = 6.6;
const SPEED = { walk: 1.7, run: 4.3, sprint: 7.2 };

interface LocoClip {
  action: THREE.AnimationAction;
  speed: number;
}

export class Player {
  readonly object = new THREE.Group();
  private model!: THREE.Object3D;
  private mixer!: THREE.AnimationMixer;
  private loco: LocoClip[] = [];
  private actions: Record<string, THREE.AnimationAction> = {};
  private body!: RAPIER.RigidBody;
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
  driving = false;
  hidden = false;

  async load(): Promise<void> {
    const [char, hair, anims] = await Promise.all([
      assets.loadGLTF('models/characters/civilian_male.glb'),
      assets.loadGLTF('models/characters/hair_simpleparted.glb'),
      assets.loadGLTF('models/characters/anim_locomotion.glb'),
    ]);
    this.model = char.scene;
    this.model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.name === 'MI_Superhero_Male') dressCivilian(mat);
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
      const hairRoot = hair.scene;
      hairRoot.updateMatrixWorld(true);
      head.attach(hairRoot);
    }
    this.object.add(this.model);
    this.object.name = 'Player';
    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (name: string) => anims.animations.find((a) => a.name === name);
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
    this.loco[0].action.setEffectiveWeight(1);
  }

  spawn(x: number, y: number, z: number, yaw: number): void {
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + HALF + RADIUS + 0.05, z);
    this.body = physics.world.createRigidBody(desc);
    this.collider = physics.world.createCollider(RAPIER.ColliderDesc.capsule(HALF, RADIUS).setCollisionGroups(GROUPS_PLAYER), this.body);
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
    this.body.setNextKinematicTranslation({ x, y: y + HALF + RADIUS + 0.02, z });
    this.body.setTranslation({ x, y: y + HALF + RADIUS + 0.02, z }, true);
    this.velocity.set(0, 0, 0);
    this.position.set(x, y, z);
    this.prevPos.copy(this.position);
    if (yaw !== undefined) this.heading = yaw;
  }

  setEnabled(enabled: boolean): void {
    this.collider.setEnabled(enabled);
  }

  fixedUpdate(dt: number, input: Input, cam: CameraRig): void {
    if (this.driving) return;
    if (input.consume('jump')) this.wantJump = true;
    // Desired horizontal velocity relative to the camera.
    const fwd = cam.forward(new THREE.Vector3());
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const move = new THREE.Vector3().addScaledVector(fwd, input.moveY).addScaledVector(right, input.moveX);
    const mag = Math.min(1, move.length());
    if (mag > 0.01) move.normalize();
    const sprint = input.held('sprint');
    const target = mag * (sprint ? SPEED.sprint : mag > 0.6 ? SPEED.run : SPEED.walk + (SPEED.run - SPEED.walk) * Math.max(0, (mag - 0.3) / 0.3));
    const hv = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    const desired = move.clone().multiplyScalar(target);
    const accel = this.grounded ? (target > hv.length() ? 14 : 22) : 3.5;
    const dv = desired.sub(hv);
    const maxDv = accel * dt;
    if (dv.length() > maxDv) dv.setLength(maxDv);
    hv.add(dv);
    this.velocity.x = hv.x;
    this.velocity.z = hv.z;
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
      this.velocity.y = Math.max(this.velocity.y, -40);
    }
    this.wantJump = false;
    const delta = this.velocity.clone().multiplyScalar(dt);
    this.controller.computeColliderMovement(this.collider, delta, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (c) => (c.collisionGroups() >>> 16 & G_PLAYER) === 0);
    const mv = this.controller.computedMovement();
    const p = this.body.translation();
    this.prevPos.copy(this.position);
    const next = { x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z };
    this.body.setNextKinematicTranslation(next);
    const wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded() && this.velocity.y <= 0.5;
    if (this.grounded) {
      if (!wasGrounded && this.airTime > 0.35) {
        this.landTimer = Math.min(0.45, 0.2 + this.airTime * 0.15);
        this.actions.land.reset().play();
      }
      this.airTime = 0;
    } else this.airTime += dt;
    // Blocked by walls: kill horizontal velocity components we couldn't execute.
    if (dt > 0) {
      this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, mv.x / dt, 0.5);
      this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, mv.z / dt, 0.5);
    }
    this.position.set(next.x, next.y - HALF - RADIUS, next.z);
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

  /** Visual update: interpolated transform + animation blending. */
  update(dt: number, alpha: number): void {
    if (!this.driving) {
      this.object.position.lerpVectors(this.prevPos, this.position, alpha);
      this.object.rotation.set(0, this.heading, 0);
    }
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    this.speedSmoothed += (hs - this.speedSmoothed) * (1 - Math.exp(-10 * dt));
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
    // Air / land layers.
    const inAir = !this.grounded && !this.driving;
    const airTarget = inAir && (this.airTime > 0.12 || this.jumpTimer > 0) ? 1 : 0;
    this.airW += (airTarget - this.airW) * (1 - Math.exp(-14 * dt));
    const landTarget = this.landTimer > 0 && !inAir ? 1 : 0;
    this.landW += (landTarget - this.landW) * (1 - Math.exp(-18 * dt));
    const driveW = this.driving ? 1 : 0;
    const locoW = Math.max(0, 1 - this.airW - this.landW * 0.7) * (1 - driveW);
    this.loco.forEach((l, i) => {
      l.action.setEffectiveWeight(w[i] * locoW);
      l.action.time = this.phase * l.action.getClip().duration;
    });
    const js = this.jumpTimer > 0 ? 1 : 0;
    this.actions.jumpStart.setEffectiveWeight(this.airW * js * (1 - driveW));
    this.actions.fall.setEffectiveWeight(this.airW * (1 - js) * (1 - driveW));
    this.actions.land.setEffectiveWeight(this.landW * 0.7 * (1 - driveW));
    this.actions.drive.setEffectiveWeight(driveW);
    this.mixer.update(dt);
  }

  get feet(): THREE.Vector3 {
    return this.object.position;
  }

  get yaw(): number {
    return this.heading;
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
