/**
 * Vellmoor Police Department (VPD): patrol units (Interceptor sedans, two officers), tactical
 * units (Bastion armoured vans, four tactical officers), roadblocks with spike strips and up to
 * two helicopters.
 *
 * Units are AICars (physics + instanced rendering) with a Driver; officers are Enemies fighters of
 * the 'vpd' faction, spawned at the doors when a unit dismounts and removed when they re-board.
 *
 * Jobs
 *  - crime:    drive to the scene with lights and siren, stop short, dismount, fight criminals
 *              (Enemies NPC-vs-NPC), then collect the knocked-out / tied criminals and leave.
 *  - chase:    pursue a getaway car (PIT / box / ram), dismount when it stops.
 *  - wanted:   hunt the player: pursuit tactics by wanted level when the player drives, drive up
 *              and dismount to arrest / fight on foot; search the circle when the player is lost.
 *  - leave:    officers re-board, the car drives off and despawns out of sight.
 * Wanted levels: 1 two patrols · 2 four · 3 five + roadblocks · 4 + tactical van and helicopter ·
 * 5 + second tactical team and second helicopter.
 */
import * as THREE from 'three';
import { events } from '../core/EventBus';
import { Rng } from '../core/Random';
import { physics, GROUPS_PROBE } from '../core/Physics';
import { SPECS } from '../vehicles/VehicleModels';
import type { AICar } from '../vehicles/AICar';
import type { Fleet } from '../vehicles/Fleet';
import type { VehicleSim } from '../vehicles/VehicleSim';
import type { Enemies, Thug, Crew } from '../ai/Enemies';
import type { Driver, Tactic } from '../ai/Driver';
import type { Lane } from '../ai/LaneGraph';
import { Helicopter } from './Helicopter';
import { heightAt } from '../world/Terrain';
import { clock } from '../systems/Clock';

export interface WantedView {
  level: number;
  /** The police currently see the player. */
  seen: boolean;
  /** Search circle (last known position). */
  center: THREE.Vector3;
  radius: number;
}

export interface PlayerInfo {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  driving: boolean;
  car: VehicleSim | null;
}

export interface CrimeScene {
  id: number;
  x: number;
  z: number;
  label: string;
  active: boolean;
}

type Job = { k: 'crime'; scene: CrimeScene } | { k: 'chase'; car: AICar; scene: CrimeScene | null } | { k: 'wanted' } | { k: 'collect'; x: number; z: number } | { k: 'leave' } | { k: 'roadblock' };

export interface Unit {
  id: number;
  name: string;
  kind: 'patrol' | 'tactical';
  car: AICar;
  drv: Driver;
  crew: Crew;
  seats: number;
  officers: Thug[];
  job: Job;
  t: number;
  dismounted: boolean;
  /** Time since the unit was last near the player / in view (despawn). */
  idle: number;
  claims: Map<Thug, Thug>;
}

interface Roadblock {
  cars: AICar[];
  crew: Crew;
  officers: Thug[];
  strip: THREE.Mesh;
  /** Strip centre, axis across the road, half length. */
  sx: number;
  sz: number;
  ax: number;
  az: number;
  half: number;
  /** Road direction (towards the block from the player's side). */
  dx: number;
  dz: number;
  cx: number;
  cz: number;
  age: number;
  hit: Set<VehicleSim>;
}

const CALLSIGNS = ['Adam', 'Bravo', 'Harbor', 'Kestrel', 'Lantern', 'Mercy', 'Nightjar', 'Ocean', 'Quarry', 'Rook', 'Tarn', 'Vale'];
const NAVY = new THREE.Color(0.02, 0.035, 0.09);
const SLATE = new THREE.Color(0.07, 0.075, 0.08);

