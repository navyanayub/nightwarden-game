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
- **pmndrs postprocessing** + **N8AO**: RenderPass → N8AO → EffectPass(height fog + harbour
  fog bank + exposure, bloom, ACES filmic tone mapping, hue/saturation, contrast, vignette) →
  EffectPass(lens raindrops, only enabled in rain while driving) → SMAA.
- **WebAudio** (no library): PannerNode 3D sound, synthesised sources + Kenney CC0 samples.
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
    textures/<id>/         diff.webp, nor.webp (OpenGL normal), arm.webp (AO/rough/metal)
    models/props/          Poly Haven props (simplified, meshopt GLB)
    models/characters/     civilian_male.glb (player), crowd_{male,female}[_lod1|_lod2].glb,
                           hair_*.glb (6 styles), anim_locomotion.glb (16 clips)
    audio/                 Kenney footsteps / impacts (OGG)
docs/                      BUILD OUTPUT for GitHub Pages (committed every stage)
screenshots/               test screenshots (committed)
src/
  main.ts                  bootstrap + window.__NW debug/test handle
  core/                    Game (orchestrator), Loop (fixed timestep), Input, EventBus,
                           AssetLoader, Settings (graphics presets), Physics, Random (seeded)
  render/                  Renderer (post stack), Atmosphere (sky + stars + moon, sun/moon
                           light, shadows, dynamic sky-probe IBL), FogEffect (height fog,
                           aerial perspective, harbour fog bank, exposure), SkyShared,
                           WeatherFX (GPU rain, splashes, lightning bolt), ScreenDropsEffect
  world/                   WorldConfig, Terrain, CityLayout (street plan & specs), MeshBuilder,
                           Materials, BuildingGen, RoadGen, Landmarks, Props, Trees, Water,
                           Signage, NightLights (lamp light pool, light pools, wet streaks,
                           lighthouse beam), Flags, World (chunk streaming / LOD orchestration)
  player/                  Player (character, animation blending, controller), CameraRig
  vehicles/                VehicleModels (9 parametric procedural vehicles), VehicleSim
                           (headless physics, per-type spec), Vehicle (drivable + HeadlightRig)
  ai/                      LaneGraph (lanes, junction connections, conflicts, signal timing),
                           Traffic (IDM sim, junction logic, buses, spawning, crashes),
                           TrafficRender (instanced cars), SignalLights, Crowd (pedestrian
                           behaviours), CrowdRender (GPU-skinned instanced people), AnimBaker
  systems/                 Clock (24 h game clock, sun/moon), Weather (states, wind,
                           lightning, wetness), Environment (per-frame clock/weather wiring)
  ui/                      UI.ts + styles.css (loading, HUD clock/weather, speedometer, pause
                           with graphics/audio/day length, controls, F3), Minimap (+ M map)
  audio/                   AudioManager (buses, 3D sounds, synths, ambience, music)
  types/                   ambient type declarations (n8ao)
tests/
  e2e.mjs                  headless load + console-error check + functional checks + perf log
                           + screenshots
  shots.mjs                one-off screenshot: node tests/shots.mjs out.png "query" "cam" ms "js"
  perf.mjs                 performance log (perf-high.json)
  debug-eval.mjs           evaluate an expression in the running game (debug helper)
tools/
  fetch_assets.py          download raw CC0 assets into .cache/raw (gitignored)
  build-assets.mjs         optimise raw assets into public/assets
  inspect-gltf.mjs         print a glTF/GLB summary
  tune-vehicle.ts          headless vehicle handling report (npx tsx tools/tune-vehicle.ts)
  img-diff.mjs             mean pixel difference of two screenshots
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
  (`uExposure`, set by `Atmosphere` as eye adaptation: 0.5 at noon → ~1.9 at night), tone
  mapping in the EffectPass. Sky colour = Preetham (`SkyShared.skyColor`) flattened by
  overcast, darkened by weather, plus night sky, city light-pollution glow and lightning flash;
  the sky dome and the fog share it so the horizon and fog always match; keep `uSkyExposure`
  ≈ 0.4. **IBL is a dynamic sky probe** (sky dome + ground hemisphere → cube → PMREM,
  desaturated 40%) re-baked when the clock/weather moved enough (max 2×/s); it also feeds
  glass and water reflections (`Atmosphere.onProbe`). One directional light is the sun by day
  and the moon at night (swapped at the horizon). The shadow box (radius per preset) is
  centred slightly ahead of the camera and texel-snapped.
