/**
 * Minimap + full-screen map. The whole map (sea, land, park, lake, blocks, buildings, roads,
 * bridge, runway) is rasterised once into an offscreen canvas at load; the HUD minimap draws a
 * rotated window of it every frame (camera-up), and the M map shows all of it with district
 * names and the player marker.
 *
 * Stage 4: crime icons (pulsing, pinned to the rim when off the minimap), police cars and
 * helicopters, the wanted search circle, hospital / precinct / bank landmarks, and gang
 * territory shading per district (owner's colour, strength = control) on the full map.
 */
import type { CityData } from '../world/CityLayout';
import { landSdf } from '../world/Terrain';
import { BRIDGE, DISTRICT_NAMES, ISLAND, LAKE, PARK, TERRAIN, districtAt, type District } from '../world/WorldConfig';

const PPM = 0.5; // map pixels per metre

const LAND: Record<District, string> = {
  midtown: '#3a3f47',
  oldtown: '#4a4038',
  harbour: '#3b4448',
  industrial: '#45403a',
  hills: '#3d4a36',
  park: '#36522f',
  island: '#40503a',
  sea: '#13283a',
};

export interface MapMarker {
  x: number;
  z: number;
  kind: 'hangout' | 'thug' | 'crime' | 'police' | 'heli' | 'hospital' | 'precinct' | 'bank';
  label?: string;
  icon?: string;
  color?: string;
}

export class Minimap {
  readonly map: HTMLCanvasElement;
  private mini: HTMLCanvasElement;
  private miniCtx: CanvasRenderingContext2D;
  private full: HTMLCanvasElement;
  private fullCtx: CanvasRenderingContext2D;
  private wrap: HTMLElement;
  private fullWrap: HTMLElement;
  open = false;
  private masks = new Map<District, HTMLCanvasElement>();
  private tint: HTMLCanvasElement | null = null;
  private tintKey = '';
  private time = 0;
  /** Wanted search circle (null = none). */
  search: { x: number; z: number; r: number; seen: boolean } | null = null;
  /** Gang shading per district: colour + 0..1 strength; legend lines. */
  territory: { district: District; color: string; strength: number }[] = [];
  legend: { color: string; text: string }[] = [];

  constructor(
    root: HTMLElement,
    private readonly city: CityData,
  ) {
    this.map = document.createElement('canvas');
    this.map.width = Math.round((TERRAIN.maxX - TERRAIN.minX) * PPM);
    this.map.height = Math.round((TERRAIN.maxZ - TERRAIN.minZ) * PPM);
    this.render();
    this.wrap = document.createElement('div');
    this.wrap.className = 'minimap';
    this.mini = document.createElement('canvas');
    this.mini.width = this.mini.height = 220;
    this.miniCtx = this.mini.getContext('2d')!;
    this.wrap.appendChild(this.mini);
    root.appendChild(this.wrap);
    this.fullWrap = document.createElement('div');
    this.fullWrap.className = 'fullmap';
    this.full = document.createElement('canvas');
    this.fullCtx = this.full.getContext('2d')!;
    const title = document.createElement('div');
    title.className = 'fullmap-title';
    title.innerHTML = '<span>PORT VELLMOOR</span><small>M or Esc to close</small>';
    this.fullWrap.append(this.full, title);
    root.appendChild(this.fullWrap);
  }

  private toMap(x: number, z: number): [number, number] {
    return [(x - TERRAIN.minX) * PPM, (z - TERRAIN.minZ) * PPM];
  }

