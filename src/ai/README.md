# ai/

Agents of the living city and its gangs.

- `LaneGraph.ts`, `Traffic.ts`, `TrafficRender.ts`, `SignalLights.ts` — traffic (Stage 2).
- `Crowd.ts`, `CrowdRender.ts`, `AnimBaker.ts` — GPU-instanced pedestrians (Stage 2); pedestrians
  struck by the player's car are handed to ragdoll actors (`actors/Actor.ts`).
- `Enemies.ts` — gang hangouts and thug AI (Stage 3): awareness, attack tokens, flanking,
  backup, fleeing, knockouts. Police arrive in Stage 4.
