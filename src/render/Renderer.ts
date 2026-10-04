/**
 * WebGL2 renderer + post-processing stack:
 * Render -> N8AO -> [height fog, bloom, AgX tone mapping, colour grade, vignette] -> SMAA.
 */
import * as THREE from 'three';
import {
  BloomEffect,
  BrightnessContrastEffect,
  EffectComposer,
  EffectPass,
  HueSaturationEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { settings, type QualitySettings } from '../core/Settings';
import { FogEffect } from './FogEffect';
import { Atmosphere } from './Atmosphere';

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  readonly atmosphere: Atmosphere;
  readonly fog = new FogEffect();
  private renderPass: RenderPass;
  private aoPass: N8AOPostPass;
  private bloom: BloomEffect;
  private smaa: SMAAEffect;
  private mainPass!: EffectPass;
  private smaaPass!: EffectPass;
  private toneMapping: ToneMappingEffect;
  private vignette: VignetteEffect;
  private grade: HueSaturationEffect;
  private contrast: BrightnessContrastEffect;
  private width = 1;
  private height = 1;
  /** Debug toggles from the URL (?nofog&noao&nobloom&noenv&noshadow) for isolating render issues. */
  readonly dbg = new URLSearchParams(location.search);

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: new URLSearchParams(location.search).has('capture'),
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = this.dbg.has('basicshadow') ? THREE.BasicShadowMap : this.dbg.has('vsm') ? THREE.VSMShadowMap : THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(62, 1, 0.3, settings.q.drawDistance);
    this.scene.add(this.camera);
    this.atmosphere = new Atmosphere(this.scene);

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.aoPass = new N8AOPostPass(this.scene, this.camera, 1, 1);
    this.aoPass.configuration.gammaCorrection = false;
    this.aoPass.configuration.aoRadius = 2.2;
    this.aoPass.configuration.distanceFalloff = 0.6;
    this.aoPass.configuration.intensity = 2.4;
    this.aoPass.configuration.color = new THREE.Color(0x0c0a10);
    this.composer.addPass(this.aoPass);

    this.bloom = new BloomEffect({ mipmapBlur: true, luminanceThreshold: 2.8, luminanceSmoothing: 0.4, intensity: 0.35, radius: 0.7 });
    this.toneMapping = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
    this.grade = new HueSaturationEffect({ saturation: 0.06, hue: 0 });
    this.contrast = new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.04 });
    this.vignette = new VignetteEffect({ darkness: 0.42, offset: 0.32 });
    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
    this.buildPasses();
    this.applyPreset(settings.q);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private buildPasses(): void {
    if (this.mainPass) this.composer.removePass(this.mainPass);
    if (this.smaaPass) this.composer.removePass(this.smaaPass);
    if (this.dbg.has('nofog')) this.fog.set('uDensity', 0);
    const effects = [this.fog, ...(settings.q.bloom && !this.dbg.has('nobloom') ? [this.bloom] : []), this.toneMapping, this.grade, this.contrast, this.vignette];
    this.mainPass = new EffectPass(this.camera, ...effects);
    this.smaaPass = new EffectPass(this.camera, this.smaa);
    this.composer.addPass(this.mainPass);
    this.composer.addPass(this.smaaPass);
  }

  applyPreset(q: QualitySettings): void {
    this.camera.far = q.drawDistance;
    this.camera.updateProjectionMatrix();
    this.atmosphere.setShadowQuality(q.shadows, q.shadowMapSize, q.shadowRadius);
    this.renderer.shadowMap.enabled = q.shadows && !this.dbg.has('noshadow');
    this.aoPass.enabled = q.ao !== false && !this.dbg.has('noao');
    if (q.ao) {
      this.aoPass.setQualityMode(q.ao);
      this.aoPass.configuration.halfRes = q.aoHalfRes;
    }
    const smaaPreset = { low: SMAAPreset.LOW, medium: SMAAPreset.MEDIUM, high: SMAAPreset.HIGH, ultra: SMAAPreset.ULTRA }[q.smaa];
    this.smaa.applyPreset(smaaPreset);
    this.buildPasses();
    this.resize();
    // Materials need recompiling when shadow maps toggle.
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      (Array.isArray(m) ? m : [m]).forEach((mm) => (mm.needsUpdate = true));
    });
  }

  resize(): void {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, settings.q.maxPixelRatio) * settings.q.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(this.width, this.height, false);
  }

  render(dt: number): void {
    this.renderer.info.reset();
    this.camera.updateMatrixWorld();
    this.fog.setCamera(this.camera);
    this.composer.render(dt);
  }
}
