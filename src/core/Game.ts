/**
 * Top-level game: owns the loop, renderer, physics, world, player, vehicles, camera and UI.
 */
import * as THREE from 'three';
import { Loop } from './Loop';
import { Input } from './Input';
import { events } from './EventBus';
import { settings } from './Settings';
import { assets } from './AssetLoader';
import { physics } from './Physics';
import { Renderer } from '../render/Renderer';
import { World } from '../world/World';
import { Player } from '../player/Player';
import { CameraRig } from '../player/CameraRig';
import { Vehicle } from '../vehicles/Vehicle';
import { UI } from '../ui/UI';
import { AudioManager } from '../audio/AudioManager';
import { DISTRICT_NAMES, districtAt } from '../world/WorldConfig';
import { heightAt } from '../world/Terrain';
import { materials, shared } from '../world/Materials';

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
    canvas.addEventListener('click', () => {
      if (this.started && !this.ui.paused) this.input.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
      // Browsers consume the first Esc to release pointer lock: treat that as "pause".
      if (!document.pointerLockElement && this.started && !this.ui.paused && !this.ui.controlsOpen && !this.automation) this.pause();
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
    const envDone = job('Sky & lighting', 2);
    const hdr = await assets.loadHDR('hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr');
    this.renderer.atmosphere.setEnvironment(this.renderer.renderer, hdr);
    if (this.renderer.dbg.has('noenv')) this.renderer.scene.environmentIntensity = 0;
    envDone();
    const worldDone = job('Port Vellmoor', 12);
    this.world = new World(this.renderer.scene, this.renderer.renderer);
    await this.world.init(async (label) => {
      assets.report(label);
      await step(label);
    });
    // Sky-matched reflections for glass and water.
    this.bakeSkyReflections();
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

  private bakeSkyReflections(): void {
    const r = this.renderer;
    const skyScene = new THREE.Scene();
    const sky = r.atmosphere.sky.clone();
    skyScene.add(sky);
    const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const cubeCam = new THREE.CubeCamera(1, 1000, cubeRT);
    cubeCam.position.set(0, 2, 0);
    cubeCam.update(r.renderer, skyScene);
    const pmrem = new THREE.PMREMGenerator(r.renderer);
    const env = pmrem.fromCubemap(cubeRT.texture).texture;
    pmrem.dispose();
    materials.setReflectionEnv(env);
    this.world.setWaterEnv(env);
    cubeRT.dispose();
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
  }

  private update(dt: number, alpha: number): void {
    if (!this.ready) return;
    const input = this.input;
    input.update();
    // Global toggles.
    if (input.pressed('stats')) settings.showStats = !settings.showStats;
    if (input.pressed('controls') && this.started) this.ui.toggleControls();
    if (input.pressed('pause') && this.started) {
      if (this.ui.controlsOpen) this.ui.toggleControls(false);
      else if (this.ui.paused) this.resume();
      else this.pause();
    }
    if (!this.loop.paused) {
      const look = input.takeLook();
      if (this.started) this.rig.look(look.x, look.y);
      this.rig.zoom(input.takeWheel());
      if (input.consume('interact')) this.toggleVehicle();
      if (input.consume('lights') && this.current) {
        this.current.lightsOn = !this.current.lightsOn;
        this.ui.toast(this.current.lightsOn ? 'Headlights on' : 'Headlights off');
      }
    }
    for (const v of this.vehicles) v.update(dt, alpha);
    this.player.update(dt, alpha);
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
    this.ui.setPrompt(this.nearVehicle ? `<span class="key">E</span> Drive the Corvane Strata` : this.mode === 'drive' && this.current && Math.abs(this.current.sim.speed) < 4 ? `<span class="key">E</span> Exit vehicle` : null);
    // HUD.
    const cp = this.renderer.camera.position;
    const where = this.mode === 'drive' && this.current ? this.current.position : this.player.object.position;
    this.ui.setDistrict(DISTRICT_NAMES[districtAt(where.x, where.z)]);
    if (this.current) {
      const kmh = Math.abs(this.current.sim.speed) * 3.6;
      this.ui.setSpeedo(true, kmh, this.current.sim.gear < 0 ? 'R' : kmh < 1 && this.input.throttle === 0 ? 'N' : String(this.current.sim.gear), this.current.sim.rpm);
      this.audio.setEngine(true, this.current.sim.rpm, this.input.throttle);
    } else {
      this.ui.setSpeedo(false);
      this.audio.setEngine(false, 0, 0);
    }
    // World streaming & atmosphere.
    this.world.update(dt, cp);
    // Shadow box: centred a little ahead of the camera so the visible foreground gets shadows.
    const camFwd = new THREE.Vector3();
    this.renderer.camera.getWorldDirection(camFwd);
    camFwd.y = 0;
    if (camFwd.lengthSq() > 1e-6) camFwd.normalize();
    const shadowFocus = this.debugCam ? cp.clone().addScaledVector(camFwd, settings.q.shadowRadius * 0.6) : where.clone().addScaledVector(camFwd, settings.q.shadowRadius * 0.35);
    shadowFocus.y = heightAt(shadowFocus.x, shadowFocus.z);
    this.renderer.atmosphere.update(dt, shadowFocus, this.renderer.fog);
    shared.daylight.value = 1;
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
            `Pos ${where.x.toFixed(0)}, ${where.y.toFixed(1)}, ${where.z.toFixed(0)}`,
        );
      }
    } else this.ui.setStats(null);
    input.endFrame();
  }

  private render(dt: number): void {
    if (!this.ready) return;
    this.renderer.render(dt);
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

  /** Synchronously complete streaming around the current camera. */
  primeWorld(): number {
    this.world.prime(this.renderer.camera.position);
    return this.world.pendingDetail;
  }

  // ---------------------------------------------------------------- vehicles

  private toggleVehicle(): void {
    if (this.mode === 'foot' && this.nearVehicle) {
      const v = this.nearVehicle;
      this.current = v;
      v.occupied = true;
      this.mode = 'drive';
      this.player.driving = true;
      this.player.setEnabled(false);
      this.rig.setMode('vehicle', v.sim.yaw + Math.PI);
      this.ui.toast('Space = handbrake · L = headlights · E = exit');
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
      this.mode = 'foot';
      this.rig.setMode('foot', v.sim.yaw + Math.PI);
      events.emit('player:exitVehicle', { vehicleId: this.vehicles.indexOf(v) });
    }
  }
}