export class Police {
  readonly units: Unit[] = [];
  readonly roadblocks: Roadblock[] = [];
  readonly helis: Helicopter[];
  readonly group = new THREE.Group();
  private rng = new Rng(0x9011ce);
  private nextId = 1;
  private spawnT = 0;
  private roadblockT = 10;
  private time = 0;
  private stripMat: THREE.MeshStandardMaterial;
  private spikeMat: THREE.MeshStandardMaterial;
  /** Seen by a car / helicopter this frame (officers report through Enemies.sees). */
  seenBy: 'officer' | 'car' | 'heli' | null = null;
  private losIdx = 0;
  /** Count of arrests of criminals (stats). */
  collected = 0;

  constructor(
    scene: THREE.Scene,
    private readonly fleet: Fleet,
    private readonly enemies: Enemies,
  ) {
    this.group.name = 'Police';
    scene.add(this.group);
    this.helis = [new Helicopter(0, scene), new Helicopter(1, scene)];
    // Spike strip: a yellow hinged carrier with two rows of steel spikes (built per length).
    this.stripMat = new THREE.MeshStandardMaterial({ color: 0xd8a920, metalness: 0.2, roughness: 0.55 });
    this.spikeMat = new THREE.MeshStandardMaterial({ color: 0x9ea3a8, metalness: 0.9, roughness: 0.3 });
  }

  // ---------------------------------------------------------------- units

  private spawnUnit(kind: 'patrol' | 'tactical', near: THREE.Vector3, player: THREE.Vector3, job: Job, minD = 130, maxD = 260): Unit | null {
    if (this.fleet.full) return null;
    const far = Math.hypot(near.x - player.x, near.z - player.z) > 280;
    const sp = this.fleet.spawnPoint(near, far ? 60 : minD, far ? 160 : maxD, player, 70, near);
    if (!sp) return null;
    const spec = kind === 'tactical' ? SPECS.tactical : SPECS.police;
    const car = this.fleet.add(spec, (kind === 'tactical' ? SLATE : NAVY).clone(), sp.x, sp.y, sp.z, sp.yaw, 9);
    car.siren = true;
    const id = this.nextId++;
    const name = `${1 + (id % 9)}-${CALLSIGNS[id % CALLSIGNS.length]}`;
    const crew = this.enemies.makeCrew('vpd', 'police', name, sp.x, sp.z);
    const u: Unit = { id, name, kind, car, drv: this.fleet.driver(car), crew, seats: kind === 'tactical' ? 4 : 2, officers: [], job, t: 0, dismounted: false, idle: 0, claims: new Map() };
    this.units.push(u);
    return u;
  }

  /** Send units to a crime scene. */
  respond(scene: CrimeScene, patrols: number, tactical: number, player: THREE.Vector3): Unit[] {
    const out: Unit[] = [];
    const at = new THREE.Vector3(scene.x, 0, scene.z);
    for (let i = 0; i < patrols + tactical; i++) {
      const u = this.spawnUnit(i < patrols ? 'patrol' : 'tactical', at, player, { k: 'crime', scene });
      if (!u) break;
      u.drv.routeTo(at, 22, 16 + i * 4);
      out.push(u);
    }
    if (out.length) events.emit('police:scanner', { text: `Dispatch: ${out.map((u) => u.name).join(', ')} responding to ${scene.label}`, priority: false });
    return out;
  }

  /** Units pursue a getaway car. */
  chase(target: AICar, scene: CrimeScene | null, n: number, player: THREE.Vector3): Unit[] {
    const out: Unit[] = [];
    // Units already at the scene join in.
    for (const u of this.units) {
      if (out.length >= n) break;
      if (u.job.k === 'crime' && scene && u.job.scene === scene) {
        this.board(u);
        u.job = { k: 'chase', car: target, scene };
        out.push(u);
      }
    }
    while (out.length < n) {
      const u = this.spawnUnit('patrol', target.position, player, { k: 'chase', car: target, scene }, 90, 200);
      if (!u) break;
      out.push(u);
    }
    return out;
  }

