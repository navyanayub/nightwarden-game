/**
 * Flagpoles with cloth flags that stream downwind. The cloth is a subdivided plane animated in
 * the vertex shader (travelling waves whose amplitude and frequency follow the global wind);
 * each pole's flag group is turned on the CPU to point downwind. Flags are original designs:
 * the Port Vellmoor city flag (navy field, gold wave, white lighthouse) and a harbour pennant.
 */
import * as THREE from 'three';
import type { CityData } from './CityLayout';
import { shared } from './Materials';
import { heightAt } from './Terrain';
import { BRIDGE, CITY_HALF } from './WorldConfig';
import { wind } from '../systems/Weather';

function flagTexture(kind: 0 | 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 160;
  const g = c.getContext('2d')!;
  if (kind === 0) {
    g.fillStyle = '#16264a';
    g.fillRect(0, 0, 256, 160);
    g.fillStyle = '#d9a63a';
    g.beginPath();
    g.moveTo(0, 104);
    for (let x = 0; x <= 256; x += 8) g.lineTo(x, 104 + Math.sin(x / 24) * 7);
    for (let x = 256; x >= 0; x -= 8) g.lineTo(x, 122 + Math.sin(x / 24) * 7);
    g.closePath();
    g.fill();
    // Lighthouse emblem.
    g.fillStyle = '#f3efe4';
    g.beginPath();
    g.moveTo(70, 96);
    g.lineTo(86, 96);
    g.lineTo(82, 40);
    g.lineTo(74, 40);
    g.closePath();
    g.fill();
    g.fillRect(70, 32, 16, 8);
    g.beginPath();
    g.moveTo(68, 32);
    g.lineTo(78, 22);
    g.lineTo(88, 32);
    g.fill();
    g.strokeStyle = '#f3efe4';
    g.lineWidth = 3;
    for (const a of [-0.5, -0.25, 0.25, 0.5]) {
      g.beginPath();
      g.moveTo(78, 36);
      g.lineTo(78 + Math.cos(a) * 60, 36 + Math.sin(a) * 30);
      g.stroke();
    }
  } else {
    g.fillStyle = '#b8322a';
    g.fillRect(0, 0, 256, 160);
    g.fillStyle = '#f2efe6';
    g.fillRect(0, 60, 256, 40);
    g.fillStyle = '#1d3557';
    g.beginPath();
    g.arc(128, 80, 26, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Flags {
  readonly group = new THREE.Group();
  private poles: THREE.Group[] = [];
  private mats: THREE.MeshStandardMaterial[] = [];

  constructor(city: CityData) {
    this.group.name = 'Flags';
    const spots: [number, number, 0 | 1][] = [];
    const tower = city.features.find((f) => f.type === 'clocktower');
    if (tower) for (const [dx, dz] of [[-14, -14], [14, 14]]) spots.push([tower.x + dx, tower.z + dz, 0]);
    for (const f of city.features.filter((ff) => ff.type === 'fountain').slice(0, 4)) spots.push([f.x + 9, f.z + 9, 0]);
    for (const x of [140, 360, 520]) spots.push([x, CITY_HALF - 7, 1]);
    spots.push([BRIDGE.startX + 6, BRIDGE.z + BRIDGE.width / 2 + 4, 0], [BRIDGE.startX + 6, BRIDGE.z - BRIDGE.width / 2 - 4, 0]);
    spots.push([1790, -470, 0], [1790, -455, 1]);
    const geo = new THREE.PlaneGeometry(2.4, 1.5, 16, 8);
    geo.translate(1.2, 0, 0); // hoist edge at the pole
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.07, 9, 8);
    poleGeo.translate(0, 4.5, 0);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8d8d4, metalness: 0.8, roughness: 0.35 });
    for (const kind of [0, 1] as const) {
      const m = new THREE.MeshStandardMaterial({ map: flagTexture(kind), side: THREE.DoubleSide, roughness: 0.85 });
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = shared.time;
        shader.uniforms.uWind = shared.wind;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec4 uWind;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
            {
              float s = clamp(uWind.z + uWind.w * 0.8, 0.0, 1.4);
              float u = position.x / 2.4;
              float ph = uTime * (3.0 + s * 7.0) - u * 7.0 + modelMatrix[3].x;
              float amp = (0.05 + 0.32 * s) * u;
              transformed.z += sin(ph) * amp + sin(ph * 2.3 + position.y * 2.0) * amp * 0.25;
              // Weak wind: the flag droops along the pole.
              float droop = (1.0 - smoothstep(0.0, 0.5, s)) * u;
              transformed.y -= droop * 0.9 * u;
              transformed.x *= 1.0 - droop * 0.35;
            }`,
          )
          .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nobjectNormal = normalize(objectNormal + vec3(0.0, 0.0, 0.0));');
      };
      this.mats.push(m);
    }
    for (const [x, z, kind] of spots) {
      const y = heightAt(x, z) + 0.15;
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(x, y, z);
      pole.castShadow = true;
      const g = new THREE.Group();
      g.position.set(x, y + 8.1, z);
      const cloth = new THREE.Mesh(geo, this.mats[kind]);
      cloth.castShadow = true;
      g.add(cloth);
      this.group.add(pole, g);
      this.poles.push(g);
    }
  }

  update(): void {
    // Point flags downwind (local +X is the fly end).
    const yaw = Math.atan2(-wind.dirZ, wind.dirX);
    for (const g of this.poles) g.rotation.y += (yaw - g.rotation.y) * 0.02;
  }
}
