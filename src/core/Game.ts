/**
 * Top-level game: owns the loop, renderer, physics, world, player, vehicles, camera and UI.
 */
import * as THREE from 'three';
import { FIXED_DT, Loop } from './Loop';
import { Input } from './Input';
import { events } from './EventBus';
import { settings } from './Settings';
import { assets } from './AssetLoader';
import { physics, GROUPS_WORLD } from './Physics';
import { Renderer } from '../render/Renderer';
import { World } from '../world/World';
import { Player } from '../player/Player';
import { CameraRig } from '../player/CameraRig';
import { HeadlightRig, Vehicle } from '../vehicles/Vehicle';
import { UI } from '../ui/UI';
import { AudioManager } from '../audio/AudioManager';
import { DISTRICT_NAMES, districtAt } from '../world/WorldConfig';
import { heightAt, landSdf, terrainSplat } from '../world/Terrain';
import { materials } from '../world/Materials';
import { EnvironmentSystem } from '../systems/Environment';
import { clock } from '../systems/Clock';
import { weather, WEATHER_NAMES } from '../systems/Weather';
import { LaneGraph, signalState, type GNode } from '../ai/LaneGraph';
import { Traffic, type TrafficCar } from '../ai/Traffic';
import { SignalLights } from '../ai/SignalLights';
import { Crowd } from '../ai/Crowd';
import { Minimap } from '../ui/Minimap';

type Mode = 'foot' | 'drive';