  /** Officers back into their car (removed from the world). */
  private board(u: Unit): void {
    for (const o of u.officers) if (!o.ko) this.enemies.removeThug(o);
    u.officers = u.officers.filter((o) => o.ko && !o.removed);
    u.dismounted = false;
    u.car.driver = true;
  }

  /** Officers out at the doors, running to `to`. */
  private dismount(u: Unit, to: THREE.Vector3 | null): void {
    if (u.dismounted) return;
    u.dismounted = true;
    const c = u.car;
    const f = c.forward(new THREE.Vector3());
    const left = new THREE.Vector3(f.z, 0, -f.x);
    const live = u.seats;
    for (let i = 0; i < live; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const p = c.position.clone().addScaledVector(left, side * (c.spec.width / 2 + 0.7)).addScaledVector(f, i < 2 ? 0.3 : -1.2);
      const o = this.enemies.spawn(u.crew, p.x, p.z, u.kind === 'tactical' ? 'tactical' : 'officer', 'pistol', i, { y: c.position.y });
      if (!o) continue;
      if (to) {
        const spread = new THREE.Vector3((i - live / 2) * 2.2, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw);
        o.goto = to.clone().add(spread);
        o.gotoRun = true;
      }
      u.officers.push(o);
    }
    c.driver = false;
    u.drv.park();
  }

  private removeUnit(u: Unit): void {
    for (const o of u.officers) this.enemies.removeThug(o);
    this.fleet.remove(u.car);
    this.units.splice(this.units.indexOf(u), 1);
  }

  // ---------------------------------------------------------------- per step

  /** Fixed-rate AI (before physics). */
  fixedUpdate(dt: number, player: PlayerInfo, wanted: WantedView): void {
    this.time += dt;
    this.manageWanted(dt, player, wanted);
    for (const u of [...this.units]) this.runUnit(u, dt, player, wanted);
    this.updateRoadblocks(dt, player, wanted);
    this.seenBy = this.detect(player, wanted);
  }

  /** Visual-rate update (helicopters). */
  update(dt: number, player: PlayerInfo, wanted: WantedView): void {
    const night = clock.night;
    for (const h of this.helis) {
      const seen = wanted.seen || this.helis.some((x) => x.sees(player.pos));
      h.update(dt, seen ? player.pos : wanted.center, seen ? player.pos.clone() : null, night);
    }
  }

  private manageWanted(dt: number, player: PlayerInfo, wanted: WantedView): void {
    const L = wanted.level;
    const want = [0, 2, 4, 5, 5, 6][Math.min(5, L)];
    const wantTac = L >= 5 ? 2 : L >= 4 ? 1 : 0;
    const mine = this.units.filter((u) => u.job.k === 'wanted');
    // Spawn reinforcements gradually.
    this.spawnT -= dt;
    if (L > 0 && this.spawnT <= 0) {
      this.spawnT = 3;
      const pat = mine.filter((u) => u.kind === 'patrol').length;
      const tac = mine.filter((u) => u.kind === 'tactical').length;
      // Units on crime jobs nearby join the hunt first.
      const join = this.units.find((u) => u.job.k === 'crime' && u.car.position.distanceTo(player.pos) < 200);
      if (pat < want && join) {
        join.job = { k: 'wanted' };
      } else if (pat < want) {
        const u = this.spawnUnit('patrol', player.pos, player.pos, { k: 'wanted' });
        if (u) events.emit('police:scanner', { text: `Unit ${u.name} joining the pursuit`, priority: false });
      } else if (tac < wantTac) {
        const u = this.spawnUnit('tactical', player.pos, player.pos, { k: 'wanted' }, 150, 280);
        if (u) events.emit('police:scanner', { text: `Tactical unit ${u.name} en route`, priority: true });
      }
    }
    // Too many units for the level: send the extras away.
    if (mine.length > want + wantTac) for (const u of mine.slice(want + wantTac)) u.job = { k: 'leave' };
    if (L === 0) for (const u of mine) u.job = { k: 'leave' };
    // Helicopters.
    const edge = player.pos.clone().add(new THREE.Vector3(Math.sin(this.time) * 420, 0, Math.cos(this.time) * 420));
    if (L >= 4) this.helis[0].activate(edge, player.pos);
    else this.helis[0].leave();
    if (L >= 5) this.helis[1].activate(edge.clone().add(new THREE.Vector3(60, 0, 0)), player.pos);
    else this.helis[1].leave();
    // Roadblocks at level 3+ while the player drives.
    this.roadblockT -= dt;
    if (L >= 3 && player.driving && this.roadblockT <= 0 && this.roadblocks.length < 2) {
      this.roadblockT = 30;
      this.buildRoadblock(player);
    }
  }

