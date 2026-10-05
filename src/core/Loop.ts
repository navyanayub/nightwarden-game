/**
 * Game loop with a fixed simulation timestep (physics, gameplay) and a variable
 * render step. `alpha` is the interpolation factor between the last two fixed states.
 */
export const FIXED_DT = 1 / 60;
const MAX_STEPS = 5;

export interface LoopCallbacks {
  /** Called 0..N times per frame with FIXED_DT. */
  fixedUpdate(dt: number): void;
  /** Called once per frame with the real (clamped) frame delta and interpolation alpha. */
  update(dt: number, alpha: number): void;
  render(dt: number): void;
}

export class Loop {
  private acc = 0;
  private last = 0;
  private running = false;
  private rafId = 0;
  /** Smoothed frames per second (for the F3 overlay). */
  fps = 60;
  frameMs = 16.7;
  paused = false;
  /** Seconds of simulated time since start. */
  time = 0;
  /** Rendered frames since start (for real, unclamped FPS measurements). */
  frames = 0;
  /** Simulation speed (slow motion < 1). Rendering still runs every frame. */
  timeScale = 1;
  /** Last real (unscaled, clamped) frame delta. */
  realDt = 1 / 60;

  constructor(private readonly cb: LoopCallbacks) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(tick);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Advance one frame manually (used by tests / tools). */
  frame(now: number): void {
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = FIXED_DT;
    dt = Math.min(dt, 0.1);
    this.frameMs = this.frameMs * 0.9 + dt * 1000 * 0.1;
    this.fps = 1000 / this.frameMs;
    this.realDt = dt;
    if (!this.paused) {
      this.acc += dt * this.timeScale;
      let steps = 0;
      while (this.acc >= FIXED_DT && steps < MAX_STEPS) {
        this.cb.fixedUpdate(FIXED_DT);
        this.acc -= FIXED_DT;
        this.time += FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS) this.acc = 0;
    }
    this.cb.update(this.paused ? 0 : dt * this.timeScale, this.acc / FIXED_DT);
    this.cb.render(dt);
    this.frames++;
  }
}