  private render(): void {
    const g = this.map.getContext('2d')!;
    const W = this.map.width;
    const H = this.map.height;
    g.fillStyle = LAND.sea;
    g.fillRect(0, 0, W, H);
    // Land by district (8 m cells).
    const step = 8;
    for (let z = TERRAIN.minZ; z < TERRAIN.maxZ; z += step) {
      for (let x = TERRAIN.minX; x < TERRAIN.maxX; x += step) {
        if (landSdf(x + step / 2, z + step / 2) < 0) continue;
        g.fillStyle = LAND[districtAt(x + step / 2, z + step / 2)];
        const [px, pz] = this.toMap(x, z);
        g.fillRect(px, pz, step * PPM + 0.6, step * PPM + 0.6);
      }
    }
    // Park + lake.
    let [px, pz] = this.toMap(PARK.minX, PARK.minZ);
    g.fillStyle = '#35552e';
    g.fillRect(px, pz, (PARK.maxX - PARK.minX) * PPM, (PARK.maxZ - PARK.minZ) * PPM);
    [px, pz] = this.toMap(LAKE.x, LAKE.z);
    g.fillStyle = '#1d4258';
    g.beginPath();
    g.ellipse(px, pz, LAKE.rx * PPM, LAKE.rz * PPM, 0, 0, Math.PI * 2);
    g.fill();
    // Paths.
    g.strokeStyle = '#6d6a55';
    g.lineWidth = 1.5;
    for (const p of this.city.paths) {
      g.beginPath();
      p.pts.forEach(([x, z], i) => {
        const [a, b] = this.toMap(x, z);
        if (i) g.lineTo(a, b);
        else g.moveTo(a, b);
      });
      g.stroke();
    }
    // Blocks (pavement) and buildings.
    g.fillStyle = '#6f7178';
    for (const b of this.city.blocks) {
      const [x0, z0] = this.toMap(b.minX, b.minZ);
      g.fillRect(x0, z0, (b.maxX - b.minX) * PPM, (b.maxZ - b.minZ) * PPM);
    }
    for (const b of this.city.buildings) {
      const [x0, z0] = this.toMap(b.cx - b.w / 2, b.cz - b.d / 2);
      const h = Math.min(1, b.height / 160);
      g.fillStyle = `rgb(${Math.round(150 + 60 * h)},${Math.round(148 + 55 * h)},${Math.round(140 + 50 * h)})`;
      g.fillRect(x0, z0, b.w * PPM, b.d * PPM);
    }
    // Roads.
    g.strokeStyle = '#22252b';
    g.lineCap = 'square';
    for (const r of this.city.roads) {
      const [a, b] = this.toMap(r.x0, r.z0);
      const [c, d] = this.toMap(r.x1, r.z1);
      g.lineWidth = Math.max(2, r.width * PPM);
      g.beginPath();
      g.moveTo(a, b);
      g.lineTo(c, d);
      g.stroke();
    }
    // Bridge.
    const [b0x, b0z] = this.toMap(BRIDGE.startX, BRIDGE.z);
    const [b1x, b1z] = this.toMap(BRIDGE.endX + 60, BRIDGE.z);
    g.strokeStyle = '#5a6d78';
    g.lineWidth = BRIDGE.width * PPM;
    g.beginPath();
    g.moveTo(b0x, b0z);
    g.lineTo(b1x, b1z);
    g.stroke();
    g.strokeStyle = '#22252b';
    g.lineWidth = 18 * PPM;
    g.stroke();
    // Runway.
    const [rx, rz0] = this.toMap(1835, ISLAND.z - 600);
    g.fillStyle = '#2a2d31';
    g.fillRect(rx - 22.5 * PPM, rz0, 45 * PPM, 1200 * PPM);
    g.strokeStyle = 'rgba(255,255,255,0.5)';
    g.setLineDash([6, 6]);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(rx, rz0);
    g.lineTo(rx, rz0 + 1200 * PPM);
    g.stroke();
    g.setLineDash([]);
    // District masks for territory shading.
    for (const d of ['midtown', 'oldtown', 'harbour', 'industrial', 'hills', 'park', 'island'] as District[]) {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      this.masks.set(d, c);
    }
    for (let z = TERRAIN.minZ; z < TERRAIN.maxZ; z += step) {
      for (let x = TERRAIN.minX; x < TERRAIN.maxX; x += step) {
        if (landSdf(x + step / 2, z + step / 2) < 0) continue;
        const m = this.masks.get(districtAt(x + step / 2, z + step / 2));
        if (!m) continue;
        const mg = m.getContext('2d')!;
        mg.fillStyle = '#fff';
        const [px2, pz2] = this.toMap(x, z);
        mg.fillRect(px2, pz2, step * PPM + 0.6, step * PPM + 0.6);
      }
    }
  }

  /** Territory overlay (rebuilt only when the shading changes). */
  private territoryLayer(): HTMLCanvasElement | null {
    const key = this.territory.map((t) => `${t.district}:${t.color}:${t.strength.toFixed(2)}`).join('|');
    if (key === this.tintKey && this.tint) return this.tint;
    this.tintKey = key;
    const W = this.map.width;
    const H = this.map.height;
    const tint = this.tint ?? document.createElement('canvas');
    tint.width = W;
    tint.height = H;
    const g = tint.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    const tg = tmp.getContext('2d')!;
    for (const t of this.territory) {
      const m = this.masks.get(t.district);
      if (!m || t.strength <= 0) continue;
      tg.globalCompositeOperation = 'source-over';
      tg.clearRect(0, 0, W, H);
      tg.drawImage(m, 0, 0);
      tg.globalCompositeOperation = 'source-in';
      tg.globalAlpha = 0.12 + t.strength * 0.4;
      tg.fillStyle = t.color;
      tg.fillRect(0, 0, W, H);
      tg.globalAlpha = 1;
      g.drawImage(tmp, 0, 0);
    }
    this.tint = tint;
    return tint;
  }

  /** Points of interest: hangouts, hostile thugs, crimes, police, landmarks. */
  markers: MapMarker[] = [];

