/**
 * Canvas-drawn texture atlas for every piece of text in the city: fictional shop brands,
 * billboards, street name blades, the clock face and runway numbers. All names are original.
 */
import * as THREE from 'three';

export interface Brand {
  name: string;
  sub: string;
  bg: string;
  fg: string;
  accent: string;
  font: string;
}

export const BRANDS: Brand[] = [
  { name: 'KESTREL', sub: 'COFFEE ROASTERS', bg: '#1f3b2d', fg: '#f3e9d2', accent: '#c9a45c', font: 'Georgia, serif' },
  { name: 'Halvard & Sons', sub: 'TAILORS SINCE 1911', bg: '#2b2b33', fg: '#e8dcc0', accent: '#b8935a', font: 'Georgia, serif' },
  { name: 'BRIGHTWATER', sub: 'SAVINGS BANK', bg: '#0f2f57', fg: '#ffffff', accent: '#4fb3e8', font: 'Arial, sans-serif' },
  { name: 'NOVA', sub: 'PHARMACY', bg: '#ffffff', fg: '#0a8f5a', accent: '#0a8f5a', font: 'Arial, sans-serif' },
  { name: 'Marlowe Books', sub: 'NEW & SECOND-HAND', bg: '#5a1e1e', fg: '#f5e6c8', accent: '#d9b46a', font: 'Georgia, serif' },
  { name: 'QUAYSIDE', sub: 'FISH & CHIPS', bg: '#0c4a6e', fg: '#fff7e0', accent: '#f2b632', font: 'Arial Black, sans-serif' },
  { name: 'TIDEWELL', sub: 'GROCERS', bg: '#f4f0e6', fg: '#2f6b33', accent: '#d94f2b', font: 'Arial, sans-serif' },
  { name: 'CORVANE', sub: 'MOTORS', bg: '#111111', fg: '#e6e6e6', accent: '#e63a2e', font: 'Arial Black, sans-serif' },
  { name: 'LUMEN', sub: 'TELECOM', bg: '#5b2a86', fg: '#ffffff', accent: '#ffcc33', font: 'Arial, sans-serif' },
  { name: 'Saltmarsh Diner', sub: 'OPEN ALL HOURS', bg: '#d8443a', fg: '#fff3e0', accent: '#ffe08a', font: 'Georgia, serif' },
  { name: 'OKARA', sub: 'ELECTRONICS', bg: '#0a0a0a', fg: '#33d1ff', accent: '#33d1ff', font: 'Arial Black, sans-serif' },
  { name: 'Pellingham', sub: 'HOTEL', bg: '#2a2016', fg: '#e9cf8f', accent: '#e9cf8f', font: 'Georgia, serif' },
  { name: 'GREYHAVEN', sub: 'INSURANCE', bg: '#e9edf0', fg: '#253746', accent: '#3d7ea6', font: 'Arial, sans-serif' },
  { name: 'Rook & Rye', sub: 'BAKERY', bg: '#e8d5b0', fg: '#5a3418', accent: '#a0522d', font: 'Georgia, serif' },
  { name: 'ATLAS', sub: 'FREIGHT', bg: '#f2a900', fg: '#1a1a1a', accent: '#1a1a1a', font: 'Arial Black, sans-serif' },
  { name: 'VELLMOOR GAZETTE', sub: 'NEWS', bg: '#f5f2ea', fg: '#111111', accent: '#8a0f0f', font: 'Georgia, serif' },
  { name: 'Lantern Street', sub: 'CINEMA', bg: '#3a0d12', fg: '#ffd27a', accent: '#ffd27a', font: 'Georgia, serif' },
  { name: 'FENWICK', sub: 'HARDWARE', bg: '#2d4f2a', fg: '#f4f0d0', accent: '#e0c040', font: 'Arial, sans-serif' },
  { name: 'Ostrey', sub: 'FLOWERS', bg: '#f7e1e6', fg: '#7a2443', accent: '#3b7a3b', font: 'Georgia, serif' },
  { name: 'SPARROW', sub: 'CYCLES', bg: '#1d6fa3', fg: '#ffffff', accent: '#ffd400', font: 'Arial Black, sans-serif' },
  { name: 'The Copper Kettle', sub: 'TEA ROOM', bg: '#3b5d5a', fg: '#f2e2c4', accent: '#c58b4c', font: 'Georgia, serif' },
  { name: 'MERIDIAN', sub: 'TRAVEL', bg: '#ffffff', fg: '#c2185b', accent: '#00838f', font: 'Arial, sans-serif' },
  { name: 'Dunmore', sub: 'BUTCHERS', bg: '#7a1f1f', fg: '#ffffff', accent: '#f0d0a0', font: 'Georgia, serif' },
  { name: 'PIXELWAVE', sub: 'GAMES', bg: '#14002b', fg: '#ff4fd8', accent: '#4fffe0', font: 'Arial Black, sans-serif' },
];

