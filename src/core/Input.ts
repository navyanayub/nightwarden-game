/**
 * Input manager: keyboard + mouse (pointer lock) + standard-mapping gamepads.
 * Game code queries *actions*, never raw keys, so rebinding and gamepad support stay central.
 */

export type Action =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'jump'
  | 'interact'
  | 'handbrake'
  | 'pause'
  | 'controls'
  | 'stats'
  | 'lights'
  | 'camera'
  | 'timeskip'
  | 'weather'
  | 'map'
  | 'horn'
  | 'debugShot';

const KEY_BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
  interact: ['KeyE'],
  handbrake: ['Space'],
  pause: ['Escape', 'KeyP'],
  controls: ['KeyH'],
  stats: ['F3'],
  lights: ['KeyL'],
  camera: ['KeyC'],
  timeskip: ['KeyT'],
  weather: ['KeyY'],
  map: ['KeyM'],
  horn: ['KeyQ'],
  debugShot: ['F6'],
};

// Standard gamepad mapping button indices.
const PAD_BINDINGS: Partial<Record<Action, number[]>> = {
  jump: [0],
  handbrake: [0, 5],
  interact: [3],
  sprint: [10, 1],
  pause: [9],
  controls: [8],
  lights: [12],
  camera: [11],
  map: [15],
  horn: [13],
  timeskip: [14],
};

export class Input {
  private down = new Set<string>();
  private pressedKeys = new Set<string>();
  private padDown = new Set<number>();
  private padPressed = new Set<number>();
  private latched = new Set<Action>();
  private mouseDX = 0;
  private mouseDY = 0;
  private wheel = 0;
  mouseButtons = 0;
  pointerLocked = false;
  /** Analog values from gamepad (or keyboard fallbacks). */
  moveX = 0;
  moveY = 0;
  lookX = 0;
  lookY = 0;
  throttle = 0;
  brake = 0;
  gamepadConnected = false;
  /** Scripted input for tests/tools (overrides keyboard & gamepad axes). */
  forced: { moveX?: number; moveY?: number; sprint?: boolean } | null = null;
  mouseSensitivity = 0.0022;
  invertY = false;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3' || e.code === 'F6' || e.code === 'Space' || e.code.startsWith('Arrow') || e.code === 'Tab') e.preventDefault();
      if (!this.down.has(e.code)) this.pressedKeys.add(e.code);
      this.down.add(e.code);
      for (const [action, keys] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) {
        if (keys.includes(e.code) && !e.repeat) this.latched.add(action);
      }
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    element.addEventListener('mousedown', (e) => {
      this.mouseButtons |= 1 << e.button;
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseButtons &= ~(1 << e.button);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.element;
    });
    window.addEventListener('gamepadconnected', () => (this.gamepadConnected = true));
    window.addEventListener('gamepaddisconnected', () => (this.gamepadConnected = false));
  }

  requestPointerLock(): void {
    if (document.pointerLockElement === this.element) return;
    try {
      const p = this.element.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    } catch {
      /* pointer lock unavailable (e.g. headless) */
    }
  }

  exitPointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Is the action currently held? */
  held(action: Action): boolean {
    if (action === 'sprint' && this.forced?.sprint) return true;
    for (const k of KEY_BINDINGS[action]) if (this.down.has(k)) return true;
    const pads = PAD_BINDINGS[action];
    if (pads) for (const b of pads) if (this.padDown.has(b)) return true;
    return false;
  }

  /** Was the action pressed this render frame? */
  pressed(action: Action): boolean {
    for (const k of KEY_BINDINGS[action]) if (this.pressedKeys.has(k)) return true;
    const pads = PAD_BINDINGS[action];
    if (pads) for (const b of pads) if (this.padPressed.has(b)) return true;
    return false;
  }

  /** Edge-triggered action that survives until consumed (safe to read from fixed-step code). */
  consume(action: Action): boolean {
    if (this.latched.has(action)) {
      this.latched.delete(action);
      return true;
    }
    return false;
  }

  /** Mouse delta since last call, scaled to radians. */
  takeLook(): { x: number; y: number } {
    const x = this.mouseDX * this.mouseSensitivity + this.lookX * 0.045;
    const y = (this.mouseDY * this.mouseSensitivity + this.lookY * 0.035) * (this.invertY ? -1 : 1);
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { x, y };
  }

  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Poll gamepads and rebuild analog axes. Call once at the start of each frame. */
  update(): void {
    this.padPressed.clear();
    let mx = 0;
    let my = 0;
    let lx = 0;
    let ly = 0;
    let rt = 0;
    let lt = 0;
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || pad.mapping !== 'standard') continue;
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      mx = dz(pad.axes[0] ?? 0);
      my = -dz(pad.axes[1] ?? 0);
      lx = dz(pad.axes[2] ?? 0);
      ly = dz(pad.axes[3] ?? 0);
      rt = pad.buttons[7]?.value ?? 0;
      lt = pad.buttons[6]?.value ?? 0;
      pad.buttons.forEach((b, i) => {
        if (b.pressed) {
          if (!this.padDown.has(i)) {
            this.padPressed.add(i);
            for (const [action, btns] of Object.entries(PAD_BINDINGS) as [Action, number[]][]) {
              if (btns.includes(i)) this.latched.add(action);
            }
          }
          this.padDown.add(i);
        } else this.padDown.delete(i);
      });
      break;
    }
    const kx = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    const ky = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    this.moveX = Math.abs(mx) > Math.abs(kx) ? mx : kx;
    this.moveY = Math.abs(my) > Math.abs(ky) ? my : ky;
    this.lookX = lx;
    this.lookY = ly;
    if (this.forced) {
      this.moveX = this.forced.moveX ?? this.moveX;
      this.moveY = this.forced.moveY ?? this.moveY;
    }
    this.throttle = Math.max(rt, this.held('forward') ? 1 : 0);
    this.brake = Math.max(lt, this.held('back') ? 1 : 0);
  }

  /** Clear per-frame edge state. Call at the end of each frame. */
  endFrame(): void {
    this.pressedKeys.clear();
  }

  /** Inject an edge-triggered action (tests/tools). */
  trigger(action: Action): void {
    this.latched.add(action);
  }

  clearLatched(): void {
    this.latched.clear();
  }
}
