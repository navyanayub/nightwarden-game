# NIGHTWARDEN — project bible

Read this first in every session. Keep it accurate: update it whenever architecture,
conventions, budgets or the roadmap change.

## Vision

NIGHTWARDEN is an original open-world action game that runs in the browser, set in the
fictional coastal city of **Port Vellmoor**. The player will eventually live a dual life as a
civilian and as a masked vigilante (the Nightwarden). The visual bar is a good modern indie
open-world game: real 3D with a stylised-realistic look — PBR materials, real-time shadows,
image-based lighting, ambient occlusion, bloom, filmic tone mapping, fog and atmospheric depth.
Never voxels, never plain cubes, never flat low-poly.

## Originality rule (non-negotiable)

Every character, logo, name, vehicle, brand and place must be **original**. Do not imitate any
existing comic, film or game franchise (no recognisable heroes, cities, logos, costumes or car
designs). Use only fictional brand names (see `src/world/Signage.ts` for the current list:
Kestrel Coffee, Brightwater Savings Bank, Corvane Motors, Lumen Telecom, Vellmar Lines…).
Assets must be CC0 and listed in `CREDITS.md`.

## Tech stack

- **Vite 8 + TypeScript (strict)**, ES modules, no framework.
- **three.js r186** with `WebGLRenderer` (WebGL2).
- **Rapier** (`@dimforge/rapier3d-compat`, WASM inlined) — colliders, kinematic character
  controller, `DynamicRayCastVehicleController`.
- **pmndrs postprocessing** + **N8AO**: RenderPass → N8AO → EffectPass(height fog + exposure,
  bloom, ACES filmic tone mapping, hue/saturation, contrast, vignette) → SMAA.
- Asset pipeline: Python `requests` downloader + `@gltf-transform` / `meshoptimizer` / `sharp`.
- Tests: Playwright (Chromium, SwiftShader software WebGL in headless).

## Folder structure

```
CLAUDE.md, README.md, CREDITS.md
index.html                 entry HTML (canvas + #ui root)
vite.config.ts             base '/nightwarden-game/', outDir 'docs', assetsDir 'static'
public/
  .nojekyll                copied into docs/ so GitHub Pages serves everything
  favicon.svg
  assets/                  optimised CC0 assets (committed)
    hdri/                  Poly Haven HDRI (IBL)
    textures/<id>/         diff.webp, nor.webp (OpenGL normal), arm.webp (AO/rough/metal)
    models/props/          Poly Haven props (simplified, meshopt GLB)
    models/characters/     civilian_male.glb, hair_simpleparted.glb, anim_locomotion.glb
docs/                      BUILD OUTPUT for GitHub Pages (committed every stage)
screenshots/               test screenshots (committed)
src/
  main.ts                  bootstrap + window.__NW debug/test handle
  core/                    Game (orchestrator), Loop (fixed timestep), Input, EventBus,
                           AssetLoader, Settings (graphics presets), Physics, Random (seeded)
  render/                  Renderer (post stack), Atmosphere (sky, sun, shadows, IBL),
                           FogEffect (height fog + aerial perspective + exposure), SkyShared
  world/                   WorldConfig, Terrain, CityLayout (street plan & specs), MeshBuilder,
                           Materials, BuildingGen, RoadGen, Landmarks, Props, Trees, Water,
                           Signage, World (chunk streaming / LOD orchestration)
  player/                  Player (character, animation blending, controller), CameraRig
  vehicles/                VehicleSim (headless physics), SedanModel (procedural car), Vehicle
  ui/                      UI.ts + styles.css (loading, HUD, speedometer, pause, controls, F3)
  audio/                   AudioManager (WebAudio; engine synth + ambience)
  ai/                      (Stage 2+) traffic, pedestrians, police
  systems/                 (later) missions, saves, wanted level
  types/                   ambient type declarations (n8ao)
tests/
  e2e.mjs                  headless load + console-error check + functional checks + screenshots
  debug-eval.mjs           evaluate an expression in the running game (debug helper)
tools/
  fetch_assets.py          download raw CC0 assets into .cache/raw (gitignored)
  build-assets.mjs         optimise raw assets into public/assets
  inspect-gltf.mjs         print a glTF/GLB summary
  tune-vehicle.ts          headless vehicle handling report (npx tsx tools/tune-vehicle.ts)
```

