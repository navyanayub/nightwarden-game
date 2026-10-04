/**
 * Everyone who fights on foot: gang members (Tidewater Crew, Ashline Syndicate, Velvet Hand),
 * Vellmoor Police officers and tactical officers. One system so that they can fight the player
 * *and each other* with the same movement, perception, ragdoll and damage code.
 *
 * Organisation: every fighter belongs to a `Crew` (a hangout, a crime scene, a police unit, an
 * ambush) of one `Faction`. Hostility:
 *   - gang ↔ police: always (gang members are criminals),
 *   - gang ↔ gang: only when one crew feuds with the other's faction (street fights, retaliation),
 *   - police ↔ player: `policeVsPlayer` (0 = ignore, 1 = arrest, 2 = lethal), set by the wanted
 *     system / police trust,
 *   - gang ↔ player: awareness of the hero (unaware → suspicious '?' → alert '!' → combat).
 *
 * Fighting the player keeps the Stage 3 rules (attack tokens: ≤2 melee + 1–2 shooters, flanking
 * slots, counterable / unblockable warnings). NPC-vs-NPC fights pick the nearest visible hostile
 * every 0.5 s. Gun users take cover: they search a ring of points for one where a low ray to
 * the foe is blocked but a standing ray is clear, crouch there, pop up, aim and fire short bursts
 * through `Gunfire` (tracers, flashes, impacts on whatever the bullet hits).
 *
 * Knockouts are ragdolls; captured criminals are zip-tied (`tie`) and collected by the police.
 */
import * as THREE from 'three';
import { physics, RAPIER, GROUPS_ENEMY, GROUPS_PROBE, GROUPS_PROP, GROUPS_SHOT, G_PLAYER, G_ENEMY, G_RAGDOLL } from '../core/Physics';
import { events } from '../core/EventBus';
import { Rng, hashN } from '../core/Random';
import { heightAt } from '../world/Terrain';
import type { CityData } from '../world/CityLayout';
import type { District } from '../world/WorldConfig';
import type { Look } from './CrowdRender';
import { Actor, type ActorKit, type WeaponKind, type ActorClip, type Gear } from '../actors/Actor';
import { twoBoneIK } from './AnimBaker';
import { clock } from '../systems/Clock';
import { GANGS, type GangId, type Territory } from '../crime/Gangs';
import { Gunfire } from '../combat/Gunfire';

export type Faction = GangId | 'vpd';
export type ThugKind = 'thug' | 'brute' | 'shield' | 'officer' | 'tactical';
export type Awareness = 'unaware' | 'suspicious' | 'alert' | 'combat' | 'flee';

export interface Crew {
  id: number;
  name: string;
  faction: Faction;
  kind: 'hangout' | 'crime' | 'police' | 'ambush';
  /** Focus point (fire drum, crime scene, unit position). */
  x: number;
  y: number;
  z: number;
  backupCalled: boolean;
  /** Game time at which called-in backup arrives (0 = none pending). */
  backupAt: number;
  /** Other factions this crew attacks on sight (gang feuds). */
  feud: Faction[];
  /** > 0: members never chase further than this from (x, z) (hostage takers indoors). */
  leash: number;
}

export interface Hangout extends Crew {
  gangName: string;
  district: District;
  active: boolean;
  clearedUntil: number;
  group: THREE.Group;
  fire: THREE.Mesh;
  /** Props/colliders are placed on first activation (once the ground colliders have streamed in). */
  placed: boolean;
  props: { x: number; z: number; s: number; yaw: number }[];
}

interface GunState {
  phase: 'move' | 'cover' | 'aim' | 'fire';
  t: number;
  shots: number;
}

export interface Thug {
  id: number;
  actor: Actor;
  crew: Crew;
  faction: Faction;
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
  /** Distance to the player. */
  dist: number;
  unseen: number;
  fleeT: number;
  backup: boolean;
  koT: number;
  // ---- Stage 4
  /** Current NPC foe (null = the player, when `vsPlayer`). */
  tgt: Thug | null;
  /** Fights the player when they meet. */
  vsPlayer: boolean;
  scanT: number;
  /** Gang members are criminals (police attack them); officers are not. */
  criminal: boolean;
  tied: boolean;
  koBy: 'player' | 'police' | 'gang' | null;
  removed: boolean;
  crouch: boolean;
  cover: THREE.Vector3 | null;
  coverFrom: THREE.Vector3;
  coverT: number;
  gun: GunState | null;
  /** Scripted walk / run target (crimes, police), used while not fighting. */
  goto: THREE.Vector3 | null;
  gotoRun: boolean;
  onArrive: (() => void) | null;
  /** Face this point when idle (crime victim, bank counter). */
  focus: THREE.Vector3 | null;
  /** Idle pose override (kneel, aim, throw). */
  pose: ActorClip | null;
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
  /** Slow / stopped enough for officers to cuff (on foot or in a stopped car). */
  canArrest: boolean;
  hurt(amount: number, from: THREE.Vector3, heavy?: boolean): boolean;
}

export type DamageKind = 'strike' | 'counter' | 'finisher' | 'cape' | 'dart' | 'dive' | 'vehicle' | 'npc' | 'gun';
const PLAYER_KINDS: DamageKind[] = ['strike', 'counter', 'finisher', 'cape', 'dart', 'dive', 'vehicle'];

const HANGOUTS: { name: string; gang: GangId; kind: string; district: District; near: [number, number] }[] = [
  { name: 'The Stacks', gang: 'tidewater', kind: 'containers', district: 'harbour', near: [420, 640] },
  { name: 'Railside', gang: 'ashline', kind: 'railyard', district: 'industrial', near: [-400, 560] },
  { name: 'Clocktower Steps', gang: 'velvet', kind: 'square', district: 'oldtown', near: [-480, 0] },
  { name: 'Glasshouse Plaza', gang: 'velvet', kind: 'plaza', district: 'midtown', near: [150, -40] },
  { name: 'The Pavilion', gang: 'tidewater', kind: 'park', district: 'park', near: [500, -620] },
  { name: 'Hilltop Lot', gang: 'ashline', kind: 'hills', district: 'hills', near: [-150, -480] },
];