  private runUnit(u: Unit, dt: number, player: PlayerInfo, wanted: WantedView): void {
    u.t += dt;
    const c = u.car;
    const dPlayer = c.position.distanceTo(player.pos);
    u.idle = dPlayer > 160 && !this.fleet.inView(c.position) ? u.idle + dt : 0;
    u.officers = u.officers.filter((o) => !o.removed);
    const up = u.officers.filter((o) => !o.ko);
    switch (u.job.k) {
      case 'crime': {
        const sc = u.job.scene;
        c.siren = true;
        if (!sc.active) {
          u.job = { k: 'collect', x: sc.x, z: sc.z };
          u.t = 0;
          break;
        }
        if (!u.dismounted && (u.drv.arrived || u.drv.mode === 'park')) this.dismount(u, new THREE.Vector3(sc.x, 0, sc.z));
        break;
      }
      case 'chase': {
        const tgt = u.job.car;
        c.siren = true;
        const gone = !this.fleet.cars.includes(tgt);
        const stopped = gone || tgt.disabled || !tgt.driver;
        if (stopped) {
          if (!u.dismounted) {
            if (gone || c.position.distanceTo(tgt.position) < 30) this.dismount(u, gone ? null : tgt.position.clone());
            else u.drv.routeTo(tgt.position.clone(), 22, 12);
          }
          if (u.job.scene && !u.job.scene.active) u.job = { k: 'collect', x: tgt.position.x, z: tgt.position.z };
          break;
        }
        if (u.dismounted) this.board(u);
        const idx = this.units.filter((x) => x.job.k === 'chase' && x.job.car === tgt).indexOf(u);
        const tactic: Tactic = (['pit', 'box', 'chase', 'ram'] as Tactic[])[idx % 4];
        u.drv.slot = idx === 1 ? 0 : 3;
        u.drv.pursue({ pos: tgt.position, vel: tgt.velocity, yaw: tgt.yaw, car: true }, tactic, 34);
        break;
      }
      case 'wanted':
        this.runWanted(u, player, wanted, up);
        break;
      case 'collect': {
        c.siren = false;
        if (!u.dismounted) {
          // Arrived by car after the fight: get out to pick up the criminals.
          const d = Math.hypot(c.position.x - u.job.x, c.position.z - u.job.z);
          if (d < 25 || u.drv.mode === 'park') {
            this.dismount(u, null);
            u.t = 0;
          }
          else if (u.drv.mode !== 'route') u.drv.routeTo(new THREE.Vector3(u.job.x, 0, u.job.z), 14, 14);
          if (u.t > 60) u.job = { k: 'leave' };
          break;
        }
        // Each officer kneels by a downed criminal for a moment, then the criminal is taken away.
        const jx = u.job.x;
        const jz = u.job.z;
        let busy = false;
        for (const o of up) {
          let crim = u.claims.get(o);
          if (crim && crim.removed) {
            u.claims.delete(o);
            crim = undefined;
          }
          if (!crim) {
            const taken = new Set(u.claims.values());
            crim = this.enemies.thugs.find((t) => t.criminal && t.ko && !t.removed && !taken.has(t) && Math.hypot(t.pos.x - jx, t.pos.z - jz) < 45 && !this.units.some((v) => v !== u && [...v.claims.values()].includes(t)));
            if (crim) {
              u.claims.set(o, crim);
              const p = crim.actor.bonePos('pelvis');
              o.goto = new THREE.Vector3(p.x + 0.8, 0, p.z);
              o.gotoRun = o.pos.distanceTo(p) > 10;
              o.onArrive = () => {
                o.pose = 'kneel';
                o.coverT = 2.6;
              };
            }
          }
          if (crim) {
            busy = true;
            if (o.pose === 'kneel' && o.coverT <= 0) {
              o.pose = null;
              u.claims.delete(o);
              this.collected++;
              events.emit('police:collect', { x: crim.pos.x, z: crim.pos.z, tied: crim.tied });
              this.enemies.removeThug(crim);
            }
          }
        }
        if (!busy || u.t > 50) u.job = { k: 'leave' };
        break;
      }
      case 'leave': {
        c.siren = false;
        if (u.dismounted) {
          // Walk back to the car.
          let all = true;
          for (const o of up) {
            if (o.aware === 'combat') o.aware = 'unaware';
            o.tgt = null;
            o.pose = null;
            if (o.pos.distanceTo(c.position) > 4.2) {
              all = false;
              if (!o.goto) {
                o.goto = c.position.clone();
                o.gotoRun = false;
              }
            }
          }
          if (all || u.t > 25) {
            this.board(u);
            u.t = 0;
          }
          break;
        }
        if (u.drv.mode !== 'route') {
          const sp = this.fleet.spawnPoint(c.position, 250, 420, player.pos, 200);
          u.drv.routeTo(sp ? new THREE.Vector3(sp.x, 0, sp.z) : c.position.clone().add(new THREE.Vector3(300, 0, 0)), 13, 10);
        }
        if (u.idle > 4 || dPlayer > 380 || u.drv.arrived) this.removeUnit(u);
        break;
      }
      case 'roadblock':
        break;
    }
    // A disabled, abandoned car: officers fight on, then the unit is cleaned up far away.
    if (c.disabled && dPlayer > 250 && u.idle > 6) this.removeUnit(u);
    if (u.job.k !== 'leave' && u.job.k !== 'wanted' && u.idle > 90 && dPlayer > 350) this.removeUnit(u);
  }

