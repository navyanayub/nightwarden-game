/**
 * Procedural broadleaf trees (bark branches + alpha-tested leaf cards with crown-spherical
 * normals and wind sway) and camera-facing impostor billboards baked from them at load.
 */
import * as THREE from 'three';
import { Rng } from '../core/Random';
import { MeshBuilder } from './MeshBuilder';
import { materials, shared } from './Materials';
import type { PropModel } from './Props';

function leafTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 512, 512);
  const rng = new Rng(4242);
  // Twigs.
  g.strokeStyle = 'rgba(70,52,35,1)';
  g.lineWidth = 3;
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    g.moveTo(256, 470);
    g.quadraticCurveTo(256 + rng.range(-120, 120), 300, 256 + rng.range(-220, 220), rng.range(60, 300));
    g.stroke();
  }
  for (let i = 0; i < 420; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * 210;
    const x = 256 + Math.cos(a) * r;
    const y = 240 + Math.sin(a) * r * 0.95;
    const len = rng.range(26, 44);
    const wid = len * rng.range(0.42, 0.55);
    const rot = rng.range(0, Math.PI * 2);
    const l = rng.range(26, 46);
    const h = rng.range(85, 112);
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.fillStyle = `hsl(${h}, ${rng.range(35, 55)}%, ${l}%)`;
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.quadraticCurveTo(0, -wid, len / 2, 0);
    g.quadraticCurveTo(0, wid, -len / 2, 0);
    g.fill();
    g.strokeStyle = `hsla(${h}, 40%, ${l - 12}%, 0.8)`;
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(-len / 2, 0);
    g.lineTo(len / 2, 0);
    g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let leafMat: THREE.MeshStandardMaterial | null = null;
function leafMaterial(): THREE.MeshStandardMaterial {
  if (leafMat) return leafMat;
  const m = new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.92, metalness: 0, envMapIntensity: 0.55, vertexColors: false });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.time;
    shader.uniforms.uWind = shared.wind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec4 uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 ip = vec3(0.0);
          #ifdef USE_INSTANCING
          ip = instanceMatrix[3].xyz;
          #endif
          // Wind: gusty sway plus a steady lean downwind (direction converted to tree space).
          vec3 wl = vec3(uWind.x, 0.0, uWind.y);
          #ifdef USE_INSTANCING
          wl = normalize(transpose(mat3(instanceMatrix)) * wl);
          #endif
          float str = 0.3 + uWind.z * 1.6 + uWind.w * 1.2;
          float sway = sin(uTime * (1.3 + uWind.z * 1.4) + ip.x * 0.15 + ip.z * 0.1 + position.y * 0.4) * 0.04 * str + sin(uTime * (3.1 + uWind.z * 3.0) + position.x * 2.0) * 0.015 * str;
          vec2 lean = wl.xz * (uWind.z * 0.1 + uWind.w * 0.12);
          transformed.xz += (vec2(sway, sway * 0.6) * mix(vec2(1.0), abs(wl.xz) + 0.3, uWind.z) + lean) * max(position.y - 2.0, 0.0) * 0.35;
        }`,
      );
    // Soft translucency: leaves facing away from the sun still receive some light.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      reflectedLight.indirectDiffuse *= 1.15;
      reflectedLight.directSpecular *= 0.3;
      reflectedLight.indirectSpecular *= 0.2;`,
    );
  };
  m.customProgramCacheKey = () => 'leaves';
  leafMat = m;
  return m;
}

