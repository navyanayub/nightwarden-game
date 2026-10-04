# systems/

Cross-cutting world systems: `Clock.ts` (24 h day), `Weather.ts` (states, wind, lightning,
wetness), `Environment.ts` (per-frame wiring of clock + weather into rendering and the world).
Missions, saves and the wanted level arrive in later stages. Chunk streaming / LOD lives in
`world/World.ts`; prop instancing in `world/Props.ts`.