## World facts (Port Vellmoor)

- Units are metres. +Y up, **north = −Z**, east = +X. Sea level y = 0, city ground y = 2.5,
  kerbs raise pavements 0.15 m.
- Mainland ≈ 1.5 × 1.5 km (|x|, |z| ≤ 750). Districts (see `districtAt` in `WorldConfig.ts`):
  Midtown (centre/east towers), Old Town (west, brick/stone, clock-tower square, cobbled lanes),
  Harbour (south-east quays, piers, gantry cranes, container yards, lighthouse on the
  breakwater), Industrial (south-west factories, chimneys, tanks, rail yard), Northside Hills
  (north, terrain up to ~30 m, suburban houses), Vellmoor Park (north-east, lake, paths,
  pavilion). Gullhaven Island airfield (runway 18/36, taxiway, hangars, terminal, tower) lies
  east, reached by the Narrows suspension bridge along z = −85 (towers at x = 880 / 1100).
- Everything is generated from `WORLD_SEED` in `src/core/Random.ts`. Never use `Math.random`
  in generation code — use `rngFor(...)` / `hashN(...)` so results don't depend on order.
- Street grid: forced lines in `FORCED_X/FORCED_Z`, remaining lines randomly spaced (~128 m);
  Old Town and Hills cells are split by lanes. Right-hand traffic.

## Architecture notes

- **Loop**: `Loop` runs `fixedUpdate` at 60 Hz (physics, player, vehicles; max 5 steps/frame),
  then `update(dt, alpha)` (input, interpolation, camera, streaming, HUD), then `render`.
- **Events**: add new event types to `GameEvents` in `core/EventBus.ts` (typed bus).
- **Input**: query actions (`held`, `pressed`, `consume`), never raw keys. Gamepads use the
  standard mapping. `input.forced` / `input.trigger()` script input for tests.
- **Rendering**: renderer does no tone mapping itself; exposure lives in `FogEffect`
  (`uExposure`), tone mapping in the EffectPass. Sky radiance is the Preetham model shared
  by the sky dome and the fog (`SkyShared.ts`) so the horizon and fog always match; keep
  `uSkyExposure` ≈ 0.4 (the model is already bright). The HDRI's sun is clamped out so the
  shadowed directional light dominates. The shadow box (radius per preset) is centred
  slightly ahead of the camera and texel-snapped.
- **Materials**: one shared library (`world/Materials.ts`). PBR sets tile in world metres
  (MeshBuilder UVs are metres; texture `repeat = 1/tile`). `patchMacro` adds low-frequency
  variation + base grime. Window glass is interior-mapped (`aWin` attribute = seed, width,
  height, style). `far_facade` draws procedural windows on impostor boxes.
- **Streaming / LOD** (`World.ts`, chunk = 200 m):
  terrain LOD0 (4 m grid) < 420 m < LOD1 (16 m); ground base merged per 3×3-chunk region;
  ground details (markings, signs) near; building **detail** generated lazily inside
  `detailDistance`, time-sliced by a generator (per building / facade side / mesh) within
  `buildBudgetMs`, disposed when far; **far impostor boxes** otherwise. Props are global
  InstancedMeshes rebuilt with near placements every ~8 m of camera movement; trees switch
  to baked billboard impostors beyond `treeDistance`.
- **Physics**: terrain heightfield (rows along Z, column-major), walkable trimesh per chunk for
  pavements/kerbs, cuboids for buildings/landmarks, cylinders for props, trimesh for the
  bridge deck. Collision groups in `core/Physics.ts`.
- **Player**: Quaternius base body dressed by a bind-space clothing shader; locomotion clips
  are phase-synchronised and blended by speed; jump/fall/land layers; Rapier kinematic
  character controller (autostep, snap-to-ground).
- **Vehicles**: `VehicleSim` is DOM-free (tune with `npx tsx tools/tune-vehicle.ts`). RWD,
  auto gearbox estimate, speed-sensitive steering, handbrake drops rear grip, traction control
  and a yaw-stability assist so slides stay catchable. One `HeadlightRig` (2 spotlights)
  follows the driven car to keep the light count constant.

## Coding conventions

