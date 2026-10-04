# NIGHTWARDEN

An original open-world action game for the web browser, set in the fictional coastal city of
**Port Vellmoor**. Built with three.js, Rapier physics and a modern post-processing stack.

**Stage 3 of 7 — the vigilante.** Press **V** to become the Nightwarden: a slate-grey
armoured suit with a hood, a half-mask with glowing pale-blue lenses, a silver crescent on the
chest and a long storm-grey cape that really moves — it streams when you run, billows when you
fall, whips about in storms, darkens and shines when wet, and snaps into a taut wing when you
glide.

- **Traversal**: vault low obstacles at a run, grab ledges, shimmy along them, climb up or drop;
  fire the **grapple gun** at a roof edge (aim assist shows a reticle) to zip up with a launch
  over the top; **hold Space in the air to glide** — dive to gain speed, pull up to trade it
  for height, ride the hot-air **updrafts** above chimneys and roof vents, and dive-bomb onto
  enemies to knock them down. Falls hurt unless you glide.
- **Freeflow combat**: strike in any direction and the hero lunges to the target; counter
  attackers when the yellow ⚡ warning appears (red ! = dodge instead); cape-stun, combo
  counter, finishers, a gadget wheel (smoke pellet, stun darts, disarm grapple), a combat camera
  and a slow-motion beat on the last knockout. Non-lethal: enemies are knocked out, never
  killed. Health and armour regenerate out of combat.
- **Gangs**: six hangouts around the city (red squares on the map) with thugs carrying fists,
  pipes, knives and pistols, heavy brutes and riot-shield thugs. They notice you (?), raise the
  alarm (!), call backup, gang up a couple at a time while the rest circle and flank, and run
  when the fight is lost.
- **Ragdolls** for everyone — thugs, pedestrians hit by your car and the hero — with get-ups
  from the front or the back. An optional gore setting (off by default) lets only extreme
  impacts detach limbs, cleanly sealed.

**Stage 2 — the living city.** Explore the whole city on foot and behind the wheel: the
glass towers of Midtown, the brick lanes and clock-tower square of Old Town, the cranes and
container yards of the Harbour, the chimneys and rail yard of the Industrial district, the
suburban streets of Northside Hills, the lake in Vellmoor Park, and Gullhaven Island's airfield
across the Narrows suspension bridge.

The streets are now alive:

- **Traffic** that obeys the traffic lights, queues, gives way, changes lanes and brakes for
  you and for pedestrians — compacts, hatchbacks, sedans, estates, SUVs, pickups, vans, taxis
  and Vellmar city buses that stop at bus stops. Take any car with **E** (if someone is
  driving, they get pulled out and run off).
- **Pedestrians** in hundreds of outfits who cross at the lights, sit on benches, wait for
  the bus, chat in groups, take phone calls, open umbrellas in the rain — and scream and run
  when a car mounts the pavement or a shot rings out.
- **A 24-hour day** (one game day = 24 real minutes): sunrise, golden evenings, starry nights
  with street lamps, lit windows, neon signs, headlights and the lighthouse beam.
- **Weather**: clear, partly cloudy, overcast, light rain, heavy rain, thunderstorms and fog,
  with wet reflective streets, wind in the trees and flags, lightning and dawn fog over the
  harbour.
- **Sound** everywhere: traffic, horns, sirens, rain, thunder, wind, footsteps, gulls, bells,
  crickets and an ambient soundtrack.

**Play:** `https://<github-username>.github.io/nightwarden-game/` (GitHub Pages serving `/docs`).

## How to play

1. Open the page and wait for the loading bar, then click **CLICK TO PLAY** (this captures the
   mouse for looking around).
2. You start as a civilian on a Midtown avenue. A dark-red **Corvane Strata** sedan is parked
   on the avenue right behind you — walk up to it and press **E** to drive. Or walk up to any
   car waiting at a red light and press **E** to take it.
3. Two more sedans (navy blue and silver) are parked on the Old Town clock-tower square and on
   the Harbour waterfront road.
4. The **minimap** (bottom left) turns with the camera; press **M** for the full city map. The
   clock and the weather are shown top right.
5. Press **V** to suit up as the Nightwarden. Gang hangouts are the red squares on the map
   (**M**) — walk or glide in and they will come for you.
6. Press **Esc** at any time to pause: pick a graphics preset, set the master / music /
   effects volume, choose how long a game day lasts and turn the gore option on or off.
   Press **H** for the controls.

### Controls

| On foot | |
| --- | --- |
| Move | **W A S D** (or arrow keys) |
| Look | **Mouse** |
| Sprint | **Shift** |
| Jump / vault / grab a ledge | **Space** |
| Enter a car / take a car from traffic | **E** (near a parked car or a slow / stopped one) |
| Civilian ⇄ Nightwarden | **V** |
| Camera zoom | **Mouse wheel** |

