/**
 * Dynamic crime: the director that makes Port Vellmoor dangerous.
 *
 * Every 35–90 s (faster at night ×1.8 and in storms ×1.5; at most three at once) a crime starts
 * 120–420 m from the player. The type is weighted by time of day and the site's district, and is
 * committed by the gang that controls that district (gang heat makes crimes likelier):
 *   mugging · car theft · shop robbery · armed bank robbery · gang street fight · hostage
 *   situation (inside a warehouse) · getaway car chase · warehouse deal · arson.
 * Each crime announces itself on the police scanner, gets a map icon and a timer, and the police
 * respond after a delay that depends on the crime.
 *
 * Outcomes
 *  - stopped: the Nightwarden knocked criminals out → they are zip-tied for the police;
 *             reputation, cash and Police Trust go up; the gang loses district control.
 *  - police:  officers dealt with it → the gang loses a little control.
 *  - failed:  the timer ran out — victim hurt / building burnt / hostages harmed; control rises.
 *  - escaped: the criminals got away (getaway car, fled) — control rises.
 * Losing control builds gang pressure, which comes back as retaliation: ambushes on the hero and
 * gang cars patrolling the streets around him.
 */
import * as THREE from 'three';
import { events } from '../core/EventBus';
import { Rng, hashN } from '../core/Random';
import { clock } from '../systems/Clock';
import { weather, wind } from '../systems/Weather';
import { DISTRICT_NAMES, districtAt, type District } from '../world/WorldConfig';
import { heightAt } from '../world/Terrain';
import { SPECS, TRAFFIC_KINDS } from '../vehicles/VehicleModels';
import type { AICar } from '../vehicles/AICar';
import type { Fleet } from '../vehicles/Fleet';
import type { Enemies, Thug, Crew, ThugKind } from '../ai/Enemies';
import type { Actor, ActorKit, ActorClip, WeaponKind } from '../actors/Actor';
import { makeLook } from '../ai/Crowd';
import { FireFX } from '../world/FireFX';
import type { Police, CrimeScene } from '../police/Police';
import { GANGS, GANG_IDS, type GangId, type Territory } from './Gangs';
import type { CrimeSites, Site, Warehouse } from './Sites';
import type { Stats, Outcome } from './Stats';

export type CrimeType = 'mugging' | 'carTheft' | 'shopRobbery' | 'bankRobbery' | 'streetFight' | 'hostage' | 'getaway' | 'deal' | 'arson';
export const CRIME_TYPES: CrimeType[] = ['mugging', 'carTheft', 'shopRobbery', 'bankRobbery', 'streetFight', 'hostage', 'getaway', 'deal', 'arson'];

interface Def {
  name: string;
  timer: number;
  /** Base spawn weight and night multiplier. */
  w: number;
  night: number;
  police: [number, number];
  delay: number;
  rep: number;
  cash: number;
  control: number;
  icon: string;
}

export const CRIME_DEFS: Record<CrimeType, Def> = {
  mugging: { name: 'Mugging', timer: 55, w: 3, night: 1.6, police: [1, 0], delay: 40, rep: 3, cash: 60, control: 8, icon: '!' },
  carTheft: { name: 'Car theft', timer: 32, w: 2, night: 1.4, police: [1, 0], delay: 30, rep: 3, cash: 80, control: 8, icon: '⚿' },
  shopRobbery: { name: 'Shop robbery', timer: 70, w: 2, night: 1.3, police: [2, 0], delay: 28, rep: 5, cash: 150, control: 10, icon: '$' },
  bankRobbery: { name: 'Armed bank robbery', timer: 95, w: 0.7, night: 0.5, police: [3, 1], delay: 14, rep: 12, cash: 600, control: 15, icon: '$$' },
  streetFight: { name: 'Gang street fight', timer: 75, w: 1.5, night: 1.5, police: [2, 0], delay: 30, rep: 4, cash: 50, control: 10, icon: '⚔' },
  hostage: { name: 'Hostage situation', timer: 160, w: 0.8, night: 1.2, police: [2, 1], delay: 20, rep: 14, cash: 400, control: 15, icon: 'H' },
  getaway: { name: 'Getaway car chase', timer: 100, w: 1, night: 1.3, police: [0, 0], delay: 0, rep: 8, cash: 250, control: 10, icon: '»' },
  deal: { name: 'Warehouse deal', timer: 90, w: 1, night: 2.2, police: [1, 0], delay: 65, rep: 8, cash: 300, control: 12, icon: '◆' },
  arson: { name: 'Arson', timer: 60, w: 0.8, night: 1.6, police: [1, 0], delay: 40, rep: 6, cash: 100, control: 10, icon: '♨' },
};

interface Victim {
  actor: Actor;
  state: 'held' | 'hurt' | 'free';
  t: number;
  dir: THREE.Vector3;
}

export interface Crime extends CrimeScene {
  type: CrimeType;
  gang: GangId;
  rival: GangId | null;
  district: District;
  y: number;
  t: number;
  timer: number;
  phase: 'active' | 'escape' | 'over';
  crew: Crew;
  crew2: Crew | null;
  criminals: Thug[];
  victims: Victim[];
  car: AICar | null;
  /** Extra parked cars (deal). */
  cars: AICar[];
  /** Criminals inside the getaway car. */
  aboard: number;
  fire: FireFX | null;
  involved: boolean;
  policeT: number;
  policeSent: boolean;
  outcome: Outcome | null;
  endT: number;
  stopT: number;
  lostT: number;
  started: number;
  warehouse: Warehouse | null;
}

export interface CrimeLogEntry {
  id: number;
  type: CrimeType;
  label: string;
  gang: string;
  district: string;
  startedAt: number;
  clock: string;
  endedAt?: number;
  outcome?: Outcome;
  detail?: string;
}

interface GangPatrol {
  gang: GangId;
  car: AICar;
  crew: Crew;
  aboard: number;
  t: number;
}