  private runWanted(u: Unit, player: PlayerInfo, wanted: WantedView, up: Thug[]): void {
    const c = u.car;
    c.siren = true;
    const known = wanted.seen;
    const target = known ? player.pos : wanted.center;
    const d = c.position.distanceTo(target);
    if (player.driving) {
      // Re-board when the player drives off.
      if (u.dismounted) {
        let all = true;
        for (const o of up) {
          if (o.pos.distanceTo(c.position) > 4.2) {
            all = false;
            o.goto = c.position.clone();
            o.gotoRun = true;
          }
        }
        if (all || u.t > 12) {
          this.board(u);
          u.t = 0;
        }
        return;
      }
      if (known) {
        const L = wanted.level;
        const ws = this.units.filter((x) => x.job.k === 'wanted' && !x.dismounted);
        const idx = ws.indexOf(u);
        let tactic: Tactic = 'chase';
        if (u.kind === 'tactical') tactic = 'ram';
        else if (L >= 3) tactic = (['pit', 'box', 'box', 'ram', 'chase'] as Tactic[])[idx % 5];
        else if (L >= 2) tactic = idx % 2 === 1 ? 'pit' : 'chase';
        u.drv.slot = idx % 2 === 1 ? 0 : 3;
        u.drv.pursue({ pos: player.pos, vel: player.vel, yaw: player.yaw, car: true }, tactic, u.kind === 'tactical' ? 30 : 36);
      } else this.search(u, wanted);
      return;
    }
    // Player on foot.
    if (!u.dismounted) {
      if (known && d < 60) {
        u.drv.pursue({ pos: player.pos, vel: player.vel, yaw: player.yaw, car: false }, 'chase', 22);
        if (u.drv.arrived || d < 12) this.dismount(u, player.pos.clone());
      } else if (known) u.drv.pursue({ pos: player.pos, vel: player.vel, yaw: player.yaw, car: false }, 'chase', 26);
      else this.search(u, wanted);
      return;
    }
    // On foot: officers hunt (Enemies handles the arrest / fight); search when lost.
    if (!known) {
      for (const [i, o] of up.entries()) {
        if (o.sees) continue;
        if (o.aware === 'combat' && o.tgt === null) o.aware = 'unaware';
        if (!o.goto || o.goto.distanceTo(o.pos) < 1.5) {
          const a = this.rng.range(0, Math.PI * 2);
          const r = this.rng.range(0, wanted.radius * 0.6);
          o.goto = new THREE.Vector3(wanted.center.x + Math.cos(a + i) * r, 0, wanted.center.z + Math.sin(a + i) * r);
          o.gotoRun = true;
        }
      }
      // Far from the search: get back in.
      if (up.every((o) => o.pos.distanceTo(wanted.center) > wanted.radius + 40)) this.board(u);
    } else {
      // Radio: everyone knows where the suspect is.
      for (const o of up) {
        o.goto = null;
        if (o.aware !== 'combat' || (!o.vsPlayer && !o.tgt)) {
          o.vsPlayer = true;
          o.aware = 'combat';
          o.tgt = null;
          o.lastSeen.copy(player.pos);
        }
      }
    }
  }