- **Time of day** (`systems/Clock.ts`): `clock.hours`, 1 game day = `dayMinutes` real minutes
  (24 default; pause menu / `?daymin=`), hold T = ×40. Solar model at 50° N (sunrise ≈ 05:25,
  sunset ≈ 18:35); `daylight`, `night`, `golden`, `activity()` (traffic/crowd density curve).
  Night: `lamp_glow` / `signs` / `neon_*` emissive ramps, lit-window fractions per hour
  (`shared.winLit`: offices / homes / shops), aviation lights blink (`light_red`), lighthouse
  beam, headlight beams, lamp pools.
- **Weather** (`systems/Weather.ts`): states clear, partly, overcast, lightrain, heavyrain,
  storm, fog; parameters ease towards the target; Markov change every 2–5 game hours; Y
  cycles. `wetness` builds with rain and dries slowly. **Global `wind`** (`dirX/dirZ`,
  `strength`, `gust`, `speed`, `vector`) — trees, flags, windsock, rain, clouds and the
  Stage 3 cape read it. Lightning strikes push flash pulses + a bolt + `weather:lightning`
  (thunder delayed by distance / 343 m/s). Harbour fog bank at dawn (`fogBank`, raymarched in
  `FogEffect`). `?weather=` forces a state.
- **Wet surfaces**: `patchMacro` darkens albedo, lowers roughness and (with `puddles: true` —
  asphalt, pavements, plaza, cobbles, markings) adds noise puddles with rain-ripple normals.
  Wet reflection streaks under lamps come from `NightLights`.
- **Street lights** (`world/NightLights.ts`): a fixed pool of `streetLights` PointLights (per
  preset) re-assigned to the nearest lamps (fade in/out, no shader recompiles); every other
  lamp gets an additive ground pool, a head glow sprite and a wet streak — 3 instanced draws.
- **Traffic** (`ai/`): `LaneGraph` builds 1–2 lanes per direction per segment (offsets match
  the markings), Bezier junction connections with lane discipline (inner = straight/left,
  outer = straight/right), U-turns at dead ends, conflict lists, and signal phases
  (`signalState`, 17 s green / 3 s amber / 2 s all-red per axis, per-node offset). The
  bridge carriageway is an extra segment ending in an island turning loop. `Traffic` runs IDM
  car-following on the route ahead (cars, red/amber lights, junction admission: conflicts,
  stop-sign stop, yield to oncoming, exit-lane space; impatience breaks deadlocks after 14 s),
  overtaking lane changes, obstacle corridor checks for the player / player car / pedestrians
  on the road, horns when blocked. Population = `settings.q.traffic` × hour activity ×
  district density; spawn out of view 90–250 m away, despawn > 330 m or unseen > 4 s beyond
  140 m. Cars within 70 m have kinematic cuboid bodies; a contact with the player's car above
  2.5 m/s turns a car into a dynamic wreck (hazards on). E near a slow car: `Game.takeTrafficCar`
  converts it to a full `Vehicle` (the driver flees via `player:hijack`); recycled when 350 m
  away. Three Vellmar buses loop through Midtown/Old Town (BFS over legal connections) and dwell
  9 s at bus stops (shelter props + colliders). `TrafficRender`: per kind one InstancedMesh each
  for paint (instance colour), glass, trim (vertex colours), lamps (instanced head / brake /
  indicator levels) and wheels; ~45 draws for any number of cars.
- **Vehicles**: `VehicleModels` lofts every body from cross-sections (hood/windshield/roof/rear
  glass/deck profile + wheel arches) from a `VehicleSpec` — compact (Halden Pip), hatchback
  (Marisco Vela), sedan (Corvane Strata), estate (Strata Tourer), SUV (Oberline Ridgeback),
  pickup (Tessaro Mule), van (Oberline Carrier), taxi (Vellmoor Cabs) and bus (Vellmar
  Citiline). `VehicleSim` takes the spec (mass, engine, top speed, dims, colliders).