/** Billboard campaigns (big rooftop / wall ads). */
export const ADS = [
  { title: 'LUMEN 9', line: 'Signal everywhere in Port Vellmoor.', bg: '#2b0f4a', fg: '#ffffff', accent: '#ffcc33' },
  { title: 'CORVANE STRATA', line: 'The new sedan. Built for the coast road.', bg: '#0d0d0d', fg: '#f0f0f0', accent: '#e63a2e' },
  { title: 'KESTREL COLD BREW', line: 'Wake the harbour.', bg: '#1f3b2d', fg: '#f3e9d2', accent: '#c9a45c' },
  { title: 'GULLHAVEN AIR', line: 'Daily flights from the island airfield.', bg: '#0b4f7c', fg: '#ffffff', accent: '#9fe0ff' },
  { title: 'BRIGHTWATER', line: 'Your city. Your savings.', bg: '#0f2f57', fg: '#ffffff', accent: '#4fb3e8' },
  { title: 'VELLMOOR FC', line: 'Season tickets on sale now.', bg: '#8a1020', fg: '#ffffff', accent: '#ffd700' },
];

const SLOT_W = 256;
const SLOT_H = 64;
const COLS = 8;

export class SignAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshStandardMaterial;
  private slots = 0;
  private brandSlot: number[] = [];
  private adRects: [number, number, number, number][] = [];
  private streetSlots = new Map<string, number>();
  private extra = new Map<string, [number, number, number, number]>();

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 2048;
    this.canvas.height = 2048;
    const g = this.canvas.getContext('2d')!;
    g.fillStyle = '#222';
    g.fillRect(0, 0, 2048, 2048);
    // Rows 0..7: brand shop signs (256x64 each).
    BRANDS.forEach((b) => this.brandSlot.push(this.drawBrand(g, b)));
    // Ads: 512x256 panels from y = 1024.
    ADS.forEach((ad, i) => {
      const x = (i % 4) * 512;
      const y = 1024 + Math.floor(i / 4) * 256;
      this.drawAd(g, ad, x, y);
      this.adRects.push([x, y, 512, 256]);
    });
    // Clock face 256x256 at (1024, 1536); runway numbers at (1280,1536).
    this.drawClock(g, 1024, 1536, 256);
    this.extra.set('clock', [1024, 1536, 256, 256]);
    this.drawRunway(g, 1280, 1536, '18');
    this.extra.set('rw18', [1280, 1536, 128, 256]);
    this.drawRunway(g, 1408, 1536, '36');
    this.extra.set('rw36', [1408, 1536, 128, 256]);
    this.drawPlate(g, 1536, 1536, 'VLM 4721');
    this.extra.set('plate', [1536, 1536, 256, 64]);
    this.drawText(g, 1536, 1600, 256, 64, 'PORT VELLMOOR', '#1b3a5c', '#ffffff');
    this.extra.set('welcome', [1536, 1600, 256, 64]);
    this.drawText(g, 1536, 1664, 256, 64, 'STOP', '#c0161b', '#ffffff');
    this.extra.set('stop', [1536, 1664, 256, 64]);
    this.drawText(g, 1536, 1728, 256, 64, 'GULLHAVEN AIRFIELD', '#0b4f7c', '#ffffff');
    this.extra.set('airfield', [1536, 1728, 256, 64]);
    this.drawText(g, 1536, 1792, 256, 64, 'VELLMAR LINES', '#c2410c', '#ffffff');
    this.extra.set('vellmar', [1536, 1792, 256, 64]);
    this.drawText(g, 1536, 1856, 256, 64, 'NORDSTRAND', '#0f5e75', '#ffffff');
    this.extra.set('nordstrand', [1536, 1856, 256, 64]);
    this.drawText(g, 1536, 1920, 256, 64, 'ATLAS FREIGHT', '#f2a900', '#1a1a1a');
    this.extra.set('atlas', [1536, 1920, 256, 64]);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      emissiveMap: this.texture,
      emissive: new THREE.Color(1, 1, 1),
      emissiveIntensity: 0.25,
      roughness: 0.45,
      metalness: 0.05,
    });
    this.material.name = 'signs';
  }

  private nextSlot(): [number, number] {
    const s = this.slots++;
    return [(s % COLS) * SLOT_W, Math.floor(s / COLS) * SLOT_H];
  }

  private drawBrand(g: CanvasRenderingContext2D, b: Brand): number {
    const idx = this.slots;
    const [x, y] = this.nextSlot();
    g.save();
    g.fillStyle = b.bg;
    g.fillRect(x, y, SLOT_W, SLOT_H);
    g.strokeStyle = b.accent;
    g.lineWidth = 3;
    g.strokeRect(x + 4, y + 4, SLOT_W - 8, SLOT_H - 8);
    g.fillStyle = b.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 30;
    g.font = `bold ${size}px ${b.font}`;
    while (g.measureText(b.name).width > SLOT_W - 24 && size > 12) {
      size -= 2;
      g.font = `bold ${size}px ${b.font}`;
    }
    g.fillText(b.name, x + SLOT_W / 2, y + SLOT_H * 0.42);
    g.fillStyle = b.accent;
    g.font = `bold 11px Arial, sans-serif`;
    g.fillText(b.sub, x + SLOT_W / 2, y + SLOT_H * 0.8);
    g.restore();
    return idx;
  }

  private drawAd(g: CanvasRenderingContext2D, ad: (typeof ADS)[number], x: number, y: number): void {
    const grd = g.createLinearGradient(x, y, x + 512, y + 256);
    grd.addColorStop(0, ad.bg);
    grd.addColorStop(1, '#000000');
    g.fillStyle = grd;
    g.fillRect(x, y, 512, 256);
    g.fillStyle = ad.accent;
    g.beginPath();
    g.arc(x + 420, y + 128, 90, 0, Math.PI * 2);
    g.globalAlpha = 0.35;
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = ad.fg;
    g.font = 'bold 54px Arial Black, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(ad.title, x + 28, y + 100, 460);
    g.font = '24px Arial, sans-serif';
    g.fillStyle = ad.accent;
    g.fillText(ad.line, x + 30, y + 170, 460);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 6;
    g.strokeRect(x + 3, y + 3, 506, 250);
  }

  private drawClock(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    const cx = x + s / 2;
    const cy = y + s / 2;
    g.fillStyle = '#1a1a1a';
    g.fillRect(x, y, s, s);
    g.fillStyle = '#efe8d6';
    g.beginPath();
    g.arc(cx, cy, s * 0.47, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#2a2a2a';
    g.lineWidth = 5;
    g.stroke();
    const numerals = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    g.fillStyle = '#1a1a1a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 20px Georgia, serif';
    numerals.forEach((n, i) => {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      g.save();
      g.translate(cx + Math.cos(a) * s * 0.37, cy + Math.sin(a) * s * 0.37);
      g.rotate(a + Math.PI / 2);
      g.fillText(n, 0, 0);
      g.restore();
    });
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const r0 = s * (i % 5 === 0 ? 0.42 : 0.44);
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * s * 0.46, cy + Math.sin(a) * s * 0.46);
      g.lineWidth = i % 5 === 0 ? 3 : 1;
      g.stroke();
    }
  }

  private drawRunway(g: CanvasRenderingContext2D, x: number, y: number, txt: string): void {
    g.fillStyle = '#333';
    g.fillRect(x, y, 128, 256);
    g.fillStyle = '#f4f4f4';
    g.font = 'bold 120px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.save();
    g.translate(x + 64, y + 128);
    g.scale(0.55, 1.6);
    g.fillText(txt, 0, 0);
    g.restore();
  }

  private drawPlate(g: CanvasRenderingContext2D, x: number, y: number, txt: string): void {
    g.fillStyle = '#f4f1e6';
    g.fillRect(x, y, 256, 64);
    g.fillStyle = '#1b4b9b';
    g.fillRect(x, y, 26, 64);
    g.fillStyle = '#111';
    g.font = 'bold 42px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(txt, x + 140, y + 34);
  }

  private drawText(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, txt: string, bg: string, fg: string): void {
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = 34;
    g.font = `bold ${size}px Arial, sans-serif`;
    while (g.measureText(txt).width > w - 16 && size > 10) {
      size -= 2;
      g.font = `bold ${size}px Arial, sans-serif`;
    }
    g.fillText(txt, x + w / 2, y + h / 2 + 1);
  }

  /** Street-name blade (white on green); allocated on first use. */
  streetUV(name: string): [number, number, number, number] {
    let slot = this.streetSlots.get(name);
    if (slot === undefined) {
      const g = this.canvas.getContext('2d')!;
      slot = this.slots;
      const [x, y] = this.nextSlot();
      if (y + SLOT_H > 1024) return this.toUV([1536, 1600, 256, 64]);
      this.drawText(g, x, y, SLOT_W, SLOT_H, name.toUpperCase(), '#1f5c3a', '#ffffff');
      g.strokeStyle = '#ffffff';
      g.lineWidth = 3;
      g.strokeRect(x + 3, y + 3, SLOT_W - 6, SLOT_H - 6);
      this.texture.needsUpdate = true;
      this.streetSlots.set(name, slot);
    }
    return this.slotUV(slot);
  }

  private custom = new Map<string, number>();

  /** A sign drawn in the brand style, allocated on first use (hospital, precinct, warehouses). */
  customUV(key: string, b: Brand): [number, number, number, number] {
    let slot = this.custom.get(key);
    if (slot === undefined) {
      slot = this.drawBrand(this.canvas.getContext('2d')!, b);
      this.custom.set(key, slot);
      this.texture.needsUpdate = true;
    }
    return this.slotUV(slot);
  }

  brandUV(i: number): [number, number, number, number] {
    return this.slotUV(this.brandSlot[i % this.brandSlot.length]);
  }

  adUV(i: number): [number, number, number, number] {
    return this.toUV(this.adRects[i % this.adRects.length]);
  }

  extraUV(key: string): [number, number, number, number] {
    return this.toUV(this.extra.get(key)!);
  }

  private slotUV(slot: number): [number, number, number, number] {
    const x = (slot % COLS) * SLOT_W;
    const y = Math.floor(slot / COLS) * SLOT_H;
    return this.toUV([x, y, SLOT_W, SLOT_H]);
  }

  /** Pixel rect -> [u0, v0, u1, v1] with v flipped for three's texture space. */
  private toUV(r: [number, number, number, number]): [number, number, number, number] {
    const [x, y, w, h] = r;
    const S = 2048;
    return [(x + 1) / S, 1 - (y + h - 1) / S, (x + w - 1) / S, 1 - (y + 1) / S];
  }
}

let atlas: SignAtlas | null = null;
export function signs(): SignAtlas {
  if (!atlas) atlas = new SignAtlas();
  return atlas;
}