/** Build one tree variant. Returns geometry parts (bark + leaves). */
function makeTree(seed: number, size: number, slim = false): { mb: MeshBuilder; leaves: THREE.BufferGeometry; height: number } {
  const rng = new Rng(seed);
  const mb = new MeshBuilder();
  const trunkH = rng.range(2.4, 3.4) * size;
  const trunkR = rng.range(0.16, 0.24) * size;
  const leafPos: number[] = [];
  const leafNor: number[] = [];
  const leafUv: number[] = [];
  const leafIdx: number[] = [];
  const crownC = new THREE.Vector3(0, trunkH + 2.6 * size, 0);
  const crownR = (slim ? 2.0 : 3.1) * size;
  const segs: [THREE.Vector3, THREE.Vector3, number, number][] = [];
  const branch = (start: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number) => {
    const end = start.clone().addScaledVector(dir, len);
    segs.push([start, end, r, r * 0.62]);
    if (depth >= 2 || len < 0.6) {
      leafCluster(end, rng.range(1.5, 2.3) * size);
      return;
    }
    const kids = depth === 0 ? rng.int(4, 6) : rng.int(2, 3);
    for (let k = 0; k < kids; k++) {
      const yaw = (k / kids) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const pitch = depth === 0 ? rng.range(0.45, 0.85) : rng.range(0.3, 0.9);
      const nd = new THREE.Vector3(Math.cos(yaw) * Math.sin(pitch), Math.cos(pitch), Math.sin(yaw) * Math.sin(pitch));
      nd.lerp(dir, 0.25).normalize();
      if (slim) nd.y += 0.6;
      nd.normalize();
      const from = start.clone().lerp(end, depth === 0 ? rng.range(0.7, 1.0) : rng.range(0.5, 1.0));
      branch(from, nd, len * rng.range(0.55, 0.75), r * 0.6, depth + 1);
      if (depth === 1) leafCluster(start.clone().lerp(end, 0.6), rng.range(1.2, 1.8) * size);
    }
  };
  const leafCluster = (c: THREE.Vector3, s: number) => {
    // 3 crossing cards.
    for (let k = 0; k < 3; k++) {
      const yaw = rng.range(0, Math.PI);
      const tilt = rng.range(-0.6, 0.6);
      const ax = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(ax, tilt);
      if (k === 2) up.set(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      const side = new THREE.Vector3().crossVectors(up, ax).normalize();
      const base = leafPos.length / 3;
      const corners = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      for (const [a, b] of corners) {
        const p = c.clone().addScaledVector(k === 2 ? ax : ax, a * s * 0.5).addScaledVector(k === 2 ? side : up, b * s * 0.5);
        leafPos.push(p.x, p.y, p.z);
        const n = p.clone().sub(crownC).normalize();
        n.y = n.y * 0.7 + 0.3;
        n.normalize();
        leafNor.push(n.x, n.y, n.z);
        leafUv.push((a + 1) / 2, (b + 1) / 2);
      }
      leafIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };
  const lean = new THREE.Vector3(rng.range(-0.08, 0.08), 1, rng.range(-0.08, 0.08)).normalize();
  // Trunk as a gently tapered lathe; branches as tapered tubes.
  mb.lathe('bark', 0, 0, [[trunkR * 1.5, -0.3], [trunkR * 1.25, 0.25], [trunkR, 0.8], [trunkR * 0.82, trunkH]], 8);
  branch(new THREE.Vector3(0, trunkH, 0), lean, (slim ? 3.6 : 2.6) * size, trunkR * 0.82, 0);
  // Fill the crown with extra clusters.
  for (let i = 0; i < (slim ? 10 : 18); i++) {
    const p = new THREE.Vector3(rng.range(-1, 1), rng.range(-0.6, 1), rng.range(-1, 1)).normalize().multiplyScalar(crownR * rng.range(0.45, 0.95));
    p.y *= slim ? 1.6 : 0.85;
    leafCluster(p.add(crownC), rng.range(1.6, 2.4) * size);
  }
  for (const [a, b, r0, r1] of segs) tube(mb, a, b, r0, r1);
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(leafPos, 3));
  leaves.setAttribute('normal', new THREE.Float32BufferAttribute(leafNor, 3));
  leaves.setAttribute('uv', new THREE.Float32BufferAttribute(leafUv, 2));
  leaves.setIndex(leafIdx);
  leaves.computeBoundingSphere();
  return { mb, leaves, height: crownC.y + crownR };
}

function tube(mb: MeshBuilder, a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number): void {
  const dir = b.clone().sub(a);
  const len = dir.length();
  dir.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const m = new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1));
  mb.pushTransform(m);
  mb.lathe('bark', 0, 0, [[r0, 0], [r1, len]], 6);
  mb.popTransform();
}

export interface TreeKit {
  models: PropModel[];
  impostor: THREE.MeshStandardMaterial;
  impostorFrames: number;
}