- **Pedestrians**: `CrowdRender` skins InstancedMeshes on the GPU from `AnimBaker` textures
  (bone matrices per frame at 30 fps; phone / umbrella arm poses made with two-bone IK at
  load); per-instance clip rows + cross-fade, clothing styles/colours, skin tone, hair colour,
  height/girth; LOD0 < 20 m (blend, eyes, brows, shadows), LOD1 < 60 m (shadows), LOD2 < 160 m.
  `Crowd`: pavement rings around blocks, corner crossings (signal walk phase or traffic gap),
  benches, bus stops (board stopped buses), groups, phone calls, umbrellas in rain, bump
  reaction, flee/cower on `world:alarm` (car on pavement, crash, gunshot via F6 / `gunshot()`),
  dive away from a speeding car. Drivers of nearby traffic are drawn with the drive clip.
- **Audio** (`audio/AudioManager.ts`): master/music/effects gains (pause-menu sliders, saved);
  outside sounds pass a lowpass when the camera is in a car; RPM engine + skid; 6 pooled 3D
  traffic voices on the nearest cars; horns, distant sirens, district/time beds (traffic hum,
  murmur, sea, machinery, crickets, birds, gulls, wind, rain, roof rain), thunder delayed by
  distance, clock-tower chimes on the hour, harbour foghorn, screams, surface footsteps from the
  player's locomotion phase; generative ambient pad (day/night chords) on the music bus.
- **HUD**: clock + weather icon (top right), rotating minimap (bottom left, camera-up, zooms
  out with speed), M = full map (pauses the simulation).
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
- **Driving physics**: `VehicleSim` is DOM-free (tune with `npx tsx tools/tune-vehicle.ts`).
  RWD, auto gearbox estimate, speed-sensitive steering, handbrake drops rear grip, traction
  control and a yaw-stability assist so slides stay catchable. One `HeadlightRig` (2
  spotlights) follows the driven vehicle to keep the light count constant.

## Coding conventions

- TypeScript strict, no `any` unless unavoidable; no unused locals (build fails).
- Small focused modules; comment the *why* at the top of each file.
- All randomness seeded; all assets via `assets.*` with paths relative to `public/assets`.
- Units in metres/seconds/radians; yaw measured so that `atan2(dir.x, dir.z)` (0 = +Z).
- Don't block the frame: anything over ~4 ms must be time-sliced or done at load.
- New materials go in `MaterialLibrary`; new props register in `World.buildProps`.
- Keep `CREDITS.md` complete whenever an asset is added.

## Performance budget (target: 60 fps on High on a mid-range gaming PC, e.g. RTX 3060)

- Draw calls ≤ ~650 on High (Stage 1 city ~380–570 + traffic ~45 + crowd ~25 + lights/FX
  ~10), triangles ≤ ~3.5 M (crowd LODs: ~8.5k / 2.5k / 0.8k tris per person).
- Measured (`npm run perf`, High, busy Midtown, 94 cars / 71 in view, 175 people / 129
  drawn): whole `update` ≈ 2.3–3.6 ms CPU per frame, of which traffic ≈ 0.6–0.9 ms and crowd
  ≈ 0.4–0.7 ms; 560–665 draw calls; 3.2–3.8 M triangles (dense overhead views slightly exceed
  the 3.5 M target — crowd LOD distances / traffic far-LOD are the levers). Traffic instances
  ≈ 4.5–5.7k tris per car near, paint + lamps only beyond 160 m. 8 real street lights on High
  (2/4/8/12 by preset). Real GPU FPS has not been measured yet (headless = SwiftShader).
- Counts per preset (`traffic` / `pedestrians`): Low 40/70, Medium 60/110, High 80/170,
  Ultra 100/220 (scaled by hour, district and rain).