export class Crimes {
  readonly active: Crime[] = [];
  readonly log: CrimeLogEntry[] = [];
  readonly group = new THREE.Group();
  enabled = true;
  private rng = new Rng(0xc7111e);
  private nextId = 1;
  spawnT = 30;
  time = 0;
  private bankCool = 0;
  private retaliateT = 60;
  private patrols: GangPatrol[] = [];
  private fires: FireFX[] = [];
  /** Sim time of the last player KO on a criminal per crime (involvement). */
  private playerPos = new THREE.Vector3();

  constructor(
    private readonly sites: CrimeSites,
    private readonly enemies: Enemies,
    private readonly police: Police,
    private readonly fleet: Fleet,
    private readonly territory: Territory,
    private readonly stats: Stats,
    private readonly kit: ActorKit,
  ) {
    this.group.name = 'Crimes';
    events.on('territory:lost', (e) => {
      const msg = `${GANGS[e.gang].name} lose their grip on ${DISTRICT_NAMES[e.district]}`;
      events.emit('news', { text: msg });
      events.emit('police:scanner', { text: `Intel: ${GANGS[e.gang].short} activity in ${DISTRICT_NAMES[e.district]} has collapsed`, priority: false });
    });
  }

  // ---------------------------------------------------------------- spawning

  private chooseType(player: THREE.Vector3): CrimeType | null {
    const night = clock.night > 0.5;
    const ws = CRIME_TYPES.map((k) => {
      const d = CRIME_DEFS[k];
      let w = d.w * (night ? d.night : 1);
      if (this.active.some((c) => c.type === k)) w *= 0.25;
      if (k === 'bankRobbery') {
        const db = Math.hypot(this.sites.bank.x - player.x, this.sites.bank.z - player.z);
        if (this.bankCool > 0 || db > 450 || db < 60 || this.active.some((c) => c.type === 'bankRobbery')) w = 0;
      }
      if (k === 'hostage' || k === 'deal') {
        if (!this.sites.warehouses.some((wh) => this.inRange(wh, player, 100, 520) && !this.active.some((c) => c.warehouse === wh))) w = 0;
      }
      return w;
    });
    const sum = ws.reduce((a, b) => a + b, 0);
    if (sum <= 0) return null;
    return this.rng.weighted(CRIME_TYPES, ws);
  }

  private inRange(p: { x: number; z: number }, q: THREE.Vector3, a: number, b: number): boolean {
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    return d >= a && d <= b;
  }

  /** The gang that would commit a crime in a district (null: nobody there). */
  private gangFor(d: District, type: CrimeType): GangId | null {
    if (type === 'arson' && this.territory.get(d, 'ashline') > 0) return 'ashline';
    if (type === 'bankRobbery' && this.territory.get(d, 'velvet') > 0) return 'velvet';
    const own = this.territory.owner(d);
    if (own) return own;
    // Unclaimed districts still see opportunists from the strongest gang overall.
    let best: GangId = 'tidewater';
    let bv = -1;
    for (const g of GANG_IDS) {
      const v = this.territory.districtsOf(g).length;
      if (v > bv) {
        bv = v;
        best = g;
      }
    }
    return this.rng.chance(0.35) ? best : null;
  }

