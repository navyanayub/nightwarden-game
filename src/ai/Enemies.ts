/**
 * Street gangs: six hangouts around Port Vellmoor that spawn groups of thugs when the player
 * comes near, so combat can be played before the Stage 4 crime system.
 *
 * Thugs carry fists, pipes, knives or pistols; variants are the heavy brute (unblockable
 * attacks, lots of health) and the riot-shield thug (blocks frontal strikes until stunned).
 *
 * AI per thug:
 *  - awareness: unaware → suspicious (sees the hero: '?') → alert ('!', calls backup) → combat,
 *    or flee when badly outnumbered; noise (fights, knockouts, gunshots) alerts nearby thugs.
 *  - combat: an attack-token system lets at most two melee attackers (and one shooter) strike at
 *    once; everyone else circles the player on spread-out flanking slots. Attacks have a
 *    wind-up with a warning icon (counterable, or red = unblockable → dodge).
 *  - movement: shared Rapier kinematic character controller per capsule.
 * Knockouts are ragdolls (non-lethal: they stay down); weapons drop as physics props.
 */
import * as THREE from 'three';
import { physics, RAPIER, GROUPS_ENEMY, GROUPS_PROBE, GROUPS_PROP, G_PLAYER, G_ENEMY, G_RAGDOLL } from '../core/Physics';
import { events } from '../core/EventBus';
import { Rng, hashN } from '../core/Random';
import { heightAt } from '../world/Terrain';
import type { CityData } from '../world/CityLayout';
import type { Look } from './CrowdRender';
import { Actor, type ActorKit, type WeaponKind, type ActorClip } from '../actors/Actor';
import { twoBoneIK } from './AnimBaker';
import { clock } from '../systems/Clock';

export type ThugKind = 'thug' | 'brute' | 'shield';
export type Awareness = 'unaware' | 'suspicious' | 'alert' | 'combat' | 'flee';

export interface Hangout {
  id: number;
  name: string;
  gang: string;
  x: number;
  z: number;
  y: number;
  palette: [number, number, number][];
  accent: [number, number, number];
  active: boolean;
  clearedUntil: number;
  backupCalled: boolean;
  group: THREE.Group;
  fire: THREE.Mesh;
  /** Props/colliders are placed on first activation (once the ground colliders have streamed in). */
  placed: boolean;
  props: { x: number; z: number; s: number; yaw: number }[];
  /** Game time at which called-in backup arrives (0 = none pending). */
  backupAt: number;
}

export interface Thug {
  id: number;
  actor: Actor;
  hangout: Hangout;
  kind: ThugKind;
  weapon: WeaponKind;
  hp: number;
  maxHp: number;
  aware: Awareness;
  suspicion: number;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  radius: number;
  pos: THREE.Vector3;
  yaw: number;
  vel: THREE.Vector3;
  token: boolean;
  atk: { phase: 'approach' | 'windup' | 'strike' | 'recover'; t: number; heavy: boolean; clip: ActorClip } | null;
  cooldown: number;
  stun: number;
  stagger: number;
  confused: number;
  slot: number;
  circleDir: 1 | -1;
  home: THREE.Vector3;
  idleClip: ActorClip;
  lastSeen: THREE.Vector3;
  alertT: number;
  ko: boolean;
  knocked: boolean;
  guardBroken: number;
  /** 0 none, 1 counterable, 2 unblockable / gun. */
  warn: 0 | 1 | 2;
  perceiveT: number;
  sees: boolean;
  dist: number;
  unseen: number;
  fleeT: number;
  backup: boolean;
  koT: number;
}

interface Drop {
  mesh: THREE.Object3D;
  body: RAPIER.RigidBody;
  t: number;
  fly?: { to: () => THREE.Vector3; t: number };
}

export interface PlayerView {
  pos: THREE.Vector3;
  hero: boolean;
  invulnerable: boolean;
  driving: boolean;
  hurt(amount: number, from: THREE.Vector3, heavy?: boolean): boolean;
}

const HANGOUTS: { name: string; gang: string; kind: string; district: string; near: [number, number]; palette: [number, number, number][]; accent: [number, number, number] }[] = [
  { name: 'The Stacks', gang: 'Rustline Crew', kind: 'containers', district: 'harbour', near: [420, 640], palette: [[0.08, 0.09, 0.1], [0.12, 0.1, 0.08], [0.06, 0.06, 0.07]], accent: [0.55, 0.22, 0.08] },
  { name: 'Railside', gang: 'Gravel Saints', kind: 'railyard', district: 'industrial', near: [-400, 560], palette: [[0.16, 0.16, 0.15], [0.1, 0.11, 0.1], [0.2, 0.19, 0.17]], accent: [0.62, 0.55, 0.1] },
  { name: 'Clocktower Steps', gang: 'Bellrope Boys', kind: 'square', district: 'oldtown', near: [-480, 0], palette: [[0.1, 0.06, 0.06], [0.14, 0.08, 0.07], [0.07, 0.05, 0.05]], accent: [0.5, 0.06, 0.08] },
  { name: 'Glasshouse Plaza', gang: 'Glass Jaws', kind: 'plaza', district: 'midtown', near: [150, -40], palette: [[0.05, 0.07, 0.1], [0.08, 0.1, 0.14], [0.04, 0.05, 0.07]], accent: [0.1, 0.4, 0.55] },
  { name: 'The Pavilion', gang: 'Pond Rats', kind: 'park', district: 'park', near: [500, -620], palette: [[0.08, 0.1, 0.07], [0.11, 0.13, 0.09], [0.06, 0.07, 0.05]], accent: [0.3, 0.5, 0.12] },
  { name: 'Hilltop Lot', gang: 'Ridge Kings', kind: 'hills', district: 'hills', near: [-150, -480], palette: [[0.12, 0.08, 0.12], [0.08, 0.06, 0.1], [0.1, 0.1, 0.12]], accent: [0.45, 0.2, 0.55] },
];

const MAX_THUGS = 26;
const SPAWN_R = 135;
const DESPAWN_R = 230;
const UP = new THREE.Vector3(0, 1, 0);

