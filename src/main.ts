/**
 * NIGHTWARDEN entry point.
 */
import { Game } from './core/Game';
import { events } from './core/EventBus';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const game = new Game(canvas);

// Debug / test hooks (used by tests/e2e.mjs).
declare global {
  interface Window {
    __NW: { game: Game; ready: boolean; error: string | null; events: typeof events };
  }
}
window.__NW = { game, ready: false, error: null, events };

game
  .init()
  .then(() => {
    window.__NW.ready = true;
  })
  .catch((err: unknown) => {
    console.error(err);
    window.__NW.error = String(err);
    const label = document.querySelector('.loading .label');
    if (label) label.textContent = `Failed to start: ${String(err)}`;
  });