  /** Start a crime (random type / place unless given). Returns null if no site fits. */
  start(type: CrimeType | null, player: THREE.Vector3, near?: THREE.Vector3): Crime | null {
    type ??= this.chooseType(player);
    if (!type) return null;
    const at = near ?? player;
    const minD = near ? 0 : 120;
    const maxD = near ? 90 : 420;
    let site: Site | null = null;
    let wh: Warehouse | null = null;
    switch (type) {
      case 'mugging':
      case 'streetFight':
        site = this.sites.streetPoint(this.rng, at, minD, maxD, (d) => d !== 'island');
        break;
      case 'carTheft':
        site = this.sites.parkingSpot(this.rng, at, minD, maxD, (d) => d !== 'island');
        break;
      case 'shopRobbery':
      case 'arson': {
        const c = this.sites.shops.filter((s) => this.inRange(s, at, minD, maxD) && !this.active.some((a) => Math.hypot(a.x - s.x, a.z - s.z) < 30));
        site = c.length ? this.rng.pick(c) : null;
        break;
      }
      case 'bankRobbery':
        site = this.sites.bank;
        break;
      case 'hostage':
      case 'deal': {
        const c = this.sites.warehouses.filter((w) => (near ? true : this.inRange(w, at, 100, 520)) && !this.active.some((a) => a.warehouse === w));
        wh = c.length ? (near ? c.sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0] : this.rng.pick(c)) : null;
        if (wh) site = { x: wh.door.x, y: wh.y, z: wh.door.z, yaw: wh.yaw, district: wh.district };
        break;
      }
      case 'getaway': {
        const sp = this.fleet.spawnPoint(at, near ? 30 : 160, near ? 120 : 330, player, near ? 20 : 90);
        if (sp) site = { x: sp.x, y: sp.y, z: sp.z, yaw: sp.yaw, district: districtAt(sp.x, sp.z) };
        break;
      }
    }
    if (!site) return null;
    const district = site.district;
    const gang = this.gangFor(district, type);
    if (!gang) return null;
    // Districts the gangs hold tightly see more crime.
    if (!near && type !== 'getaway' && !this.rng.chance(0.35 + 0.65 * this.territory.heat(district))) return null;
    const def = CRIME_DEFS[type];
    const label = `${def.name} — ${type === 'bankRobbery' ? 'Brightwater Savings' : wh ? wh.name : DISTRICT_NAMES[district]}`;
    const crew = this.enemies.makeCrew(gang, 'crime', label, site.x, site.z, { leash: type === 'hostage' ? 8.5 : 0 });
    const id = this.nextId++;
    const crime: Crime = {
      id,
      label,
      x: site.x,
      z: site.z,
      y: site.y,
      active: true,
      type,
      gang,
      rival: null,
      district,
      t: 0,
      timer: def.timer,
      phase: 'active',
      crew,
      crew2: null,
      criminals: [],
      victims: [],
      car: null,
      cars: [],
      aboard: 0,
      fire: null,
      involved: false,
      policeT: def.delay * this.rng.range(0.8, 1.3),
      policeSent: false,
      outcome: null,
      endT: 0,
      stopT: 0,
      lostT: 0,
      started: this.time,
      warehouse: wh,
    };
    this.setup(crime, site, player);
    if (!crime.criminals.length && !crime.car) {
      this.cleanup(crime);
      return null;
    }
    this.active.push(crime);
    this.log.push({ id, type, label, gang: GANGS[gang].name, district: DISTRICT_NAMES[district], startedAt: Math.round(this.time), clock: clock.label() });
    events.emit('crime:start', { id, type, label, x: crime.x, z: crime.z });
    events.emit('police:scanner', { text: this.scannerText(crime), priority: type === 'bankRobbery' || type === 'hostage' });
    if (type === 'bankRobbery') this.bankCool = 480;
    return crime;
  }

  private scannerText(c: Crime): string {
    const where = c.type === 'bankRobbery' ? 'Brightwater Savings Bank, Midtown' : c.warehouse ? `${c.warehouse.name}, ${DISTRICT_NAMES[c.district]}` : DISTRICT_NAMES[c.district];
    const g = GANGS[c.gang].short;
    switch (c.type) {
      case 'mugging':
        return `Dispatch: robbery with violence reported, ${where}. Suspects wearing ${g} colours`;
      case 'carTheft':
        return `Dispatch: vehicle break-in in progress, ${where}`;
      case 'shopRobbery':
        return `Dispatch: armed robbery at a shop, ${where}. Silent alarm triggered`;
      case 'bankRobbery':
        return `All units, code red: armed robbery in progress at ${where}. Multiple armed suspects, hostages reported`;
      case 'streetFight':
        return `Dispatch: large fight between ${g} and ${GANGS[c.rival ?? c.gang].short} members, ${where}`;
      case 'hostage':
        return `All units: hostages held by armed ${g} suspects inside ${where}. Establish a perimeter, do not enter`;
      case 'getaway':
        return `Pursuit: units chasing a stolen vehicle through ${where}, suspects armed`;
      case 'deal':
        return `Informant tip: ${g} deal going down at ${where}`;
      case 'arson':
        return `Fire service and police requested: suspects setting fire to a shopfront, ${where}`;
    }
  }

  // ---------------------------------------------------------------- setup

  private criminal(c: Crime, x: number, z: number, o: { kind?: ThugKind; weapon?: WeaponKind; idle?: ActorClip; focus?: THREE.Vector3; crew?: Crew; y?: number } = {}): Thug | null {
    const crew = o.crew ?? c.crew;
    const g = crew.faction as GangId;
    const kind: ThugKind = o.kind ?? (this.rng.chance(GANGS[g].bruteChance * 0.4) ? 'brute' : 'thug');
    let weapon = o.weapon ?? this.enemies.pickWeapon(g, this.rng);
    if (kind === 'brute' && weapon === 'pistol') weapon = 'pipe';
    const t = this.enemies.spawn(crew, x, z, kind, weapon, c.criminals.length, { idle: o.idle, y: o.y ?? c.y });
    if (!t) return null;
    if (o.focus) t.focus = o.focus.clone();
    t.yaw = o.focus ? Math.atan2(o.focus.x - x, o.focus.z - z) : t.yaw;
    c.criminals.push(t);
    return t;
  }

  private victim(c: Crime, x: number, z: number, yaw: number, clip: ActorClip, y?: number): Victim {
    const a = this.kit.create(makeLook(hashN(c.id, c.victims.length, 7717)));
    a.root.position.set(x, y ?? this.enemies.groundAt(x, z, c.y), z);
    a.root.rotation.y = yaw;
    a.loop(clip, 1, 0.01);
    this.group.add(a.root);
    const v: Victim = { actor: a, state: 'held', t: 0, dir: new THREE.Vector3() };
    c.victims.push(v);
    return v;
  }

  private gangCar(g: GangId, x: number, y: number, z: number, yaw: number, speed = 0): AICar | null {
    if (this.fleet.full) return null;
    const G = GANGS[g];
    const spec = SPECS[this.rng.pick(G.vehicles)];
    const col = this.rng.pick(G.vehicleColors);
    return this.fleet.add(spec, new THREE.Color(...col), x, y, z, yaw, speed);
  }

  private setup(c: Crime, s: Site, player: THREE.Vector3): void {
    const fwd = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    const side = new THREE.Vector3(fwd.z, 0, -fwd.x);
    const P = (f: number, l: number) => new THREE.Vector3(s.x, 0, s.z).addScaledVector(fwd, f).addScaledVector(side, l);
    switch (c.type) {
      case 'mugging': {
        const vp = P(-0.6, 0);
        this.victim(c, vp.x, vp.z, s.yaw + Math.PI, 'crouch');
        const n = this.rng.chance(0.5) ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const p = P(0.9, (i - (n - 1) / 2) * 1.3);
          this.criminal(c, p.x, p.z, { weapon: this.rng.pick(['knife', 'knife', 'fists', 'pistol'] as WeaponKind[]), idle: 'fight', focus: vp, kind: 'thug' });
        }
        break;
      }
      case 'carTheft': {
        const spec = SPECS[this.rng.pick(TRAFFIC_KINDS.filter((k) => k !== 'taxi'))];
        const [r, g, b] = this.rng.pick(spec.palette);
        if (this.fleet.full) return;
        const car = this.fleet.add(spec, new THREE.Color(r, g, b), s.x, s.y, s.z, s.yaw, 0);
        car.driver = false;
        c.car = car;
        // Driver door: the car's left (+X local).
        const left = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
        const door = new THREE.Vector3(s.x, 0, s.z).addScaledVector(left, spec.width / 2 + 0.55).addScaledVector(fwd, 0.3);
        const thief = this.criminal(c, door.x, door.z, { weapon: 'fists', idle: 'kneel', focus: new THREE.Vector3(s.x, 0, s.z), kind: 'thug' });
        if (thief) thief.pose = 'kneel';
        if (this.rng.chance(0.6)) {
          const lp = door.clone().addScaledVector(left, 1.6).addScaledVector(fwd, -2.5);
          this.criminal(c, lp.x, lp.z, { idle: 'idle', kind: 'thug' });
        }
        break;
      }
      case 'shopRobbery': {
        const vp = P(-1.5, 0);
        this.victim(c, vp.x, vp.z, s.yaw, 'crouch');
        const n = this.rng.int(2, 3);
        for (let i = 0; i < n; i++) {
          const p = P(i === 0 ? -0.2 : 1.6, (i - 1) * 1.6);
          this.criminal(c, p.x, p.z, { weapon: i === 0 ? 'pistol' : undefined, idle: i === 0 ? 'aim' : 'idle', focus: i === 0 ? vp : P(10, 0), kind: 'thug' });
        }
        break;
      }
      case 'bankRobbery': {
        // Hostages kneel by the doors; gunmen cover them and the street; a getaway car waits.
        for (let i = 0; i < 3; i++) {
          const vp = P(-0.9, (i - 1) * 1.4);
          this.victim(c, vp.x, vp.z, s.yaw + Math.PI + (i - 1) * 0.3, 'kneel');
        }
        const pos: [number, number, ActorClip, boolean][] = [
          [1.2, -2.6, 'aim', true],
          [1.2, 2.6, 'aim', true],
          [3.4, -1.0, 'pistolIdle', false],
          [3.2, 1.6, 'pistolIdle', false],
          [0.6, 4.4, 'idle', false],
        ];
        const n = this.rng.int(4, 5);
        for (let i = 0; i < n; i++) {
          const [f, l, idle, atHostages] = pos[i];
          const p = P(f, l);
          this.criminal(c, p.x, p.z, { weapon: i < 4 ? 'pistol' : 'pipe', idle, focus: atHostages ? P(-0.9, 0) : P(14, l * 2), kind: i === 4 ? 'brute' : 'thug' });
        }
        const park = this.sites.parkingSpot(this.rng, new THREE.Vector3(s.x, 0, s.z), 0, 40);
        if (park) {
          c.car = this.gangCar(c.gang, park.x, park.y, park.z, park.yaw);
          c.aboard = 0;
        }
        break;
      }
      case 'streetFight': {
        const rivals = GANG_IDS.filter((g) => g !== c.gang);
        const rival = this.rng.pick(rivals);
        c.rival = rival;
        c.crew.feud = [rival];
        c.crew2 = this.enemies.makeCrew(rival, 'crime', c.label, s.x, s.z, { feud: [c.gang] });
        for (let i = 0; i < 3; i++) {
          const a = P(-3 - (i % 2), (i - 1) * 2);
          const b = P(4 + (i % 2), (i - 1) * 2);
          const ta = this.criminal(c, a.x, a.z, { idle: 'fight', focus: b });
          const tb = this.criminal(c, b.x, b.z, { idle: 'fight', focus: a, crew: c.crew2 });
          if (ta && tb) {
            ta.tgt = tb;
            tb.tgt = ta;
            ta.aware = 'combat';
            tb.aware = 'combat';
          }
        }
        break;
      }
      case 'hostage': {
        const w = c.warehouse!;
        c.crew.x = w.inside.x;
        c.crew.z = w.inside.z;
        c.x = w.inside.x;
        c.z = w.inside.z;
        const tbl = w.table;
        for (let i = 0; i < 2; i++) {
          const vp = w.local(-2.5 + i * 1.4, -2.2);
          this.victim(c, vp.x, vp.z, w.yaw, 'kneel', w.y + 0.1);
        }
        const spots: [number, number, WeaponKind, ActorClip][] = [
          [-1.2, -0.6, 'pistol', 'aim'],
          [2.6, -2.0, 'pipe', 'idle'],
          [0.5, 4.8, 'pistol', 'pistolIdle'],
          [-4.5, 2.5, 'knife', 'idle'],
        ];
        const n = this.rng.int(3, 4);
        for (let i = 0; i < n; i++) {
          const [lx, lz, wpn, idle] = spots[i];
          const p = w.local(lx, lz);
          this.criminal(c, p.x, p.z, { weapon: wpn, idle, focus: i === 0 ? w.local(-1.8, -2.2) : i === 2 ? w.door : tbl, y: w.y + 0.1 });
        }
        break;
      }
      case 'getaway': {
        const car = this.gangCar(c.gang, s.x, s.y, s.z, s.yaw, 12);
        if (!car) return;
        c.car = car;
        c.aboard = 2;
        c.phase = 'escape';
        this.fleet.driver(car).flee(() => this.pursuersOf(car), 28);
        this.police.chase(car, c, 2, player);
        c.policeSent = true;
        break;
      }
      case 'deal': {
        const w = c.warehouse!;
        const others = GANG_IDS.filter((g) => g !== c.gang);
        const buyer = this.rng.pick(others);
        c.crew2 = this.enemies.makeCrew(buyer, 'crime', c.label, s.x, s.z);
        const mid = w.local(0, 15 / 2 + 7);
        const p1 = w.local(-5, 15 / 2 + 9);
        const p2 = w.local(5, 15 / 2 + 9);
        const car1 = this.gangCar(c.gang, p1.x, w.y, p1.z, w.yaw + Math.PI / 2);
        const car2 = this.gangCar(buyer, p2.x, w.y, p2.z, w.yaw - Math.PI / 2);
        for (const car of [car1, car2]) if (car) {
          car.driver = false;
          c.cars.push(car);
        }
        for (let i = 0; i < 3; i++) {
          const p = w.local(-1.6, 15 / 2 + 5.8 + i * 1.1);
          this.criminal(c, p.x, p.z, { idle: i === 0 ? 'talk' : 'idle', focus: mid, weapon: i === 0 ? 'pistol' : undefined });
        }
        for (let i = 0; i < 2; i++) {
          const p = w.local(1.6, 15 / 2 + 6.2 + i * 1.2);
          this.criminal(c, p.x, p.z, { idle: i === 0 ? 'talk' : 'idle', focus: mid, crew: c.crew2 });
        }
        break;
      }
      case 'arson': {
        const facade = P(-2.2, 0);
        const fire = new FireFX(new THREE.Vector3(facade.x, heightAt(facade.x, facade.z) + 0.15, facade.z), fwd.clone(), Math.min(9, (s.b ? (s.b.front === 'n' || s.b.front === 's' ? s.b.w : s.b.d) : 8) * 0.6));
        fire.target = 0.25;
        this.group.add(fire.group);
        c.fire = fire;
        this.fires.push(fire);
        for (let i = 0; i < 2; i++) {
          const p = P(0.8, (i - 0.5) * 3);
          const t = this.criminal(c, p.x, p.z, { weapon: this.rng.pick(['fists', 'pipe'] as WeaponKind[]), idle: 'throw', focus: facade, kind: 'thug' });
          if (t) t.pose = 'throw';
        }
        break;
      }
    }
  }

  /** Police cars chasing a car + the player's car. */
  private pursuersOf(car: AICar): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const u of this.police.units) if (u.job.k === 'chase' && u.job.car === car) out.push(u.car.position);
    out.push(this.playerPos);
    return out;
  }

  // ---------------------------------------------------------------- simulation

  fixedUpdate(dt: number, player: { pos: THREE.Vector3; hero: boolean; driving: boolean }): void {
    this.time += dt;
    this.playerPos.copy(player.pos);
    this.bankCool -= dt;
    if (this.enabled) {
      const m = (clock.night > 0.5 ? 1.8 : 1) * (weather.state === 'storm' ? 1.5 : weather.state === 'heavyrain' ? 1.2 : 1);
      this.spawnT -= dt * m;
      if (this.spawnT <= 0) {
        this.spawnT = this.rng.range(35, 90);
        if (this.active.filter((c) => c.phase !== 'over').length < 3) {
          for (let i = 0; i < 4; i++) if (this.start(null, player.pos)) break;
        }
      }
      this.retaliation(dt, player);
    }
    for (const c of [...this.active]) this.step(c, dt, player);
    this.updatePatrols(dt, player);
  }

  private step(c: Crime, dt: number, player: { pos: THREE.Vector3; hero: boolean; driving: boolean }): void {
    c.t += dt;
    if (c.phase === 'over') {
      c.endT += dt;
      const dp = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
      const collecting = this.police.units.some((u) => u.job.k === 'collect' && Math.hypot(u.job.x - c.x, u.job.z - c.z) < 60);
      if ((c.endT > 90 && !collecting && dp > 60) || dp > 380 || c.endT > 240) this.cleanup(c);
      return;
    }
    const dp = Math.hypot(c.x - player.pos.x, c.z - player.pos.z);
    if (dp < 45) c.involved = true;
    // Police response.
    if (!c.policeSent) {
      c.policeT -= dt;
      const [pat, tac] = CRIME_DEFS[c.type].police;
      if (c.policeT <= 0 && pat + tac > 0) {
        c.policeSent = true;
        // Hostage situations: a perimeter at the warehouse door (sharing the crime's active flag).
        const door = c.type === 'hostage' && c.warehouse ? c.warehouse.door : null;
        const at: CrimeScene = door
          ? {
              id: c.id,
              label: c.label,
              x: door.x,
              z: door.z,
              get active() {
                return c.active;
              },
            }
          : c;
        this.police.respond(at, pat, tac, player.pos);
        if (this.stats.trust >= 60 && c.involved && player.hero) events.emit('police:scanner', { text: `Units at ${c.label}: the Nightwarden is on scene — let him work`, priority: false });
      }
    }
    const crims = c.criminals;
    const standing = crims.filter((t) => !t.removed && !t.ko);
    // Type-specific behaviour.
    switch (c.type) {
      case 'arson':
        if (c.fire) c.fire.target = Math.min(1, 0.25 + (c.t / c.timer) * 0.85);
        break;
      case 'carTheft':
        if (c.phase === 'active' && c.t > c.timer && c.car) {
          const thief = standing.find((t) => t.pose === 'kneel' && t.aware === 'unaware');
          if (thief) {
            this.enemies.removeThug(thief);
            c.aboard = 1;
            c.car.driver = true;
            c.phase = 'escape';
            c.timer = c.t + 75;
            this.fleet.driver(c.car).flee(() => this.pursuersOf(c.car!), 26);
            events.emit('police:scanner', { text: `Stolen vehicle fleeing ${DISTRICT_NAMES[c.district]}`, priority: false });
            if (c.policeSent) this.police.chase(c.car, c, 1, player.pos);
          }
        }
        break;
      case 'bankRobbery':
        this.sites.alarmMat.emissiveIntensity = c.phase === 'active' ? (Math.floor(c.t * 3) % 2 ? 6 : 0.3) : 0;
        if (c.phase === 'active' && c.t > c.timer && c.car && !c.car.disabled) {
          // Run for the car.
          let boarding = false;
          const door = c.car.position;
          for (const t of standing) {
            if (t.aware === 'combat' && t.dist < 25) continue;
            boarding = true;
            if (!t.goto) {
              t.aware = 'unaware';
              t.tgt = null;
              t.goto = door.clone();
              t.gotoRun = true;
            }
            if (t.pos.distanceTo(door) < 3.2 || c.t > c.timer + 14) {
              this.enemies.removeThug(t);
              c.aboard++;
            }
          }
          if (!boarding || c.t > c.timer + 16) {
            if (c.aboard > 0) {
              c.phase = 'escape';
              c.timer = c.t + 90;
              c.car.driver = true;
              this.fleet.driver(c.car).flee(() => this.pursuersOf(c.car!), 28);
              this.police.chase(c.car, c, 3, player.pos);
              events.emit('police:scanner', { text: 'Bank robbers fleeing in a getaway car — all units pursue', priority: true });
            }
          }
        }
        break;
      case 'deal':
        if (c.t > c.timer && c.phase === 'active' && !standing.some((t) => t.aware === 'combat')) {
          // The deal is done: everyone drives off.
          for (const t of standing) this.enemies.removeThug(t);
          for (const car of c.cars) {
            car.driver = true;
            const sp = this.fleet.spawnPoint(car.position, 300, 500, player.pos, 150);
            if (sp) this.fleet.driver(car).routeTo(new THREE.Vector3(sp.x, 0, sp.z), 16, 10);
          }
          this.end(c, 'escaped', 'the deal went through and both crews drove off');
          return;
        }
        break;
    }
    // Getaway car stopped or wrecked: the people inside bail out and fight / run.
    if (c.phase === 'escape' && c.car) {
      const car = c.car;
      c.stopT = Math.abs(car.speed) < 1 ? c.stopT + dt : 0;
      if ((car.disabled || c.stopT > 5) && c.aboard > 0) {
        const f = car.forward(new THREE.Vector3());
        const left = new THREE.Vector3(f.z, 0, -f.x);
        for (let i = 0; i < c.aboard; i++) {
          const p = car.position.clone().addScaledVector(left, (i % 2 ? -1 : 1) * (car.spec.width / 2 + 0.7)).addScaledVector(f, i < 2 ? 0.4 : -1);
          const t = this.criminal(c, p.x, p.z, { weapon: c.type === 'bankRobbery' ? 'pistol' : undefined, y: car.position.y });
          if (t) {
            t.aware = 'combat';
            t.vsPlayer = player.hero;
          }
        }
        c.aboard = 0;
        car.driver = false;
        events.emit('police:scanner', { text: 'Suspects have bailed out of the vehicle, on foot', priority: true });
      }
      // Got away? (out of time, or every pursuer and the hero far behind for a while)
      if (c.aboard > 0) {
        let near = Math.hypot(car.position.x - player.pos.x, car.position.z - player.pos.z);
        for (const q of this.pursuersOf(car)) near = Math.min(near, q.distanceTo(car.position));
        c.lostT = near > 320 ? c.lostT + dt : 0;
        if (c.t > c.timer || c.lostT > 20) {
          this.end(c, 'escaped', 'the getaway car lost its pursuers');
          return;
        }
      }
    }
    // Everyone down or gone?
    if (standing.length === 0 && c.aboard === 0 && crims.length > 0) {
      const koP = crims.filter((t) => t.ko && t.koBy === 'player').length;
      const koPol = crims.filter((t) => t.ko && t.koBy === 'police').length;
      const koAny = crims.filter((t) => t.ko).length;
      if (koP > 0) this.end(c, 'stopped', `${koP} knocked out by the Nightwarden`);
      else if (koPol > 0) this.end(c, 'police', `${koPol} arrested by Vellmoor PD`);
      else if (c.type === 'streetFight' && koAny > 0) this.end(c, 'failed', 'gang members hurt each other');
      else this.end(c, 'escaped', 'the suspects fled');
      return;
    }
    // Street fight: one side left standing.
    if (c.type === 'streetFight' && c.crew2) {
      const a = standing.filter((t) => t.crew === c.crew).length;
      const b = standing.filter((t) => t.crew === c.crew2).length;
      if ((a === 0 || b === 0) && !standing.some((t) => t.vsPlayer && t.aware === 'combat')) {
        const koP = crims.filter((t) => t.ko && t.koBy === 'player').length;
        const koPol = crims.filter((t) => t.ko && t.koBy === 'police').length;
        for (const t of standing) this.flee(t, player.pos);
        if (koP > 0) this.end(c, 'stopped', `${koP} knocked out by the Nightwarden`);
        else if (koPol > 0) this.end(c, 'police', 'police broke it up');
        else this.end(c, 'failed', `${a ? GANGS[c.gang].short : GANGS[c.rival!].short} won the fight; several hurt`);
        return;
      }
    }
    // Timer.
    if (c.phase === 'active' && c.t > c.timer && c.type !== 'bankRobbery' && c.type !== 'carTheft' && c.type !== 'deal') {
      const fighting = standing.some((t) => t.aware === 'combat' && t.vsPlayer && t.dist < 30);
      if (fighting) return; // The hero is in the middle of it: wait.
      for (const v of c.victims) this.hurt(v);
      for (const t of standing) this.flee(t, player.pos);
      const what: Record<string, string> = {
        mugging: 'the victim was beaten and robbed',
        shopRobbery: 'the shopkeeper was hurt, the robbers escaped with the till',
        streetFight: 'several people were hurt',
        hostage: 'hostages were harmed',
        arson: 'the building burnt',
      };
      if (c.fire) c.fire.target = 1;
      this.end(c, c.type === 'shopRobbery' ? 'escaped' : 'failed', what[c.type] ?? 'the suspects escaped');
    }
  }

  private flee(t: Thug, from: THREE.Vector3): void {
    t.aware = 'flee';
    t.tgt = null;
    t.goto = null;
    t.crew.leash = 0;
    t.fleeT = 0;
    const away = t.pos.clone().sub(from).setY(0).normalize();
    t.goto = t.pos.clone().addScaledVector(away, 200);
  }

  private hurt(v: Victim): void {
    if (v.state !== 'held') return;
    v.state = 'hurt';
    const a = v.actor;
    const yaw = a.root.rotation.y;
    a.knockDown(new THREE.Vector3(Math.sin(yaw) * -2, 1.2, Math.cos(yaw) * -2), null, null, Infinity);
  }

  private free(v: Victim, from: THREE.Vector3): void {
    if (v.state !== 'held') return;
    v.state = 'free';
    v.t = 0;
    const a = v.actor;
    v.dir.copy(a.root.position).sub(from).setY(0);
    if (v.dir.lengthSq() < 0.01) v.dir.set(Math.sin(a.root.rotation.y), 0, Math.cos(a.root.rotation.y));
    v.dir.normalize();
    a.root.rotation.y = Math.atan2(v.dir.x, v.dir.z);
    a.loop('jog', 1, 0.4);
  }

  /** Resolve a crime. */
  end(c: Crime, outcome: Outcome, detail: string): void {
    if (c.phase === 'over') return;
    c.phase = 'over';
    c.active = false;
    c.outcome = outcome;
    c.endT = 0;
    const def = CRIME_DEFS[c.type];
    if (c.type === 'bankRobbery') this.sites.alarmMat.emissiveIntensity = 0;
    if (outcome === 'stopped') {
      for (const t of c.criminals) if (t.ko && !t.removed) this.enemies.tie(t);
      for (const v of c.victims) this.free(v, new THREE.Vector3(c.x, 0, c.z));
      if (c.fire) c.fire.target = 0;
      this.stats.change({ reputation: def.rep, money: def.cash, trust: 3 }, `stopped ${c.type}`);
      this.stats.criminalsCaptured += c.criminals.filter((t) => t.ko).length;
      this.territory.adjust(c.gang, c.district, -def.control, 'crime stopped');
      if (c.rival) this.territory.adjust(c.rival, c.district, -Math.round(def.control / 2), 'crime stopped');
      events.emit('news', { text: this.headline(c, 'stopped') });
      // Make sure someone comes for the tied-up criminals.
      if (!c.policeSent) {
        c.policeSent = true;
        this.police.respond(c, 1, 0, this.playerPos);
      }
    } else if (outcome === 'police') {
      for (const v of c.victims) this.free(v, new THREE.Vector3(c.x, 0, c.z));
      if (c.fire) c.fire.target = 0;
      this.territory.adjust(c.gang, c.district, -Math.round(def.control / 2), 'police');
      events.emit('news', { text: this.headline(c, 'police') });
    } else {
      for (const v of c.victims) if (outcome === 'failed') this.hurt(v);
      else this.free(v, new THREE.Vector3(c.x, 0, c.z));
      this.territory.adjust(c.gang, c.district, 5, outcome);
      this.stats.change({ reputation: -1 }, `ignored ${c.type}`);
      if (c.type === 'bankRobbery' || c.type === 'hostage' || c.type === 'arson' || this.rng.chance(0.4)) events.emit('news', { text: this.headline(c, outcome) });
    }
    this.stats.crime(c.type, outcome);
    const e = this.log.find((l) => l.id === c.id);
    if (e) {
      e.endedAt = Math.round(this.time);
      e.outcome = outcome;
      e.detail = detail;
    }
    events.emit('crime:end', { id: c.id, type: c.type, outcome, x: c.x, z: c.z });
    events.emit('police:scanner', { text: `${c.label}: ${outcome === 'stopped' ? 'suspects subdued and restrained — the vigilante again' : outcome === 'police' ? 'suspects in custody' : outcome === 'failed' ? 'casualties reported, suspects gone' : 'suspects escaped'}`, priority: false });
  }

  private headline(c: Crime, o: Outcome): string {
    const where = c.type === 'bankRobbery' ? 'Brightwater Savings' : c.warehouse ? c.warehouse.name : DISTRICT_NAMES[c.district];
    const g = GANGS[c.gang].name;
    const name = CRIME_DEFS[c.type].name.toLowerCase();
    if (o === 'stopped') {
      const lines: Record<CrimeType, string> = {
        mugging: `Masked vigilante stops a mugging in ${where}`,
        carTheft: `Car thief caught red-handed in ${where} — left tied up for police`,
        shopRobbery: `Shop robbery in ${where} foiled by the Nightwarden`,
        bankRobbery: `Nightwarden foils armed raid on Brightwater Savings — ${g} gunmen left for police`,
        streetFight: `Street brawl in ${where} broken up by the Nightwarden`,
        hostage: `Hostages freed at ${where} — witnesses describe a caped figure`,
        getaway: `Getaway car stopped in ${where}; the Nightwarden strikes again`,
        deal: `${g} deal at ${where} busted by the vigilante`,
        arson: `Arsonists stopped in ${where} before the fire spread`,
      };
      return lines[c.type];
    }
    if (o === 'police') return `Vellmoor PD arrests ${g} suspects after ${name} in ${where}`;
    if (o === 'failed') return c.type === 'arson' ? `Shopfront gutted by fire in ${where}; ${g} suspected` : `${CRIME_DEFS[c.type].name} in ${where} leaves victims hurt`;
    return `Suspects in ${name} at ${where} still at large`;
  }

  private cleanup(c: Crime): void {
    for (const t of c.criminals) if (!t.removed) this.enemies.removeThug(t);
    for (const v of c.victims) v.actor.dispose();
    c.victims.length = 0;
    const carGone = (car: AICar) => {
      if (this.fleet.inView(car.position) && car.position.distanceTo(this.playerPos) < 150) return false;
      this.fleet.remove(car);
      return true;
    };
    if (c.car && carGone(c.car)) c.car = null;
    c.cars = c.cars.filter((car) => !carGone(car));
    if (c.fire) c.fire.target = 0;
    const i = this.active.indexOf(c);
    if (i >= 0) this.active.splice(i, 1);
  }

  // ---------------------------------------------------------------- retaliation

  private retaliation(dt: number, player: { pos: THREE.Vector3; hero: boolean; driving: boolean }): void {
    this.retaliateT -= dt;
    if (this.retaliateT > 0 || !player.hero) return;
    for (const g of GANG_IDS) {
      if (this.territory.pressure[g] < 15) continue;
      this.territory.pressure[g] -= 15;
      this.retaliateT = 120;
      if (!player.driving && this.rng.chance(0.55)) this.ambush(g, player.pos);
      else this.gangPatrol(g, player.pos);
      return;
    }
  }

  /** A crew of 4–5 comes for the hero on foot. */
  ambush(g: GangId, at: THREE.Vector3): number {
    const crew = this.enemies.makeCrew(g, 'ambush', `${GANGS[g].short} ambush`, at.x, at.z);
    const base = this.rng.range(0, Math.PI * 2);
    let n = 0;
    for (let i = 0; i < this.rng.int(4, 5); i++) {
      const a = base + (i - 2) * 0.35;
      const x = at.x + Math.cos(a) * 30;
      const z = at.z + Math.sin(a) * 30;
      const kind: ThugKind = i === 0 && this.rng.chance(GANGS[g].bruteChance) ? 'brute' : 'thug';
      const t = this.enemies.spawn(crew, x, z, kind, kind === 'brute' ? 'pipe' : this.enemies.pickWeapon(g, this.rng), i);
      if (!t) break;
      t.aware = 'combat';
      t.vsPlayer = true;
      t.lastSeen.copy(at);
      n++;
    }
    if (n) {
      events.emit('police:scanner', { text: `Reports of armed ${GANGS[g].name} members gathering in ${DISTRICT_NAMES[this.districtOf(at)]}`, priority: false });
      events.emit('gang:retaliate', { gang: g, kind: 'ambush', x: at.x, z: at.z });
      this.log.push({ id: this.nextId++, type: 'streetFight', label: `${GANGS[g].short} ambush (retaliation)`, gang: GANGS[g].name, district: DISTRICT_NAMES[this.districtOf(at)], startedAt: Math.round(this.time), clock: clock.label(), detail: 'retaliation' });
    }
    return n;
  }

  /** A gang car cruising near the hero; the crew piles out when they spot him. */
  gangPatrol(g: GangId, at: THREE.Vector3): boolean {
    const sp = this.fleet.spawnPoint(at, 120, 220, at, 100, at);
    if (!sp) return false;
    const car = this.gangCar(g, sp.x, sp.y, sp.z, sp.yaw, 8);
    if (!car) return false;
    const crew = this.enemies.makeCrew(g, 'ambush', `${GANGS[g].short} patrol`, sp.x, sp.z);
    this.fleet.driver(car).routeTo(at.clone(), 14, 25);
    this.patrols.push({ gang: g, car, crew, aboard: 3, t: 0 });
    events.emit('police:scanner', { text: `${GANGS[g].name} vehicle seen cruising ${DISTRICT_NAMES[this.districtOf(at)]}, occupants armed`, priority: false });
    events.emit('gang:retaliate', { gang: g, kind: 'patrol', x: sp.x, z: sp.z });
    return true;
  }

  private districtOf(p: THREE.Vector3): District {
    return districtAt(p.x, p.z);
  }

  private updatePatrols(dt: number, player: { pos: THREE.Vector3; hero: boolean; driving: boolean }): void {
    for (const p of [...this.patrols]) {
      p.t += dt;
      const car = p.car;
      const d = car.position.distanceTo(player.pos);
      const drv = this.fleet.driver(car);
      if (p.aboard > 0) {
        if (d < 30 && player.hero && !player.driving) {
          // Spotted: pile out.
          drv.park();
          car.driver = false;
          const f = car.forward(new THREE.Vector3());
          const left = new THREE.Vector3(f.z, 0, -f.x);
          for (let i = 0; i < p.aboard; i++) {
            const q = car.position.clone().addScaledVector(left, (i % 2 ? -1 : 1) * (car.spec.width / 2 + 0.7)).addScaledVector(f, i < 2 ? 0.4 : -1);
            const t = this.enemies.spawn(p.crew, q.x, q.z, 'thug', this.enemies.pickWeapon(p.gang, this.rng), i, { y: car.position.y });
            if (t) {
              t.aware = 'combat';
              t.vsPlayer = true;
              t.lastSeen.copy(player.pos);
            }
          }
          p.aboard = 0;
        } else if (drv.mode !== 'route' || drv.arrived) {
          const sp = this.sites.streetPoint(this.rng, player.pos, 20, 120);
          drv.routeTo(sp ? new THREE.Vector3(sp.x, 0, sp.z) : player.pos.clone(), 13, 8);
        }
      }
      if (d > 380 || p.t > 300) {
        this.enemies.removeCrew(p.crew);
        this.fleet.remove(car);
        this.patrols.splice(this.patrols.indexOf(p), 1);
      }
    }
  }

  // ---------------------------------------------------------------- visuals

  update(dt: number, cam: THREE.Vector3): void {
    for (const c of this.active) {
      for (const v of c.victims) {
        const a = v.actor;
        v.t += dt;
        if (v.state === 'free') {
          a.root.position.addScaledVector(v.dir, 3.2 * dt);
          a.root.position.y = heightAt(a.root.position.x, a.root.position.z) + 0.15;
          if (v.t > 10) a.root.visible = false;
        }
        a.update(dt, cam);
      }
    }
    const wv = new THREE.Vector3(wind.vector.x, 0, wind.vector.z);
    for (const f of [...this.fires]) {
      f.update(dt, cam, wv);
      if (f.target === 0 && f.level < 0.02 && !this.active.some((c) => c.fire === f)) {
        f.dispose();
        this.fires.splice(this.fires.indexOf(f), 1);
      }
    }
  }

  /** Map / HUD: active crimes with time left. */
  markers(): { id: number; x: number; z: number; type: CrimeType; label: string; left: number; icon: string; escape: boolean }[] {
    return this.active
      .filter((c) => c.phase !== 'over')
      .map((c) => {
        const p = c.phase === 'escape' && c.car ? c.car.position : c;
        return { id: c.id, x: p.x, z: p.z, type: c.type, label: c.label, left: Math.max(0, c.timer - c.t), icon: CRIME_DEFS[c.type].icon, escape: c.phase === 'escape' };
      });
  }

  /** Is the player standing at an active scene next to officers (Police Trust check)? */
  atScene(p: THREE.Vector3): boolean {
    for (const c of this.active) {
      if (c.phase === 'over' || Math.hypot(c.x - p.x, c.z - p.z) > 40) continue;
      if (this.enemies.thugs.some((t) => t.faction === 'vpd' && !t.ko && t.pos.distanceTo(p) < 25)) return true;
    }
    return false;
  }

  clear(): void {
    for (const c of [...this.active]) this.cleanup(c);
    for (const p of this.patrols) {
      this.enemies.removeCrew(p.crew);
      this.fleet.remove(p.car);
    }
    this.patrols.length = 0;
    for (const f of this.fires) f.dispose();
    this.fires.length = 0;
  }
}
