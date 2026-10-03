/**
 * Central asset loader. Tracks progress for the loading screen and caches results.
 * All URLs are relative to `import.meta.env.BASE_URL` so the build works under /nightwarden-game/.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { events } from './EventBus';

export const BASE = import.meta.env.BASE_URL;
export const assetUrl = (p: string): string => `${BASE}assets/${p}`;

export interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  /** glTF-style packed AO (r) / roughness (g) / metalness (b). */
  armMap: THREE.Texture;
}

type Job = { weight: number; done: boolean; label: string };

export class AssetLoader {
  private gltf = new GLTFLoader();
  private tex = new THREE.TextureLoader();
  private hdr = new HDRLoader();
  private cache = new Map<string, Promise<unknown>>();
  private jobs: Job[] = [];
  anisotropy = 8;

  constructor() {
    this.gltf.setMeshoptDecoder(MeshoptDecoder);
  }

  /** Register a progress job (also used for non-network work like city generation). */
  track<T>(label: string, weight: number, p: Promise<T>): Promise<T> {
    const job: Job = { weight, done: false, label };
    this.jobs.push(job);
    this.report(label);
    return p.then((v) => {
      job.done = true;
      this.report(label);
      return v;
    });
  }

  report(label: string): void {
    let total = 0;
    let done = 0;
    for (const j of this.jobs) {
      total += j.weight;
      if (j.done) done += j.weight;
    }
    events.emit('loading:progress', { progress: total ? done / total : 0, label });
  }

  loadGLTF(path: string): Promise<GLTF> {
    return this.cached(`gltf:${path}`, () =>
      this.track(path.split('/').pop() ?? path, 2, this.gltf.loadAsync(assetUrl(path))),
    );
  }

  loadTexture(path: string, srgb: boolean, repeat = true): Promise<THREE.Texture> {
    return this.cached(`tex:${path}:${srgb}`, () =>
      this.track(path.split('/').slice(-2).join('/'), 1, this.tex.loadAsync(assetUrl(path))).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = this.anisotropy;
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        return t;
      }),
    );
  }

  /** Load a Poly Haven-style PBR texture set from public/assets/textures/<id>/. */
  loadPbr(id: string): Promise<PbrSet> {
    return this.cached(`pbr:${id}`, async () => {
      const [map, normalMap, armMap] = await Promise.all([
        this.loadTexture(`textures/${id}/diff.webp`, true),
        this.loadTexture(`textures/${id}/nor.webp`, false),
        this.loadTexture(`textures/${id}/arm.webp`, false),
      ]);
      return { map, normalMap, armMap };
    });
  }

  loadHDR(path: string): Promise<THREE.DataTexture> {
    return this.cached(`hdr:${path}`, () =>
      this.track(path.split('/').pop() ?? path, 3, this.hdr.loadAsync(assetUrl(path))).then((t) => {
        t.mapping = THREE.EquirectangularReflectionMapping;
        return t;
      }),
    );
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.cache.set(key, p);
    }
    return p;
  }
}

export const assets = new AssetLoader();
