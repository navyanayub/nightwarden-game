/**
 * Headless vehicle tuning: runs VehicleSim on a flat plane and prints acceleration,
 * top speed, braking distance, cornering and handbrake behaviour.
 * Run: npx tsx tools/tune-vehicle.ts
 */
import { physics, RAPIER, GROUPS_WORLD } from '../src/core/Physics';
import { VehicleSim } from '../src/vehicles/VehicleSim';

await physics.init();
physics.world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 1, 5000).setTranslation(0, -1, 0).setCollisionGroups(GROUPS_WORLD).setFriction(1));
const dt = 1 / 60;
const car = new VehicleSim(0, 0, 0, 0);
car.occupied = true;
const step = (inp: { throttle: number; brake: number; steer: number; handbrake: boolean }, n: number, log?: (t: number) => void) => {
  for (let i = 0; i < n; i++) {
    car.fixedUpdate(dt, inp);
    physics.step(dt);
    car.postStep();
    log?.(i * dt);
  }
};
const kmh = () => (car.speed * 3.6).toFixed(1);
const pos = () => car.chassis.translation();
step({ throttle: 0, brake: 0, steer: 0, handbrake: false }, 90);
console.log('settled y', pos().y.toFixed(3), 'rot', JSON.stringify(car.chassis.rotation()));
let t100 = -1;
let t = 0;
step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, 60 * 25, () => {
  t += dt;
  if (t100 < 0 && car.speed * 3.6 >= 100) t100 = t;
});
console.log('0-100 km/h', t100.toFixed(2), 's; speed after 25s', kmh(), 'gear', car.gear, 'pos z', pos().z.toFixed(0));
// Brake from current speed.
const z0 = pos().z;
let tb = 0;
step({ throttle: 0, brake: 1, steer: 0, handbrake: false }, 60 * 10, () => {
  if (car.speed > 0.3) tb += dt;
});
console.log('braking distance', (pos().z - z0).toFixed(1), 'm in', tb.toFixed(2), 's');
// Accelerate to ~60 km/h and turn.
step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, 60 * 5);
console.log('speed before turn', kmh());
const yaw0 = car.yaw;
step({ throttle: 0.4, brake: 0, steer: 1, handbrake: false }, 60 * 2);
const r = car.chassis.rotation();
console.log('after 2s full steer: speed', kmh(), 'yaw change', ((car.yaw - yaw0) * 180 / Math.PI).toFixed(0), 'deg, tilt', JSON.stringify({ x: r.x.toFixed(3), z: r.z.toFixed(3) }));
const lv = car.chassis.linvel();
// Handbrake turn.
step({ throttle: 1, brake: 0, steer: 0, handbrake: false }, 60 * 3);
const vBefore = car.chassis.linvel();
const y1 = car.yaw;
step({ throttle: 0.3, brake: 0, steer: 1, handbrake: true }, 60 * 1);
const v2 = car.chassis.linvel();
const heading = car.yaw;
const velDir = Math.atan2(v2.x, v2.z);
console.log('handbrake 1s: yaw change', ((heading - y1) * 180 / Math.PI).toFixed(0), 'slip angle', (((heading - velDir) * 180) / Math.PI).toFixed(0), 'speed', kmh(), JSON.stringify(vBefore), JSON.stringify(lv).length);
// Reverse.
step({ throttle: 0, brake: 1, steer: 0, handbrake: false }, 60 * 6);
console.log('reverse speed', kmh(), 'reversing', car.reversing);
console.log('upright', !car.upsideDown);