export class Enemies {
  readonly thugs: Thug[] = [];
  readonly hangouts: Hangout[] = [];
  readonly group = new THREE.Group();
  private drops: Drop[] = [];
  private controller: RAPIER.KinematicCharacterController;
  private nextId = 1;
  private time = 0;
  private rng = new Rng(0x5eed7);
  private tokenT = 0;
  /** Hangouts spawn crews when the player comes near (tests switch this off for calm shots). */
  spawning = true;
  /** Smoke clouds (x, z, r, t). */
  smokes: { x: number; z: number; r: number; t: number }[] = [];

  constructor(
    city: CityData,
    private readonly kit: ActorKit,
  ) {
    this.group.name = 'Enemies';
    this.controller = physics.world.createCharacterController(0.03);
    this.controller.enableAutostep(0.4, 0.2, false);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    HANGOUTS.forEach((h, i) => {
      const p = this.findSpot(city, h.kind, h.district, h.near);
      const hg: Hangout = { id: i, name: h.name, gang: h.gang, x: p.x, z: p.z, y: p.y, palette: h.palette, accent: h.accent, active: false, clearedUntil: 0, backupCalled: false, group: new THREE.Group(), fire: null as unknown as THREE.Mesh, placed: false, props: [], backupAt: 0 };
      this.buildHangout(hg);
      this.hangouts.push(hg);
    });
    events.on('world:alarm', (a) => {
      if (a.kind !== 'gunshot') return;
      for (const t of this.thugs) if (!t.ko && Math.hypot(t.pos.x - a.x, t.pos.z - a.z) < a.radius * 0.6) this.alert(t, new THREE.Vector3(a.x, t.pos.y, a.z));
    });
  }

  // ---------------------------------------------------------------- hangouts

  private findSpot(city: CityData, kind: string, district: string, near: [number, number]): THREE.Vector3 {
    let cx = near[0];
    let cz = near[1];
    if (kind === 'park') {
      const pav = city.features.find((f) => f.type === 'pavilion');
      if (pav) {
        cx = pav.x + 14;
        cz = pav.z + 10;
      }
    } else {
      const blocks = city.blocks.filter((b) => (kind === 'hills' ? b.district === 'hills' : b.kind === kind && b.district === district));
      blocks.sort((a, b) => Math.hypot((a.minX + a.maxX) / 2 - near[0], (a.minZ + a.maxZ) / 2 - near[1]) - Math.hypot((b.minX + b.maxX) / 2 - near[0], (b.minZ + b.maxZ) / 2 - near[1]));
      if (blocks[0]) {
        cx = (blocks[0].minX + blocks[0].maxX) / 2;
        cz = (blocks[0].minZ + blocks[0].maxZ) / 2;
      }
    }
    // Spiral out to a clear patch of ground (no roofs, containers or props within ~4 m).
    const down = new THREE.Vector3(0, -1, 0);
    for (let i = 0; i < 160; i++) {
      const a = i * 2.4;
      const r = Math.sqrt(i) * 3.2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const g = heightAt(x, z);
      let ok = true;
      for (const [ox, oz] of [
        [0, 0],
        [4, 0],
        [-4, 0],
        [0, 4],
        [0, -4],
        [3, 3],
        [-3, -3],
      ]) {
        const h = physics.rayHit(new THREE.Vector3(x + ox, g + 40, z + oz), down, 60, GROUPS_PROBE);
        if (!h || h.point.y > g + 0.45 || h.normal.y < 0.85) {
          ok = false;
          break;
        }
      }
      if (ok) {
        const h = physics.rayHit(new THREE.Vector3(x, g + 40, z), down, 60, GROUPS_PROBE);
        return new THREE.Vector3(x, h ? h.point.y : g, z);
      }
    }
    return new THREE.Vector3(cx, heightAt(cx, cz), cz);
  }

