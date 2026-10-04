/**
 * Graphics presets. Every quality knob in the game reads from `settings.q` so a preset
 * change can be applied live (see Renderer.applyPreset / World.applyPreset).
 */
import { events } from './EventBus';

export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  /** Multiplier on devicePixelRatio (clamped by maxPixelRatio). */
  renderScale: number;
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Half-size (m) of the sun shadow box that follows the player. */
  shadowRadius: number;
  ao: false | 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';
  aoHalfRes: boolean;
  bloom: boolean;
  smaa: 'low' | 'medium' | 'high' | 'ultra';
  /** Max distance (m) at which anything is drawn (camera far plane / chunk visibility). */
  drawDistance: number;
  /** Distance (m) within which chunks use full-detail geometry. */
  detailDistance: number;
  /** Distance (m) within which instanced props (lamps, benches...) are drawn. */
  propDistance: number;
  /** Distance (m) within which full 3D trees are drawn; beyond uses impostors. */
  treeDistance: number;
  anisotropy: number;
  /** Interior-mapped windows (otherwise flat reflective glass). */
  interiorMapping: boolean;
  /** Max chunk detail builds per frame. */
  buildBudgetMs: number;
  /** Real point lights assigned to the nearest street lamps at night. */
  streetLights: number;
  /** Max rain drops (GPU particles) in heavy rain. */
  rainDrops: number;
  /** Max simulated traffic cars / pedestrians around the player. */
  traffic: number;
  pedestrians: number;
}

export const PRESETS: Record<GraphicsPreset, QualitySettings> = {
  low: {
    renderScale: 0.75,
    maxPixelRatio: 1,
    shadows: true,
    shadowMapSize: 1024,
    shadowRadius: 45,
    ao: false,
    aoHalfRes: true,
    bloom: false,
    smaa: 'low',
    drawDistance: 900,
    detailDistance: 170,
    propDistance: 90,
    treeDistance: 110,
    anisotropy: 2,
    interiorMapping: false,
    buildBudgetMs: 4,
    streetLights: 2,
    rainDrops: 5000,
    traffic: 40,
    pedestrians: 70,
  },
  medium: {
    renderScale: 1,
    maxPixelRatio: 1,
    shadows: true,
    shadowMapSize: 2048,
    shadowRadius: 70,
    ao: 'Performance',
    aoHalfRes: true,
    bloom: true,
    smaa: 'medium',
    drawDistance: 1400,
    detailDistance: 240,
    propDistance: 140,
    treeDistance: 170,
    anisotropy: 4,
    interiorMapping: true,
    buildBudgetMs: 6,
    streetLights: 4,
    rainDrops: 9000,
    traffic: 60,
    pedestrians: 110,
  },
  high: {
    renderScale: 1,
    maxPixelRatio: 1.5,
    shadows: true,
    shadowMapSize: 4096,
    shadowRadius: 100,
    ao: 'Medium',
    aoHalfRes: true,
    bloom: true,
    smaa: 'high',
    drawDistance: 2400,
    detailDistance: 330,
    propDistance: 200,
    treeDistance: 240,
    anisotropy: 8,
    interiorMapping: true,
    buildBudgetMs: 8,
    streetLights: 8,
    rainDrops: 15000,
    traffic: 80,
    pedestrians: 170,
  },
  ultra: {
    renderScale: 1,
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 4096,
    shadowRadius: 150,
    ao: 'High',
    aoHalfRes: false,
    bloom: true,
    smaa: 'ultra',
    drawDistance: 3600,
    detailDistance: 480,
    propDistance: 300,
    treeDistance: 360,
    anisotropy: 16,
    interiorMapping: true,
    buildBudgetMs: 10,
    streetLights: 12,
    rainDrops: 22000,
    traffic: 100,
    pedestrians: 220,
  },
};

const STORAGE_KEY = 'nightwarden.settings.v1';

class Settings {
  preset: GraphicsPreset = 'high';
  q: QualitySettings = { ...PRESETS.high };
  showStats = false;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { preset?: GraphicsPreset };
        if (saved.preset && saved.preset in PRESETS) this.preset = saved.preset;
      }
    } catch {
      /* storage unavailable */
    }
    const url = new URLSearchParams(location.search).get('preset') as GraphicsPreset | null;
    if (url && url in PRESETS) this.preset = url;
    this.q = { ...PRESETS[this.preset] };
  }

  setPreset(preset: GraphicsPreset): void {
    this.preset = preset;
    this.q = { ...PRESETS[preset] };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset }));
    } catch {
      /* ignore */
    }
    events.emit('settings:preset', { preset });
  }
}

export const settings = new Settings();