  private markerStyle(m: MapMarker): { fill: string; r: number; glyph: string } {
    const blink = Math.floor(this.time * 4) % 2 === 0;
    switch (m.kind) {
      case 'hangout':
        return { fill: m.color ?? '#d64834', r: 5, glyph: '' };
      case 'thug':
        return { fill: '#ff5a3c', r: 3.5, glyph: '' };
      case 'crime':
        return { fill: blink ? '#ff3b2e' : '#ffb347', r: 8, glyph: m.icon ?? '!' };
      case 'police':
        return { fill: blink ? '#ff4a3c' : '#4a8cff', r: 4, glyph: '' };
      case 'heli':
        return { fill: '#7fb6ff', r: 5, glyph: '✈' };
      case 'hospital':
        return { fill: '#18a06a', r: 7, glyph: 'H' };
      case 'precinct':
        return { fill: '#2f6fd6', r: 7, glyph: 'P' };
      case 'bank':
        return { fill: '#1d4f8f', r: 7, glyph: '$' };
    }
  }

  /** Draw the rotating HUD minimap. yaw = camera heading (atan2 convention), heading = player facing. */
  update(x: number, z: number, camYaw: number, heading: number, zoom: number, visible: boolean): void {
    this.wrap.style.display = visible && !this.open ? 'block' : 'none';
    if (!visible) return;
    const g = this.miniCtx;
    const S = this.mini.width;
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = LAND.sea;
    g.fillRect(0, 0, S, S);
    g.translate(S / 2, S / 2);
    // Camera forward (+atan2 yaw) points up: map +Z is down, so rotate by yaw - PI.
    g.rotate(camYaw - Math.PI);
    const k = zoom / PPM;
    g.scale(k, k);
    const [mx, mz] = this.toMap(x, z);
    g.drawImage(this.map, -mx, -mz);
    if (this.search) {
      const [cx, cz] = this.toMap(this.search.x, this.search.z);
      g.fillStyle = this.search.seen ? 'rgba(255, 60, 40, 0.12)' : 'rgba(80, 140, 255, 0.14)';
      g.strokeStyle = this.search.seen ? 'rgba(255, 90, 60, 0.9)' : 'rgba(120, 170, 255, 0.9)';
      g.lineWidth = 2 / k;
      g.setLineDash([6 / k, 4 / k]);
      g.beginPath();
      g.arc(cx - mx, cz - mz, this.search.r * PPM, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();
    // Markers drawn upright: rotate offsets by hand; crimes stick to the rim when off the map.
    const rot = camYaw - Math.PI;
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    const R = S / 2 - 12;
    for (const m of this.markers) {
      const st = this.markerStyle(m);
      const dx = (m.x - x) * PPM * k;
      const dz = (m.z - z) * PPM * k;
      let sx = dx * cr - dz * sr;
      let sy = dx * sr + dz * cr;
      const len = Math.hypot(sx, sy);
      if (len > R) {
        if (m.kind !== 'crime' && m.kind !== 'heli') continue;
        sx *= R / len;
        sy *= R / len;
      }
      this.drawMarker(g, S / 2 + sx, S / 2 + sy, st, m.kind === 'hangout');
    }
    // Player arrow (relative heading).
    g.save();
    g.translate(S / 2, S / 2);
    g.rotate(-(heading - camYaw));
    g.fillStyle = '#f3d27a';
    g.strokeStyle = '#1a1206';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7.5, 8);
    g.lineTo(0, 4);
    g.lineTo(-7.5, 8);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // North marker on the rim.
    const na = camYaw - Math.PI;
    const r = S / 2 - 14;
    const nx = S / 2 + Math.sin(-na) * -r;
    const ny = S / 2 - Math.cos(-na) * r;
    g.fillStyle = '#c9a45c';
    g.font = 'bold 13px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', nx, ny);
    g.strokeStyle = 'rgba(201,164,92,0.6)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2);
    g.stroke();
  }