  private search(u: Unit, wanted: WantedView): void {
    const drv = u.drv;
    if (drv.mode !== 'route' || drv.arrived || (drv.goal && drv.goal.distanceTo(wanted.center) > wanted.radius * 1.4)) {
      const a = this.rng.range(0, Math.PI * 2);
      const r = this.rng.range(0, wanted.radius * 0.8);
      drv.routeTo(new THREE.Vector3(wanted.center.x + Math.cos(a) * r, 0, wanted.center.z + Math.sin(a) * r), 16, 12);
    }
  }

  // ---------------------------------------------------------------- detection

  /** Do the police see the player? (officers' own perception, unit cars, helicopters). */
  private detect(player: PlayerInfo, wanted: WantedView): 'officer' | 'car' | 'heli' | null {
    if (wanted.level <= 0) return null;
    for (const t of this.enemies.thugs) if (t.faction === 'vpd' && !t.ko && t.sees) return 'officer';
    for (const h of this.helis) if (h.sees(player.pos)) return 'heli';
    // Cars: two line-of-sight rays per step, round robin.
    const cars = this.units.filter((u) => !u.dismounted && !u.car.disabled).map((u) => u.car);
    for (let k = 0; k < Math.min(2, cars.length); k++) {
      const c = cars[(this.losIdx++ + k) % cars.length];
      if (this.canSee(c.position, player.pos, player.driving ? 70 : 45)) return 'car';
    }
    return this.seenBy === 'car' && cars.some((c) => c.position.distanceTo(player.pos) < 25) ? 'car' : null;
  }

  private canSee(from: THREE.Vector3, to: THREE.Vector3, range: number): boolean {
    const d = from.distanceTo(to);
    if (d > range) return false;
    const eye = from.clone().setY(from.y + 1.4);
    const dir = to.clone().setY(to.y + 1.2).sub(eye);
    const len = dir.length();
    return !physics.rayHit(eye, dir.normalize(), len - 0.8, GROUPS_PROBE);
  }

  /** Could the police see something happen at p? (offense witnesses, incl. patrol cars in traffic). */
  witness(p: THREE.Vector3, trafficPolice: { x: number; y: number; z: number }[]): boolean {
    for (const t of this.enemies.thugs) if (t.faction === 'vpd' && !t.ko && this.canSee(t.pos, p, 45)) return true;
    for (const u of this.units) if (this.canSee(u.car.position, p, 60)) return true;
    for (const c of trafficPolice) if (this.canSee(new THREE.Vector3(c.x, c.y, c.z), p, 55)) return true;
    return this.helis.some((h) => h.active && h.pos.distanceTo(p) < 120);
  }