- Shadow map: one 4096² cascade (High), 100 m radius; Ultra 150 m.
- Texture budget: 1K tiling sets (2K asphalt), WebP; total `public/assets` < 150 MB (≈ 27 MB now).
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
node tools/build-assets.mjs [textures|props|character|crowd|animations|audio]
```

## Testing (required before finishing any stage)

```
npm run build
npm run test:e2e                 # headless load, zero console errors, functional checks
npm run screenshots              # + screenshots in /screenshots (street, skyline, harbour,
                                 #   driving, clock tower, bridge, park, hills, airfield, busy
                                 #   intersection, night skyline, rainy night street, sunset
                                 #   harbour, dawn fog, storm, vehicle line-up, crowd, umbrellas,
                                 #   UI incl. map) and screenshots/perf-e2e.json
node tests/e2e.mjs --screenshots --only=03 --preset=ultra --query=nofog   # options
W=960 H=540 node tests/shots.mjs /tmp/x.png "time=22&weather=heavyrain" "" 15000 "1"
npm run perf                     # High preset, 60+ cars / 150+ people in view ->
                                 #   screenshots/perf-high.json (+ --headed on a GPU machine)
```
- Headless uses SwiftShader (very slow: a frame takes seconds with Stage 2 lighting, so the
  full screenshot run takes over an hour). Functional checks step the simulation directly via
  `game.simulate(seconds)` / `game.warmAI(seconds)` with `input.forced`. The FPS in
  `perf-high.json` is SwiftShader's — only the CPU timings there are meaningful; measure real
  FPS with F3 on a GPU.
- Debug URL flags: `?preset=low|medium|high|ultra`, `?auto` (skip click-to-play),
  `?capture` (preserveDrawingBuffer), `?cam=x,y,z,tx,ty,tz`, `?time=h`, `?weather=state`,
  `?daymin=m`, `?norender` (logic only), `?nofog`, `?noao`, `?nobloom`, `?noenv`,
  `?noshadow`, `?basicshadow`, `?vsm`, `?fogdbg`.
- `window.__NW.game` exposes `setDebugCamera`, `teleportPlayer`, `enterVehicle`,
  `exitVehicle`, `simulate`, `primeWorld`, `autoDrive`, `setTime`, `setWeather`, `lightning`,
  `gunshot`, `warmAI`, `gotoJunction`, `takeNearestTraffic`, `traffic`, `crowd`, `env`, `perf`.
- Always inspect the screenshots yourself; fix anything flat, blocky, broken or too dark.

## Roadmap

1. **Stage 1 — Foundations (done)**: engine core, rendering, seeded Port Vellmoor with all
   districts, island airfield and suspension bridge, streaming/LOD, civilian player,
   drivable sedan, basic UI.
2. **Stage 2 — Living city (done)**: lane-graph traffic with signals, 9 vehicle types,
   buses, hijacking; GPU-skinned crowds with behaviours and reactions; 24 h day/night with
   night lighting; 7 weather states with rain, wet roads, lightning, wind, fog banks; 3D audio
   with ambience and music; minimap, full map, clock and weather HUD.
3. **Stage 3 — The vigilante**: suit, cape physics, grapple, gliding, combat, ragdolls.
4. **Stage 4 — Crime and police**.
5. **Stage 5 — Dual identity**.
6. **Stage 6 — Every vehicle type**.
7. **Stage 7 — Polish, missions and saves**.

## Known limitations / ideas for later stages

- Only one shadow cascade; distant shadows are absent (AO + fog carry depth).
- Building interiors are faked (interior mapping); no enterable buildings yet.
- The civilian's clothes are painted by shader on a base body (no cloth meshes yet).
- Glass, water and wet roads reflect the sky probe, not the city (no SSR); lamp reflections
  on wet roads are faked with streaks.
- Chunk generation runs on the main thread (time-sliced); a Web Worker would remove the
  remaining ~40 ms worst-case step.
- Pedestrians have no physics bodies (the player's car passes through; they dodge instead).
  Ragdolls arrive in Stage 3. Crowd navigation is pavement rings + crossings, not a navmesh:
  people never enter parks/plazas interiors except benches and groups.
- Traffic cars are kinematic until hit; a wreck stays where it stops until it despawns.
- No positional reverb/occlusion; sounds are mostly synthesised.