const MAX_THUGS = 46;
const SPAWN_R = 135;
const DESPAWN_R = 230;
const UP = new THREE.Vector3(0, 1, 0);
const SKINS: [number, number, number][] = [
  [1.0, 0.96, 0.92],
  [0.93, 0.8, 0.68],
  [0.78, 0.6, 0.45],
  [0.55, 0.4, 0.3],
  [0.38, 0.27, 0.2],
];
const HAIRS: [number, number, number][] = [
  [0.05, 0.04, 0.035],
  [0.18, 0.12, 0.07],
  [0.35, 0.25, 0.15],
];

export class Enemies {
  readonly thugs: Thug[] = [];
  readonly hangouts: Hangout[] = [];
  readonly group = new THREE.Group();
  readonly gunfire = new Gunfire();
  private drops: Drop[] = [];
  private controller: RAPIER.KinematicCharacterController;
  private nextId = 1;
  private nextCrew = 100;
  time = 0;
  private rng = new Rng(0x5eed7);
  private tokenT = 0;
  /** Hangouts spawn crews when the player comes near (tests switch this off for calm shots). */
  spawning = true;
  /** Smoke clouds (x, z, r, t). */
  smokes: { x: number; z: number; r: number; t: number }[] = [];
  /** How officers treat the player: 0 ignore, 1 arrest, 2 lethal force. */
  policeVsPlayer: 0 | 1 | 2 = 0;
  /** Seconds an officer has been holding the player (busted at 2.5 s). */
  arrestT = 0;
  territory: Territory | null = null;
  private lastShotAlarm = -9;
  private reported = new Map<number, number>();

  constructor(
    city: CityData,
    private readonly kit: ActorKit,
  ) {
    this.group.name = 'Enemies';
    this.group.add(this.gunfire.group);
    this.controller = physics.world.createCharacterController(0.03);
    this.controller.enableAutostep(0.4, 0.2, false);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    HANGOUTS.forEach((h, i) => {
      const p = this.findSpot(city, h.kind, h.district, h.near);
      const hg: Hangout = {
        id: i,
        name: h.name,
        faction: h.gang,
        kind: 'hangout',
        gangName: GANGS[h.gang].name,
        district: h.district,
        x: p.x,
        z: p.z,
        y: p.y,
        feud: [],
        leash: 0,
        active: false,
        clearedUntil: 0,
        backupCalled: false,
        group: new THREE.Group(),
        fire: null as unknown as THREE.Mesh,
        placed: false,
        props: [],
        backupAt: 0,
      };
      this.buildHangout(hg);
      this.hangouts.push(hg);
    });
    events.on('world:alarm', (a) => {
      if (a.kind !== 'gunshot') return;
      for (const t of this.thugs) if (!t.ko && t.faction !== 'vpd' && Math.hypot(t.pos.x - a.x, t.pos.z - a.z) < a.radius * 0.6) this.alert(t, new THREE.Vector3(a.x, t.pos.y, a.z));
    });
  }