  private buildHangout(h: Hangout): void {
    const g = h.group;
    g.position.set(h.x, h.y, h.z);
    // Burning oil drum.
    const drumMat = new THREE.MeshStandardMaterial({ color: 0x3b2a20, metalness: 0.6, roughness: 0.75 });
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.88, 14, 1, true), drumMat);
    drum.position.y = 0.44;
    drum.castShadow = true;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.025, 6, 16), drumMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.88;
    const embers = new THREE.Mesh(new THREE.CircleGeometry(0.28, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.9, 0.25) }));
    embers.rotation.x = -Math.PI / 2;
    embers.position.y = 0.8;
    const flameMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9, 78.2))) * 43758.5); }
        float n(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        void main(){
          vec2 p = vUv;
          float flick = n(vec2(p.x * 4.0, p.y * 3.0 - uTime * 3.5)) * 0.6 + n(vec2(p.x * 9.0, p.y * 7.0 - uTime * 6.0)) * 0.4;
          float shape = (1.0 - abs(p.x - 0.5) * 2.2 - p.y * 0.9) + flick * 0.55 - 0.35;
          float a = smoothstep(0.0, 0.45, shape) * (1.0 - p.y);
          vec3 c = mix(vec3(1.0, 0.25, 0.04), vec3(1.0, 0.8, 0.35), smoothstep(0.2, 0.8, shape));
          gl_FragColor = vec4(c * 2.2 * a, a);
        }`,
    });
    const fire = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.0), flameMat);
    fire.position.y = 1.3;
    h.fire = fire;
    g.add(drum, rim, embers, fire);
    // Crates and a pallet to sit on.
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.85 });
    const r = new Rng(hashN(h.id, 77));
    for (let i = 0; i < 3; i++) {
      const a = r.range(0, Math.PI * 2);
      const d = r.range(2.4, 3.4);
      const s = r.range(0.5, 0.7);
      const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateMat);
      c.position.set(Math.cos(a) * d, s / 2, Math.sin(a) * d);
      c.rotation.y = r.range(0, 1.5);
      c.castShadow = true;
      c.receiveShadow = true;
      g.add(c);
      h.props.push({ x: c.position.x, z: c.position.z, s, yaw: c.rotation.y });
    }
    g.visible = false;
    this.group.add(g);
  }

  /** Settle the hangout on the real ground (pavement / plaza colliders exist by now). */
  private place(h: Hangout): void {
    if (h.placed) return;
    h.placed = true;
    h.y = this.groundAt(h.x, h.z, h.y + 3);
    h.group.position.y = h.y;
    physics.addStaticCylinder(h.x, h.y + 0.45, h.z, 0.45, 0.32, GROUPS_PROP);
    for (const p of h.props) physics.addStaticBox(h.x + p.x, h.y + p.s / 2, h.z + p.z, p.s / 2, p.s / 2, p.s / 2, p.yaw, GROUPS_PROP);
  }

  // ---------------------------------------------------------------- spawning

  private lookFor(h: Hangout, kind: ThugKind, seed: number): Look {
    const r = new Rng(hashN(seed, 4242));
    const female = kind === 'thug' && r.chance(0.2);
    const base = r.pick(h.palette);
    const v = (c: [number, number, number], k: number): [number, number, number] => [c[0] * (1 + (r.next() - 0.5) * k), c[1] * (1 + (r.next() - 0.5) * k), c[2] * (1 + (r.next() - 0.5) * k)];
    const accentTop = r.chance(0.2);
    const top = accentTop ? v([h.accent[0] * 0.55, h.accent[1] * 0.55, h.accent[2] * 0.55], 0.2) : v(base, 0.4);
    const bottoms: [number, number, number][] = [
      [0.05, 0.06, 0.08],
      [0.1, 0.1, 0.1],
      [0.12, 0.1, 0.08],
    ];
    const skins: [number, number, number][] = [
      [1.0, 0.96, 0.92],
      [0.93, 0.8, 0.68],
      [0.78, 0.6, 0.45],
      [0.55, 0.4, 0.3],
      [0.38, 0.27, 0.2],
    ];
    const hairs: [number, number, number][] = [
      [0.05, 0.04, 0.035],
      [0.18, 0.12, 0.07],
      [0.35, 0.25, 0.15],
    ];
    return {
      gender: female ? 1 : 0,
      top: [...top, kind === 'brute' ? 1 : r.pick([0, 3, 3])] as [number, number, number, number],
      bottom: [...r.pick(bottoms), r.pick([0, 1])] as [number, number, number, number],
      skin: [...r.pick(skins), r.pick([1, 1, 2])] as [number, number, number, number],
      hair: r.pick(hairs),
      hairStyle: female ? r.int(0, 2) : r.pick([1, 1, 2, 0]),
      height: kind === 'brute' ? 1.1 : r.range(0.97, 1.05),
      girth: kind === 'brute' ? 1.32 : r.range(1.0, 1.14),
    };
  }

  private spawnThug(h: Hangout, x: number, z: number, kind: ThugKind, weapon: WeaponKind, slot: number): Thug | null {
    if (this.thugs.length >= MAX_THUGS) return null;
    const id = this.nextId++;
    const look = this.lookFor(h, kind, id * 31 + h.id);
    const actor = this.kit.create(look, weapon, kind === 'shield');
    const y = this.groundAt(x, z, h.y);
    actor.root.position.set(x, y, z);
    this.group.add(actor.root);
    const radius = kind === 'brute' ? 0.42 : 0.32;
    const half = (kind === 'brute' ? 0.62 : 0.58) * look.height;
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + half + radius, z));
    const collider = physics.world.createCollider(RAPIER.ColliderDesc.capsule(half, radius).setCollisionGroups(GROUPS_ENEMY), body);
    const hp = kind === 'brute' ? 11 : kind === 'shield' ? 6 : 4;
    const t: Thug = {
      id,
      actor,
      hangout: h,
      kind,
      weapon,
      hp,
      maxHp: hp,
      aware: 'unaware',
      suspicion: 0,
      body,
      collider,
      radius,
      pos: new THREE.Vector3(x, y, z),
      yaw: Math.atan2(h.x - x, h.z - z),
      vel: new THREE.Vector3(),
      token: false,
      atk: null,
      cooldown: 1 + this.rng.range(0, 2),
      stun: 0,
      stagger: 0,
      confused: 0,
      slot,
      circleDir: this.rng.chance(0.5) ? 1 : -1,
      home: new THREE.Vector3(x, y, z),
      idleClip: this.rng.pick(['idle', 'talk', 'talk', 'idle'] as ActorClip[]),
      lastSeen: new THREE.Vector3(),
      alertT: 0,
      ko: false,
      knocked: false,
      guardBroken: 0,
      warn: 0,
      perceiveT: this.rng.range(0, 0.3),
      sees: false,
      dist: 99,
      unseen: 0,
      fleeT: 0,
      backup: false,
      koT: 0,
    };
    actor.loop(weapon === 'pistol' ? 'pistolIdle' : t.idleClip, this.rng.range(0.9, 1.1), 0.01);
    if (kind === 'shield') actor.postPose = (a) => this.shieldPose(t, a);
    this.thugs.push(t);
    return t;
  }

  private spawnGroup(h: Hangout): void {
    this.place(h);
    const r = new Rng(hashN(h.id, Math.floor(this.time / 60), 99));
    const n = r.int(4, 6);
    const night = clock.night > 0.5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
      const d = r.range(1.6, 2.4);
      let kind: ThugKind = 'thug';
      let weapon: WeaponKind = r.weighted(['fists', 'pipe', 'knife'] as WeaponKind[], [4, 3, 2]);
      if (i === 0 && r.chance(0.55)) kind = 'brute';
      if (i === 1 && r.chance(0.45)) {
        kind = 'shield';
        weapon = r.chance(0.5) ? 'pipe' : 'fists';
      }
      if (i === 2 && r.chance(night ? 0.6 : 0.4)) weapon = 'pistol';
      if (kind === 'brute') weapon = r.chance(0.5) ? 'pipe' : 'fists';
      this.spawnThug(h, h.x + Math.cos(a) * d, h.z + Math.sin(a) * d, kind, weapon, i);
    }
    h.active = true;
    h.backupCalled = false;
    h.group.visible = true;
  }

  /** Test / debug: spawn `n` thugs around a point, already fighting. */
  spawnFight(x: number, z: number, n: number, kinds?: ThugKind[]): Thug[] {
    let h = this.hangouts[0];
    let bd = Infinity;
    for (const hh of this.hangouts) {
      const d = Math.hypot(hh.x - x, hh.z - z);
      if (d < bd) {
        bd = d;
        h = hh;
      }
    }
    const out: Thug[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const kind = kinds?.[i] ?? 'thug';
      const weapon: WeaponKind = kind === 'shield' ? 'fists' : (['fists', 'pipe', 'knife', 'fists', 'pipe'] as WeaponKind[])[i % 5];
      const t = this.spawnThug(h, x + Math.cos(a) * 4, z + Math.sin(a) * 4, kind, weapon, i);
      if (t) {
        t.aware = 'combat';
        t.lastSeen.set(x, t.pos.y, z);
        out.push(t);
      }
    }
    return out;
  }

  private groundAt(x: number, z: number, near: number): number {
    const h = physics.rayHit(new THREE.Vector3(x, near + 3, z), new THREE.Vector3(0, -1, 0), 10, GROUPS_PROBE);
    return h && h.normal.lengthSq() > 0.5 ? h.point.y : heightAt(x, z);
  }

  private removeThug(t: Thug): void {
    t.actor.dispose();
    physics.world.removeRigidBody(t.body);
    this.thugs.splice(this.thugs.indexOf(t), 1);
  }

  // ---------------------------------------------------------------- queries

  /** Thugs fighting the player nearby. */
  get inCombat(): boolean {
    return this.thugs.some((t) => t.aware === 'combat' && !t.ko && t.dist < 30);
  }

  /** Thugs able to be targeted (alive, not fleeing far). */
  targets(): Thug[] {
    return this.thugs.filter((t) => !t.ko && t.aware !== 'flee');
  }

  // ---------------------------------------------------------------- simulation

  fixedUpdate(dt: number, player: PlayerView): void {
    this.time += dt;
    // Hangout activation / despawn.
    for (const h of this.hangouts) {
      const d = Math.hypot(h.x - player.pos.x, h.z - player.pos.z);
      if (!h.active && d < SPAWN_R && this.time > h.clearedUntil && this.spawning) this.spawnGroup(h);
      if (h.active && d > DESPAWN_R) {
        for (const t of this.thugs.filter((tt) => tt.hangout === h && tt.aware !== 'combat')) this.removeThug(t);
        if (!this.thugs.some((t) => t.hangout === h)) {
          h.active = false;
          h.group.visible = false;
        }
      }
      if (h.backupAt > 0 && this.time >= h.backupAt) this.arriveBackup(h, player);
      if (h.active && !this.thugs.some((t) => t.hangout === h && !t.ko && t.aware !== 'flee')) {
        // Cleared: respawns after five minutes away.
        if (h.clearedUntil < this.time) h.clearedUntil = this.time + 300;
      }
    }
    // Tokens.
    this.tokenT -= dt;
    if (this.tokenT <= 0) {
      this.tokenT = 0.35;
      this.assignTokens(player);
    }
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      this.smokes[i].t -= dt;
      if (this.smokes[i].t <= 0) this.smokes.splice(i, 1);
    }
    for (let i = this.thugs.length - 1; i >= 0; i--) this.think(this.thugs[i], dt, player);
    this.separate();
    for (const t of this.thugs) this.move(t, dt);
  }

  private assignTokens(player: PlayerView): void {
    const fighters = this.thugs.filter((t) => t.aware === 'combat' && !t.ko && !t.knocked && t.stun <= 0 && t.confused <= 0);
    let melee = fighters.filter((t) => t.token && t.weapon !== 'pistol').length;
    let shooters = fighters.filter((t) => t.token && t.weapon === 'pistol').length;
    if (player.driving) return;
    const cands = fighters.filter((t) => !t.token && t.cooldown <= 0).sort((a, b) => a.dist - b.dist);
    for (const t of cands) {
      if (t.weapon === 'pistol') {
        if (shooters < 1 && t.dist < 22) {
          t.token = true;
          shooters++;
        }
      } else if (melee < 2 && t.dist < 12) {
        t.token = true;
        melee++;
      }
    }
  }

  private alert(t: Thug, at: THREE.Vector3): void {
    if (t.ko || t.aware === 'combat' || t.aware === 'flee') return;
    t.lastSeen.copy(at);
    if (t.aware !== 'alert') {
      t.aware = 'alert';
      t.alertT = 0.7;
    }
  }

  /** Call the rest of the crew (and once per encounter, two more from out of sight). */
  private callBackup(t: Thug, player: PlayerView): void {
    for (const o of this.thugs) {
      if (o === t || o.ko) continue;
      if (o.hangout === t.hangout || o.pos.distanceTo(t.pos) < 40) {
        if (o.aware === 'unaware' || o.aware === 'suspicious') {
          o.aware = 'combat';
          o.lastSeen.copy(player.pos);
        }
      }
    }
    const h = t.hangout;
    if (!h.backupCalled && player.hero) {
      h.backupCalled = true;
      h.backupAt = this.time + 6;
    }
  }

  /** Two more crew members run in from out of sight once backup was called. */
  private arriveBackup(h: Hangout, player: PlayerView): void {
    h.backupAt = 0;
    if (!h.active) return;
    const ang = Math.atan2(h.z - player.pos.z, h.x - player.pos.x) + 0.6;
    for (let i = 0; i < 2; i++) {
      const a = ang + i * 0.5;
      const nt = this.spawnThug(h, player.pos.x + Math.cos(a) * 32, player.pos.z + Math.sin(a) * 32, 'thug', i === 0 ? 'pipe' : 'knife', 10 + i);
      if (nt) {
        nt.aware = 'combat';
        nt.backup = true;
        nt.lastSeen.copy(player.pos);
      }
    }
  }

  private perceive(t: Thug, player: PlayerView): void {
    const eye = t.pos.clone().add(new THREE.Vector3(0, 1.6, 0));
    const tgt = player.pos.clone().add(new THREE.Vector3(0, 1.3, 0));
    const d = eye.distanceTo(tgt);
    t.sees = false;
    if (player.driving || d > 35) return;
    const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
    const to = tgt.clone().sub(eye).setY(0).normalize();
    const inCone = fwd.dot(to) > 0.35 || d < 3.5;
    if (!inCone) return;
    const dir = tgt.clone().sub(eye).normalize();
    const block = physics.rayHit(eye, dir, d - 0.5, GROUPS_PROBE);
    t.sees = !block;
    if (t.sees) t.lastSeen.copy(player.pos);
  }

  private think(t: Thug, dt: number, player: PlayerView): void {
    t.dist = t.pos.distanceTo(player.pos);
    t.warn = 0;
    if (t.ko) {
      t.koT += dt;
      // Knocked-out bodies are tidied away once far and out of mind.
      if (t.koT > 30 && t.dist > 60) this.removeThug(t);
      return;
    }
    if (t.knocked) {
      if (!t.actor.down) {
        // Back on its feet where the ragdoll left it.
        t.knocked = false;
        const p = t.actor.root.position;
        t.pos.copy(p);
        t.yaw = t.actor.root.rotation.y;
        t.collider.setEnabled(true);
        t.body.setTranslation({ x: p.x, y: p.y + t.radius + 0.6, z: p.z }, true);
        if (t.aware !== 'flee') t.aware = 'combat';
      }
      return;
    }
    t.cooldown -= dt;
    t.stun = Math.max(0, t.stun - dt);
    t.stagger = Math.max(0, t.stagger - dt);
    t.confused = Math.max(0, t.confused - dt);
    t.guardBroken = Math.max(0, t.guardBroken - dt);
    t.perceiveT -= dt;
    if (t.perceiveT <= 0) {
      t.perceiveT = 0.2;
      this.perceive(t, player);
      // Smoke: lose track of the player.
      for (const s of this.smokes) {
        if (Math.hypot(t.pos.x - s.x, t.pos.z - s.z) < s.r || Math.hypot(player.pos.x - s.x, player.pos.z - s.z) < s.r) {
          t.sees = false;
          if (Math.hypot(t.pos.x - s.x, t.pos.z - s.z) < s.r) t.confused = Math.max(t.confused, 2.5);
        }
      }
    }
    const want = new THREE.Vector3();
    let speed = 0;
    let face: number | null = null;
    switch (t.aware) {
      case 'unaware': {
        if (t.sees) {
          const rate = player.hero ? (1.4 - t.dist / 30) * (clock.night > 0.5 ? 0.75 : 1) : t.dist < 2.5 ? 0.3 : 0;
          t.suspicion += Math.max(0, rate) * dt;
          if (player.hero && t.dist < 4) t.suspicion = Math.max(t.suspicion, 1.1);
        } else t.suspicion = Math.max(0, t.suspicion - dt * 0.15);
        if (t.suspicion > 0.35) t.aware = 'suspicious';
        // Idle around the fire: face the drum.
        face = Math.atan2(t.hangout.x - t.pos.x, t.hangout.z - t.pos.z);
        const back = t.home.clone().sub(t.pos).setY(0);
        if (back.length() > 0.6) {
          want.copy(back.normalize());
          speed = 1.4;
          face = null;
        }
        break;
      }
      case 'suspicious': {
        if (t.sees) t.suspicion += (player.hero ? 0.8 : 0.1) * dt;
        else t.suspicion -= dt * 0.12;
        face = Math.atan2(t.lastSeen.x - t.pos.x, t.lastSeen.z - t.pos.z);
        if (t.suspicion > 1) this.alert(t, player.pos);
        else if (t.suspicion <= 0.05) t.aware = 'unaware';
        else if (t.pos.distanceTo(t.lastSeen) > 3 && t.sees) {
          want.copy(t.lastSeen).sub(t.pos).setY(0).normalize();
          speed = 1.3;
        }
        break;
      }
      case 'alert': {
        t.alertT -= dt;
        face = Math.atan2(t.lastSeen.x - t.pos.x, t.lastSeen.z - t.pos.z);
        if (t.alertT <= 0) {
          t.aware = 'combat';
          this.callBackup(t, player);
        }
        break;
      }
      case 'flee': {
        t.fleeT += dt;
        const away = t.pos.clone().sub(player.pos).setY(0).normalize();
        want.copy(away);
        speed = 5.6;
        t.unseen = t.dist > 45 ? t.unseen + dt : 0;
        if (t.unseen > 3 || t.fleeT > 25) {
          this.removeThug(t);
          return;
        }
        break;
      }
      case 'combat':
        ({ speed, face } = this.combat(t, dt, player, want));
        break;
    }
    t.vel.x = want.x * speed;
    t.vel.z = want.z * speed;
    if (face === null && speed > 0.3) face = Math.atan2(want.x, want.z);
    if (face !== null) {
      let d = face - t.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      t.yaw += d * (1 - Math.exp(-(t.aware === 'combat' ? 10 : 5) * dt));
    }
  }

  /** Combat tactics; fills `want` with a unit move direction and returns speed / facing. */
  private combat(t: Thug, dt: number, player: PlayerView, want: THREE.Vector3): { speed: number; face: number | null } {
    const toP = player.pos.clone().sub(t.pos).setY(0);
    const d = toP.length();
    const faceP = Math.atan2(toP.x, toP.z);
    toP.normalize();
    if (player.driving || (d > 45 && !t.sees)) {
      t.token = false;
      t.atk = null;
      t.aware = 'suspicious';
      t.suspicion = 0.6;
      return { speed: 0, face: null };
    }
    if (t.stun > 0 || t.stagger > 0) {
      t.atk = null;
      if (t.stagger > 0) {
        want.copy(toP).negate();
        return { speed: t.stagger * 6, face: faceP };
      }
      return { speed: 0, face: null };
    }
    if (t.confused > 0) {
      t.token = false;
      t.atk = null;
      want.set(Math.sin(this.time * 0.7 + t.id), 0, Math.cos(this.time * 0.9 + t.id));
      return { speed: 1.0, face: null };
    }
    // Flee when badly outnumbered (most of the crew down).
    if (Math.floor(this.time) !== Math.floor(this.time - dt)) {
      const crew = this.thugs.filter((o) => o.hangout === t.hangout);
      const down = crew.filter((o) => o.ko).length;
      const up = crew.filter((o) => !o.ko && o.aware === 'combat').length;
      if (down >= 3 && up <= 1 && t.kind !== 'brute' && hashN(t.id, Math.floor(this.time)) % 3 !== 0) {
        t.aware = 'flee';
        t.token = false;
        t.atk = null;
        return { speed: 0, face: null };
      }
    }
    // Attack in progress.
    if (t.atk) return this.attack(t, dt, player, d, toP, faceP, want);
    if (t.token && t.cooldown <= 0) {
      const heavy = t.kind === 'brute';
      const clip: ActorClip = t.weapon === 'pistol' ? 'pistolShoot' : t.weapon === 'pipe' || heavy ? 'swing' : t.weapon === 'knife' ? 'jab' : this.rng.chance(0.5) ? 'jab' : 'cross';
      t.atk = { phase: t.weapon === 'pistol' ? 'windup' : 'approach', t: 0, heavy, clip };
      return { speed: 0, face: faceP };
    }
    // Circle on a flanking slot.
    const fighters = this.thugs.filter((o) => o.aware === 'combat' && !o.ko && o.weapon !== 'pistol');
    const idx = Math.max(0, fighters.indexOf(t));
    const n = Math.max(1, fighters.length);
    const R = t.weapon === 'pistol' ? 10 : 3.6 + (t.kind === 'brute' ? 0.6 : 0) + (idx % 2) * 0.8;
    const base = (idx / n) * Math.PI * 2 + this.time * 0.18 * t.circleDir;
    const slot = new THREE.Vector3(player.pos.x + Math.cos(base) * R, t.pos.y, player.pos.z + Math.sin(base) * R);
    const to = slot.sub(t.pos).setY(0);
    const dl = to.length();
    if (dl > 0.4) {
      want.copy(to.normalize());
      return { speed: dl > 6 ? 4.6 : Math.min(1.8, dl * 1.5), face: dl > 6 ? null : faceP };
    }
    return { speed: 0, face: faceP };
  }

  private attack(t: Thug, dt: number, player: PlayerView, d: number, toP: THREE.Vector3, faceP: number, want: THREE.Vector3): { speed: number; face: number | null } {
    const a = t.atk!;
    a.t += dt;
    const reach = t.kind === 'brute' ? 2.1 : t.weapon === 'pipe' ? 2.0 : 1.6;
    if (a.phase === 'approach') {
      if (d > reach * 0.85) {
        want.copy(toP);
        if (a.t > 4) this.endAttack(t);
        return { speed: d > 4 ? 5.2 : 3.2, face: faceP };
      }
      a.phase = 'windup';
      a.t = 0;
    }
    if (a.phase === 'windup') {
      const wind = t.weapon === 'pistol' ? 1.05 : a.heavy ? 0.85 : 0.6;
      t.warn = a.heavy || t.weapon === 'pistol' ? 2 : 1;
      if (t.weapon === 'pistol') t.actor.loop('aim', 1, 0.15);
      if (a.t >= wind) {
        a.phase = 'strike';
        a.t = 0;
        t.actor.play(a.clip, a.heavy ? 1.1 : t.weapon === 'knife' ? 1.6 : 1.35, 0.06, t.weapon === 'pistol' ? 0 : 0.12);
      }
      return { speed: 0, face: faceP };
    }
    if (a.phase === 'strike') {
      const hitAt = t.weapon === 'pistol' ? 0.05 : 0.18;
      if (a.t >= hitAt && a.t - dt < hitAt) {
        if (t.weapon === 'pistol') {
          const eye = t.pos.clone().add(new THREE.Vector3(0, 1.45, 0));
          const tgt = player.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
          const dir = tgt.clone().sub(eye).normalize();
          const block = physics.rayHit(eye, dir, eye.distanceTo(tgt) - 0.5, GROUPS_PROBE);
          events.emit('world:alarm', { x: t.pos.x, z: t.pos.z, radius: 70, kind: 'gunshot' });
          if (!block && this.rng.chance(0.8)) player.hurt(13, t.pos);
        } else {
          const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
          if (d < reach + 0.3 && fwd.dot(toP) > 0.35) {
            const dmg = a.heavy ? 26 : t.weapon === 'pipe' ? 15 : t.weapon === 'knife' ? 13 : 9;
            const landed = player.hurt(dmg, t.pos, a.heavy);
            if (landed) {
              const hp = player.pos.clone().add(new THREE.Vector3(0, 1.3, 0));
              events.emit('combat:hit', { x: hp.x, y: hp.y, z: hp.z, strength: a.heavy ? 1 : 0.55 });
            }
          }
        }
      }
      if (a.t > 0.45) {
        a.phase = 'recover';
        a.t = 0;
      }
      return { speed: 0, face: null };
    }
    // Recover.
    if (a.t > (a.heavy ? 0.9 : 0.5)) this.endAttack(t);
    return { speed: 0, face: faceP };
  }

  private endAttack(t: Thug): void {
    t.atk = null;
    t.token = false;
    t.cooldown = t.weapon === 'pistol' ? this.rng.range(2.6, 4.2) : this.rng.range(1.4, 3.4);
  }

  private separate(): void {
    const live = this.thugs.filter((t) => !t.ko && !t.knocked);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        const d = Math.hypot(dx, dz);
        const min = a.radius + b.radius + 0.25;
        if (d < min && d > 1e-4) {
          const push = ((min - d) / d) * 2.5;
          a.vel.x -= dx * push;
          a.vel.z -= dz * push;
          b.vel.x += dx * push;
          b.vel.z += dz * push;
        }
      }
    }
  }

  private move(t: Thug, dt: number): void {
    if (t.ko || t.knocked) return;
    const delta = new THREE.Vector3(t.vel.x * dt, -4 * dt, t.vel.z * dt);
    this.controller.computeColliderMovement(t.collider, delta, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (c) => ((c.collisionGroups() >>> 16) & (G_PLAYER | G_ENEMY | G_RAGDOLL)) === 0);
    const mv = this.controller.computedMovement();
    const p = t.body.translation();
    const next = { x: p.x + mv.x, y: p.y + mv.y, z: p.z + mv.z };
    t.body.setNextKinematicTranslation(next);
    const half = (t.kind === 'brute' ? 0.62 : 0.58) * t.actor.look.height;
    t.pos.set(next.x, next.y - half - t.radius, next.z);
  }

  // ---------------------------------------------------------------- damage

  /**
   * Hit a thug. Returns 'blocked' (riot shield), 'hit' or 'ko'.
   * knock: ragdoll knock-down (gets up unless KO); stun: seconds dazed.
   */
  damage(t: Thug, amount: number, from: THREE.Vector3, o: { stun?: number; knock?: number; kind?: 'strike' | 'counter' | 'finisher' | 'cape' | 'dart' | 'dive' | 'vehicle' } = {}): 'blocked' | 'hit' | 'ko' {
    if (t.ko) return 'ko';
    const dir = t.pos.clone().sub(from).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(Math.sin(t.yaw), 0, Math.cos(t.yaw)).negate();
    dir.normalize();
    const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
    // Riot shield blocks frontal strikes until the guard is broken.
    if (t.kind === 'shield' && t.actor.shieldObj && t.guardBroken <= 0 && (o.kind === 'strike' || o.kind === 'counter') && fwd.dot(dir) < -0.35 && !t.knocked) {
      t.actor.flinch(dir, 0.08);
      events.emit('combat:hit', { x: t.pos.x, y: t.pos.y + 1.2, z: t.pos.z, strength: 0.3, blocked: true });
      return 'blocked';
    }
    if (o.kind === 'cape' && t.kind === 'shield') t.guardBroken = 4;
    if (t.aware !== 'combat' && t.aware !== 'flee') {
      t.aware = 'combat';
      t.lastSeen.copy(from);
      for (const other of this.thugs) if (other !== t && other.pos.distanceTo(t.pos) < 25) this.alert(other, from);
    }
    t.atk = null;
    t.token = false;
    t.hp -= amount;
    const hitPos = t.pos.clone().add(new THREE.Vector3(0, 1.35, 0));
    if (t.hp <= 0) {
      this.knockOut(t, dir, o.kind === 'finisher' || o.kind === 'dive' ? 5.5 : o.kind === 'vehicle' ? 12 : 3.8);
      const last = !this.thugs.some((x) => !x.ko && x.aware === 'combat' && x.pos.distanceTo(t.pos) < 30);
      events.emit('combat:ko', { x: t.pos.x, z: t.pos.z, last });
      this.fightNoise(t.pos);
      return 'ko';
    }
    if (o.knock) {
      this.knockDown(t, dir, o.knock);
      return 'hit';
    }
    if (o.stun) {
      t.stun = Math.max(t.stun, o.stun);
      t.actor.play('hitHead', 0.8, 0.05);
      t.actor.flinch(dir, 0.35);
    } else if (t.kind === 'brute' && amount < 2) {
      // Brutes shrug off single light hits.
      t.actor.flinch(dir, 0.12);
    } else {
      t.stagger = 0.18;
      t.actor.play(Math.random() < 0.5 ? 'hitHead' : 'hitChest', 1.2, 0.05);
      t.actor.flinch(dir, 0.3);
    }
    events.emit('combat:hit', { x: hitPos.x, y: hitPos.y, z: hitPos.z, strength: Math.min(1, amount / 3) });
    this.fightNoise(t.pos);
    return 'hit';
  }

  private lastNoise = -9;

  /** A fight scares nearby pedestrians (throttled). */
  private fightNoise(p: THREE.Vector3): void {
    if (this.time - this.lastNoise < 1.5) return;
    this.lastNoise = this.time;
    events.emit('world:alarm', { x: p.x, z: p.z, radius: 20, kind: 'pavement' });
  }

  private dropWeapon(t: Thug): void {
    const w = t.actor.dropWeapon();
    if (!w) return;
    this.group.add(w);
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(w.position.x, w.position.y, w.position.z).setRotation(w.quaternion).setLinvel((Math.random() - 0.5) * 2, 2, (Math.random() - 0.5) * 2));
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.05, 0.05, 0.25).setDensity(400).setCollisionGroups(GROUPS_PROP), body);
    this.drops.push({ mesh: w, body, t: 0 });
  }

  private knockDown(t: Thug, dir: THREE.Vector3, strength: number): void {
    t.knocked = true;
    t.atk = null;
    t.token = false;
    t.collider.setEnabled(false);
    t.actor.root.position.copy(t.pos);
    t.actor.root.rotation.y = t.yaw;
    const vel = dir.clone().multiplyScalar(strength).add(UP.clone().multiplyScalar(strength * 0.35));
    t.actor.knockDown(vel, null, null, 1.4 + Math.random());
  }

  knockOut(t: Thug, dir: THREE.Vector3, strength: number): void {
    t.ko = true;
    t.koT = 0;
    t.hp = 0;
    t.atk = null;
    t.token = false;
    t.warn = 0;
    t.collider.setEnabled(false);
    this.dropWeapon(t);
    t.actor.root.position.copy(t.pos);
    t.actor.root.rotation.y = t.yaw;
    const vel = dir.clone().multiplyScalar(strength).add(UP.clone().multiplyScalar(Math.min(3, strength * 0.3)));
    t.actor.knockDown(vel, dir.clone().multiplyScalar(strength * 2.2), t.pos.clone().add(new THREE.Vector3(0, 1.4, 0)), Infinity);
  }

  /** Stun every thug within r of a point (cape stun / dart / shockwave). */
  stunAround(x: number, z: number, r: number, secs: number, from: THREE.Vector3, kind: 'cape' | 'dive'): Thug[] {
    const hit: Thug[] = [];
    for (const t of this.thugs) {
      if (t.ko || t.knocked) continue;
      if (Math.hypot(t.pos.x - x, t.pos.z - z) > r) continue;
      if (kind === 'dive') this.damage(t, 1, from, { knock: 6, kind: 'dive' });
      else this.damage(t, 0, from, { stun: secs, kind: 'cape' });
      hit.push(t);
    }
    return hit;
  }

  /** Disarm grapple: yank the weapon (or riot shield) towards `to()`. */
  disarm(t: Thug, to: () => THREE.Vector3): boolean {
    let w: THREE.Object3D | null = null;
    if (t.weapon !== 'fists') w = t.actor.dropWeapon();
    else if (t.actor.shieldObj) {
      const s = t.actor.shieldObj;
      s.updateMatrixWorld(true);
      const m = s.matrixWorld.clone();
      s.removeFromParent();
      m.decompose(s.position, s.quaternion, s.scale);
      t.actor.shieldObj = null;
      t.actor.postPose = null;
      t.kind = 'thug';
      w = s;
    }
    if (!w) return false;
    this.group.add(w);
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(w.position.x, w.position.y, w.position.z));
    this.drops.push({ mesh: w, body, t: 0, fly: { to, t: 0 } });
    t.weapon = 'fists';
    t.atk = null;
    t.token = false;
    t.actor.loop('fight', 1, 0.2);
    t.actor.flinch(to().sub(t.pos).normalize(), 0.25);
    return true;
  }

  smoke(x: number, z: number, r: number): void {
    this.smokes.push({ x, z, r, t: 6 });
    for (const t of this.thugs) {
      if (t.ko) continue;
      if (Math.hypot(t.pos.x - x, t.pos.z - z) < r + 2) {
        t.confused = 4;
        t.token = false;
        t.atk = null;
      }
    }
  }

  // ---------------------------------------------------------------- visuals

  update(dt: number, cam: THREE.Vector3): void {
    for (const h of this.hangouts) {
      if (!h.group.visible) continue;
      ((h.fire.material as THREE.ShaderMaterial).uniforms.uTime.value as number) += dt;
      // Flames face the camera on one axis.
      h.fire.rotation.y = Math.atan2(cam.x - h.x, cam.z - h.z);
    }
    for (const t of this.thugs) {
      const a = t.actor;
      if (!t.ko && !t.knocked) {
        a.root.position.copy(t.pos);
        a.root.rotation.y = t.yaw;
        this.animate(t);
      }
      a.update(dt, cam);
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.t += dt;
      if (d.fly) {
        d.fly.t += dt;
        const to = d.fly.to();
        d.mesh.position.lerp(to, Math.min(1, dt * 9));
        d.mesh.rotation.x += dt * 14;
        if (d.fly.t > 0.45 || d.mesh.position.distanceTo(to) < 0.4) d.t = 99;
      } else {
        const p = d.body.translation();
        const q = d.body.rotation();
        d.mesh.position.set(p.x, p.y, p.z);
        d.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      }
      if (d.t > 25) {
        d.mesh.removeFromParent();
        physics.world.removeRigidBody(d.body);
        this.drops.splice(i, 1);
      }
    }
  }

  private animate(t: Thug): void {
    const a = t.actor;
    if (a.busy) return;
    const sp = Math.hypot(t.vel.x, t.vel.z);
    if (t.stun > 0) {
      a.loop('crouch', 0.6, 0.2);
      if (Math.random() < 0.02) a.flinch(new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize(), 0.15);
      return;
    }
    if (t.atk && t.atk.phase === 'windup' && t.weapon !== 'pistol') {
      a.loop('fight', 1.6, 0.1);
      return;
    }
    if (sp > 4.2) a.loop('sprint', sp / 7.2, 0.2);
    else if (sp > 2.4) a.loop('jog', sp / 4.3, 0.2);
    else if (sp > 0.35) a.loop('walk', Math.max(0.6, sp / 1.7), 0.2);
    else if (t.aware === 'combat' || t.aware === 'alert') a.loop(t.weapon === 'pistol' ? (t.atk ? 'aim' : 'pistolIdle') : 'fight', 1, 0.25);
    else if (t.aware === 'suspicious') a.loop(t.weapon === 'pistol' ? 'pistolIdle' : 'idle', 1, 0.3);
    else a.loop(t.weapon === 'pistol' ? 'pistolIdle' : t.idleClip, 1, 0.3);
  }

  /** Riot shield: hold the forearm across the chest so the shield faces forward. */
  private shieldPose(t: Thug, a: Actor): void {
    if (!a.shieldObj || t.guardBroken > 0) return;
    const B = (n: string) => a.bones.get(n)!;
    const chest = B('spine_03').getWorldPosition(new THREE.Vector3());
    const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const target = chest.clone().addScaledVector(fwd, 0.42).addScaledVector(right, 0.05).add(new THREE.Vector3(0, -0.05, 0));
    const pole = chest.clone().addScaledVector(right, -1).add(new THREE.Vector3(0, -0.6, 0));
    twoBoneIK(B('upperarm_l'), B('lowerarm_l'), B('hand_l'), target, pole);
  }

  /** Screen icons: awareness '?', '!' and attack warnings. */
  icons(): { x: number; y: number; z: number; kind: 'sus' | 'alert' | 'warn' | 'danger' | 'stun' }[] {
    const out: { x: number; y: number; z: number; kind: 'sus' | 'alert' | 'warn' | 'danger' | 'stun' }[] = [];
    for (const t of this.thugs) {
      if (t.ko || t.knocked || t.dist > 60) continue;
      const k = t.warn === 2 ? 'danger' : t.warn === 1 ? 'warn' : t.stun > 0 ? 'stun' : t.aware === 'alert' ? 'alert' : t.aware === 'suspicious' ? 'sus' : null;
      if (!k) continue;
      out.push({ x: t.pos.x, y: t.pos.y + 2.25 * t.actor.look.height, z: t.pos.z, kind: k });
    }
    return out;
  }

  /** Remove everything (tests). */
  clear(): void {
    for (const t of [...this.thugs]) this.removeThug(t);
    for (const h of this.hangouts) {
      h.active = false;
      h.group.visible = false;
    }
  }
}