| Traversal (as the Nightwarden) | |
| --- | --- |
| Vault a low obstacle / mantle onto a low ledge | run into it (or press **Space**) |
| Grab a ledge | jump or fall at it |
| Ledge: shimmy / climb up / drop | **A D** / **W** or **Space** / **S** |
| Grapple to a roof edge (reticle shows the target) | **G** or **Right mouse** (not in combat) |
| Let go mid-zip (chain into a glide) | **Space** |
| Glide | hold **Space** in the air |
| Glide: dive / pull up / turn | **W** / **S** / **A D** |
| Updrafts | glide over chimneys and roof vents (rising steam) |
| Dive-bomb | dive steeply and land next to enemies |

| Combat | |
| --- | --- |
| Strike (aimed with the move keys, lunges to the target) | **Left mouse** |
| Counter (yellow ⚡ over an attacker) | **Q** |
| Dodge / roll (red ! = unblockable or gunfire) | **Space** |
| Cape stun (also breaks riot shields) | **C** |
| Finisher (combo 5+, on a stunned thug) | **F** |
| Gadget wheel (time slows; mouse or 1/2/3 to pick) | hold **Tab** |
| Use gadget: smoke pellet / stun darts / disarm grapple | **R** |

| Driving | |
| --- | --- |
| Accelerate | **W** |
| Brake / reverse | **S** (hold when stopped to reverse) |
| Steer | **A / D** |
| Handbrake (drift) | **Space** |
| Horn | **Q** |
| Headlights on/off | **L** |
| Look around | **Mouse** (camera re-centres behind the car) |
| Exit vehicle | **E** (below ~15 km/h) |

| General | |
| --- | --- |
| Controls panel | **H** |
| Pause menu (graphics, audio, day length, gore) | **Esc** (or **P**) |
| City map | **M** |
| Fast-forward time (hold) | **T** |
| Cycle the weather | **Y** |
| Test gunshot (debug: pedestrians react) | **F6** |
| Performance overlay (FPS, draw calls, triangles) | **F3** |

| Gamepad (standard mapping) | |
| --- | --- |
| Move / steer | Left stick |
| Look | Right stick |
| Throttle / brake | RT / LT |
| Jump / handbrake / glide (hold) | A |
| Strike / counter / cape stun | X / Y / B |
| Grapple / gadget wheel / use gadget | LB / LT / RT |
| Enter / exit | Y |
| Sprint | B or L3 |
| Horn / city map | D-pad down / D-pad right |
| Fast-forward time | D-pad left |
| Pause / controls | Start / Back |

### Graphics presets

| Preset | Aimed at | What changes |
| --- | --- | --- |
| Low | integrated GPUs | 0.75 render scale, 1K shadows over 45 m, no AO / bloom / interior mapping, 900 m draw distance, 2 real street lights, 40 cars / 70 people |
| Medium | entry-level GPUs | 2K shadows, fast AO, bloom, 1.4 km draw distance, 4 street lights, 60 cars / 110 people |
| High (default) | mid-range gaming PC, 60 fps | 4K shadows over 100 m, N8AO, 2.4 km draw distance, 1.5× pixel ratio cap, 8 street lights, 80 cars / 170 people |
| Ultra | high-end gaming PC | full-res AO, 150 m shadow range, 2× pixel ratio cap, whole-map draw distance, 12 street lights, 100 cars / 220 people |

The choice (and your audio volumes and day length) is saved in your browser. Car and crowd
numbers also follow the time of day (rush hours are busiest, the small hours quietest), the
district and the weather.

## Development

```bash
npm install
npm run dev        # http://localhost:5173/nightwarden-game/
npm run build      # type-check + static build into /docs
npm run preview    # serve /docs at http://localhost:4173/nightwarden-game/
npm run test:e2e   # headless Chromium: loads the game, fails on console errors, checks walking,
                   # driving, traffic, hijacking, crowds, time of day, weather, cape stability,
                   # ledges, grapple, glide, fights, ragdolls and gore
npm run screenshots   # + screenshots/
npm run perf          # performance log -> screenshots/perf-high.json (use --headed on a GPU machine)
```

See **CLAUDE.md** for architecture, conventions, budgets and the roadmap, and **CREDITS.md**
for every asset (all CC0).

## Roadmap

1. Foundations — engine, rendering, city, player, first car, UI ✅
2. Living city — traffic, pedestrians, day/night, weather, audio ✅
3. The vigilante — suit, cape physics, grapple, gliding, combat, ragdolls ✅
4. Crime and police
5. Dual identity
6. Every vehicle type
7. Polish, missions and saves

All names, brands, places and characters in NIGHTWARDEN are fictional and original.
