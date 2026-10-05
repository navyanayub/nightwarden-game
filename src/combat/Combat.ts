/**
 * Freeflow combat for the player.
 *
 * - Left mouse: strike. The target is the thug best matching the input direction (or the
 *   camera direction) within 8 m; the hero motion-warps to striking distance and the hit lands
 *   mid-swing. Strikes alternate jab / cross with variations as the combo grows.
 * - Q: counter an attacker showing the warning icon (red = unblockable → dodge with Space).
 * - C: cape stun (hero) — dazes everyone in front and breaks riot-shield guards.
 * - F: finisher on a stunned / staggered thug once the combo reaches 5 (instant knockout).
 * - Tab: gadget wheel (time slows while open; 1/2/3 or mouse to choose), R: use gadget:
 *     smoke pellet (thugs lose track), stun darts (aimed), disarm grapple (yanks weapons
 *     and riot shields away).
 * - The last knockout of a fight triggers a short slow-motion beat; `timeScale` is applied
 *   by the game loop. Knockouts are non-lethal.
 */
import * as THREE from 'three';
import { events } from '../core/EventBus';
import type { Input } from '../core/Input';
import type { Player } from '../player/Player';
import type { Enemies, Thug } from '../ai/Enemies';

export type Gadget = 'smoke' | 'dart' | 'disarm';
export const GADGETS: { id: Gadget; name: string }[] = [
  { id: 'smoke', name: 'Smoke pellet' },
  { id: 'dart', name: 'Stun darts' },
  { id: 'disarm', name: 'Disarm grapple' },
];

interface PendingHit {
  thug: Thug;
  t: number;
  dmg: number;
  kind: 'strike' | 'counter' | 'finisher';
}

export class Combat {
  combo = 0;
  private comboT = 0;
  private lastFinisherCombo = 0;
  best = 0;
  gadget: Gadget = 'smoke';
  wheelOpen = false;
  private wheelAcc = new THREE.Vector2();
  timeScale = 1;
  private slowT = 0;
  private strikeLock = 0;
  private strikeN = 0;
  private pending: PendingHit[] = [];
  private gadgetCd = 0;
  private capeCd = 0;
  lastTarget: Thug | null = null;
  readonly fx: CombatFX;
  /** Free-aim target for darts / disarm (closest thug to the screen centre). */
  aimTarget: Thug | null = null;

  constructor(
    private readonly enemies: Enemies,
    private readonly player: Player,
    scene: THREE.Scene,
  ) {
    this.fx = new CombatFX();
    scene.add(this.fx.group);
    events.on('combat:ko', (k) => {
      if (k.last) this.slowMo(0.9, 0.28);
    });
    events.on('combat:hit', (h) => this.fx.impact(new THREE.Vector3(h.x, h.y, h.z), h.strength, !!h.blocked));
    events.on('player:land', (l) => {
      if (!l.dive) return;
      const p = new THREE.Vector3(l.x, l.y, l.z);
      const hit = this.enemies.stunAround(l.x, l.z, 5, 0, p, 'dive');
      this.fx.shock(p);
      if (hit.length) this.addCombo(hit.length);
    });
    events.on('player:hurt', () => {
      this.combo = 0;
      this.lastFinisherCombo = 0;
    });
  }

  get inCombat(): boolean {
    return this.enemies.inCombat;
  }

  get finisherReady(): boolean {
    return this.combo - this.lastFinisherCombo >= 5;
  }

  slowMo(realSecs: number, scale: number): void {
    this.slowT = Math.max(this.slowT, realSecs);
    this.timeScale = scale;
  }

  private addCombo(n = 1): void {
    this.combo += n;
    this.comboT = 0;
    this.best = Math.max(this.best, this.combo);
  }

