/**
 * The three (original) gangs of Port Vellmoor and their grip on each district.
 *
 *  - Tidewater Crew — the Harbour: sea-green windbreakers and beanies, knives and pipes,
 *    teal vans and pickups.
 *  - Ashline Syndicate — Industrial: charcoal work jackets with hi-vis orange, pipes and
 *    brutes, dark SUVs.
 *  - Velvet Hand — Midtown: long burgundy / black coats, pistols and knives, black sedans.
 *
 * `Territory` keeps a 0..100 control value per gang per district. Clearing crimes and crews
 * lowers it; ignored crimes raise it; at zero the gang loses the district. Every 15 points
 * lost builds retaliation pressure that Crimes turns into ambushes and street patrols.
 */
import { events } from '../core/EventBus';
import type { District } from '../world/WorldConfig';
import type { VehicleKind } from '../vehicles/VehicleModels';
import type { HatKind, WeaponKind } from '../actors/Actor';

export type GangId = 'tidewater' | 'ashline' | 'velvet';
export const GANG_IDS: GangId[] = ['tidewater', 'ashline', 'velvet'];

export interface GangDef {
  id: GangId;
  name: string;
  short: string;
  home: District;
  /** UI / map colour. */
  color: string;
  /** Clothing: top colours, bottom colours, top styles (0 jacket, 1 tee, 2 coat, 3 sweater). */
  tops: [number, number, number][];
  accent: [number, number, number];
  bottoms: [number, number, number][];
  topStyles: number[];
  hats: HatKind[];
  weapons: Partial<Record<WeaponKind, number>>;
  bruteChance: number;
  shieldChance: number;
  vehicles: VehicleKind[];
  vehicleColors: [number, number, number][];
}

export const GANGS: Record<GangId, GangDef> = {
  tidewater: {
    id: 'tidewater',
    name: 'Tidewater Crew',
    short: 'Tidewater',
    home: 'harbour',
    color: '#2bb3a0',
    tops: [
      [0.05, 0.22, 0.2],
      [0.04, 0.16, 0.17],
      [0.07, 0.1, 0.14],
    ],
    accent: [0.1, 0.45, 0.38],
    bottoms: [
      [0.05, 0.06, 0.09],
      [0.08, 0.08, 0.1],
    ],
    topStyles: [0, 0, 3],
    hats: ['beanie', 'beanie', 'none'],
    weapons: { knife: 3, pipe: 3, fists: 2, pistol: 1.5 },
    bruteChance: 0.4,
    shieldChance: 0.25,
    vehicles: ['van', 'pickup'],
    vehicleColors: [
      [0.05, 0.3, 0.3],
      [0.18, 0.26, 0.28],
    ],
  },
  ashline: {
    id: 'ashline',
    name: 'Ashline Syndicate',
    short: 'Ashline',
    home: 'industrial',
    color: '#e8762e',
    tops: [
      [0.08, 0.08, 0.085],
      [0.12, 0.11, 0.1],
      [0.06, 0.06, 0.065],
    ],
    accent: [0.6, 0.25, 0.04],
    bottoms: [
      [0.12, 0.1, 0.08],
      [0.07, 0.07, 0.07],
    ],
    topStyles: [0, 0, 1],
    hats: ['none', 'flatcap', 'beanie'],
    weapons: { pipe: 5, fists: 2, knife: 1, pistol: 1 },
    bruteChance: 0.65,
    shieldChance: 0.3,
    vehicles: ['suv'],
    vehicleColors: [
      [0.06, 0.06, 0.065],
      [0.2, 0.2, 0.21],
    ],
  },
  velvet: {
    id: 'velvet',
    name: 'Velvet Hand',
    short: 'Velvet Hand',
    home: 'midtown',
    color: '#c0466d',
    tops: [
      [0.22, 0.03, 0.08],
      [0.04, 0.035, 0.04],
      [0.14, 0.02, 0.06],
    ],
    accent: [0.45, 0.05, 0.15],
    bottoms: [
      [0.03, 0.03, 0.035],
      [0.06, 0.05, 0.06],
    ],
    topStyles: [2, 2, 0],
    hats: ['none', 'none', 'flatcap'],
    weapons: { pistol: 3, knife: 2, fists: 1 },
    bruteChance: 0.2,
    shieldChance: 0.15,
    vehicles: ['sedan', 'estate'],
    vehicleColors: [
      [0.02, 0.02, 0.025],
      [0.22, 0.02, 0.06],
    ],
  },
};

export const CONTROL_DISTRICTS: District[] = ['midtown', 'oldtown', 'harbour', 'industrial', 'hills', 'park', 'island'];

export class Territory {
  /** control[district][gang] = 0..100 (missing = 0). */
  readonly control: Record<string, Partial<Record<GangId, number>>> = {
    harbour: { tidewater: 80 },
    industrial: { ashline: 80 },
    midtown: { velvet: 75 },
    oldtown: { velvet: 45, ashline: 25 },
    park: { tidewater: 35 },
    hills: { ashline: 30 },
    island: { tidewater: 15 },
  };
  /** Points lost since the gang last retaliated. */
  readonly pressure: Record<GangId, number> = { tidewater: 0, ashline: 0, velvet: 0 };

  get(d: District | string, g: GangId): number {
    return this.control[d]?.[g] ?? 0;
  }

  /** The gang with the strongest grip on a district (null if nobody holds it). */
  owner(d: District | string): GangId | null {
    let best: GangId | null = null;
    let bv = 0;
    for (const g of GANG_IDS) {
      const v = this.get(d, g);
      if (v > bv) {
        bv = v;
        best = g;
      }
    }
    return best;
  }

  /** Total crime pressure in a district (0..1): sum of all control. */
  heat(d: District | string): number {
    let s = 0;
    for (const g of GANG_IDS) s += this.get(d, g);
    return Math.min(1, s / 100);
  }

  adjust(g: GangId, d: District | string, delta: number, reason: string): void {
    const c = (this.control[d] ??= {});
    const before = c[g] ?? 0;
    if (before <= 0 && delta < 0) return;
    const after = Math.max(0, Math.min(100, before + delta));
    c[g] = after;
    if (delta < 0) this.pressure[g] += before - after;
    events.emit('territory:change', { gang: g, district: d as District, control: after, delta: after - before, reason });
    if (before > 0 && after <= 0) events.emit('territory:lost', { gang: g, district: d as District });
  }

  /** Districts a gang still controls (any grip). */
  districtsOf(g: GangId): District[] {
    return CONTROL_DISTRICTS.filter((d) => this.get(d, g) > 0);
  }
}