  // ---------------------------------------------------------------- roadblocks

  private buildRoadblock(player: PlayerInfo): void {
    if (this.fleet.cars.length > 11) return;
    // The lane the player drives on, then follow straight-ish connections ~170 m ahead.
    const p = player.pos;
    const f = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
    let lane: Lane | null = null;
    let bd = 20;
    for (const l of this.fleet.graph.lanesNear(p.x, p.z, 40)) {
      if (l.dirX * f.x + l.dirZ * f.z < 0.6) continue;
      const along = (p.x - l.xs[0]) * l.dirX + (p.z - l.zs[0]) * l.dirZ;
      if (along < -5 || along > l.length + 5) continue;
      const lat = Math.abs((p.x - l.xs[0]) * -l.dirZ + (p.z - l.zs[0]) * l.dirX);
      if (lat < bd) {
        bd = lat;
        lane = l;
      }
    }
    if (!lane) return;
    let dist = lane.length - ((p.x - lane.xs[0]) * lane.dirX + (p.z - lane.zs[0]) * lane.dirZ);
    let cur: Lane = lane;
    while (dist < 150) {
      const nx = cur.next.find((c) => c.turn === 'straight') ?? cur.next.find((c) => c.turn !== 'uturn');
      if (!nx) return;
      cur = nx.to;
      if (dist + cur.length > 150 && cur.length > 30) break;
      dist += cur.length + nx.length;
    }
    if (cur.length < 30) return;
    const q = { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
    cur.sample(Math.min(cur.length - 12, Math.max(18, 150 - dist)), q);
    const dx = q.dx;
    const dz = q.dz;
    const rx = -dz;
    const rz = dx; // right of travel
    const W = cur.road.width;
    // Road centre line.
    const cx = q.x - rx * cur.offset;
    const cz = q.z - rz * cur.offset;
    if (Math.hypot(cx - p.x, cz - p.z) < 90) return;
    const crew = this.enemies.makeCrew('vpd', 'police', 'Roadblock', cx, cz);
    const cars: AICar[] = [];
    for (const side of [1, -1]) {
      const x = cx + rx * side * W * 0.22;
      const z = cz + rz * side * W * 0.22;
      const yaw = Math.atan2(dx, dz) + Math.PI / 2 + side * 0.35;
      const car = this.fleet.add(SPECS.police, NAVY.clone(), x, heightAt(x, z), z, yaw, 0);
      car.driver = false;
      car.siren = true;
      cars.push(car);
    }
    // Spike strip across the player's half of the road, 14 m before the cars.
    const sx = cx + rx * W * 0.25 - dx * 14;
    const sz = cz + rz * W * 0.25 - dz * 14;
    const half = W * 0.27;
    const len = half * 2;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, 0.42), this.stripMat);
    strip.position.set(sx, heightAt(sx, sz) + 0.02, sz);
    strip.rotation.y = Math.atan2(rx, rz) + Math.PI / 2;
    strip.receiveShadow = true;
    strip.castShadow = true;
    const parts: THREE.BufferGeometry[] = [];
    const n = Math.floor(len / 0.3);
    for (let i = 0; i < n * 2; i++) {
      const sp = new THREE.ConeGeometry(0.018, 0.08, 4).toNonIndexed();
      sp.translate(-len / 2 + 0.15 + (i >> 1) * 0.3, 0.06, (i % 2) * 0.2 - 0.1);
      parts.push(sp);
    }
    strip.add(new THREE.Mesh(mergeSimple(parts), this.spikeMat));
    this.group.add(strip);
    const officers: Thug[] = [];
    for (const side of [1, -1]) {
      const x = cx + rx * side * W * 0.3 + dx * 3.2;
      const z = cz + rz * side * W * 0.3 + dz * 3.2;
      const o = this.enemies.spawn(crew, x, z, 'officer', 'pistol', 0);
      if (o) {
        o.focus = new THREE.Vector3(cx - dx * 30, 0, cz - dz * 30);
        officers.push(o);
      }
    }
    this.roadblocks.push({ cars, crew, officers, strip, sx, sz, ax: rx, az: rz, half, dx, dz, cx, cz, age: 0, hit: new Set() });
    events.emit('police:scanner', { text: 'All units: roadblock set up, spike strip deployed', priority: true });
  }

  /** Test / screenshot hook: build a roadblock ahead of the player now. */
  forceRoadblock(player: PlayerInfo): boolean {
    const n = this.roadblocks.length;
    this.buildRoadblock(player);
    return this.roadblocks.length > n;
  }

  private updateRoadblocks(dt: number, player: PlayerInfo, wanted: WantedView): void {
    for (const rb of [...this.roadblocks]) {
      rb.age += dt;
      // Spike strip: any car crossing it (player or AI).
      const sims: VehicleSim[] = [];
      if (player.car) sims.push(player.car);
      for (const c of this.fleet.cars) if (!c.police) sims.push(c.sim);
      for (const s of sims) {
        if (rb.hit.has(s)) continue;
        const px = s.curPos.x - rb.sx;
        const pz = s.curPos.z - rb.sz;
        const across = px * rb.ax + pz * rb.az;
        const along = px * rb.dx + pz * rb.dz;
        if (Math.abs(across) < rb.half + 0.6 && Math.abs(along) < s.spec.length / 2) {
          rb.hit.add(s);
          // Front and rear tyres shredded.
          s.puncture();
          s.puncture();
          events.emit('police:spikes', { x: rb.sx, z: rb.sz, player: s === player.car });
        }
      }
      const passed = (player.pos.x - rb.cx) * rb.dx + (player.pos.z - rb.cz) * rb.dz > 40;
      const far = Math.hypot(player.pos.x - rb.cx, player.pos.z - rb.cz);
      if ((passed && far > 150) || far > 420 || wanted.level < 3 || rb.age > 150) {
        for (const c of rb.cars) this.fleet.remove(c);
        this.enemies.removeCrew(rb.crew);
        rb.strip.removeFromParent();
        rb.strip.geometry.dispose();
        this.roadblocks.splice(this.roadblocks.indexOf(rb), 1);
      }
    }
  }

  /** Remove every unit, roadblock and helicopter (respawn / tests). */
  clear(): void {
    for (const u of [...this.units]) this.removeUnit(u);
    for (const rb of [...this.roadblocks]) {
      for (const c of rb.cars) this.fleet.remove(c);
      this.enemies.removeCrew(rb.crew);
      rb.strip.removeFromParent();
    }
    this.roadblocks.length = 0;
    for (const h of this.helis) h.deactivate();
  }

  /** Map markers: unit cars, officers on foot, helicopters. */
  markers(): { x: number; z: number; kind: 'police' | 'heli' }[] {
    const out: { x: number; z: number; kind: 'police' | 'heli' }[] = [];
    for (const u of this.units) out.push({ x: u.car.position.x, z: u.car.position.z, kind: 'police' });
    for (const rb of this.roadblocks) for (const c of rb.cars) out.push({ x: c.position.x, z: c.position.z, kind: 'police' });
    for (const h of this.helis) if (h.active) out.push({ x: h.pos.x, z: h.pos.z, kind: 'heli' });
    return out;
  }

  /** Positions of cars with sirens on (audio). */
  sirens(): THREE.Vector3[] {
    return this.units.filter((u) => u.car.siren && !u.car.disabled && u.car.driver).map((u) => u.car.position);
  }
}

function mergeSimple(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    o += p.getAttribute('position').count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}
