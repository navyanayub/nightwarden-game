/**
 * Fixed world constants for Port Vellmoor. Units are metres, +Y up, north = -Z, east = +X.
 */

export const SEA_LEVEL = 0;
/** Ground level of the flat city core. */
export const GROUND = 2.5;
/** Raised pavement height above the road. */
export const KERB = 0.15;

/** City land square half-size (the mainland is roughly 1.5 x 1.5 km). */
export const CITY_HALF = 750;

/** Terrain heightfield extents (covers mainland, harbour piers, island and bridge). */
export const TERRAIN = {
  minX: -1000,
  maxX: 2400,
  minZ: -1000,
  maxZ: 1200,
  cell: 4,
};

export const CHUNK_SIZE = 200;

export type District = 'midtown' | 'oldtown' | 'harbour' | 'industrial' | 'hills' | 'park' | 'island' | 'sea';

export const DISTRICT_NAMES: Record<District, string> = {
  midtown: 'Midtown',
  oldtown: 'Old Town',
  harbour: 'Harbour',
  industrial: 'Industrial',
  hills: 'Northside Hills',
  park: 'Vellmoor Park',
  island: 'Gullhaven Island Airfield',
  sea: 'Vellmoor Sound',
};

/** Park rectangle (no streets inside). */
export const PARK = { minX: 330, maxX: 700, minZ: -700, maxZ: -270 };
export const LAKE = { x: 520, z: -500, rx: 110, rz: 75, level: GROUND - 0.7 };

/** Island with airfield. */
export const ISLAND = { x: 1720, z: 40, rx: 470, rz: 760 };

/** Suspension bridge from the east seawall to the island. */
export const BRIDGE = {
  z: -85,
  startX: 560, // where the approach ramp leaves the city street
  endX: 1420, // where it returns to ground level on the island
  deckY: 18,
  towerX: [880, 1100] as const,
  towerTop: 92,
  width: 24,
};

/** Bridge deck road height along X (smooth ramps, flat main span). */
export function bridgeDeckY(x: number): number {
  const ramp = (a: number, b: number, t: number) => {
    const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  if (x <= BRIDGE.towerX[0]) return GROUND + (BRIDGE.deckY - GROUND) * ramp(BRIDGE.startX, BRIDGE.towerX[0], x);
  if (x >= BRIDGE.towerX[1]) return 3 + (BRIDGE.deckY - 3) * (1 - ramp(BRIDGE.towerX[1], BRIDGE.endX, x));
  return BRIDGE.deckY;
}

/** Harbour piers and breakwater: [minX, maxX, minZ, maxZ]. */
export const PIERS: [number, number, number, number][] = [
  [90, 190, 740, 930],
  [300, 410, 740, 980],
  [560, 600, 740, 1080],
];
export const LIGHTHOUSE = { x: 580, z: 1062 };

/** Grid lines every street plan must contain (district borders, bridge avenue, coast roads). */
export const FORCED_X = [-722, -230, 20, 330, 560, 722];
export const FORCED_Z = [-722, -270, BRIDGE.z, 240, 722];
/** Corner radius of the engineered (seawall) coastline. */
export const COAST_CORNER = 40;

export function districtAt(x: number, z: number): District {
  if (x > CITY_HALF + 120) return x > ISLAND.x - ISLAND.rx - 60 ? 'island' : 'sea';
  if (x >= PARK.minX && x <= PARK.maxX + 60 && z >= PARK.minZ - 60 && z <= PARK.maxZ) return 'park';
  if (z < PARK.maxZ) return 'hills';
  if (z >= 240) return x < 20 ? 'industrial' : 'harbour';
  if (x < -230) return 'oldtown';
  return 'midtown';
}