  /** Input + combat logic, once per fixed step (dt = simulated time). */
  fixedUpdate(dt: number, input: Input, camFwd: THREE.Vector3, camRight: THREE.Vector3): void {
    const p = this.player;
    this.strikeLock = Math.max(0, this.strikeLock - dt);
    this.gadgetCd = Math.max(0, this.gadgetCd - dt);
    this.capeCd = Math.max(0, this.capeCd - dt);
    this.comboT += dt;
    if (this.comboT > 3.2 && this.combo > 0) {
      this.combo = 0;
      this.lastFinisherCombo = 0;
    }
    // Scheduled hits (land mid-swing, after the warp).
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const h = this.pending[i];
      h.t -= dt;
      if (h.t > 0) continue;
      this.pending.splice(i, 1);
      if (h.thug.ko) continue;
      const d = h.thug.pos.distanceTo(p.position);
      if (d > 2.4 && h.kind !== 'finisher') continue;
      const res = this.enemies.damage(h.thug, h.dmg, p.position, { kind: h.kind, stun: h.kind === 'counter' ? 0.6 : undefined });
      if (res === 'blocked') {
        p.playOnce('Hit_Chest', 1.4, 0.05);
        this.strikeLock = 0.45;
      } else this.addCombo();
    }
    if (p.driving || p.state === 'ragdoll' || p.state === 'glide' || p.state === 'grapple' || p.state === 'hang' || p.state === 'climb') {
      input.consume('attack');
      input.consume('counter');
      input.consume('capeStun');
      input.consume('finisher');
      return;
    }
    // Input direction (camera relative).
    const dir = new THREE.Vector3().addScaledVector(camFwd, input.moveY).addScaledVector(camRight, input.moveX);
    const hasDir = dir.lengthSq() > 0.04;
    if (hasDir) dir.normalize();
    else dir.copy(camFwd);
    if (input.consume('counter')) this.counter();
    if (input.consume('capeStun')) this.capeStun();
    if (input.consume('finisher')) this.finisher(dir);
    if (input.consume('attack') && this.strikeLock <= 0 && !p.dodging) this.strike(dir, hasDir);
    // Gadgets.
    for (const [a, g] of [
      ['gadget1', 'smoke'],
      ['gadget2', 'dart'],
      ['gadget3', 'disarm'],
    ] as const) {
      if (input.consume(a)) this.gadget = g;
    }
    if (input.consume('useGadget')) this.useGadget(camFwd);
  }

  /** Real-time update: slow-mo timer, gadget wheel, aim, FX. */
  update(realDt: number, input: Input, camera: THREE.Camera): void {
    if (this.slowT > 0) {
      this.slowT -= realDt;
      if (this.slowT <= 0) this.timeScale = 1;
    }
    const open = input.held('gadgets') && !this.player.driving;
    if (open && !this.wheelOpen) this.wheelAcc.set(0, 0);
    this.wheelOpen = open;
    if (open) {
      this.timeScale = Math.min(this.timeScale, 0.25);
    } else if (this.slowT <= 0) this.timeScale = 1;
    this.aimTarget = this.findAim(camera);
    this.fx.update(realDt * this.timeScale, camera);
  }

  /** Mouse delta while the wheel is open picks a sector (top = smoke, right = dart, left = disarm). */
  wheelLook(dx: number, dy: number): void {
    this.wheelAcc.x += dx;
    this.wheelAcc.y += dy;
    if (this.wheelAcc.length() > 0.06) {
      const a = Math.atan2(this.wheelAcc.x, -this.wheelAcc.y);
      const idx = ((Math.round(a / ((Math.PI * 2) / 3)) % 3) + 3) % 3;
      this.gadget = GADGETS[idx].id;
    }
  }

  // ---------------------------------------------------------------- moves

  private pickTarget(dir: THREE.Vector3, hasDir: boolean, range = 8): Thug | null {
    const p = this.player.position;
    let best: Thug | null = null;
    let bs = -Infinity;
    for (const t of this.enemies.targets()) {
      if (t.aware === 'unaware' && !hasDir && t.dist > 3) continue;
      const to = t.pos.clone().sub(p).setY(0);
      const d = to.length();
      if (d > range || Math.abs(t.pos.y - p.y) > 2) continue;
      to.normalize();
      const c = d < 0.01 ? 1 : to.dot(dir);
      if (c < (hasDir ? 0.35 : -0.2) && d > 2) continue;
      // Officers who leave the player alone are only hit on purpose (aimed at, close).
      if (t.faction === 'vpd' && !this.enemies.policeHostile(t) && (!hasDir || c < 0.85 || d > 2.6)) continue;
      const score = c * 2 - d * 0.18 + (t === this.lastTarget ? 0.3 : 0) + (t.knocked ? -3 : 0);
      if (score > bs) {
        bs = score;
        best = t;
      }
    }
    return best;
  }

  private strike(dir: THREE.Vector3, hasDir: boolean): void {
    const p = this.player;
    const t = this.pickTarget(dir, hasDir);
    this.strikeN++;
    const variety = ['Punch_Jab', 'Punch_Cross'];
    if (this.combo >= 3) variety.push('Sword_Attack', 'Punch_Cross');
    const clip = variety[this.strikeN % variety.length];
    const heavy = clip === 'Sword_Attack';
    if (!t) {
      p.playOnce(clip, 1.7, 0.05, 0.1);
      this.strikeLock = 0.32;
      return;
    }
    this.lastTarget = t;
    const to = t.pos.clone().sub(p.position).setY(0);
    const d = to.length();
    const yaw = Math.atan2(to.x, to.z);
    let warpDur = 0;
    if (d > 1.25) {
      warpDur = THREE.MathUtils.clamp(d / 15, 0.08, 0.4);
      const stop = t.pos.clone().addScaledVector(to.normalize(), -1.05);
      stop.y = p.position.y;
      p.startWarp(stop, warpDur, yaw);
    } else p.face(yaw);
    p.playOnce(clip, heavy ? 1.5 : 1.75, 0.05, heavy ? 0.25 : 0.12);
    this.pending.push({ thug: t, t: warpDur + (heavy ? 0.2 : 0.12), dmg: heavy ? 2 : 1, kind: 'strike' });
    this.strikeLock = warpDur + (heavy ? 0.36 : 0.26);
  }

  private counter(): void {
    const p = this.player;
    const attackers = this.enemies.thugs.filter((t) => t.warn === 1 && !t.ko && t.dist < 6).sort((a, b) => a.dist - b.dist);
    if (!attackers.length) return;
    let delay = 0;
    for (const t of attackers.slice(0, 2)) {
      t.atk = null;
      t.token = false;
      t.cooldown = 1.5;
      const to = t.pos.clone().sub(p.position).setY(0);
      const yaw = Math.atan2(to.x, to.z);
      if (delay === 0) {
        if (to.length() > 1.3) p.startWarp(t.pos.clone().addScaledVector(to.normalize(), -1.0).setY(p.position.y), 0.1, yaw);
        else p.face(yaw);
        p.playOnce('Punch_Cross', 2.0, 0.04, 0.1);
      }
      this.pending.push({ thug: t, t: 0.14 + delay, dmg: 2, kind: 'counter' });
      delay += 0.28;
    }
    this.strikeLock = 0.3 + delay;
  }

  private capeStun(): void {
    const p = this.player;
    if (!p.hero || this.capeCd > 0) return;
    this.capeCd = 1.1;
    p.playOnce('Spell_Simple_Shoot', 1.6, 0.05);
    const c = p.position.clone();
    p.cape.flick(c, 9);
    this.fx.swirl(c.clone().add(new THREE.Vector3(0, 1, 0)));
    const fwd = new THREE.Vector3(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    const hit = this.enemies.thugs.filter((t) => {
      if (t.ko || t.knocked || (t.faction === 'vpd' && !this.enemies.policeHostile(t))) return false;
      const to = t.pos.clone().sub(c).setY(0);
      return to.length() < 3.2 && (to.length() < 1.2 || to.normalize().dot(fwd) > -0.2);
    });
    for (const t of hit) this.enemies.damage(t, 0, c, { stun: 2.8, kind: 'cape' });
    if (hit.length) this.addCombo();
  }

  private finisher(dir: THREE.Vector3): void {
    if (!this.finisherReady) return;
    const p = this.player;
    const cands = this.enemies.targets().filter((t) => (t.stun > 0 || t.stagger > 0 || t.hp <= 1) && t.dist < 7 && !t.knocked);
    if (!cands.length) return;
    cands.sort((a, b) => a.pos.clone().sub(p.position).normalize().dot(dir) * -1 + a.dist * 0.1 - (b.pos.clone().sub(p.position).normalize().dot(dir) * -1 + b.dist * 0.1));
    const t = cands[0];
    const to = t.pos.clone().sub(p.position).setY(0);
    const yaw = Math.atan2(to.x, to.z);
    const d = to.length();
    const warp = d > 1.2 ? THREE.MathUtils.clamp(d / 14, 0.1, 0.35) : 0;
    if (warp) p.startWarp(t.pos.clone().addScaledVector(to.normalize(), -1.0).setY(p.position.y), warp, yaw);
    else p.face(yaw);
    p.playOnce('Sword_Attack', 1.25, 0.05, 0.2);
    this.pending.push({ thug: t, t: warp + 0.3, dmg: 99, kind: 'finisher' });
    this.strikeLock = warp + 0.7;
    this.lastFinisherCombo = this.combo + 1;
    this.slowMo(0.75, 0.3);
  }

  private findAim(camera: THREE.Camera): Thug | null {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    let best: Thug | null = null;
    let bc = 0.94;
    for (const t of this.enemies.targets()) {
      if (t.dist > 28) continue;
      const to = t.pos.clone().add(new THREE.Vector3(0, 1.2, 0)).sub(camera.position);
      const c = to.normalize().dot(fwd);
      if (c > bc) {
        bc = c;
        best = t;
      }
    }
    return best;
  }

  private useGadget(camFwd: THREE.Vector3): void {
    const p = this.player;
    if (!p.hero || this.gadgetCd > 0 || p.driving) return;
    const hand = p.bonePos('hand_r');
    if (this.gadget === 'smoke') {
      this.gadgetCd = 1.2;
      p.playOnce('Spell_Simple_Shoot', 1.8, 0.05);
      const at = p.position.clone();
      this.enemies.smoke(at.x, at.z, 5.5);
      this.fx.smoke(at);
      events.emit('combat:gadget', { kind: 'smoke', x: at.x, y: at.y, z: at.z });
    } else if (this.gadget === 'dart') {
      this.gadgetCd = 0.5;
      const t = this.aimTarget ?? this.pickTarget(camFwd, true, 25);
      p.playOnce('Spell_Simple_Shoot', 2.2, 0.04);
      const to = t ? t.pos.clone().add(new THREE.Vector3(0, 1.3, 0)) : hand.clone().addScaledVector(camFwd, 20);
      this.fx.tracer(hand, to);
      events.emit('combat:gadget', { kind: 'dart', x: hand.x, y: hand.y, z: hand.z });
      if (t) {
        p.face(Math.atan2(t.pos.x - p.position.x, t.pos.z - p.position.z));
        this.enemies.damage(t, 0, p.position, { stun: 3.2, kind: 'dart' });
      }
    } else {
      const t = (this.aimTarget && (this.aimTarget.weapon !== 'fists' || this.aimTarget.actor.shieldObj) ? this.aimTarget : null) ?? this.enemies.targets().filter((x) => (x.weapon !== 'fists' || x.actor.shieldObj) && x.dist < 20).sort((a, b) => a.dist - b.dist)[0];
      if (!t) return;
      this.gadgetCd = 0.8;
      p.playOnce('Spell_Simple_Shoot', 1.8, 0.05);
      p.face(Math.atan2(t.pos.x - p.position.x, t.pos.z - p.position.z));
      const from = t.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
      this.fx.tracer(hand, from);
      if (this.enemies.disarm(t, () => p.bonePos('hand_r'))) {
        this.addCombo();
        events.emit('combat:gadget', { kind: 'disarm', x: from.x, y: from.y, z: from.z });
      }
    }
  }
}