  /** A new crew (crime scene, police unit, ambush). */
  makeCrew(faction: Faction, kind: Crew['kind'], name: string, x: number, z: number, o: { feud?: Faction[]; leash?: number; y?: number } = {}): Crew {
    return { id: this.nextCrew++, name, faction, kind, x, y: o.y ?? heightAt(x, z), z, backupCalled: kind !== 'hangout', backupAt: 0, feud: o.feud ?? [], leash: o.leash ?? 0 };
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
    return findClearSpot(cx, cz, 4);
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
    const fire = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 1.0), flameMaterial());
    fire.position.y = 1.3;
    h.fire = fire;
    g.add(drum, rim, embers, fire);
    // Crates to sit on, and a spray-painted gang tag in the gang's colour on a board.
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
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshStandardMaterial({ color: new THREE.Color(GANGS[h.faction as GangId].color).multiplyScalar(0.6), roughness: 0.9, side: THREE.DoubleSide }));
    const c0 = h.props[0];
    flag.position.set(c0.x, c0.s + 0.02, c0.z);
    flag.rotation.set(-Math.PI / 2, 0, c0.yaw);
    g.add(flag);
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

  // ---------------------------------------------------------------- looks

  /** Clothing + gear for a faction member (gang colours / police uniform). */
  lookFor(faction: Faction, kind: ThugKind, seed: number): { look: Look; gear: Gear } {
    const r = new Rng(hashN(seed, 4242));
    const v = (c: [number, number, number], k: number): [number, number, number] => [c[0] * (1 + (r.next() - 0.5) * k), c[1] * (1 + (r.next() - 0.5) * k), c[2] * (1 + (r.next() - 0.5) * k)];
    const skin = [...r.pick(SKINS), 1] as [number, number, number, number];
    if (faction === 'vpd') {
      const tac = kind === 'tactical';
      const female = !tac && r.chance(0.3);
      return {
        look: {
          gender: female ? 1 : 0,
          top: tac ? [0.07, 0.075, 0.08, 3] : [...v([0.035, 0.05, 0.11], 0.1), 0],
          bottom: tac ? [0.06, 0.065, 0.07, 1] : [0.025, 0.03, 0.06, 1],
          skin,
          hair: r.pick(HAIRS),
          hairStyle: 1,
          height: tac ? r.range(1.0, 1.06) : r.range(0.96, 1.05),
          girth: tac ? 1.16 : r.range(1.0, 1.1),
        },
        gear: tac ? { hat: 'helmet', hatColor: [0.08, 0.085, 0.09], vest: 'plate' } : { hat: 'cap', hatColor: [0.03, 0.04, 0.09], vest: 'patrol' },
      };
    }
    const G = GANGS[faction];
    const female = kind === 'thug' && r.chance(0.2);
    const accentTop = r.chance(0.3);
    const top = accentTop ? v([G.accent[0] * 0.7, G.accent[1] * 0.7, G.accent[2] * 0.7], 0.2) : v(r.pick(G.tops), 0.35);
    const hat = r.pick(G.hats);
    return {
      look: {
        gender: female ? 1 : 0,
        top: [...top, kind === 'brute' ? 1 : r.pick(G.topStyles)] as [number, number, number, number],
        bottom: [...r.pick(G.bottoms), r.pick([0, 1])] as [number, number, number, number],
        skin: [skin[0], skin[1], skin[2], r.pick([1, 1, 2])],
        hair: r.pick(HAIRS),
        hairStyle: hat !== 'none' ? 1 : female ? r.int(0, 2) : r.pick([1, 1, 2, 0]),
        height: kind === 'brute' ? 1.1 : r.range(0.97, 1.05),
        girth: kind === 'brute' ? 1.32 : r.range(1.0, 1.14),
      },
      gear: { hat, hatColor: hat === 'beanie' ? v(G.accent, 0.2) : v([0.08, 0.075, 0.07], 0.3) },
    };
  }

  /** A weapon from the gang's preferences. */
  pickWeapon(faction: Faction, r: Rng = this.rng): WeaponKind {
    if (faction === 'vpd') return 'pistol';
    const w = GANGS[faction].weapons;
    const ks = Object.keys(w) as WeaponKind[];
    return r.weighted(ks, ks.map((k) => w[k] ?? 0));
  }

  // ---------------------------------------------------------------- spawning

  /** Spawn one fighter. Returns null when the pool is full. */
  spawn(crew: Crew, x: number, z: number, kind: ThugKind, weapon: WeaponKind, slot = 0, o: { idle?: ActorClip; y?: number } = {}): Thug | null {
    if (this.thugs.length >= MAX_THUGS) return null;
    const id = this.nextId++;
    const { look, gear } = this.lookFor(crew.faction, kind, id * 31 + crew.id);
    const shield = kind === 'shield';
    const actor = this.kit.create(look, weapon, shield, gear);
    const y = this.groundAt(x, z, o.y ?? crew.y);
    actor.root.position.set(x, y, z);
    this.group.add(actor.root);
    const big = kind === 'brute' || kind === 'tactical';
    const radius = big ? 0.4 : 0.32;
    const half = (big ? 0.6 : 0.58) * look.height;
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + half + radius, z));
    const collider = physics.world.createCollider(RAPIER.ColliderDesc.capsule(half, radius).setCollisionGroups(GROUPS_ENEMY), body);
    const hp = kind === 'brute' ? 11 : kind === 'shield' ? 6 : kind === 'tactical' ? 11 : kind === 'officer' ? 7 : 4;
    const police = crew.faction === 'vpd';
    const t: Thug = {
      id,
      actor,
      crew,
      faction: crew.faction,
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
      yaw: Math.atan2(crew.x - x, crew.z - z),
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
      idleClip: o.idle ?? (police ? 'idle' : this.rng.pick(['idle', 'talk', 'talk', 'idle'] as ActorClip[])),
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
      tgt: null,
      vsPlayer: false,
      scanT: this.rng.range(0, 0.5),
      criminal: !police,
      tied: false,
      koBy: null,
      removed: false,
      crouch: false,
      cover: null,
      coverFrom: new THREE.Vector3(),
      coverT: 0,
      gun: null,
      goto: null,
      gotoRun: false,
      onArrive: null,
      focus: null,
      pose: null,
    };
    actor.loop(weapon === 'pistol' && !o.idle ? 'pistolIdle' : t.idleClip, this.rng.range(0.9, 1.1), 0.01);
    if (shield) actor.postPose = (a) => this.shieldPose(t, a);
    this.thugs.push(t);
    return t;
  }

  private spawnGroup(h: Hangout): void {
    this.place(h);
    const r = new Rng(hashN(h.id, Math.floor(this.time / 60), 99));
    const G = GANGS[h.faction as GangId];
    const n = r.int(4, 6);
    const night = clock.night > 0.5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r.range(-0.3, 0.3);
      const d = r.range(1.6, 2.4);
      let kind: ThugKind = 'thug';
      let weapon: WeaponKind = this.pickWeapon(h.faction, r);
      if (weapon === 'pistol' && i !== 2) weapon = r.pick(['fists', 'pipe', 'knife'] as WeaponKind[]);
      if (i === 0 && r.chance(G.bruteChance)) kind = 'brute';
      if (i === 1 && r.chance(G.shieldChance + 0.2)) {
        kind = 'shield';
        weapon = r.chance(0.5) ? 'pipe' : 'fists';
      }
      if (i === 2 && r.chance(night ? 0.6 : 0.4)) weapon = 'pistol';
      if (kind === 'brute') weapon = r.chance(0.5) ? 'pipe' : 'fists';
      this.spawn(h, h.x + Math.cos(a) * d, h.z + Math.sin(a) * d, kind, weapon, i);
    }
    h.active = true;
    h.backupCalled = false;
    h.group.visible = true;
  }

  /** Test / debug: spawn `n` thugs around a point, already fighting the player. */
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
      const t = this.spawn(h, x + Math.cos(a) * 4, z + Math.sin(a) * 4, kind, weapon, i);
      if (t) {
        t.aware = 'combat';
        t.vsPlayer = true;
        t.lastSeen.set(x, t.pos.y, z);
        out.push(t);
      }
    }
    return out;
  }

  groundAt(x: number, z: number, near: number): number {
    const h = physics.rayHit(new THREE.Vector3(x, near + 3, z), new THREE.Vector3(0, -1, 0), 10, GROUPS_PROBE);
    return h && h.normal.lengthSq() > 0.5 ? h.point.y : heightAt(x, z);
  }

  removeThug(t: Thug): void {
    if (t.removed) return;
    t.removed = true;
    t.actor.dispose();
    physics.world.removeRigidBody(t.body);
    this.thugs.splice(this.thugs.indexOf(t), 1);
    for (const o of this.thugs) if (o.tgt === t) o.tgt = null;
  }

  /** Remove every member of a crew. */
  removeCrew(c: Crew): void {
    for (const t of this.thugs.filter((x) => x.crew === c)) this.removeThug(t);
  }

  /** Move a thug instantly (spawning out of a car door, etc.). */
  teleport(t: Thug, x: number, z: number, y?: number): void {
    const gy = this.groundAt(x, z, y ?? t.pos.y);
    t.pos.set(x, gy, z);
    t.home.copy(t.pos);
    const half = (t.kind === 'brute' || t.kind === 'tactical' ? 0.6 : 0.58) * t.actor.look.height;
    t.body.setTranslation({ x, y: gy + half + t.radius, z }, true);
    t.actor.root.position.copy(t.pos);
  }

  // ---------------------------------------------------------------- queries

  /** Fighting the player nearby. */
  get inCombat(): boolean {
    return this.thugs.some((t) => t.aware === 'combat' && !t.ko && t.dist < 30 && t.vsPlayer && t.tgt === null);
  }

  /** Fighters the player can target (alive, not fleeing far). */
  targets(): Thug[] {
    return this.thugs.filter((t) => !t.ko && !t.tied && t.aware !== 'flee');
  }

  /** Can a and b fight each other? */
  hostile(a: Thug, b: Thug): boolean {
    if (a.faction === b.faction) return false;
    if (a.faction === 'vpd') return b.criminal;
    if (b.faction === 'vpd') return a.criminal;
    return a.crew.feud.includes(b.faction) || b.crew.feud.includes(a.faction);
  }

  /** Is an officer currently treating the player as a target? */
  policeHostile(t: Thug): boolean {
    return t.faction === 'vpd' && this.policeVsPlayer > 0;
  }

  // ---------------------------------------------------------------- simulation

  fixedUpdate(dt: number, player: PlayerView): void {
    this.time += dt;
    // Hangout activation / despawn.
    for (const h of this.hangouts) {
      const d = Math.hypot(h.x - player.pos.x, h.z - player.pos.z);
      const held = !this.territory || this.territory.get(h.district, h.faction as GangId) > 0;
      if (!h.active && d < SPAWN_R && this.time > h.clearedUntil && this.spawning && held) this.spawnGroup(h);
      if (h.active && d > DESPAWN_R) {
        for (const t of this.thugs.filter((tt) => tt.crew === h && tt.aware !== 'combat')) this.removeThug(t);
        if (!this.thugs.some((t) => t.crew === h)) {
          h.active = false;
          h.group.visible = false;
        }
      }
      if (h.backupAt > 0 && this.time >= h.backupAt) this.arriveBackup(h, player);
      if (h.active && !this.thugs.some((t) => t.crew === h && !t.ko && t.aware !== 'flee')) {
        // Cleared: respawns after five minutes away.
        if (h.clearedUntil < this.time) h.clearedUntil = this.time + 300;
      }
    }
    // Officers keep / drop the player as a target.
    for (const t of this.thugs) {
      if (t.faction !== 'vpd') continue;
      const want = this.policeVsPlayer > 0;
      if (t.vsPlayer && !want) {
        t.vsPlayer = false;
        t.token = false;
        if (t.tgt === null && t.aware === 'combat') t.aware = 'unaware';
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
    for (let i = this.thugs.length - 1; i >= 0; i--) {
      const t = this.thugs[i];
      if (t) this.think(t, dt, player);
    }
    this.separate();
    for (const t of this.thugs) this.move(t, dt);
    // Arrest: an able officer holding a slow player.
    let holding = false;
    if (this.policeVsPlayer > 0 && player.canArrest) {
      for (const t of this.thugs) {
        if (t.faction !== 'vpd' || t.ko || t.knocked || t.stun > 0 || t.confused > 0) continue;
        if (t.dist < (player.driving ? 3.2 : 1.9)) {
          holding = true;
          break;
        }
      }
    }
    this.arrestT = holding ? this.arrestT + dt : Math.max(0, this.arrestT - dt * 2);
    if (this.arrestT > 2.5) {
      this.arrestT = 0;
      events.emit('player:busted', { x: player.pos.x, z: player.pos.z });
    }
  }

  private assignTokens(player: PlayerView): void {
    const fighters = this.thugs.filter((t) => t.aware === 'combat' && t.vsPlayer && t.tgt === null && !t.ko && !t.knocked && t.stun <= 0 && t.confused <= 0);
    let melee = fighters.filter((t) => t.token && t.weapon !== 'pistol').length;
    let shooters = fighters.filter((t) => t.token && t.weapon === 'pistol').length;
    if (player.driving) return;
    const maxShooters = this.policeVsPlayer === 2 ? 2 : 1;
    const cands = fighters.filter((t) => !t.token && t.cooldown <= 0).sort((a, b) => a.dist - b.dist);
    for (const t of cands) {
      if (t.faction === 'vpd' && this.policeVsPlayer < 2) continue;
      if (t.weapon === 'pistol') {
        if (shooters < maxShooters && t.dist < 30) {
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
      if (o === t || o.ko || o.faction !== t.faction) continue;
      if (o.crew === t.crew || o.pos.distanceTo(t.pos) < 40) {
        if (o.aware === 'unaware' || o.aware === 'suspicious') {
          o.aware = 'combat';
          o.vsPlayer = o.vsPlayer || t.vsPlayer;
          o.tgt = t.tgt;
          o.lastSeen.copy(player.pos);
        }
      }
    }
    const h = t.crew;
    if (!h.backupCalled && player.hero && t.vsPlayer && t.faction !== 'vpd') {
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
      const nt = this.spawn(h, player.pos.x + Math.cos(a) * 32, player.pos.z + Math.sin(a) * 32, 'thug', i === 0 ? 'pipe' : 'knife', 10 + i);
      if (nt) {
        nt.aware = 'combat';
        nt.vsPlayer = true;
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
    const range = t.faction === 'vpd' ? 50 : 35;
    if ((player.driving && t.faction !== 'vpd') || d > range) return;
    const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
    const to = tgt.clone().sub(eye).setY(0).normalize();
    const inCone = fwd.dot(to) > 0.35 || d < 3.5 || t.aware === 'combat';
    if (!inCone) return;
    const dir = tgt.clone().sub(eye).normalize();
    const block = physics.rayHit(eye, dir, d - 0.5, GROUPS_PROBE);
    t.sees = !block;
    if (t.sees) t.lastSeen.copy(player.pos);
  }

  /** Nearest visible hostile NPC (every 0.5 s). */
  private scan(t: Thug): void {
    if (t.tgt && (t.tgt.ko || t.tgt.removed || t.tgt.tied)) t.tgt = null;
    const range = t.weapon === 'pistol' ? 42 : 30;
    let best: Thug | null = null;
    let bd = range;
    for (const o of this.thugs) {
      if (o === t || o.ko || o.tied || o.removed || !this.hostile(t, o)) continue;
      const d = o.pos.distanceTo(t.pos);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    if (!best) {
      if (t.tgt && t.tgt.pos.distanceTo(t.pos) > range + 10) t.tgt = null;
      return;
    }
    if (best === t.tgt) return;
    if (bd > 6) {
      const eye = t.pos.clone().setY(t.pos.y + 1.5);
      const to = best.pos.clone().setY(best.pos.y + 1.3).sub(eye);
      const len = to.length();
      if (physics.rayHit(eye, to.normalize(), len - 0.6, GROUPS_PROBE)) return;
    }
    t.tgt = best;
    if (t.aware !== 'combat' && t.aware !== 'flee') {
      t.aware = 'combat';
      t.lastSeen.copy(best.pos);
      if (t.faction === 'vpd' && this.time - (this.reported.get(t.crew.id) ?? -99) > 45) {
        this.reported.set(t.crew.id, this.time);
        events.emit('police:scanner', { text: `Unit ${t.crew.name}: engaging armed suspects`, priority: true });
      }
    }
  }

  private think(t: Thug, dt: number, player: PlayerView): void {
    t.dist = t.pos.distanceTo(player.pos);
    t.warn = 0;
    if (t.ko) {
      t.koT += dt;
      // Knocked-out hangout thugs are tidied away once far and out of mind.
      if (t.crew.kind === 'hangout' && t.koT > 30 && t.dist > 60) this.removeThug(t);
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
    t.coverT -= dt;
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
    t.scanT -= dt;
    if (t.scanT <= 0) {
      t.scanT = 0.5;
      this.scan(t);
    }
    // Officers spot a player they are after.
    if (t.faction === 'vpd' && this.policeVsPlayer > 0 && t.sees && !t.vsPlayer) {
      t.vsPlayer = true;
      if (!t.tgt || t.tgt.pos.distanceTo(t.pos) > t.dist + 4) {
        t.tgt = null;
        t.aware = 'combat';
      }
    }
    const want = new THREE.Vector3();
    let speed = 0;
    let face: number | null = null;
    t.crouch = false;
    switch (t.aware) {
      case 'unaware': {
        if (t.faction !== 'vpd') {
          if (t.sees) {
            const rate = player.hero ? (1.4 - t.dist / 30) * (clock.night > 0.5 ? 0.75 : 1) : t.dist < 2.5 ? 0.3 : 0;
            t.suspicion += Math.max(0, rate) * dt;
            if (player.hero && t.dist < 4) t.suspicion = Math.max(t.suspicion, 1.1);
          } else t.suspicion = Math.max(0, t.suspicion - dt * 0.15);
          if (t.suspicion > 0.35) t.aware = 'suspicious';
        }
        if (t.goto) {
          const to = t.goto.clone().sub(t.pos).setY(0);
          if (to.length() < 0.9) {
            t.goto = null;
            t.home.copy(t.pos);
            const cb = t.onArrive;
            t.onArrive = null;
            cb?.();
          } else {
            want.copy(to.normalize());
            speed = t.gotoRun ? 5.2 : 1.6;
          }
          break;
        }
        // Idle at the crew's focus (fire drum, victim): face it.
        const f = t.focus ?? t.crew;
        face = Math.atan2(f.x - t.pos.x, f.z - t.pos.z);
        const back = t.home.clone().sub(t.pos).setY(0);
        if (back.length() > 0.6) {
          want.copy(back.normalize());
          speed = back.length() > 6 ? 4.5 : 1.4;
          face = null;
        }
        break;
      }
      case 'suspicious': {
        if (t.sees) t.suspicion += (player.hero ? 0.8 : 0.1) * dt;
        else t.suspicion -= dt * 0.12;
        face = Math.atan2(t.lastSeen.x - t.pos.x, t.lastSeen.z - t.pos.z);
        if (t.suspicion > 1) {
          t.vsPlayer = true;
          this.alert(t, player.pos);
        } else if (t.suspicion <= 0.05) t.aware = 'unaware';
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
          t.tgt = null;
          this.callBackup(t, player);
        }
        break;
      }
      case 'flee': {
        t.fleeT += dt;
        const from = t.tgt && !t.tgt.ko ? t.tgt.pos : player.pos;
        const away = t.goto ? t.goto.clone().sub(t.pos).setY(0).normalize() : t.pos.clone().sub(from).setY(0).normalize();
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
    const npc = t.tgt && !t.tgt.ko && !t.tgt.removed && !t.tgt.tied ? t.tgt : null;
    if (!npc) t.tgt = null;
    const vsP = !npc && t.vsPlayer && (!player.driving || t.faction === 'vpd');
    if (!npc && !vsP) {
      // Nobody left to fight.
      t.token = false;
      t.atk = null;
      t.gun = null;
      t.aware = t.faction === 'vpd' ? 'unaware' : 'suspicious';
      t.suspicion = 0.6;
      return { speed: 0, face: null };
    }
    const tp = npc ? npc.pos : player.pos;
    const toP = tp.clone().sub(t.pos).setY(0);
    const d = toP.length();
    const faceP = Math.atan2(toP.x, toP.z);
    toP.normalize();
    if (vsP && t.faction !== 'vpd' && (player.driving || (d > 45 && !t.sees))) {
      t.token = false;
      t.atk = null;
      t.aware = 'suspicious';
      t.suspicion = 0.6;
      return { speed: 0, face: null };
    }
    if (t.stun > 0 || t.stagger > 0) {
      t.atk = null;
      if (t.gun) t.gun.phase = 'cover';
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
    // Leash (hostage takers stay inside).
    if (t.crew.leash > 0 && Math.hypot(t.pos.x - t.crew.x, t.pos.z - t.crew.z) > t.crew.leash) {
      want.set(t.crew.x - t.pos.x, 0, t.crew.z - t.pos.z).normalize();
      return { speed: 3.5, face: null };
    }
    // Flee when badly outnumbered (most of the crew down).
    if (t.faction !== 'vpd' && Math.floor(this.time) !== Math.floor(this.time - dt)) {
      const crew = this.thugs.filter((o) => o.crew === t.crew);
      const down = crew.filter((o) => o.ko).length;
      const up = crew.filter((o) => !o.ko && o.aware === 'combat').length;
      if (down >= 3 && up <= 1 && t.kind !== 'brute' && t.crew.leash === 0 && hashN(t.id, Math.floor(this.time)) % 3 !== 0) {
        t.aware = 'flee';
        t.token = false;
        t.atk = null;
        return { speed: 0, face: null };
      }
    }
    // Police arresting (no force): close in and hold.
    if (vsP && t.faction === 'vpd' && this.policeVsPlayer === 1) {
      if (d > 1.3) {
        want.copy(toP);
        return { speed: d > 5 ? 5 : 2.2, face: faceP };
      }
      return { speed: 0, face: faceP };
    }
    // Guns: cover-based shooting.
    if (t.weapon === 'pistol') return this.gunfight(t, dt, player, npc, tp, d, faceP, want);
    // Melee attack in progress.
    if (t.atk) return this.attack(t, dt, player, npc, d, toP, faceP, want);
    if (npc) {
      if (d > 1.5) {
        want.copy(toP);
        return { speed: d > 4 ? 4.8 : 2.4, face: faceP };
      }
      if (t.cooldown <= 0) {
        const heavy = t.kind === 'brute';
        t.atk = { phase: 'windup', t: 0, heavy, clip: t.weapon === 'pipe' || heavy ? 'swing' : t.weapon === 'knife' ? 'jab' : this.rng.chance(0.5) ? 'jab' : 'cross' };
      }
      want.set(-toP.z * t.circleDir, 0, toP.x * t.circleDir);
      return { speed: 0.6, face: faceP };
    }
    if (t.token && t.cooldown <= 0) {
      const heavy = t.kind === 'brute';
      const clip: ActorClip = t.weapon === 'pipe' || heavy ? 'swing' : t.weapon === 'knife' ? 'jab' : this.rng.chance(0.5) ? 'jab' : 'cross';
      t.atk = { phase: 'approach', t: 0, heavy, clip };
      return { speed: 0, face: faceP };
    }
    // Circle on a flanking slot.
    const fighters = this.thugs.filter((o) => o.aware === 'combat' && o.vsPlayer && o.tgt === null && !o.ko && o.weapon !== 'pistol');
    const idx = Math.max(0, fighters.indexOf(t));
    const n = Math.max(1, fighters.length);
    const R = 3.6 + (t.kind === 'brute' ? 0.6 : 0) + (idx % 2) * 0.8;
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

  private attack(t: Thug, dt: number, player: PlayerView, npc: Thug | null, d: number, toP: THREE.Vector3, faceP: number, want: THREE.Vector3): { speed: number; face: number | null } {
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
      const wind = a.heavy ? 0.85 : 0.6;
      if (!npc) t.warn = a.heavy ? 2 : 1;
      if (a.t >= wind) {
        a.phase = 'strike';
        a.t = 0;
        t.actor.play(a.clip, a.heavy ? 1.1 : t.weapon === 'knife' ? 1.6 : 1.35, 0.06, 0.12);
      }
      return { speed: 0, face: faceP };
    }
    if (a.phase === 'strike') {
      const hitAt = 0.18;
      if (a.t >= hitAt && a.t - dt < hitAt) {
        const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
        if (d < reach + 0.3 && fwd.dot(toP) > 0.35) {
          if (npc) {
            const dmg = a.heavy ? 2 : t.weapon === 'pipe' ? 1.5 : t.weapon === 'knife' ? 1.2 : 1;
            this.damage(npc, dmg, t.pos, { kind: 'npc', by: t });
          } else {
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
    t.cooldown = t.tgt ? this.rng.range(1.0, 2.4) : t.weapon === 'pistol' ? this.rng.range(2.6, 4.2) : this.rng.range(1.4, 3.4);
  }

  // ---------------------------------------------------------------- guns & cover

  /**
   * Gun users: move to cover, crouch, pop up, aim (warning icon vs the player), fire a burst.
   * Shooting the player needs an attack token; NPC foes can be shot any time.
   */
  private gunfight(t: Thug, dt: number, player: PlayerView, npc: Thug | null, tp: THREE.Vector3, d: number, faceP: number, want: THREE.Vector3): { speed: number; face: number | null } {
    const g = (t.gun ??= { phase: 'move', t: 0, shots: 0 });
    g.t += dt;
    // Find (or refresh) cover when there is none or the foe moved a lot.
    if ((!t.cover || t.coverFrom.distanceTo(tp) > 9 || t.cover.distanceTo(t.pos) > 14) && t.coverT <= 0) {
      t.coverT = 3.5 + this.rng.range(0, 1.5);
      t.cover = this.findCover(t, tp);
      t.coverFrom.copy(tp);
      if (t.cover && g.phase !== 'fire') {
        g.phase = 'move';
        g.t = 0;
      }
    }
    if (g.phase === 'move') {
      if (t.cover) {
        const to = t.cover.clone().sub(t.pos).setY(0);
        const l = to.length();
        if (l > 0.5 && g.t < 5) {
          want.copy(to.normalize());
          return { speed: l > 3 ? 4.8 : 2.2, face: null };
        }
        g.phase = 'cover';
        g.t = 0;
      } else {
        // No cover: keep a shooting distance.
        const ideal = 11;
        if (Math.abs(d - ideal) > 3 && g.t < 3) {
          want.copy(tp).sub(t.pos).setY(0).normalize().multiplyScalar(d > ideal ? 1 : -1);
          return { speed: 3.2, face: faceP };
        }
        g.phase = 'cover';
        g.t = 0;
      }
    }
    if (g.phase === 'cover') {
      t.crouch = !!t.cover;
      const wait = npc ? 0.8 + (t.id % 3) * 0.35 : 1.0;
      const may = npc ? true : t.token;
      if (g.t > wait && may) {
        g.phase = 'aim';
        g.t = 0;
      }
      return { speed: 0, face: faceP };
    }
    if (g.phase === 'aim') {
      const aimT = npc ? 0.5 : t.faction === 'vpd' ? 0.85 : 1.0;
      if (!npc) t.warn = 2;
      if (g.t >= aimT) {
        g.phase = 'fire';
        g.t = 0;
        g.shots = npc ? 1 + (hashN(t.id, Math.floor(this.time)) % 3) : t.faction === 'vpd' ? 2 : 1;
        this.shoot(t, player, npc, tp, d);
        g.shots--;
      }
      return { speed: 0, face: faceP };
    }
    // Fire: burst.
    if (g.shots > 0 && g.t > 0.3) {
      g.t = 0;
      this.shoot(t, player, npc, tp, d);
      g.shots--;
    } else if (g.shots <= 0 && g.t > 0.45) {
      g.phase = 'cover';
      g.t = -this.rng.range(0.4, 1.4);
      if (!npc) this.endAttack(t);
    }
    return { speed: 0, face: faceP };
  }

  /** One bullet: tracer + muzzle flash; damage on a hit. */
  private shoot(t: Thug, player: PlayerView, npc: Thug | null, tp: THREE.Vector3, d: number): void {
    t.actor.play('pistolShoot', 1.4, 0.04, 0);
    const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
    // Standing muzzle (the pose may still be crouched for a frame when popping up).
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const muzzle = t.pos.clone().addScaledVector(fwd, 0.55).addScaledVector(right, -0.12).setY(t.pos.y + 1.42 * t.actor.look.height);
    const aim = tp.clone().add(new THREE.Vector3(0, npc?.crouch ? 0.9 : 1.25, 0));
    const blocked = !!physics.rayHit(muzzle, aim.clone().sub(muzzle).normalize(), muzzle.distanceTo(aim) - 0.5, GROUPS_SHOT);
    let hit = false;
    if (!blocked) {
      if (npc) {
        const p = THREE.MathUtils.clamp(0.5 * (1 - d / 55) * (npc.crouch ? 0.35 : 1) * (npc.gun?.phase === 'move' ? 0.7 : 1), 0.06, 0.55);
        hit = this.rng.chance(p);
      } else {
        const p = THREE.MathUtils.clamp((t.faction === 'vpd' ? 0.7 : 0.8) * (1 - d / 70), 0.15, 0.85);
        hit = this.rng.chance(p) && !player.invulnerable;
      }
    }
    this.gunfire.fire(muzzle, aim, hit, t.faction === 'vpd');
    if (this.time - this.lastShotAlarm > 1) {
      this.lastShotAlarm = this.time;
      events.emit('world:alarm', { x: t.pos.x, z: t.pos.z, radius: 70, kind: 'gunshot' });
    }
    if (!hit) return;
    if (npc) this.damage(npc, 1.4, t.pos, { kind: 'gun', by: t });
    else player.hurt(t.kind === 'tactical' ? 16 : 13, t.pos);
  }

  /** A spot within ~6 m where a crouched body is hidden from `foe` but standing can shoot. */
  private findCover(t: Thug, foe: THREE.Vector3): THREE.Vector3 | null {
    const foeChest = foe.clone().setY(foe.y + 1.2);
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    const base = Math.atan2(foe.x - t.pos.x, foe.z - t.pos.z);
    for (let i = 0; i < 12; i++) {
      const a = base + ((i % 6) - 2.5) * 0.55 + (i >= 6 ? Math.PI : 0) * 0.35;
      const r = i < 6 ? 2.6 : 5.2;
      const c = new THREE.Vector3(t.pos.x + Math.sin(a) * r, t.pos.y, t.pos.z + Math.cos(a) * r);
      const df = Math.hypot(foe.x - c.x, foe.z - c.z);
      if (df < 4) continue;
      // Reachable in a straight line.
      const start = t.pos.clone().setY(t.pos.y + 0.6);
      const dir = c.clone().setY(t.pos.y + 0.6).sub(start);
      const len = dir.length();
      if (physics.rayHit(start, dir.normalize(), len, GROUPS_SHOT)) continue;
      // Low ray blocked close in front (something to hide behind).
      const low = c.clone().setY(c.y + 0.75);
      const ld = foeChest.clone().sub(low);
      const lh = physics.rayHit(low, ld.clone().normalize(), Math.min(3, ld.length() - 0.5), GROUPS_SHOT);
      if (!lh) continue;
      // Standing ray clear (can return fire).
      const hi = c.clone().setY(c.y + 1.55);
      const hd = foeChest.clone().sub(hi);
      const shootable = !physics.rayHit(hi, hd.clone().normalize(), hd.length() - 0.5, GROUPS_SHOT);
      const score = len + (shootable ? 0 : 6) + Math.abs(df - 12) * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = c.addScaledVector(ld.setY(0).normalize(), -0.15);
      }
    }
    return best;
  }

  private separate(): void {
    const live = this.thugs.filter((t) => !t.ko && !t.knocked);
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i];
        const b = live[j];
        const dx = b.pos.x - a.pos.x;
        const dz = b.pos.z - a.pos.z;
        if (Math.abs(dx) > 2 || Math.abs(dz) > 2) continue;
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
    // Fell through the world (ground not streamed in yet): stand on the terrain.
    const half = (t.kind === 'brute' || t.kind === 'tactical' ? 0.6 : 0.58) * t.actor.look.height;
    const floor = heightAt(next.x, next.z) - 0.5;
    if (next.y - half - t.radius < floor) next.y = floor + 0.5 + half + t.radius;
    t.body.setNextKinematicTranslation(next);
    t.pos.set(next.x, next.y - half - t.radius, next.z);
  }

  // ---------------------------------------------------------------- damage

  /**
   * Hit a fighter. Returns 'blocked' (riot shield), 'hit' or 'ko'.
   * knock: ragdoll knock-down (gets up unless KO); stun: seconds dazed; by: the NPC attacker.
   */
  damage(t: Thug, amount: number, from: THREE.Vector3, o: { stun?: number; knock?: number; kind?: DamageKind; by?: Thug } = {}): 'blocked' | 'hit' | 'ko' {
    if (t.ko) return 'ko';
    const byPlayer = !o.by && PLAYER_KINDS.includes(o.kind ?? 'strike');
    const dir = t.pos.clone().sub(from).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(Math.sin(t.yaw), 0, Math.cos(t.yaw)).negate();
    dir.normalize();
    const fwd = new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw));
    // Riot shield blocks frontal strikes until the guard is broken.
    if (t.kind === 'shield' && t.actor.shieldObj && t.guardBroken <= 0 && (o.kind === 'strike' || o.kind === 'counter' || o.kind === 'npc') && fwd.dot(dir) < -0.35 && !t.knocked) {
      t.actor.flinch(dir, 0.08);
      events.emit('combat:hit', { x: t.pos.x, y: t.pos.y + 1.2, z: t.pos.z, strength: 0.3, blocked: true });
      return 'blocked';
    }
    if (o.kind === 'cape' && t.kind === 'shield') t.guardBroken = 4;
    if (byPlayer) {
      if (t.faction === 'vpd') t.vsPlayer = true;
      if (t.aware !== 'combat' && t.aware !== 'flee') {
        t.aware = 'combat';
        t.vsPlayer = true;
        t.tgt = null;
        t.lastSeen.copy(from);
        for (const other of this.thugs) if (other !== t && other.faction === t.faction && other.pos.distanceTo(t.pos) < 25) this.alert(other, from);
      }
    } else if (o.by && t.aware !== 'flee') {
      // Fight back.
      if (!t.tgt || t.tgt.ko) t.tgt = o.by;
      if (t.aware !== 'combat') t.aware = 'combat';
    }
    t.atk = null;
    t.token = false;
    t.hp -= amount;
    const hitPos = t.pos.clone().add(new THREE.Vector3(0, 1.35, 0));
    const offense = (ko: boolean) => {
      if (byPlayer && t.faction === 'vpd') events.emit('player:offense', { kind: ko ? 'koOfficer' : 'attackOfficer', x: t.pos.x, z: t.pos.z });
    };
    if (t.hp <= 0) {
      t.koBy = byPlayer ? 'player' : o.by?.faction === 'vpd' ? 'police' : o.by ? 'gang' : 'player';
      this.knockOut(t, dir, o.kind === 'finisher' || o.kind === 'dive' ? 5.5 : o.kind === 'vehicle' ? 12 : 3.8);
      if (byPlayer) {
        const last = !this.thugs.some((x) => !x.ko && x.aware === 'combat' && x.vsPlayer && x.pos.distanceTo(t.pos) < 30);
        events.emit('combat:ko', { x: t.pos.x, z: t.pos.z, last });
      }
      offense(true);
      this.fightNoise(t.pos);
      return 'ko';
    }
    offense(false);
    if (o.knock) {
      this.knockDown(t, dir, o.knock);
      return 'hit';
    }
    if (o.stun) {
      t.stun = Math.max(t.stun, o.stun);
      t.actor.play('hitHead', 0.8, 0.05);
      t.actor.flinch(dir, 0.35);
    } else if ((t.kind === 'brute' || t.kind === 'tactical') && amount < 2) {
      // Heavies shrug off single light hits.
      t.actor.flinch(dir, 0.12);
    } else {
      t.stagger = 0.18;
      t.actor.play(this.rng.chance(0.5) ? 'hitHead' : 'hitChest', 1.2, 0.05);
      t.actor.flinch(dir, 0.3);
    }
    events.emit('combat:hit', { x: hitPos.x, y: hitPos.y, z: hitPos.z, strength: Math.min(1, amount / 3) * (o.kind === 'gun' ? 0.5 : 1) });
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
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(w.position.x, w.position.y, w.position.z).setRotation(w.quaternion).setLinvel(this.rng.range(-1, 1), 2, this.rng.range(-1, 1)));
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
    t.actor.knockDown(vel, null, null, 1.4 + this.rng.next());
  }

  knockOut(t: Thug, dir: THREE.Vector3, strength: number): void {
    t.ko = true;
    t.koT = 0;
    t.hp = 0;
    t.atk = null;
    t.token = false;
    t.warn = 0;
    t.gun = null;
    t.collider.setEnabled(false);
    this.dropWeapon(t);
    t.actor.root.position.copy(t.pos);
    t.actor.root.rotation.y = t.yaw;
    const vel = dir.clone().multiplyScalar(strength).add(UP.clone().multiplyScalar(Math.min(3, strength * 0.3)));
    t.actor.knockDown(vel, dir.clone().multiplyScalar(strength * 2.2), t.pos.clone().add(new THREE.Vector3(0, 1.4, 0)), Infinity);
  }

  /** Zip-tie a knocked-out criminal (left for the police). */
  tie(t: Thug): void {
    if (!t.ko || t.tied) return;
    t.tied = true;
    t.actor.tie();
  }

  /** Stun every hostile within r of a point (cape stun / dart / shockwave). */
  stunAround(x: number, z: number, r: number, secs: number, from: THREE.Vector3, kind: 'cape' | 'dive'): Thug[] {
    const hit: Thug[] = [];
    for (const t of this.thugs) {
      if (t.ko || t.knocked) continue;
      if (t.faction === 'vpd' && !this.policeHostile(t)) continue;
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
    t.gun = null;
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
    this.gunfire.update(dt);
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
      if (this.rng.chance(0.02)) a.flinch(new THREE.Vector3(this.rng.range(-0.5, 0.5), 0, this.rng.range(-0.5, 0.5)).normalize(), 0.15);
      return;
    }
    if (t.atk && t.atk.phase === 'windup') {
      a.loop('fight', 1.6, 0.1);
      return;
    }
    const pistol = t.weapon === 'pistol';
    if (sp > 4.2) a.loop('sprint', sp / 7.2, 0.2);
    else if (sp > 2.4) a.loop('jog', sp / 4.3, 0.2);
    else if (sp > 0.35) a.loop(t.crouch ? 'crouchWalk' : 'walk', Math.max(0.6, sp / 1.7), 0.2);
    else if (t.crouch) a.loop('crouch', 1, 0.2);
    else if (t.aware === 'combat' || t.aware === 'alert') a.loop(pistol ? (t.gun && (t.gun.phase === 'aim' || t.gun.phase === 'fire') ? 'aim' : 'pistolIdle') : 'fight', 1, 0.25);
    else if (t.pose) a.loop(t.pose, 1, 0.3);
    else if (t.aware === 'suspicious') a.loop(pistol ? 'pistolIdle' : 'idle', 1, 0.3);
    else a.loop(pistol && t.idleClip === 'idle' ? 'pistolIdle' : t.idleClip, 1, 0.3);
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

  /** Screen icons: awareness '?', '!' and attack warnings (only for fighters after the player). */
  icons(): { x: number; y: number; z: number; kind: 'sus' | 'alert' | 'warn' | 'danger' | 'stun' | 'tied' }[] {
    const out: { x: number; y: number; z: number; kind: 'sus' | 'alert' | 'warn' | 'danger' | 'stun' | 'tied' }[] = [];
    for (const t of this.thugs) {
      if (t.dist > 60) continue;
      if (t.tied) {
        if (t.dist < 25) {
          const p = t.actor.bonePos('pelvis');
          out.push({ x: p.x, y: p.y + 0.6, z: p.z, kind: 'tied' });
        }
        continue;
      }
      if (t.ko || t.knocked) continue;
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

/** Flickering flame billboard (oil drums, arson). */
export function flameMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
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
}

/** Spiral out from (cx, cz) to a clear patch of ground (no roofs, containers or props within r). */
export function findClearSpot(cx: number, cz: number, r: number, tries = 160): THREE.Vector3 {
  const down = new THREE.Vector3(0, -1, 0);
  for (let i = 0; i < tries; i++) {
    const a = i * 2.4;
    const rr = Math.sqrt(i) * 3.2;
    const x = cx + Math.cos(a) * rr;
    const z = cz + Math.sin(a) * rr;
    const g = heightAt(x, z);
    let ok = true;
    for (const [ox, oz] of [
      [0, 0],
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
      [r * 0.75, r * 0.75],
      [-r * 0.75, -r * 0.75],
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