export class Game {
  readonly renderer: Renderer;
  readonly input: Input;
  readonly ui: UI;
  readonly loop: Loop;
  readonly audio = new AudioManager();
  world!: World;
  player!: Player;
  rig!: CameraRig;
  vehicles: Vehicle[] = [];
  headlights!: HeadlightRig;
  env!: EnvironmentSystem;
  traffic!: Traffic;
  signals!: SignalLights;
  crowd!: Crowd;
  minimap!: Minimap;
  private nearTraffic: TrafficCar | null = null;
  private vehicleSerial = 0;
  mode: Mode = 'foot';
  current: Vehicle | null = null;
  ready = false;
  started = false;
  private nearVehicle: Vehicle | null = null;
  private statsTimer = 0;
  private debugCam: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    this.ui = new UI();
    this.loop = new Loop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt, a) => this.update(dt, a),
      render: (dt) => this.render(dt),
    });
    events.on('settings:preset', () => {
      this.renderer.applyPreset(settings.q);
      this.world?.applyPreset(settings.q);
    });
    this.ui.onStart = () => this.start();
    this.ui.onResume = () => this.resume();
    this.ui.onVolume = (k, v) => this.audio.setVolumes({ [k]: v });
    this.ui.onDayLength = (m) => clock.setDayMinutes(m);
    this.ui.setVolumes(this.audio.volumes);
    this.ui.setDayLength(clock.dayMinutes);
    canvas.addEventListener('click', () => {
      if (this.started && !this.ui.paused) this.input.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      // Browsers consume the first Esc to release pointer lock: treat that as "pause".
      if (!document.pointerLockElement && this.started && !this.ui.paused && !this.ui.controlsOpen && !this.minimap?.open && !this.automation) this.pause();
    });
  }

  /** True when driven by tests/tools (URL ?auto) — disables pointer-lock pause. */
  get automation(): boolean {
    return new URLSearchParams(location.search).has('auto');
  }

  async init(): Promise<void> {
    const step = async (label: string) => {
      events.emit('loading:progress', { progress: 0.5, label });
      await new Promise((r) => setTimeout(r, 0));
    };
    const job = (label: string, w: number) => {
      let done!: () => void;
      const p = new Promise<void>((r) => (done = r));
      assets.track(label, w, p);
      return done;
    };
    assets.anisotropy = settings.q.anisotropy;
    const physDone = job('Physics', 2);
    await physics.init();
    physDone();
    const worldDone = job('Port Vellmoor', 12);
    this.world = new World(this.renderer.scene, this.renderer.renderer);
    await this.world.init(async (label) => {
      assets.report(label);
      await step(label);
    });
    // Dynamic sky probe: IBL + glass/water reflections that follow the clock and weather.
    const atm = this.renderer.atmosphere;
    atm.onProbe = (tex) => {
      materials.setReflectionEnv(tex);
      this.world.setWaterEnv(tex);
    };
    if (this.renderer.dbg.has('noenv')) atm.envIntensity = 0;
    atm.initProbe(this.renderer.renderer);
    this.env = new EnvironmentSystem(this.renderer, this.world);
    worldDone();
    const playerDone = job('Characters', 3);
    this.player = new Player();
    await this.player.load();
    playerDone();
    this.renderer.scene.add(this.player.object);
    this.rig = new CameraRig(this.renderer.camera);
    const sp = this.world.city.spawn;
    this.player.spawn(sp.x, heightAt(sp.x, sp.z) + 0.2, sp.z, sp.yaw);
    this.rig.yaw = sp.yaw + Math.PI;
    // Three sedans in different colours.
    const colors = [new THREE.Color(0.42, 0.02, 0.03), new THREE.Color(0.03, 0.07, 0.18), new THREE.Color(0.72, 0.73, 0.74)];
    this.world.city.carSpots.forEach((s, i) => {
      const v = new Vehicle(`Sedan${i}`, colors[i % colors.length], s.x, heightAt(s.x, s.z) + 0.05, s.z, s.yaw);
      this.renderer.scene.add(v.object);
      this.vehicles.push(v);
    });
    this.headlights = new HeadlightRig(this.renderer.scene);
    // Traffic: lane graph, signals, bus stops, buses.
    const trafficDone = job('Traffic', 2);
    const graph = new LaneGraph(this.world.city);
    this.traffic = new Traffic(graph, settings.q.traffic);
    this.renderer.scene.add(this.traffic.render.group);
    this.signals = new SignalLights(this.world.city, graph);
    this.renderer.scene.add(this.signals.mesh);
    for (const st of this.traffic.busStops) {
      this.world.props.add({ type: 'bus_shelter', x: st.x, y: heightAt(st.x, st.z) + 0.15, z: st.z, yaw: st.yaw });
      const bx = st.x - Math.sin(st.yaw) * 0.75;
      const bz = st.z - Math.cos(st.yaw) * 0.75;
      physics.addStaticBox(bx, heightAt(st.x, st.z) + 1.4, bz, 2.1, 1.3, 0.12, st.yaw, GROUPS_WORLD);
    }
    this.traffic.spawnBuses(3);
    trafficDone();
    const crowdDone = job('Pedestrians', 3);
    this.crowd = new Crowd(this.world.city, this.traffic, settings.q.pedestrians);
    await this.crowd.load();
    this.renderer.scene.add(this.crowd.render.group);
    crowdDone();
    this.minimap = new Minimap(this.ui.root, this.world.city);
    // Debug camera from the URL (?cam=x,y,z,tx,ty,tz) for screenshots.
    const cam = new URLSearchParams(location.search).get('cam');
    if (cam) {
      const n = cam.split(',').map(Number);
      if (n.length >= 6) this.debugCam = { pos: new THREE.Vector3(n[0], n[1], n[2]), target: new THREE.Vector3(n[3], n[4], n[5]) };
    }
    // Warm-up: build nearby detail, compile shaders.
    const focus = this.debugCam ? this.debugCam.pos : this.player.position;
    this.world.prime(focus);
    this.renderer.renderer.compile(this.renderer.scene, this.renderer.camera);
    this.ready = true;
    this.ui.setLoadingDone();
    events.emit('loading:done');
    if (this.automation) this.start();
    this.loop.start();
  }

  start(): void {
    if (!this.ready || this.started) return;
    this.started = true;
    this.ui.hideLoading();
    this.audio.unlock();
    if (!this.automation) this.input.requestPointerLock();
    this.ui.toast('Welcome to Port Vellmoor — press H for controls');
  }

  pause(): void {
    this.loop.paused = true;
    this.ui.setPaused(true);
    this.input.exitPointerLock();
    this.audio.setPaused(true);
  }

  resume(): void {
    this.loop.paused = false;
    this.ui.setPaused(false);
    this.input.clearLatched();
    this.input.requestPointerLock();
    this.audio.setPaused(false);
  }

  // ---------------------------------------------------------------- loop

  private fixedUpdate(dt: number): void {
    if (!this.ready) return;
    if (this.mode === 'foot') this.player.fixedUpdate(dt, this.input, this.rig);
    for (const v of this.vehicles) {
      const drive = v === this.current ? this.autoDrive ?? { throttle: this.input.throttle, brake: this.input.brake, steer: this.input.moveX, handbrake: this.input.held('handbrake') } : null;
      v.fixedUpdate(dt, drive);
    }
    physics.step(dt);
    for (const v of this.vehicles) v.postStep();
    this.traffic?.detectCrashes();
  }

  /** Smoothed CPU timings (ms) for the F3 overlay and the perf log. */
  readonly perf = { update: 0, render: 0, traffic: 0, crowd: 0 };

  private update(dt: number, alpha: number): void {
    if (!this.ready) return;
    const t0 = performance.now();
    this.updateInner(dt, alpha);
    this.perf.update = this.perf.update * 0.9 + (performance.now() - t0) * 0.1;
  }

  private updateInner(dt: number, alpha: number): void {
    const input = this.input;
    input.update();
    // Global toggles.
    if (input.pressed('stats')) settings.showStats = !settings.showStats;
    if (input.pressed('controls') && this.started) this.ui.toggleControls();
    if (input.pressed('map') && this.started && !this.ui.paused) {
      this.minimap.toggle();
      this.loop.paused = this.minimap.open;
      if (this.minimap.open) this.input.exitPointerLock();
      else this.input.requestPointerLock();
    }
    if (input.pressed('pause') && this.started && this.minimap.open) {
      this.minimap.toggle(false);
      this.loop.paused = false;
      this.input.requestPointerLock();
    } else if (input.pressed('pause') && this.started) {
      if (this.ui.controlsOpen) this.ui.toggleControls(false);
      else if (this.ui.paused) this.resume();
      else this.pause();
    }
    if (!this.loop.paused) {
      const look = input.takeLook();
      if (this.started) this.rig.look(look.x, look.y);
      this.rig.zoom(input.takeWheel());
      if (input.consume('interact')) this.toggleVehicle();
      clock.fastForward = input.held('timeskip');
      if (input.consume('debugShot')) this.gunshot();
      if (input.consume('weather')) {
        weather.cycle();
        this.ui.toast(`Weather: ${WEATHER_NAMES[weather.state]}`);
      }
      if (input.consume('lights') && this.current) {
        this.current.lightsOn = !this.current.lightsOn;
        this.ui.toast(this.current.lightsOn ? 'Headlights on' : 'Headlights off');
      }
    }
    for (const v of this.vehicles) v.update(dt, alpha);
    this.headlights.update(this.current);
    this.updateTraffic(dt);
    this.player.update(dt, alpha);
    this.rescueFromWater();
    if (this.current) {
      // Seat the driver.
      const seat = this.current.parts.seat;
      seat.updateWorldMatrix(true, false);
      seat.getWorldPosition(this.player.object.position);
      this.player.object.position.y -= 0.42;
      this.player.object.quaternion.copy(this.current.object.quaternion);
      if (this.current.sim.upsideDown && Math.abs(this.current.sim.speed) < 1) this.current.sim.resetUpright();
    }
    // Camera.
    const focus = new THREE.Vector3();
    if (this.mode === 'drive' && this.current) {
      focus.copy(this.current.position).add(new THREE.Vector3(0, 1.45, 0));
      this.rig.vehicleYaw = this.current.sim.yaw + Math.PI;
      this.rig.vehicleSpeed = this.current.sim.speed;
    } else focus.copy(this.player.object.position).add(new THREE.Vector3(0, 1.62, 0));
    if (this.debugCam) {
      this.renderer.camera.position.copy(this.debugCam.pos);
      this.renderer.camera.lookAt(this.debugCam.target);
    } else this.rig.update(dt, focus);
    // Interaction prompt.
    this.nearVehicle = null;
    this.nearTraffic = null;
    if (this.mode === 'foot') {
      let best = 3.2;
      for (const v of this.vehicles) {
        const d = v.doorPosition().distanceTo(this.player.object.position);
        const d2 = v.position.distanceTo(this.player.object.position) - 1.2;
        const dd = Math.min(d, d2);
        if (dd < best) {
          best = dd;
          this.nearVehicle = v;
        }
      }
    }
    if (this.mode === 'foot' && !this.nearVehicle) {
      const pp = this.player.object.position;
      const t = this.traffic.nearest(pp.x, pp.z, 2.4);
      if (t && t.speed < 3 && Math.abs(t.y - pp.y) < 2.5) this.nearTraffic = t;
    }
    const label = (sp: { make: string; model: string }) => `${sp.make} ${sp.model}`;
    this.ui.setPrompt(
      this.nearVehicle
        ? `<span class="key">E</span> Drive the ${this.nearVehicle.label}`
        : this.nearTraffic
          ? `<span class="key">E</span> ${this.nearTraffic.driver && this.nearTraffic.state === 'drive' ? 'Take' : 'Drive'} the ${label(this.nearTraffic.spec)}`
          : this.mode === 'drive' && this.current && Math.abs(this.current.sim.speed) < 4
            ? `<span class="key">E</span> Exit vehicle`
            : null,
    );
    // HUD.
    const cp = this.renderer.camera.position;
    const where = this.mode === 'drive' && this.current ? this.current.position : this.player.object.position;
    this.ui.setDistrict(DISTRICT_NAMES[districtAt(where.x, where.z)]);
    if (this.current) {
      const kmh = Math.abs(this.current.sim.speed) * 3.6;
      this.ui.setSpeedo(true, kmh, this.current.sim.gear < 0 ? 'R' : kmh < 1 && this.input.throttle === 0 ? 'N' : String(this.current.sim.gear), this.current.sim.rpm);
      const sim = this.current.sim;
      const skid = Math.max(0, (sim.lateral - 2.5) / 6) + (this.input.held('handbrake') && Math.abs(sim.speed) > 4 ? 0.5 : 0);
      this.audio.setEngine(true, sim.rpm, this.autoDrive?.throttle ?? this.input.throttle, Math.min(1, skid));
      this.audio.setHorn(!this.loop.paused && this.input.held('horn'));
      if (this.input.pressed('horn')) events.emit('world:alarm', { x: this.current.position.x, z: this.current.position.z, radius: 6, kind: 'pavement' as const });
    } else {
      this.ui.setSpeedo(false);
      this.audio.setEngine(false, 0, 0);
      this.audio.setHorn(false);
    }
    this.updateAudio(dt, where);
    // Clock, weather and minimap.
    this.ui.setClock(clock.label(), weather.state, WEATHER_NAMES[weather.state], clock.night > 0.5);
    const cf = new THREE.Vector3();
    this.renderer.camera.getWorldDirection(cf);
    const camYaw = Math.atan2(cf.x, cf.z);
    const heading = this.mode === 'drive' && this.current ? this.current.sim.yaw : this.player.yaw;
    const zoom = this.mode === 'drive' && this.current ? Math.max(0.42, 0.8 - Math.abs(this.current.sim.speed) * 0.012) : 1;
    this.minimap.update(where.x, where.z, camYaw, heading, zoom, this.started && !this.ui.paused);
    this.minimap.drawFull(where.x, where.z, heading);
    // World streaming & atmosphere.
    this.world.update(dt, cp);
    // Shadow box: centred a little ahead of the camera so the visible foreground gets shadows.
    const camFwd = new THREE.Vector3();
    this.renderer.camera.getWorldDirection(camFwd);
    camFwd.y = 0;
    if (camFwd.lengthSq() > 1e-6) camFwd.normalize();
    const shadowFocus = this.debugCam ? cp.clone().addScaledVector(camFwd, settings.q.shadowRadius * 0.6) : where.clone().addScaledVector(camFwd, settings.q.shadowRadius * 0.35);
    shadowFocus.y = heightAt(shadowFocus.x, shadowFocus.z);
    this.env.update(dt, where, this.mode === 'drive' && !this.debugCam, this.loop.paused);
    this.renderer.atmosphere.update(dt, shadowFocus, this.renderer.fog, this.renderer.renderer);
    // Stats overlay.
    this.statsTimer -= dt;
    if (settings.showStats) {
      if (this.statsTimer <= 0) {
        this.statsTimer = 0.25;
        const info = this.renderer.renderer.info;
        this.ui.setStats(
          `FPS ${this.loop.fps.toFixed(0)}  (${this.loop.frameMs.toFixed(1)} ms)\n` +
            `Preset ${settings.preset.toUpperCase()}\n` +
            `Draw calls ${info.render.calls}\nTriangles ${(info.render.triangles / 1e6).toFixed(2)} M\n` +
            `Geometries ${info.memory.geometries}  Textures ${info.memory.textures}\n` +
            `Chunks building ${this.world.pendingDetail}\n` +
            `CPU update ${this.perf.update.toFixed(1)} ms (traffic ${this.perf.traffic.toFixed(1)}, crowd ${this.perf.crowd.toFixed(1)})  render ${this.perf.render.toFixed(1)} ms\n` +
            `Cars ${this.traffic.cars.length}  Pedestrians ${this.crowd.peds.length} (drawn ${this.crowd.render.stats.drawn})\n` +
            `${clock.label()}  ${WEATHER_NAMES[weather.state]}\n` +
            `Pos ${where.x.toFixed(0)}, ${where.y.toFixed(1)}, ${where.z.toFixed(0)}`,
        );
      }
    } else this.ui.setStats(null);
    input.endFrame();
  }

  private render(dt: number): void {
    if (!this.ready || this.renderer.dbg.has('norender')) return;
    const t0 = performance.now();
    this.renderer.render(dt);
    this.perf.render = this.perf.render * 0.9 + (performance.now() - t0) * 0.1;
  }

  // ---------------------------------------------------------------- automation hooks (tests/tools)

  /** three.js namespace for in-page debugging tools. */
  readonly __THREE = THREE;

  /** Override drive input (tests). */
  autoDrive: { throttle: number; steer: number; brake: number; handbrake: boolean } | null = null;

  setDebugCamera(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
    this.debugCam = { pos: new THREE.Vector3(px, py, pz), target: new THREE.Vector3(tx, ty, tz) };
    this.renderer.camera.position.copy(this.debugCam.pos);
    this.renderer.camera.lookAt(this.debugCam.target);
    this.world.prime(this.debugCam.pos);
  }

  /** Set the game clock (hours) and refresh the sky probe immediately (tests/tools). */
  setTime(hours: number): void {
    clock.set(hours);
    this.env.update(0, this.player.position, false, true);
    this.renderer.atmosphere.update(0, this.player.position, this.renderer.fog, this.renderer.renderer);
  }

  /** Force a weather state instantly (tests/tools). */
  setWeather(state: Parameters<typeof weather.set>[0]): void {
    weather.set(state, true);
  }

  /** Signal phase helper for tests. */
  readonly __signalState = signalState;

  /** Teleport next to the signalised junction nearest the spawn (tests / screenshots). */
  gotoJunction(): GNode {
    const s = this.world.city.spawn;
    const n = this.traffic.graph.nodes.filter((nd) => nd.signal).sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0];
    this.clearDebugCamera();
    this.teleportPlayer(n.x + n.road!.hx + 4, n.z + n.road!.hz + 4, Math.PI * 1.25);
    return n;
  }

  /** Enter (or hijack) the nearest traffic car (tests). */
  takeNearestTraffic(): void {
    if (this.mode !== 'foot') return;
    const p = this.player.position;
    this.nearVehicle = null;
    this.nearTraffic = this.traffic.nearest(p.x, p.z, 5);
    this.toggleVehicle();
  }

  /** Run traffic + crowd AI for a while without rendering (tests / screenshots). */
  warmAI(seconds: number): void {
    const cam = this.renderer.camera;
    for (let t = 0; t < seconds; t += 0.1) {
      this.traffic.update(0.1, this.player.position, cam, clock.activity(), 1 - 0.25 * weather.p.rain, clock.night);
      this.crowd.update(0.1, cam, this.player.position, this.mode === 'foot', null, Math.min(1, 0.12 + clock.activity() * 0.95), weather.p.rain, false);
    }
  }

  /** Debug: a gunshot near the player (pedestrians scream, flee or cower). */
  gunshot(): void {
    const p = this.player.position;
    events.emit('world:alarm', { x: p.x, z: p.z, radius: 60, kind: 'gunshot' });
    this.ui.toast('Bang! (debug gunshot)');
  }

  /** Release a held lightning flash (tests/tools). */
  releaseLightning(): void {
    weather.holdFlash = null;
  }

  /** Trigger a lightning strike near the camera (tests/tools); `hold` keeps it lit for screenshots. */
  lightning(hold = false): void {
    const f = new THREE.Vector3();
    this.renderer.camera.getWorldDirection(f);
    weather.strike(this.renderer.camera.position.x, this.renderer.camera.position.z, hold ? { x: f.x, z: f.z } : undefined);
    weather.holdFlash = hold ? 1.6 : null;
  }

  clearDebugCamera(): void {
    this.debugCam = null;
  }

  teleportPlayer(x: number, z: number, yaw: number, camYaw?: number): void {
    this.player.teleport(x, heightAt(x, z) + 0.25, z, yaw);
    this.rig.yaw = camYaw ?? yaw + Math.PI;
    this.rig.snap(new THREE.Vector3(x, heightAt(x, z) + 1.8, z));
    this.world.prime(new THREE.Vector3(x, 0, z));
  }

  enterVehicle(i: number): void {
    const v = this.vehicles[i];
    if (!v || this.mode === 'drive') return;
    this.nearVehicle = v;
    this.toggleVehicle();
  }

  /** Deterministically advance the simulation (tests): fixed steps without rendering. */
  simulate(seconds: number): void {
    const steps = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < steps; i++) {
      this.input.update();
      this.fixedUpdate(FIXED_DT);
      this.loop.time += FIXED_DT;
    }
    this.update(FIXED_DT, 1);
  }

  exitVehicle(): void {
    if (this.mode !== 'drive' || !this.current) return;
    this.current.sim.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.current.sim.speed = 0;
    this.toggleVehicle();
  }

  /** Synchronously complete streaming around the current camera. */
  primeWorld(): number {
    this.world.prime(this.renderer.camera.position);
    return this.world.pendingDetail;
  }

  /** Respawn the player (or the driven car) if it ends up in the sea. */
  private rescueFromWater(): void {
    const sp = this.world.city.spawn;
    if (this.mode === 'foot' && this.player.position.y < -1.5) {
      this.player.teleport(sp.x, heightAt(sp.x, sp.z) + 0.3, sp.z, sp.yaw);
      this.rig.snap(this.player.position.clone().setY(this.player.position.y + 1.6));
      this.ui.toast('You were pulled out of the water');
    }
    for (const [i, v] of this.vehicles.entries()) {
      if (v.sim.curPos.y > -2.5) continue;
      const spot = this.world.city.carSpots[i] ?? { ...this.world.city.spawn, yaw: 0 };
      if (v === this.current) this.exitVehicle();
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spot.yaw);
      v.sim.chassis.setTranslation({ x: spot.x, y: heightAt(spot.x, spot.z) + 1.2, z: spot.z }, true);
      v.sim.chassis.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      v.sim.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      v.sim.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.ui.toast('Vehicle recovered from the water');
    }
  }

  // ---------------------------------------------------------------- audio

  private clockTower: { x: number; z: number } | null = null;

  private updateAudio(dt: number, where: THREE.Vector3): void {
    if (!this.audio.ready) return;
    if (!this.clockTower) {
      const ct = this.world.city.features.find((f) => f.type === 'clocktower');
      this.clockTower = ct ? { x: ct.x, z: ct.z } : { x: 1e6, z: 1e6 };
    }
    const cam = this.renderer.camera.position;
    const cars: { x: number; y: number; z: number; speed: number; bus: boolean }[] = [];
    for (const c of this.traffic.cars) {
      if ((c.x - cam.x) ** 2 + (c.z - cam.z) ** 2 < 120 * 120) cars.push({ x: c.x, y: c.y, z: c.z, speed: c.speed, bus: !!c.bus });
    }
    let crowdNear = 0;
    for (const p of this.crowd.peds) if ((p.x - cam.x) ** 2 + (p.z - cam.z) ** 2 < 40 * 40) crowdNear++;
    const sdf = landSdf(cam.x, cam.z);
    this.audio.update(dt, {
      camera: this.renderer.camera,
      district: districtAt(where.x, where.z),
      night: clock.night,
      hour: clock.hours,
      rain: weather.p.rain,
      wind: (weather.p.wind * 14),
      fog: weather.p.fog,
      inCar: this.mode === 'drive' && !this.debugCam,
      sea: 1 - THREE.MathUtils.smoothstep(sdf, -20, 140),
      cars,
      crowdNear,
      screams: this.crowd.screams,
      clockDist: Math.hypot(this.clockTower.x - cam.x, this.clockTower.z - cam.z),
    });
    if (this.mode === 'foot') {
      const p = this.player.position;
      let surface: 'concrete' | 'grass' | 'wood' | 'snow' = 'concrete';
      const d = districtAt(p.x, p.z);
      if (!this.crowd.onPavement(p.x, p.z)) {
        const h = heightAt(p.x, p.z);
        const [g, sand] = terrainSplat(p.x, p.z, h, 0);
        if (sand > 0.5) surface = 'snow';
        else if ((d === 'park' || d === 'hills' || d === 'island') && g > 0.4) surface = 'grass';
      }
      this.audio.playerSteps(this.player.stepPhase, this.player.groundSpeed, surface, weather.wetness);
    }
  }

  // ---------------------------------------------------------------- traffic

  private updateTraffic(dt: number): void {
    const t = this.traffic;
    const obs = t.obstacles;
    obs.length = 0;
    if (this.mode === 'foot') obs.push({ x: this.player.position.x, z: this.player.position.z, r: 0.5, kind: 'player' });
    for (const v of this.vehicles) {
      const p = v.position;
      if (p.distanceToSquared(this.player.position) < 250 * 250) obs.push({ x: p.x, z: p.z, r: v.spec.width / 2 + (v === this.current ? 0.6 : 0.2), kind: 'car' });
    }
    for (const o of this.crowd.roadObstacles) obs.push(o);
    t.playerVehicleSpeed = this.current ? this.current.sim.speed : 0;
    const focus = this.mode === 'drive' && this.current ? this.current.position : this.player.position;
    const tt = performance.now();
    t.update(this.loop.paused ? 0 : dt, focus, this.renderer.camera, clock.activity(), 1 - 0.25 * weather.p.rain, clock.night);
    this.signals.update(t.time);
    t.draw(clock.night, this.renderer.camera.position);
    // Pedestrians.
    const cur = this.current;
    const carInfo = cur ? { x: cur.position.x, z: cur.position.z, speed: cur.sim.speed, yaw: cur.sim.yaw, onPavement: this.crowd.onPavement(cur.position.x, cur.position.z) } : null;
    const pedActivity = Math.min(1, 0.12 + clock.activity() * 0.95);
    const tc = performance.now();
    this.perf.traffic = this.perf.traffic * 0.9 + (tc - tt) * 0.1;
    this.crowd.update(dt, this.renderer.camera, this.player.position, this.mode === 'foot', carInfo, pedActivity, weather.p.rain, this.loop.paused);
    this.perf.crowd = this.perf.crowd * 0.9 + (performance.now() - tc) * 0.1;
    // Recycle cars the player took from traffic once they are far away.
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (!v.fromTraffic || v === this.current) continue;
      if (v.position.distanceTo(this.player.position) > 350) this.disposeVehicle(v);
    }
  }

  /** Turn a traffic car into a drivable vehicle (pulling the driver out if there is one). */
  private takeTrafficCar(car: TrafficCar): Vehicle {
    const hijack = car.driver && car.state === 'drive';
    const v = new Vehicle(`${car.spec.kind}-${++this.vehicleSerial}`, car.color, car.x, car.y + 0.05, car.z, car.yaw, car.spec);
    v.fromTraffic = true;
    this.renderer.scene.add(v.object);
    this.vehicles.push(v);
    this.traffic.remove(car);
    if (hijack) {
      const door = v.doorPosition();
      events.emit('player:hijack', { x: door.x, z: door.z });
      this.ui.toast(`You took the ${v.label} — the driver runs off`);
    }
    return v;
  }

  private disposeVehicle(v: Vehicle): void {
    this.renderer.scene.remove(v.object);
    physics.world.removeRigidBody(v.sim.chassis);
    v.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.vehicles.splice(this.vehicles.indexOf(v), 1);
  }

  // ---------------------------------------------------------------- vehicles

  private toggleVehicle(): void {
    if (this.mode === 'foot' && !this.nearVehicle && this.nearTraffic) {
      this.nearVehicle = this.takeTrafficCar(this.nearTraffic);
      this.nearTraffic = null;
    }
    if (this.mode === 'foot' && this.nearVehicle) {
      const v = this.nearVehicle;
      this.current = v;
      v.occupied = true;
      this.mode = 'drive';
      this.player.driving = true;
      this.player.setEnabled(false);
      this.rig.setMode('vehicle', v.sim.yaw + Math.PI);
      this.traffic.playerColliders = [];
      for (let i = 0; i < v.sim.chassis.numColliders(); i++) this.traffic.playerColliders.push(v.sim.chassis.collider(i));
      this.ui.toast('Space = handbrake · L = headlights · Q = horn · E = exit');
      events.emit('player:enterVehicle', { vehicleId: this.vehicles.indexOf(v) });
    } else if (this.mode === 'drive' && this.current) {
      const v = this.current;
      if (Math.abs(v.sim.speed) > 4) return;
      // Exit to the driver's side if free, else the passenger side.
      const door = v.doorPosition();
      const other = new THREE.Vector3(-(v.object.position.x - door.x), 0, -(v.object.position.z - door.z)).add(v.object.position);
      const free = (p: THREE.Vector3) => physics.rayDistance(new THREE.Vector3(v.position.x, v.position.y + 1, v.position.z), p.clone().setY(v.position.y + 1).sub(new THREE.Vector3(v.position.x, v.position.y + 1, v.position.z)).normalize(), p.distanceTo(v.position)) < 0;
      const exit = free(door) ? door : other;
      this.player.teleport(exit.x, Math.max(heightAt(exit.x, exit.z), v.position.y) + 0.15, exit.z, v.sim.yaw + Math.PI / 2);
      this.player.driving = false;
      this.player.setEnabled(true);
      v.occupied = false;
      this.current = null;
      this.traffic.playerColliders = [];
      this.mode = 'foot';
      this.rig.setMode('foot', v.sim.yaw + Math.PI);
      events.emit('player:exitVehicle', { vehicleId: this.vehicles.indexOf(v) });
    }
  }
}
