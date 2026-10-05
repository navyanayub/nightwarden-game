/**
 * A building fire (arson): flickering flame billboards along a facade, a rising column of dark
 * smoke (instanced puffs) and a scorch glow on the ground. `level` eases towards `target`
 * (0 = out, 1 = fully ablaze). No real lights (the light count stays constant); the flames are
 * HDR-bright so bloom carries the glow.
 */
import * as THREE from 'three';
import { flameMaterial } from '../ai/Enemies';

const PUFFS = 40;

let glowTex: THREE.Texture | null = null;
/** Soft radial falloff for the light the fire throws on the ground. */
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

export class FireFX {
  readonly group = new THREE.Group();
  level = 0;
  target = 1;
  private flames: THREE.Mesh[] = [];
  private flameMats: THREE.ShaderMaterial[] = [];
  private smoke: THREE.InstancedMesh;
  private puffs: { p: THREE.Vector3; v: THREE.Vector3; t: number; life: number; s: number }[] = [];
  private glow: THREE.Mesh;
  private m = new THREE.Matrix4();
  private time = 0;
  private seed: number;
  private emit = 0;
  private q = new THREE.Quaternion();
  private sv = new THREE.Vector3();

  /** `pos` = base of the facade at ground level, `normal` = outward, `width` along the wall. */
  constructor(
    readonly pos: THREE.Vector3,
    readonly normal: THREE.Vector3,
    readonly width: number,
  ) {
    this.seed = Math.abs(Math.round(pos.x * 7 + pos.z * 13)) % 1000;
    const along = new THREE.Vector3(-normal.z, 0, normal.x);
    const n = 5;
    for (let i = 0; i < n; i++) {
      const mat = flameMaterial();
      mat.uniforms.uTime.value = i * 1.7;
      const f = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 2.8), mat);
      const k = (i / (n - 1) - 0.5) * width * 0.85;
      f.position.copy(pos).addScaledVector(along, k).addScaledVector(normal, 0.5);
      f.userData.base = f.position.clone();
      f.userData.h = i % 2 ? 2.6 : 3.4;
      this.flames.push(f);
      this.flameMats.push(mat);
      this.group.add(f);
    }
    const smokeMat = new THREE.MeshStandardMaterial({ color: 0x1b1a19, roughness: 1, transparent: true, opacity: 0.42, depthWrite: false });
    this.smoke = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), smokeMat, PUFFS);
    this.smoke.count = 0;
    this.smoke.frustumCulled = false;
    this.group.add(this.smoke);
    for (let i = 0; i < PUFFS; i++) this.puffs.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), t: 99, life: 1, s: 1 });
    const gm = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 0.5, 0.1), map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.4, width * 1.1), gm);
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.copy(pos).addScaledVector(normal, 1.2).setY(pos.y + 0.06);
    this.group.add(this.glow);
  }

  update(dt: number, cam: THREE.Vector3, wind: THREE.Vector3): void {
    this.time += dt;
    this.level += (this.target - this.level) * Math.min(1, dt * (this.target > this.level ? 0.12 : 0.4));
    const L = this.level;
    this.group.visible = L > 0.01;
    if (!this.group.visible) return;
    for (const [i, f] of this.flames.entries()) {
      this.flameMats[i].uniforms.uTime.value += dt * (1 + i * 0.1);
      const on = THREE.MathUtils.clamp(L * 5 - i * 0.8, 0, 1);
      const h = f.userData.h as number;
      f.scale.set(on * (0.8 + L * 0.6), on * (0.5 + L * 0.9) * (h / 3), 1);
      f.position.copy(f.userData.base as THREE.Vector3).setY((f.userData.base as THREE.Vector3).y + f.scale.y * 1.3);
      f.rotation.y = Math.atan2(cam.x - f.position.x, cam.z - f.position.z);
      f.visible = on > 0.02;
    }
    (this.glow.material as THREE.MeshBasicMaterial).opacity = L * (0.32 + Math.sin(this.time * 9) * 0.04);
    // Smoke puffs.
    const along = new THREE.Vector3(-this.normal.z, 0, this.normal.x);
    this.emit += L > 0.1 ? L * 7 * dt : 0;
    let n = 0;
    for (const [i, p] of this.puffs.entries()) {
      p.t += dt;
      if (p.t > p.life) {
        if (this.emit < 1) continue;
        this.emit -= 1;
        const k = Math.sin(i * 12.9 + this.time * 3.1 + this.seed) * 0.5 * this.width * 0.8;
        p.p.copy(this.pos).addScaledVector(along, k).addScaledVector(this.normal, 0.6).setY(this.pos.y + 2.5 + L * 2);
        p.v.set(0, 2.2 + L * 1.5, 0).addScaledVector(this.normal, 0.8);
        p.t = 0;
        p.life = 5 + (i % 5);
        p.s = 0.6 + (i % 3) * 0.3;
      }
      p.v.addScaledVector(wind, dt * 0.25);
      p.p.addScaledVector(p.v, dt);
      const k = p.t / p.life;
      const s = p.s * (1 + k * 4) * (0.6 + L * 0.6);
      this.m.compose(p.p, this.q, this.sv.set(s, s * 0.85, s));
      this.smoke.setMatrixAt(n++, this.m);
    }
    this.emit = Math.min(this.emit, 2);
    this.smoke.count = n;
    this.smoke.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.flameMats) m.dispose();
  }
}