/** Lightweight combat effects: impact flashes, shockwave rings, smoke clouds, dart tracers. */
class CombatFX {
  readonly group = new THREE.Group();
  private flashes: { m: THREE.Mesh; t: number; life: number; grow: number }[] = [];
  private puffs: THREE.InstancedMesh;
  private puffData: { p: THREE.Vector3; v: THREE.Vector3; t: number; life: number; s: number }[] = [];
  private dummy = new THREE.Object3D();
  private flashMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.4, 1.1), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  private ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.7, 0.85, 1.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  private lineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 0.9, 1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

  constructor() {
    this.group.name = 'CombatFX';
    const mat = new THREE.MeshStandardMaterial({ color: 0x6e7175, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false });
    this.puffs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, 160);
    this.puffs.count = 0;
    this.puffs.frustumCulled = false;
    this.group.add(this.puffs);
  }

  private spawn(geo: THREE.BufferGeometry, mat: THREE.Material, pos: THREE.Vector3, life: number, grow: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat.clone());
    m.position.copy(pos);
    this.group.add(m);
    this.flashes.push({ m, t: 0, life, grow });
    return m;
  }

  impact(pos: THREE.Vector3, strength: number, blocked: boolean): void {
    const m = this.spawn(new THREE.SphereGeometry(0.08 + strength * 0.06, 8, 6), blocked ? this.ringMat : this.flashMat, pos, 0.12, 4);
    void m;
  }

  shock(pos: THREE.Vector3): void {
    const m = this.spawn(new THREE.RingGeometry(0.6, 0.9, 40), this.ringMat, pos.clone().add(new THREE.Vector3(0, 0.08, 0)), 0.45, 9);
    m.rotation.x = -Math.PI / 2;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      this.puffData.push({ p: pos.clone().add(new THREE.Vector3(Math.cos(a) * 0.8, 0.2, Math.sin(a) * 0.8)), v: new THREE.Vector3(Math.cos(a) * 5, 0.8, Math.sin(a) * 5), t: 0, life: 0.9, s: 0.35 });
    }
  }

  swirl(pos: THREE.Vector3): void {
    const m = this.spawn(new THREE.RingGeometry(0.9, 1.15, 40), this.ringMat, pos, 0.3, 2.6);
    m.rotation.x = -Math.PI / 2;
  }

  smoke(pos: THREE.Vector3): void {
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random();
      this.puffData.push({ p: pos.clone().add(new THREE.Vector3(Math.cos(a) * r, 0.3 + Math.random() * 0.6, Math.sin(a) * r)), v: new THREE.Vector3(Math.cos(a) * (1.5 + r * 2.5), 0.3 + Math.random() * 0.8, Math.sin(a) * (1.5 + r * 2.5)), t: 0, life: 5.5 + Math.random() * 1.5, s: 0.9 + Math.random() * 0.8 });
    }
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3): void {
    const d = b.clone().sub(a);
    const g = new THREE.CylinderGeometry(0.012, 0.012, 1, 4, 1, true);
    g.translate(0, 0.5, 0);
    const m = this.spawn(g, this.lineMat, a, 0.18, 0);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    m.scale.set(1, d.length(), 1);
  }

  update(dt: number, camera: THREE.Camera): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = f.t / f.life;
      if (f.grow) f.m.scale.setScalar(1 + k * f.grow);
      (f.m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - k);
      if (k >= 1) {
        f.m.geometry.dispose();
        (f.m.material as THREE.Material).dispose();
        f.m.removeFromParent();
        this.flashes.splice(i, 1);
      }
    }
    let n = 0;
    for (let i = this.puffData.length - 1; i >= 0; i--) {
      const p = this.puffData[i];
      p.t += dt;
      if (p.t > p.life) {
        this.puffData.splice(i, 1);
        continue;
      }
      p.v.multiplyScalar(Math.exp(-2.2 * dt));
      p.p.addScaledVector(p.v, dt);
      if (n >= 160) continue;
      const k = p.t / p.life;
      this.dummy.position.copy(p.p);
      this.dummy.scale.setScalar(p.s * (0.6 + k * 1.6) * Math.min(1, (1 - k) * 4));
      this.dummy.updateMatrix();
      this.puffs.setMatrixAt(n++, this.dummy.matrix);
    }
    this.puffs.count = n;
    this.puffs.instanceMatrix.needsUpdate = true;
    void camera;
  }
}