  private drawMarker(g: CanvasRenderingContext2D, px: number, py: number, st: { fill: string; r: number; glyph: string }, square: boolean, scale = 1): void {
    const r = st.r * scale;
    g.fillStyle = st.fill;
    g.strokeStyle = 'rgba(10, 6, 4, 0.9)';
    g.lineWidth = 1.5;
    g.beginPath();
    if (square) g.rect(px - r, py - r, r * 2, r * 2);
    else g.arc(px, py, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    if (st.glyph) {
      g.fillStyle = '#fff';
      g.font = `bold ${Math.round(r * 1.25)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(st.glyph, px, py + 0.5);
    }
  }

  tick(dt: number): void {
    this.time += dt;
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.fullWrap.classList.toggle('show', this.open);
  }

  /** Draw the full-screen map with district names and the player. */
  drawFull(x: number, z: number, heading: number): void {
    if (!this.open) return;
    const W = (this.full.width = window.innerWidth);
    const H = (this.full.height = window.innerHeight);
    const g = this.fullCtx;
    g.fillStyle = '#0b1622';
    g.fillRect(0, 0, W, H);
    // Fit the mainland + island.
    const x0 = -800;
    const x1 = 2250;
    const z0 = -800;
    const z1 = 860;
    const s = Math.min((W * 0.92) / (x1 - x0), (H * 0.86) / (z1 - z0));
    const ox = (W - (x1 - x0) * s) / 2;
    const oz = (H - (z1 - z0) * s) / 2 + 20;
    const tm = (wx: number, wz: number): [number, number] => [ox + (wx - x0) * s, oz + (wz - z0) * s];
    const [sx0, sz0] = this.toMap(x0, z0);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.map, sx0, sz0, (x1 - x0) * PPM, (z1 - z0) * PPM, ox, oz, (x1 - x0) * s, (z1 - z0) * s);
    const tl = this.territoryLayer();
    if (tl) g.drawImage(tl, sx0, sz0, (x1 - x0) * PPM, (z1 - z0) * PPM, ox, oz, (x1 - x0) * s, (z1 - z0) * s);
    if (this.search) {
      const [cx, cz] = tm(this.search.x, this.search.z);
      g.fillStyle = 'rgba(80, 140, 255, 0.15)';
      g.strokeStyle = 'rgba(120, 170, 255, 0.95)';
      g.lineWidth = 2;
      g.setLineDash([8, 5]);
      g.beginPath();
      g.arc(cx, cz, this.search.r * s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.setLineDash([]);
    }
    // District labels.
    const labels: [District, number, number][] = [
      ['midtown', 170, -20],
      ['oldtown', -480, 0],
      ['harbour', 360, 520],
      ['industrial', -380, 520],
      ['hills', -200, -520],
      ['park', 520, -620],
      ['island', 1720, 200],
    ];
    g.textAlign = 'center';
    for (const [d, lx, lz] of labels) {
      const [a, b] = tm(lx, lz);
      g.font = `600 ${Math.max(12, Math.round(s * 34))}px system-ui, sans-serif`;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillText(DISTRICT_NAMES[d].toUpperCase(), a + 1, b + 1);
      g.fillStyle = '#e9dfc4';
      g.fillText(DISTRICT_NAMES[d].toUpperCase(), a, b);
    }
    const [bx, bz] = tm((BRIDGE.startX + BRIDGE.endX) / 2, BRIDGE.z - 40);
    g.font = `italic ${Math.max(11, Math.round(s * 24))}px system-ui, sans-serif`;
    g.fillStyle = '#9fb3c2';
    g.fillText('The Narrows Bridge', bx, bz);
    // Markers (hangouts, landmarks, crimes, police).
    for (const m of this.markers) {
      if (m.kind === 'thug') continue;
      const [a, b] = tm(m.x, m.z);
      this.drawMarker(g, a, b, this.markerStyle(m), m.kind === 'hangout', m.kind === 'police' ? 1 : 1.25);
      g.textAlign = 'center';
      g.textBaseline = 'alphabetic';
      if (m.label) {
        g.font = `600 ${Math.max(11, Math.round(s * 20))}px system-ui, sans-serif`;
        g.fillStyle = 'rgba(0,0,0,0.7)';
        g.fillText(m.label, a + 1, b - 11);
        g.fillStyle = m.kind === 'crime' ? '#ffd0c0' : m.kind === 'hangout' ? '#f0b4a8' : '#d8e6f5';
        g.fillText(m.label, a, b - 12);
      }
    }
    // Legend: gang colours.
    g.textAlign = 'left';
    g.font = '600 13px system-ui, sans-serif';
    this.legend.forEach((l, i) => {
      const ly = H - 110 + i * 20;
      g.fillStyle = l.color;
      g.fillRect(W - 300, ly - 10, 14, 14);
      g.fillStyle = '#e9e4d8';
      g.fillText(l.text, W - 278, ly + 2);
    });
    // Player.
    const [px, pz] = tm(x, z);
    g.save();
    g.translate(px, pz);
    g.rotate(-heading + Math.PI);
    g.fillStyle = '#f3d27a';
    g.strokeStyle = '#1a1206';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, -12);
    g.lineTo(8, 9);
    g.lineTo(0, 4);
    g.lineTo(-8, 9);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // Compass + scale.
    g.fillStyle = '#c9a45c';
    g.font = 'bold 16px system-ui, sans-serif';
    g.fillText('N ↑', W - 60, 50);
    const bar = 500 * s;
    g.fillRect(40, H - 40, bar, 3);
    g.font = '12px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('500 m', 40, H - 48);
  }
}