- TypeScript strict, no `any` unless unavoidable; no unused locals (build fails).
- Small focused modules; comment the *why* at the top of each file.
- All randomness seeded; all assets via `assets.*` with paths relative to `public/assets`.
- Units in metres/seconds/radians; yaw measured so that `atan2(dir.x, dir.z)` (0 = +Z).
- Don't block the frame: anything over ~4 ms must be time-sliced or done at load.
- New materials go in `MaterialLibrary`; new props register in `World.buildProps`.
- Keep `CREDITS.md` complete whenever an asset is added.

## Performance budget (target: 60 fps on High on a mid-range gaming PC, e.g. RTX 3060)

- Draw calls ≤ ~600 on High (currently ~380–570 in Midtown), triangles ≤ ~3.5 M.
- Shadow map: one 4096² cascade (High), 100 m radius; Ultra 150 m.
- Texture budget: 1K tiling sets (2K asphalt), WebP; total `public/assets` < 150 MB (≈ 25 MB now).
- Chunk build steps: p95 < 5 ms, worst < 50 ms (measured).
- Presets (`core/Settings.ts`): Low / Medium / High / Ultra control render scale, pixel-ratio
  cap, shadow size & radius, AO quality/half-res, bloom, SMAA, draw / detail / prop / tree
  distances, interior mapping and build budget.

## Build & deploy

```
npm install
npm run dev          # http://localhost:5173/nightwarden-game/
npm run build        # tsc --noEmit + vite build -> docs/  (must have zero TS errors)
npm run preview      # serve docs/ at http://localhost:4173/nightwarden-game/
```
GitHub Pages: serve the `/docs` folder of the default branch; the site lives at
`https://<github-username>.github.io/nightwarden-game/`. `docs/.nojekyll` comes from `public/`.
**Rebuild and commit `/docs` at the end of every stage.**

Assets (only needed when adding/changing assets):
```
pip install requests && python3 tools/fetch_assets.py   # -> .cache/raw (gitignored)
node tools/build-assets.mjs [textures|props|character|animations]
```

## Testing (required before finishing any stage)

```
npm run build
npm run test:e2e                 # headless load, zero console errors, functional checks
npm run screenshots              # + screenshots in /screenshots (street, skyline, harbour,
                                 #   driving, clock tower, bridge, park, hills, airfield, UI)
node tests/e2e.mjs --screenshots --only=03 --preset=ultra --query=nofog   # options
```
- Headless uses SwiftShader (very slow: ~1 frame per few seconds). Functional checks therefore
  step the simulation directly via `game.simulate(seconds)` with `input.forced`.
- Debug URL flags: `?preset=low|medium|high|ultra`, `?auto` (skip click-to-play),
  `?capture` (preserveDrawingBuffer), `?cam=x,y,z,tx,ty,tz`, `?nofog`, `?noao`, `?nobloom`,
  `?noenv`, `?noshadow`, `?basicshadow`, `?vsm`, `?fogdbg`.
- `window.__NW.game` exposes `setDebugCamera`, `teleportPlayer`, `enterVehicle`,
  `exitVehicle`, `simulate`, `primeWorld`, `autoDrive`.
- Always inspect the screenshots yourself; fix anything flat, blocky, broken or too dark.

## Roadmap

1. **Stage 1 — Foundations (done)**: engine core, rendering, seeded Port Vellmoor with all
   districts, island airfield and suspension bridge, streaming/LOD, civilian player,
   drivable sedan, basic UI.
2. **Stage 2 — Living city**: traffic, pedestrians, day/night cycle, weather, audio.
   (Hooks: `shared.daylight`, `World.clockHours`, interior lights, lamp glow, `ai/`, `audio/`.)
3. **Stage 3 — The vigilante**: suit, cape physics, grapple, gliding, combat, ragdolls.
4. **Stage 4 — Crime and police**.
5. **Stage 5 — Dual identity**.
6. **Stage 6 — Every vehicle type**.
7. **Stage 7 — Polish, missions and saves**.

## Known limitations / ideas for later stages

- Only one shadow cascade; distant shadows are absent (AO + fog carry depth).
- Building interiors are faked (interior mapping); no enterable buildings yet.
- The civilian's clothes are painted by shader on a base body (no cloth meshes yet).
- Glass reflects the sky probe, not the city (consider a city cube-probe later).
- Chunk generation runs on the main thread (time-sliced); a Web Worker would remove the
  remaining ~40 ms worst-case step.
