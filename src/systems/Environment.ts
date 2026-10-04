/**
 * Drives everything that depends on the clock and the weather each frame: shared shader
 * uniforms (wetness, wind, lit windows), fog density and the harbour fog bank, rain / splash /
 * lightning visuals, lens drops, night lights and the sky (via Atmosphere).
 */
import * as THREE from 'three';
import { clock } from './Clock';
import { weather, wind } from './Weather';
import { shared } from '../world/Materials';
import { WeatherFX } from '../render/WeatherFX';
import type { Renderer } from '../render/Renderer';
import type { World } from '../world/World';
import { settings } from '../core/Settings';

/** Piecewise-linear curve over the 24 h clock: [[hour, value], ...] (wraps). */
function curve(points: [number, number][], h: number): number {
  for (let i = 0; i < points.length; i++) {
    const [h1, v1] = points[i];
    const [h2, v2] = points[(i + 1) % points.length];
    const end = h2 <= h1 ? h2 + 24 : h2;
    const hh = h < h1 ? h + 24 : h;
    if (hh >= h1 && hh <= end) return v1 + ((v2 - v1) * (hh - h1)) / Math.max(1e-6, end - h1);
  }
  return points[0][1];
}

const OFFICE: [number, number][] = [[0, 0.06], [6.5, 0.1], [8, 0.62], [17.5, 0.62], [20, 0.3], [23, 0.1]];
const HOME: [number, number][] = [[0, 0.22], [2, 0.07], [5.5, 0.06], [7, 0.3], [9, 0.12], [17, 0.18], [19.5, 0.55], [22.5, 0.5]];
const SHOP: [number, number][] = [[0, 0.3], [7.5, 0.35], [8.5, 0.95], [20.5, 0.95], [22, 0.35]];

export class EnvironmentSystem {
  readonly fx: WeatherFX;
  private bankDrift = new THREE.Vector2();

  constructor(
    private readonly renderer: Renderer,
    private readonly world: World,
  ) {
    this.fx = new WeatherFX(world.heightTex, settings.q.rainDrops);
    renderer.scene.add(this.fx.group);
  }

  update(dt: number, focus: THREE.Vector3, drivingCam: boolean, paused: boolean): void {
    if (!paused) {
      clock.update(dt);
      weather.update(dt, this.renderer.camera.position.x, this.renderer.camera.position.z);
    }
    const h = clock.hours;
    shared.daylight.value = clock.daylight;
    shared.wetness.value = weather.wetness;
    shared.rain.value = weather.p.rain;
    shared.winLit.value.set(curve(OFFICE, h), curve(HOME, h), curve(SHOP, h));
    shared.wind.value.set(wind.dirX, wind.dirZ, wind.strength, wind.gust);
    // Fog: weather density and the harbour fog bank.
    const fog = this.renderer.fog;
    fog.set('uDensity', this.renderer.dbg.has('nofog') ? 0 : 0.0006 * weather.p.fog);
    fog.set('uMaxOpacity', THREE.MathUtils.clamp(0.85 + (weather.p.fog - 1) * 0.02, 0.85, 0.985));
    fog.set('uBank', weather.fogBank);
    this.bankDrift.x += wind.vector.x * dt * 0.0012 + dt * 0.0008;
    this.bankDrift.y += wind.vector.z * dt * 0.0012;
    fog.set('uBankDrift', this.bankDrift);
    // Rain, splashes, lightning.
    const skyAmb = clock.daylight * (1 - 0.6 * weather.p.overcast);
    this.fx.update(paused ? 0 : dt, weather.p.rain, this.renderer.camera, skyAmb, clock.night, weather.bolt, weather.time, weather.flash);
    this.renderer.setScreenDrops(drivingCam ? THREE.MathUtils.clamp((weather.p.rain - 0.1) * 1.2, 0, 1) : 0);
    this.world.updateEnvironment(dt, focus, weather.wetness);
  }
}
