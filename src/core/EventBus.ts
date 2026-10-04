/**
 * Typed publish/subscribe bus. Systems talk through events instead of importing each other.
 * Add new events to `GameEvents` so every emit/on call stays type-checked.
 */
import type { GraphicsPreset } from './Settings';

export interface GameEvents {
  'loading:progress': { progress: number; label: string };
  'loading:done': void;
  'game:pause': void;
  'game:resume': void;
  'settings:preset': { preset: GraphicsPreset };
  'player:enterVehicle': { vehicleId: number };
  'player:exitVehicle': { vehicleId: number };
  'vehicle:speed': { kmh: number; rpm: number; gear: number };
  'ui:toggleControls': void;
  'ui:toggleStats': void;
  'world:chunkBuilt': { key: string };
  'weather:change': { state: string };
  'weather:lightning': { x: number; z: number; dist: number };
  /** A loud bang (gunshot, crash) that pedestrians react to. */
  'world:alarm': { x: number; z: number; radius: number; kind: 'gunshot' | 'crash' | 'pavement' };
  'traffic:horn': { x: number; z: number };
  'player:hijack': { x: number; z: number };
  // Stage 3: the vigilante.
  'player:hero': { on: boolean };
  /** Landing impact (m/s); `dive` = a dive-bomb landing from a glide. */
  'player:land': { x: number; y: number; z: number; speed: number; dive: boolean };
  'player:grapple': { x: number; y: number; z: number };
  'player:hurt': { amount: number; health: number };
  'player:ko': void;
  /** A melee impact (for audio): strength 0..1. */
  'combat:hit': { x: number; y: number; z: number; strength: number; blocked?: boolean };
  'combat:ko': { x: number; z: number; last: boolean };
  'combat:gadget': { kind: 'smoke' | 'dart' | 'disarm'; x: number; y: number; z: number };
}

type Handler<T> = (payload: T) => void;

export class EventBus {
  private handlers = new Map<keyof GameEvents, Set<Handler<unknown>>>();

  on<K extends keyof GameEvents>(type: K, handler: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<unknown>);
    return () => set!.delete(handler as Handler<unknown>);
  }

  emit<K extends keyof GameEvents>(type: K, ...payload: GameEvents[K] extends void ? [] : [GameEvents[K]]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) h(payload[0]);
  }
}

/** Shared singleton bus. */
export const events = new EventBus();
