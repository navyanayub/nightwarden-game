# NIGHTWARDEN

An original open-world action game for the web browser, set in the fictional coastal city of
**Port Vellmoor**. Built with three.js, Rapier physics and a modern post-processing stack.

**Stage 1 of 7** — explore the whole city on foot and behind the wheel: the glass towers of
Midtown, the brick lanes and clock-tower square of Old Town, the cranes and container yards of
the Harbour, the chimneys and rail yard of the Industrial district, the suburban streets of
Northside Hills, the lake in Vellmoor Park, and Gullhaven Island's airfield across the Narrows
suspension bridge.

**Play:** `https://<github-username>.github.io/nightwarden-game/` (GitHub Pages serving `/docs`).

## How to play

1. Open the page and wait for the loading bar, then click **CLICK TO PLAY** (this captures the
   mouse for looking around).
2. You start as a civilian on a Midtown avenue. A dark-red **Corvane Strata** sedan is parked
   on the avenue right behind you — walk up to it and press **E** to drive.
3. Two more sedans (navy blue and silver) are parked on the Old Town clock-tower square and on
   the Harbour waterfront road.
4. Press **Esc** at any time to pause and pick a graphics preset; press **H** for the controls.

### Controls

| On foot | |
| --- | --- |
| Move | **W A S D** (or arrow keys) |
| Look | **Mouse** |
| Sprint | **Shift** |
| Jump | **Space** |
| Enter / exit vehicle | **E** (near a car / when slow) |
| Camera zoom | **Mouse wheel** |

| Driving | |
| --- | --- |
| Accelerate | **W** |
| Brake / reverse | **S** (hold when stopped to reverse) |
| Steer | **A / D** |
| Handbrake (drift) | **Space** |
| Headlights on/off | **L** |
| Look around | **Mouse** (camera re-centres behind the car) |
| Exit vehicle | **E** (below ~15 km/h) |

| General | |
| --- | --- |
| Controls panel | **H** |
| Pause menu / graphics presets | **Esc** (or **P**) |
| Performance overlay (FPS, draw calls, triangles) | **F3** |

| Gamepad (standard mapping) | |
| --- | --- |
| Move / steer | Left stick |
| Look | Right stick |
| Throttle / brake | RT / LT |
| Jump / handbrake | A |
| Enter / exit | Y |
| Sprint | B or L3 |
| Pause / controls | Start / Back |

### Graphics presets

| Preset | Aimed at | What changes |
| --- | --- | --- |
| Low | integrated GPUs | 0.75 render scale, 1K shadows over 45 m, no AO / bloom / interior mapping, 900 m draw distance |
| Medium | entry-level GPUs | 2K shadows, fast AO, bloom, 1.4 km draw distance |
| High (default) | mid-range gaming PC, 60 fps | 4K shadows over 100 m, N8AO, 2.4 km draw distance, 1.5× pixel ratio cap |
| Ultra | high-end gaming PC | full-res AO, 150 m shadow range, 2× pixel ratio cap, whole-map draw distance |

The choice is saved in your browser.

## Development

```bash
npm install
npm run dev        # http://localhost:5173/nightwarden-game/
npm run build      # type-check + static build into /docs
npm run preview    # serve /docs at http://localhost:4173/nightwarden-game/
npm run test:e2e   # headless Chromium: loads the game, fails on console errors, checks walking/driving
npm run screenshots
```

See **CLAUDE.md** for architecture, conventions, budgets and the roadmap, and **CREDITS.md**
for every asset (all CC0).

## Roadmap

1. Foundations — engine, rendering, city, player, first car, UI ✅
2. Living city — traffic, pedestrians, day/night, weather, audio
3. The vigilante — suit, cape physics, grapple, gliding, combat, ragdolls
4. Crime and police
5. Dual identity
6. Every vehicle type
7. Polish, missions and saves

All names, brands, places and characters in NIGHTWARDEN are fictional and original.
