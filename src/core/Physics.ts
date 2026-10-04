/**
 * Thin wrapper around the Rapier world: initialisation, collision groups and query helpers.
 * Rapier's heightfield layout: heights are column-major, rows along Z, columns along X.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

export { RAPIER };

/** Collision membership bits. */
export const G_WORLD = 0x0001;
export const G_PLAYER = 0x0002;
export const G_VEHICLE = 0x0004;
export const G_PROP = 0x0008;
/** Ragdoll limbs (dynamic bodies). */
export const G_RAGDOLL = 0x0010;
/** Enemy capsules (kinematic, moved by a character controller). */
export const G_ENEMY = 0x0020;

/** Pack Rapier interaction groups (membership << 16 | filter). */
export const groups = (membership: number, filter: number): number => ((membership & 0xffff) << 16) | (filter & 0xffff);

export const GROUPS_WORLD = groups(G_WORLD, 0xffff);
export const GROUPS_PROP = groups(G_PROP, G_PLAYER | G_VEHICLE | G_RAGDOLL | G_ENEMY);
export const GROUPS_PLAYER = groups(G_PLAYER, G_WORLD | G_VEHICLE | G_PROP);
export const GROUPS_VEHICLE = groups(G_VEHICLE, G_WORLD | G_VEHICLE | G_PLAYER | G_PROP | G_RAGDOLL);
// Ragdolls do not collide with each other (no self-collision between overlapping limbs).
export const GROUPS_RAGDOLL = groups(G_RAGDOLL, G_WORLD | G_VEHICLE | G_PROP);
export const GROUPS_ENEMY = groups(G_ENEMY, G_WORLD | G_PROP);
/** Traversal probes (ledges, vaults, grapple targets): solid world + props. */
export const GROUPS_PROBE = groups(0xffff, G_WORLD | G_PROP);
/** Camera rays only hit solid world geometry. */
export const GROUPS_CAMERA_RAY = groups(0xffff, G_WORLD);
/** Wheel suspension rays hit world + props, never the car itself. */
export const GROUPS_WHEEL_RAY = groups(0xffff, G_WORLD | G_PROP);

export class Physics {
  world!: RAPIER.World;
  private ready = false;
  private tmpRay!: RAPIER.Ray;

  async init(): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.tmpRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.ready = true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  step(dt: number): void {
    this.world.timestep = dt;
    this.world.step();
  }

  /** Fixed body with a box collider (centre, half extents, optional yaw). */
  addStaticBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw = 0, collisionGroups = GROUPS_WORLD): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setCollisionGroups(collisionGroups).setFriction(0.9);
    if (yaw !== 0) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      desc.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
    return this.world.createCollider(desc);
  }

  addStaticCylinder(cx: number, cy: number, cz: number, halfHeight: number, radius: number, collisionGroups = GROUPS_PROP): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cylinder(halfHeight, radius).setTranslation(cx, cy, cz).setCollisionGroups(collisionGroups);
    return this.world.createCollider(desc);
  }

  addTrimesh(vertices: Float32Array, indices: Uint32Array, collisionGroups = GROUPS_WORLD): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(collisionGroups).setFriction(0.9);
    return this.world.createCollider(desc);
  }

  /** Ray cast; returns distance or -1. */
  rayDistance(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, collisionGroups = GROUPS_CAMERA_RAY, exclude?: RAPIER.Collider): number {
    this.tmpRay.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.tmpRay.dir = { x: dir.x, y: dir.y, z: dir.z };
    const hit = this.world.castRay(this.tmpRay, maxDist, true, undefined, collisionGroups, exclude);
    return hit ? hit.timeOfImpact : -1;
  }

  /** Ray cast returning distance and surface normal (or null). */
  rayHit(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, collisionGroups = GROUPS_CAMERA_RAY): { dist: number; normal: THREE.Vector3; point: THREE.Vector3 } | null {
    this.tmpRay.origin = { x: origin.x, y: origin.y, z: origin.z };
    this.tmpRay.dir = { x: dir.x, y: dir.y, z: dir.z };
    const hit = this.world.castRayAndGetNormal(this.tmpRay, maxDist, true, undefined, collisionGroups);
    if (!hit) return null;
    const d = hit.timeOfImpact;
    return { dist: d, normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z), point: origin.clone().addScaledVector(dir, d) };
  }

  /** Sphere sweep for camera collision; returns safe distance along dir. */
  sphereCast(origin: THREE.Vector3, dir: THREE.Vector3, radius: number, maxDist: number, collisionGroups = GROUPS_CAMERA_RAY): number {
    const shape = new RAPIER.Ball(radius);
    const hit = this.world.castShape(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: dir.x, y: dir.y, z: dir.z },
      shape,
      0,
      maxDist,
      true,
      undefined,
      collisionGroups,
    );
    return hit ? hit.time_of_impact : maxDist;
  }
}

export const physics = new Physics();
