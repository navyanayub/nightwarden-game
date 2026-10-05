/**
 * NPC gunfire effects, all instanced (5 draws total however many shots are in flight):
 * tracers (bright streaks from muzzle to the hit point), muzzle flashes, impact sparks, dust
 * puffs and bullet marks left on walls / ground (fade after 25 s).
 *
 * `fire()` also resolves where a missed bullet lands (a ray cast past the target against the
 * solid world), so impacts appear on the right surfaces.
 */
import * as THREE from 'three';
import { physics, GROUPS_SHOT } from '../core/Physics';
import { events } from '../core/EventBus';

interface Fx {
  t: number;
  life: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
  /** Tracers: muzzle position and full flight length. */
  origin?: THREE.Vector3;
  len?: number;
}

const MAX = { tracer: 48, flash: 24, spark: 160, dust: 64, mark: 96 };

export class Gunfire {
  readonly group = new THREE.Group();
  private tracers: Fx[] = [];
  private flashes: Fx[] = [];
  private sparks: Fx[] = [];
  private dust: Fx[] = [];
  private marks: Fx[] = [];
  private meshes: Record<keyof typeof MAX, THREE.InstancedMesh>;
  private m = new THREE.Matrix4();
  private markNext = 0;
  shots = 0;

  /** Tracers + flashes currently visible (screenshots wait for one). */
  get live(): number {
    return this.tracers.length + this.flashes.length;
  }

  constructor() {
    this.group.name = 'Gunfire';
    const glow = (c: THREE.Color, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o, depthWrite: false, blending: THREE.AdditiveBlending });
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0, 0.5);
    const mk = (g: THREE.BufferGeometry, mat: THREE.Material, n: number, name: string) => {
      const im = new THREE.InstancedMesh(g, mat, n);
      im.count = 0;
      im.frustumCulled = false;
      im.name = `gunfire:${name}`;
      this.group.add(im);
      return im;
    };
    const markMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 1, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, depthWrite: false });
    const dustMat = new THREE.MeshStandardMaterial({ color: 0x8a8274, roughness: 1, transparent: true, opacity: 0.45, depthWrite: false });
    this.meshes = {
      tracer: mk(box, glow(new THREE.Color(2.6, 2.0, 1.1), 0.85), MAX.tracer, 'tracer'),
      flash: mk(new THREE.IcosahedronGeometry(1, 0), glow(new THREE.Color(4, 2.8, 1.2)), MAX.flash, 'flash'),
      spark: mk(box.clone(), glow(new THREE.Color(3, 2, 0.8)), MAX.spark, 'spark'),
      dust: mk(new THREE.IcosahedronGeometry(1, 1), dustMat, MAX.dust, 'dust'),
      mark: mk(new THREE.CircleGeometry(1, 10), markMat, MAX.mark, 'mark'),
    };
  }

  /**
   * One shot from `muzzle` towards `aim`. If `hit` is false the bullet flies past the aim
   * point (with spread) and lands on whatever solid surface is behind it.
   */
  fire(muzzle: THREE.Vector3, aim: THREE.Vector3, hit: boolean, police: boolean): void {
    this.shots++;
    const dir = aim.clone().sub(muzzle);
    const len = dir.length();
    dir.normalize();
    let end = aim.clone();
    let normal: THREE.Vector3 | null = null;
    if (!hit) {
      // Miss: random spread, continue until something solid.
      dir.add(new THREE.Vector3((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.08)).normalize();
      const r = physics.rayHit(muzzle, dir, len + 40, GROUPS_SHOT);
      if (r && r.normal.lengthSq() > 0.5) {
        end = r.point;
        normal = r.normal;
      } else end = muzzle.clone().addScaledVector(dir, len + 25);
    } else {
      // Something solid in between still takes the bullet.
      const r = physics.rayHit(muzzle, dir, len - 0.3, GROUPS_SHOT);
      if (r && r.normal.lengthSq() > 0.5) {
        end = r.point;
        normal = r.normal;
      }
    }
    const d = end.clone().sub(muzzle);
    const L = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.clone().normalize());
    // A short streak travelling at ~380 m/s from the muzzle to the impact (v = unit direction).
    this.tracers.push({ t: 0, life: Math.max(0.03, L / 380), p: muzzle.clone(), origin: muzzle.clone(), len: L, v: d.normalize(), q, s: new THREE.Vector3(0.012, 0.012, Math.min(3.2, L)) });
    this.flashes.push({ t: 0, life: 0.06, p: muzzle.clone().addScaledVector(dir, 0.1), v: new THREE.Vector3(), q: new THREE.Quaternion(), s: new THREE.Vector3(0.12, 0.12, 0.12) });
    if (normal) this.impact(end, normal);
    events.emit('combat:shot', { x: muzzle.x, y: muzzle.y, z: muzzle.z, police });
  }

  /** Sparks, dust and a bullet mark on a surface. */
  impact(p: THREE.Vector3, n: THREE.Vector3): void {
    for (let i = 0; i < 6; i++) {
      const v = n.clone().multiplyScalar(2 + Math.random() * 3).add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4));
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), v.clone().normalize());
      this.sparks.push({ t: 0, life: 0.18 + Math.random() * 0.12, p: p.clone(), v, q, s: new THREE.Vector3(0.012, 0.012, 0.09) });
    }
    this.dust.push({ t: 0, life: 0.7, p: p.clone().addScaledVector(n, 0.08), v: n.clone().multiplyScalar(0.6), q: new THREE.Quaternion(), s: new THREE.Vector3(0.1, 0.1, 0.1) });
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const mark = { t: 0, life: 25, p: p.clone().addScaledVector(n, 0.01), v: new THREE.Vector3(), q, s: new THREE.Vector3(0.035, 0.035, 1) };
    if (this.marks.length < MAX.mark) this.marks.push(mark);
    else this.marks[this.markNext++ % MAX.mark] = mark;
  }

  update(dt: number): void {
    const run = (list: Fx[], im: THREE.InstancedMesh, fn: (f: Fx, k: number) => void, keep = false) => {
      let n = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i];
        f.t += dt;
        if (f.t > f.life && !keep) {
          list.splice(i, 1);
          continue;
        }
        if (f.t > f.life) continue;
        fn(f, f.t / f.life);
        if (n < im.instanceMatrix.count) {
          this.m.compose(f.p, f.q, f.s);
          im.setMatrixAt(n++, this.m);
        }
      }
      im.count = n;
      im.instanceMatrix.needsUpdate = true;
    };
    run(this.tracers, this.meshes.tracer, (f, k) => {
      // Head of the streak at k * length; the box starts at its tail.
      const total = f.len ?? f.s.z;
      const head = Math.min(total, k * total + 1.6);
      f.p.copy(f.v).multiplyScalar(Math.max(0, head - f.s.z)).add(f.origin!);
    });
    run(this.flashes, this.meshes.flash, (f, k) => f.s.setScalar(0.14 * (1 - k * 0.6)));
    run(this.sparks, this.meshes.spark, (f) => {
      f.v.y -= 9.8 * dt;
      f.p.addScaledVector(f.v, dt);
    });
    run(this.dust, this.meshes.dust, (f, k) => {
      f.p.addScaledVector(f.v, dt);
      f.s.setScalar(0.1 + k * 0.45);
    });
    run(this.marks, this.meshes.mark, (f, k) => {
      if (k > 0.8) f.s.set(0.035 * (1 - (k - 0.8) * 5), 0.035 * (1 - (k - 0.8) * 5), 1);
    });
  }
}
