/**
 * Wanted level for the player's own crimes.
 *
 * Offenses add heat (more when a police officer, unit or patrol car witnessed them): hitting a
 * pedestrian with a car, stealing a car in sight of the police, attacking / knocking out an
 * officer, wrecking property. Heat thresholds give levels 1–5 (never dropping while the police
 * keep eyes on the player).
 *
 * Escaping: once the police lose sight, a search circle forms around the last known position
 * (radius grows with the level). Leave the circle — or hide on a rooftop / in an alley inside it —
 * and stay unseen through the cooldown, and the level clears. Being seen again re-centres it.
 *
 * Busted (an officer holds a slow player for 2.5 s) → precinct, fine. Knocked out → General
 * Hospital, bill. Both clear the wanted level.
 */
import * as THREE from 'three';
import { events } from '../core/EventBus';
import type { Stats } from './Stats';

const THRESH = [25, 100, 220, 400, 650];
const POINTS: Record<string, [number, number]> = {
  // [witnessed by police, unwitnessed (a bystander calls it in)]
  hitPedestrian: [35, 14],
  carTheft: [60, 0],
  attackOfficer: [45, 45],
  koOfficer: [110, 110],
  property: [16, 3],
  resist: [40, 40],
};

export class Wanted {
  heat = 0;
  level = 0;
  seen = false;
  /** Seconds since the police last saw the player. */
  unseenT = 0;
  readonly center = new THREE.Vector3();
  radius = 0;
  /** Escape cooldown progress (s) and its target. */
  cool = 0;
  get coolTarget(): number {
    return 6 + this.level * 3.5;
  }
  /** Seconds the police still get radio reports of the player's position (after an offense). */
  reportT = 0;
  /** Pending respawn after busted / KO. */
  respawn: { where: 'hospital' | 'precinct'; fine: number; t: number } | null = null;

  constructor(private readonly stats: Stats) {
    events.on('player:busted', () => {
      if (this.respawn) return;
      const fine = Math.max(150, Math.round(this.stats.money * 0.1));
      this.respawn = { where: 'precinct', fine, t: 2.2 };
      this.stats.busted++;
      this.stats.change({ money: -fine, trust: -4, reputation: -3 }, 'busted');
      events.emit('news', { text: `Masked vigilante taken into custody by Vellmoor PD — released after paying a $${fine} fine` });
    });
    events.on('player:ko', () => {
      if (this.respawn) return;
      const fine = 300;
      this.respawn = { where: 'hospital', fine, t: 3.2 };
      this.stats.hospital++;
      this.stats.change({ money: -fine }, 'hospital');
    });
  }

  /** The police still know where the player is (seen, or lost only moments ago). */
  get known(): boolean {
    return this.level > 0 && (this.seen || this.unseenT < 4);
  }

  get searching(): boolean {
    return this.level > 0 && !this.seen && this.unseenT > 1.5;
  }

  /** A crime by the player; `witnessed` = police saw it. */
  offense(kind: string, x: number, z: number, witnessed: boolean): void {
    const pts = POINTS[kind] ?? [10, 0];
    const add = witnessed ? pts[0] : pts[1];
    if (add <= 0) return;
    this.heat = Math.min(900, this.heat + add);
    this.stats.change({ trust: -(witnessed ? Math.ceil(add / 12) : 1) }, kind);
    const before = this.level;
    let L = 0;
    for (let i = 0; i < THRESH.length; i++) if (this.heat >= THRESH[i]) L = i + 1;
    this.reportT = Math.max(this.reportT, witnessed ? 12 : 6);
    if (L > this.level) {
      this.level = L;
      if (witnessed || before === 0) {
        this.center.set(x, 0, z);
        this.unseenT = 0;
      }
      this.cool = 0;
      events.emit('wanted:change', { level: L, reason: kind });
      const msg: Record<string, string> = {
        hitPedestrian: 'pedestrian struck by a vehicle, driver fled',
        carTheft: 'vehicle theft in progress',
        attackOfficer: 'officer assaulted by a masked suspect',
        koOfficer: 'officer down, suspect at large',
        property: 'reckless driving, property damage',
        resist: 'suspect resisting arrest',
      };
      events.emit('police:scanner', { text: `All units: ${msg[kind] ?? 'disturbance'} — wanted level ${L}`, priority: true });
    }
  }

  /** Raise straight to a level (tests / debug). */
  setLevel(L: number, x: number, z: number): void {
    this.level = Math.max(0, Math.min(5, L));
    this.heat = L > 0 ? THRESH[L - 1] : 0;
    this.center.set(x, 0, z);
    this.unseenT = 0;
    this.cool = 0;
    this.reportT = L > 0 ? 12 : 0;
    events.emit('wanted:change', { level: this.level, reason: 'debug' });
  }

  /** Per step: `seenNow` from the police; `hidden` = rooftop / alley. */
  update(dt: number, player: THREE.Vector3, seenNow: boolean, hidden: boolean): void {
    if (this.respawn) {
      this.respawn.t -= dt;
      return;
    }
    if (this.level <= 0) {
      this.seen = false;
      this.heat = Math.max(0, this.heat - dt * 2);
      return;
    }
    this.radius = 60 + this.level * 28;
    this.reportT = Math.max(0, this.reportT - dt);
    if (seenNow || this.reportT > 0) {
      this.seen = true;
      this.unseenT = 0;
      this.cool = 0;
      this.center.copy(player);
      return;
    }
    this.seen = false;
    this.unseenT += dt;
    // The search drifts slowly towards where they think the suspect went.
    const out = Math.hypot(player.x - this.center.x, player.z - this.center.z) > this.radius;
    if (out || hidden) this.cool += dt * (hidden && !out ? 0.7 : 1);
    else this.cool = Math.max(0, this.cool - dt * 0.5);
    if (this.cool >= this.coolTarget) this.clear('escaped');
  }

  clear(reason: string): void {
    if (this.level === 0) return;
    const was = this.level;
    this.level = 0;
    this.heat = 0;
    this.cool = 0;
    this.seen = false;
    events.emit('wanted:change', { level: 0, reason });
    if (reason === 'escaped') {
      events.emit('police:scanner', { text: 'All units: suspect lost, resume patrol', priority: false });
      if (was >= 3) events.emit('news', { text: 'Police pursuit across Port Vellmoor ends without an arrest' });
    }
  }

  /** Take a respawn that is due. */
  takeRespawn(): { where: 'hospital' | 'precinct'; fine: number } | null {
    if (!this.respawn || this.respawn.t > 0) return null;
    const r = this.respawn;
    this.respawn = null;
    this.clear('respawn');
    events.emit('player:respawn', { where: r.where, fine: r.fine });
    return r;
  }
}