/** Build tree variants and bake impostor textures. */
export function buildTrees(renderer: THREE.WebGLRenderer, env: THREE.Texture | null): TreeKit {
  const variants = [
    makeTree(101, 1.0),
    makeTree(202, 1.15),
    makeTree(303, 0.9),
    makeTree(404, 0.75, true),
  ];
  const leaf = leafMaterial();
  const models: PropModel[] = variants.map((v) => {
    const g = v.mb.build(materials.m);
    const parts = g.children.map((c) => ({ geometry: (c as THREE.Mesh).geometry, material: (c as THREE.Mesh).material as THREE.Material, matrix: new THREE.Matrix4(), castShadow: true }));
    parts.push({ geometry: v.leaves, material: leaf, matrix: new THREE.Matrix4(), castShadow: true });
    return { parts, radius: 0.3, height: 3, range: 1 };
  });
  // Bake impostors: 4 variants side by side, each a front view (cylindrical billboard).
  const size = 256;
  const rt = new THREE.WebGLRenderTarget(size * variants.length, size, { samples: 4 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.environment = env;
  scene.environmentIntensity = 0.9;
  const sun = new THREE.DirectionalLight(0xffffff, 3.2);
  sun.position.set(0.4, 1, 0.8);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x3a3020, 0.6));
  const cam = new THREE.OrthographicCamera(-5, 5, 10, 0, 0.1, 100);
  cam.position.set(0, 0, 30);
  const prevTarget = renderer.getRenderTarget();
  const prevViewport = renderer.getViewport(new THREE.Vector4());
  const prevScissor = renderer.getScissor(new THREE.Vector4());
  const prevScissorTest = renderer.getScissorTest();
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  variants.forEach((v, i) => {
    const grp = new THREE.Group();
    models[i].parts.forEach((p) => grp.add(new THREE.Mesh(p.geometry, p.material)));
    scene.add(grp);
    const h = v.height + 0.5;
    cam.left = -h / 2;
    cam.right = h / 2;
    cam.top = h;
    cam.bottom = 0;
    cam.updateProjectionMatrix();
    renderer.setViewport(i * size, 0, size, size);
    renderer.setScissor(i * size, 0, size, size);
    renderer.setScissorTest(true);
    renderer.render(scene, cam);
    scene.remove(grp);
    (models[i] as PropModel & { impostorHeight?: number }).impostorHeight = h;
  });
  renderer.setRenderTarget(prevTarget);
  renderer.setViewport(prevViewport);
  renderer.setScissor(prevScissor);
  renderer.setScissorTest(prevScissorTest);
  renderer.setClearColor(prevColor, prevAlpha);
  const impostor = new THREE.MeshStandardMaterial({ map: rt.texture, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  impostor.onBeforeCompile = (shader) => {
    // Cylindrical billboard: rotate the quad around the instance's Y axis to face the camera.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
      vec3 ip = instanceMatrix[3].xyz;
      float sc = length(instanceMatrix[0].xyz);
      vec3 toCam = cameraPosition - ip;
      toCam.y = 0.0;
      toCam = normalize(toCam);
      vec3 right = vec3(toCam.z, 0.0, -toCam.x);
      vec3 wp = ip + right * transformed.x * sc + vec3(0.0, transformed.y * sc, 0.0);
      mvPosition = viewMatrix * vec4(wp, 1.0);
      #endif
      gl_Position = projectionMatrix * mvPosition;`,
    );
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);');
  };
  impostor.customProgramCacheKey = () => 'treeImpostor';
  return { models, impostor, impostorFrames: variants.length };
}

/** Billboard quad for impostor variant i (UVs into the baked strip). */
export function impostorModel(kit: TreeKit, i: number): PropModel {
  const h = (kit.models[i] as PropModel & { impostorHeight?: number }).impostorHeight ?? 10;
  const g = new THREE.PlaneGeometry(h, h);
  g.translate(0, h / 2 - 0.3, 0);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / kit.impostorFrames);
  return { parts: [{ geometry: g, material: kit.impostor, matrix: new THREE.Matrix4(), castShadow: false }], radius: 0, height: 0, range: 1 };
}
