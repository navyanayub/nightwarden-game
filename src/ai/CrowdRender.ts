/**
 * GPU-instanced, GPU-skinned crowd rendering.
 *
 * Each body / hair / prop mesh is an InstancedMesh whose vertex shader skins with bone matrices
 * fetched from a baked animation texture (see AnimBaker): per instance it reads two frame rows
 * (current and previous clip) and cross-fades them. Clothing is painted in the fragment shader
 * from bind-space position with per-instance colours and styles (jacket, tee, coat, sweater;
 * jeans, trousers, skirt, shorts), skin tone and hair colour — so a few meshes give hundreds
 * of distinct pedestrians. Three body LODs; shadows only for the nearer two.
 */
import * as THREE from 'three';
import { assets } from '../core/AssetLoader';
import { bakeAnimations, BAKE_FPS, type BakedAnimations, type BakeSpec } from './AnimBaker';

export interface Look {
  /** rgb + style (0 jacket+tee, 1 tee, 2 coat, 3 sweater). */
  top: [number, number, number, number];
  /** rgb + style (0 jeans, 1 trousers, 2 skirt, 3 shorts). */
  bottom: [number, number, number, number];
  /** skin tone rgb + shoe style (0 white, 1 black, 2 brown). */
  skin: [number, number, number, number];
  hair: [number, number, number];
  gender: 0 | 1;
  hairStyle: number;
  height: number;
  girth: number;
}

export interface Figure {
  x: number;
  y: number;
  z: number;
  yaw: number;
  look: Look;
  /** Baked frame rows (fractional ok) for the current and previous clip, blend 0..1 towards current. */
  rowA: number;
  rowB: number;
  blend: number;
  /** 0 none, 1 phone, 2 umbrella. */
  prop: number;
  /** Umbrella colour. */
  propColor?: [number, number, number];
}

export const CLIP_NAMES = ['idle', 'walk', 'walkFormal', 'jog', 'sprint', 'talk', 'phone', 'phoneWalk', 'sit', 'sitTalk', 'cower', 'hit', 'umbrella', 'umbrellaWalk', 'drive'] as const;
export type ClipName = (typeof CLIP_NAMES)[number];

const SKIN_GLSL = /* glsl */ `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 aAnim;
uniform highp sampler2D uBones;
mat4 nwBone(float row, float b) {
  int x = int(b + 0.5) * 4;
  int y = int(row);
  return mat4(texelFetch(uBones, ivec2(x, y), 0), texelFetch(uBones, ivec2(x + 1, y), 0), texelFetch(uBones, ivec2(x + 2, y), 0), texelFetch(uBones, ivec2(x + 3, y), 0));
}
mat4 nwSkin(float row) {
  return skinWeight.x * nwBone(row, skinIndex.x) + skinWeight.y * nwBone(row, skinIndex.y) + skinWeight.z * nwBone(row, skinIndex.z) + skinWeight.w * nwBone(row, skinIndex.w);
}
`;

const SKIN_MAIN = /* glsl */ `
  mat4 nwM = nwSkin(aAnim.x);
  #ifdef NW_BLEND
  if (aAnim.z < 0.999) nwM = nwM * aAnim.z + nwSkin(aAnim.y) * (1.0 - aAnim.z);
  #endif
`;

interface PatchOpts {
  blend: boolean;
  clothes?: { heightScale: number };
  hairColor?: boolean;
  posOnly?: THREE.Vector3;
  propColor?: boolean;
}

function patch(mat: THREE.Material, bones: THREE.Texture, o: PatchOpts, depth = false): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uBones = { value: bones };
    if (o.blend) shader.defines = { ...(shader.defines ?? {}), NW_BLEND: '' };
    let vs = shader.vertexShader.replace('#include <common>', `#include <common>\n${SKIN_GLSL}\nattribute vec4 aLook0;\nattribute vec4 aLook1;\nattribute vec4 aLook2;\nvarying vec3 vBind;\nvarying vec4 vLook0;\nvarying vec4 vLook1;\nvarying vec4 vLook2;\n${o.posOnly ? 'uniform vec3 uAnchor;' : ''}`);
    const posExpr = o.posOnly ? `(position - uAnchor + (nwM * vec4(uAnchor, 1.0)).xyz)` : `(nwM * vec4(position, 1.0)).xyz`;
    const nrmExpr = o.posOnly ? `normal` : `normalize(mat3(nwM) * normal)`;
    if (!depth) {
      vs = vs.replace('#include <beginnormal_vertex>', `${SKIN_MAIN}\nvec3 objectNormal = ${nrmExpr};\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif`);
      vs = vs.replace('#include <begin_vertex>', `vec3 transformed = ${posExpr};\nvBind = position;\nvLook0 = aLook0;\nvLook1 = aLook1;\nvLook2 = aLook2;`);
    } else {
      vs = vs.replace('#include <begin_vertex>', `${SKIN_MAIN}\nvec3 transformed = ${posExpr};\nvBind = position;\nvLook0 = aLook0;\nvLook1 = aLook1;\nvLook2 = aLook2;`);
    }
    if (o.posOnly) shader.uniforms.uAnchor = { value: o.posOnly };
    shader.vertexShader = vs;
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vBind;\nvarying vec4 vLook0;\nvarying vec4 vLook1;\nvarying vec4 vLook2;\nfloat clCloth = 0.0;');
    if (o.clothes && !depth) {
      shader.uniforms.uHS = { value: o.clothes.heightScale };
      fs = fs
        .replace(
          '#include <common>',
          `#include <common>
          uniform float uHS;
          float clHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
          float clNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(clHash(i), clHash(i + vec2(1, 0)), u.x), mix(clHash(i + vec2(0, 1)), clHash(i + vec2(1, 1)), u.x), u.y); }`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          {
            vec3 b = vBind / uHS;
            float ax = abs(b.x);
            float topStyle = vLook0.w;
            float botStyle = vLook1.w;
            vec3 topC = vLook0.rgb;
            vec3 botC = vLook1.rgb;
            // Skin: tint the light base texture.
            vec3 c = diffuseColor.rgb * vLook2.rgb;
            float shoe = step(b.y, 0.115);
            float hipY = 0.985;
            float legs = step(b.y, hipY) * (1.0 - shoe);
            float lowerCut = botStyle > 2.5 ? 0.62 : (botStyle > 1.5 ? 0.5 : 0.0);
            float bottom = legs * step(lowerCut, b.y);
            float bareLeg = legs * (1.0 - step(lowerCut, b.y));
            float belt = step(0.94, b.y) * step(b.y, 0.99) * step(ax, 0.2) * step(botStyle, 1.5);
            float torso = step(0.985, b.y) * step(b.y, 1.5) * step(ax, 0.235);
            float sleeveEnd = topStyle > 0.5 && topStyle < 1.5 ? 0.34 : 0.66;
            float arms = step(1.24, b.y) * step(b.y, 1.62) * step(0.2, ax) * step(ax, sleeveEnd);
            float top = max(torso, arms);
            // Coat skirt over the thighs.
            float coat = step(1.5, topStyle) * step(topStyle, 2.5) * step(0.55, b.y) * step(b.y, 0.985) * step(ax, 0.26);
            vec3 fabricN = vec3(0.9 + 0.15 * clNoise(b.xy * 120.0));
            vec3 bot = botC * (botStyle < 0.5 ? (0.82 + 0.3 * clNoise(b.xy * vec2(220.0, 40.0))) : (0.92 + 0.08 * clNoise(b.xy * 60.0)));
            if (botStyle < 0.5) bot *= 1.0 - 0.25 * smoothstep(0.55, 0.3, b.y) * (0.5 + 0.5 * clNoise(b.xy * 9.0));
            vec3 shoeC = vLook2.w < 0.5 ? vec3(0.85, 0.84, 0.8) : (vLook2.w < 1.5 ? vec3(0.04) : vec3(0.22, 0.12, 0.06));
            shoeC = mix(shoeC, vec3(0.06), step(b.y, 0.03));
            c = mix(c, bot, bottom);
            c = mix(c, c * 0.92, bareLeg);
            c = mix(c, vec3(0.1, 0.07, 0.05), belt);
            c = mix(c, topC * fabricN, top);
            c = mix(c, topC * fabricN * 0.95, coat);
            // Jacket: tee panel, collar and zip.
            if (topStyle < 0.5) {
              float shirt = torso * step(1.38, b.y) * step(ax, (b.y - 1.38) * 0.55 + 0.012) * step(0.02, b.z);
              float collar = step(1.44, b.y) * step(b.y, 1.53) * step(ax, 0.1) * step(b.z, 0.02);
              float zip = torso * step(ax, 0.005) * step(0.02, b.z) * (1.0 - step(1.38, b.y));
              c = mix(c, vec3(0.75, 0.74, 0.7) * (0.6 + 0.4 * botC.g), shirt);
              c = mix(c, topC * 0.8, collar);
              c = mix(c, vec3(0.5), zip);
            } else if (topStyle > 1.5 && topStyle < 2.5) {
              float buttons = torso * step(abs(b.x - 0.03), 0.008) * step(0.6, fract(b.y * 9.0)) * step(0.02, b.z);
              c = mix(c, vec3(0.08), buttons);
            } else if (topStyle > 2.5) {
              float rib = step(0.985, b.y) * step(b.y, 1.04) * step(ax, 0.235);
              c = mix(c, topC * (0.8 + 0.2 * step(0.5, fract(b.x * 120.0))), rib);
            }
            c = mix(c, shoeC, shoe);
            clCloth = clamp(legs * (1.0 - bareLeg) + top + shoe + belt + coat, 0.0, 1.0);
            diffuseColor.rgb = c;
          }`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.82, clCloth);')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize(mix(normal, normalize(vNormal), clCloth * 0.85));');
    }
    if (o.hairColor && !depth) fs = fs.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vLook0.rgb * 2.2;');
    if (o.propColor && !depth) fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vLook0.rgb;');
    shader.fragmentShader = fs;
  };
  const key = `crowd-${o.blend}-${!!o.clothes}-${!!o.hairColor}-${!!o.posOnly}-${!!o.propColor}-${depth}`;
  mat.customProgramCacheKey = () => key;
}

interface Part {
  mesh: THREE.InstancedMesh;
  anim: THREE.InstancedBufferAttribute;
  l0: THREE.InstancedBufferAttribute;
  l1: THREE.InstancedBufferAttribute;
  l2: THREE.InstancedBufferAttribute;
  n: number;
}

interface Gender {
  baked: BakedAnimations;
  bodies: Part[];
  eyes: Part | null;
  brows: Part | null;
  hairs: Part[][];
  phone: Part;
  umbrella: Part;
  pelvis: number;
}

const LOD_DIST = [20, 60, 160];

export class CrowdRender {
  readonly group = new THREE.Group();
  private genders: Gender[] = [];
  readonly capacity: number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private frustum = new THREE.Frustum();
  private pv = new THREE.Matrix4();
  private sphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  stats = { drawn: 0, lod: [0, 0, 0] };

  constructor(capacity: number) {
    this.capacity = capacity;
    this.group.name = 'Crowd';
  }

  /** Clip row helpers. */
  clip(gender: 0 | 1, name: ClipName) {
    return this.genders[gender].baked.clips[name];
  }

  async load(): Promise<void> {
    const [m0, m1, m2, f0, f1, f2, anims, ...hairs] = await Promise.all([
      assets.loadGLTF('models/characters/crowd_male.glb'),
      assets.loadGLTF('models/characters/crowd_male_lod1.glb'),
      assets.loadGLTF('models/characters/crowd_male_lod2.glb'),
      assets.loadGLTF('models/characters/crowd_female.glb'),
      assets.loadGLTF('models/characters/crowd_female_lod1.glb'),
      assets.loadGLTF('models/characters/crowd_female_lod2.glb'),
      assets.loadGLTF('models/characters/anim_locomotion.glb'),
      assets.loadGLTF('models/characters/hair_simpleparted.glb'),
      assets.loadGLTF('models/characters/hair_buzzed.glb'),
      assets.loadGLTF('models/characters/hair_beard.glb'),
      assets.loadGLTF('models/characters/hair_long.glb'),
      assets.loadGLTF('models/characters/hair_buns.glb'),
      assets.loadGLTF('models/characters/hair_buzzedfemale.glb'),
    ]);
    const clip = (n: string) => anims.animations.find((a) => a.name === n)!;
    const specs: BakeSpec[] = [
      { name: 'idle', clip: clip('Idle_Loop'), loop: true },
      { name: 'walk', clip: clip('Walk_Loop'), loop: true },
      { name: 'walkFormal', clip: clip('Walk_Formal_Loop'), loop: true },
      { name: 'jog', clip: clip('Jog_Fwd_Loop'), loop: true },
      { name: 'sprint', clip: clip('Sprint_Loop'), loop: true },
      { name: 'talk', clip: clip('Idle_Talking_Loop'), loop: true },
      { name: 'phone', clip: clip('Idle_Loop'), loop: true, arm: 'phone' },
      { name: 'phoneWalk', clip: clip('Walk_Loop'), loop: true, arm: 'phone' },
      { name: 'sit', clip: clip('Sitting_Idle_Loop'), loop: true },
      { name: 'sitTalk', clip: clip('Sitting_Talking_Loop'), loop: true },
      { name: 'cower', clip: clip('Crouch_Idle_Loop'), loop: true },
      { name: 'hit', clip: clip('Hit_Chest'), loop: false },
      { name: 'umbrella', clip: clip('Idle_Loop'), loop: true, arm: 'umbrella' },
      { name: 'umbrellaWalk', clip: clip('Walk_Loop'), loop: true, arm: 'umbrella' },
      { name: 'drive', clip: clip('Driving_Loop'), loop: true },
    ];
    const hairSets: THREE.Object3D[][] = [
      [hairs[0].scene, hairs[1].scene, hairs[1].scene, hairs[2].scene],
      [hairs[3].scene, hairs[4].scene, hairs[5].scene],
    ];
    // Male style 2 = buzzed + beard (two meshes); styles index into these lists.
    let malePelvis = 1;
    for (const [gi, lods] of [
      [0, [m0, m1, m2]],
      [1, [f0, f1, f2]],
    ] as [0 | 1, { scene: THREE.Object3D }[]][]) {
      const root = lods[0].scene;
      root.updateMatrixWorld(true);
      let skinned: THREE.SkinnedMesh | null = null;
      root.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (sm.isSkinnedMesh && /superhero/i.test(sm.name) && !skinned) skinned = sm;
      });
      const body = skinned as unknown as THREE.SkinnedMesh;
      const pelvisBone = body.skeleton.bones.find((b) => b.name === 'pelvis')!;
      const pelvisY = pelvisBone.getWorldPosition(new THREE.Vector3()).y;
      if (gi === 0) malePelvis = pelvisY;
      const baked = bakeAnimations(root, body, specs, pelvisY / malePelvis);
      const hs = pelvisY / malePelvis;
      const bodies: Part[] = [];
      for (let l = 0; l < 3; l++) {
        let sm: THREE.SkinnedMesh | null = null;
        lods[l].scene.traverse((o) => {
          const x = o as THREE.SkinnedMesh;
          if (x.isSkinnedMesh && /superhero/i.test(x.name) && !sm) sm = x;
        });
        const src = sm as unknown as THREE.SkinnedMesh;
        const mat = (src.material as THREE.MeshStandardMaterial).clone();
        mat.vertexColors = false;
        patch(mat, baked.texture, { blend: l === 0, clothes: { heightScale: hs } });
        bodies.push(this.part(src.geometry, mat, baked.texture, l < 2, l === 0, { clothes: { heightScale: hs } }));
      }
      let eyes: Part | null = null;
      let brows: Part | null = null;
      root.traverse((o) => {
        const x = o as THREE.SkinnedMesh;
        if (!x.isSkinnedMesh || /superhero/i.test(x.name)) return;
        const mat = (x.material as THREE.MeshStandardMaterial).clone();
        mat.vertexColors = false;
        if (/brow/i.test(x.name)) {
          mat.alphaTest = 0.4;
          mat.transparent = false;
          mat.side = THREE.DoubleSide;
          patch(mat, baked.texture, { blend: true, hairColor: true });
          brows = this.part(x.geometry, mat, baked.texture, false, true, { hairColor: true });
        } else if (/eye/i.test(x.name)) {
          patch(mat, baked.texture, { blend: true });
          eyes = this.part(x.geometry, mat, baked.texture, false, true, {});
        }
      });
      // Hair: rigid to the head bone.
      const headIdx = baked.boneIndex('Head');
      const hairParts: Part[][] = hairSets[gi].map((h) => {
        const parts: Part[] = [];
        h.updateMatrixWorld(true);
        h.traverse((o) => {
          const mm = o as THREE.Mesh;
          if (!mm.isMesh) return;
          const g = mm.geometry.clone();
          g.applyMatrix4(mm.matrixWorld);
          const n = g.getAttribute('position').count;
          g.setAttribute('skinIndex', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? headIdx : 0)), 4));
          g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
          const mat = (mm.material as THREE.MeshStandardMaterial).clone();
          mat.alphaTest = 0.4;
          mat.transparent = false;
          mat.side = THREE.DoubleSide;
          mat.color.setRGB(1, 1, 1);
          patch(mat, baked.texture, { blend: false, hairColor: true });
          parts.push(this.part(g, mat, baked.texture, true, false, { hairColor: true }));
        });
        return parts;
      });
      // Props: phone (rigid to the hand), umbrella (follows the hand position, stays upright).
      const handIdx = baked.boneIndex('hand_r');
      const handPos = baked.bindPos('hand_r');
      const phoneG = new THREE.BoxGeometry(0.075, 0.15, 0.012);
      phoneG.translate(handPos.x - 0.05, handPos.y, handPos.z + 0.02);
      this.rigid(phoneG, handIdx);
      const phoneMat = new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.3, metalness: 0.6 });
      patch(phoneMat, baked.texture, { blend: false });
      const phone = this.part(phoneG, phoneMat, baked.texture, false, false, {});
      const umb = umbrellaGeometry();
      umb.translate(handPos.x, handPos.y, handPos.z);
      this.rigid(umb, handIdx);
      const umbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, side: THREE.DoubleSide, vertexColors: true });
      patch(umbMat, baked.texture, { blend: false, posOnly: handPos, propColor: true });
      const umbrella = this.part(umb, umbMat, baked.texture, true, false, { posOnly: handPos, propColor: true });
      this.genders.push({ baked, bodies, eyes, brows, hairs: hairParts, phone, umbrella, pelvis: pelvisY });
    }
  }

  private rigid(g: THREE.BufferGeometry, bone: number): void {
    const n = g.getAttribute('position').count;
    g.setAttribute('skinIndex', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? bone : 0)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  }

  private part(src: THREE.BufferGeometry, mat: THREE.Material, bones: THREE.Texture, shadow: boolean, blend: boolean, o: Omit<PatchOpts, 'blend'>): Part {
    const g = new THREE.BufferGeometry();
    for (const k of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight', 'color']) {
      const a = src.getAttribute(k);
      if (a) g.setAttribute(k, a);
    }
    g.setIndex(src.getIndex());
    const cap = this.capacity;
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const anim = mk(4);
    const l0 = mk(4);
    const l1 = mk(4);
    const l2 = mk(4);
    g.setAttribute('aAnim', anim);
    g.setAttribute('aLook0', l0);
    g.setAttribute('aLook1', l1);
    g.setAttribute('aLook2', l2);
    const mesh = new THREE.InstancedMesh(g, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    if (shadow) {
      const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      patch(dm, bones, { ...o, blend }, true);
      mesh.customDepthMaterial = dm;
    }
    this.group.add(mesh);
    return { mesh, anim, l0, l1, l2, n: 0 };
  }

  private push(p: Part, f: Figure, l0: number[], l1: number[], l2: number[]): void {
    if (p.n >= this.capacity) return;
    const i = p.n++;
    p.mesh.setMatrixAt(i, this.m);
    p.anim.setXYZW(i, f.rowA, f.rowB, f.blend, 0);
    p.l0.setXYZW(i, l0[0], l0[1], l0[2], l0[3]);
    p.l1.setXYZW(i, l1[0], l1[1], l1[2], l1[3]);
    p.l2.setXYZW(i, l2[0], l2[1], l2[2], l2[3]);
  }

  update(figures: Figure[], camera: THREE.Camera): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cam = camera.position;
    for (const g of this.genders) {
      for (const p of [...g.bodies, g.phone, g.umbrella, ...g.hairs.flat()]) p.n = 0;
      if (g.eyes) g.eyes.n = 0;
      if (g.brows) g.brows.n = 0;
    }
    this.stats.drawn = 0;
    this.stats.lod = [0, 0, 0];
    const zero = [0, 0, 0, 0];
    for (const f of figures) {
      const d = Math.hypot(f.x - cam.x, f.z - cam.z);
      if (d > LOD_DIST[2]) continue;
      this.sphere.center.set(f.x, f.y + 0.9, f.z);
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const lod = d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : 2;
      const L = f.look;
      const g = this.genders[L.gender];
      this.q.setFromAxisAngle(this.up, f.yaw);
      this.s.set(L.girth * L.height, L.height, L.girth * L.height);
      this.m.compose(this.v.set(f.x, f.y, f.z), this.q, this.s);
      const ff = lod === 0 ? f : { ...f, blend: 1 };
      this.push(g.bodies[lod], ff, L.top, L.bottom, L.skin);
      if (lod === 0) {
        if (g.eyes) this.push(g.eyes, ff, zero, zero, zero);
        if (g.brows) this.push(g.brows, ff, [L.hair[0], L.hair[1], L.hair[2], 0], zero, zero);
      }
      const hairs = g.hairs[L.hairStyle];
      if (hairs && d < 110) {
        const hc = [L.hair[0], L.hair[1], L.hair[2], 0];
        for (const h of hairs) this.push(h, { ...f, blend: 1 }, hc, zero, zero);
        if (L.gender === 0 && L.hairStyle === 2) for (const h of g.hairs[3]) this.push(h, { ...f, blend: 1 }, hc, zero, zero);
      }
      if (f.prop === 1 && d < 60) this.push(g.phone, { ...f, blend: 1 }, zero, zero, zero);
      if (f.prop === 2) {
        const c = f.propColor ?? [0.1, 0.1, 0.12];
        this.push(g.umbrella, { ...f, blend: 1 }, [c[0], c[1], c[2], 0], zero, zero);
      }
      this.stats.drawn++;
      this.stats.lod[lod]++;
    }
    for (const g of this.genders) {
      const parts = [...g.bodies, g.phone, g.umbrella, ...g.hairs.flat()];
      if (g.eyes) parts.push(g.eyes);
      if (g.brows) parts.push(g.brows);
      for (const p of parts) {
        p.mesh.count = p.n;
        if (!p.n) continue;
        p.mesh.instanceMatrix.needsUpdate = true;
        p.anim.needsUpdate = true;
        p.l0.needsUpdate = true;
        p.l1.needsUpdate = true;
        p.l2.needsUpdate = true;
      }
    }
  }

  /** Frame row for a clip at time t (seconds). */
  row(gender: 0 | 1, name: ClipName, t: number): number {
    const c = this.genders[gender].baked.clips[name];
    const f = c.loop ? (t * BAKE_FPS) % c.frames : Math.min(t * BAKE_FPS, c.frames - 1);
    return c.start + Math.floor(f);
  }

  duration(gender: 0 | 1, name: ClipName): number {
    return this.genders[gender].baked.clips[name].duration;
  }
}

/** Umbrella: canopy (ribbed dome) on a shaft, authored around the hand (origin). */
function umbrellaGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    pts.push(new THREE.Vector2(Math.sin(t * 1.25) * 0.62, 0.95 + Math.cos(t * 1.25) * 0.28 - 0.18));
  }
  const canopy = new THREE.LatheGeometry(pts, 8);
  const shaft = new THREE.CylinderGeometry(0.012, 0.012, 1.0, 6);
  shaft.translate(0, 0.5, 0);
  const handle = new THREE.TorusGeometry(0.05, 0.012, 6, 8, Math.PI);
  handle.rotateZ(Math.PI);
  const col = (g: THREE.BufferGeometry, c: number) => {
    const n = g.getAttribute('position').count;
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(c), 3));
    return g.index ? g.toNonIndexed() : g;
  };
  const merged = new THREE.BufferGeometry();
  const parts = [col(canopy, 1), col(shaft, 0.15), col(handle, 0.1)];
  const pos: number[] = [];
  const nor: number[] = [];
  const cc: number[] = [];
  for (const p of parts) {
    pos.push(...(p.getAttribute('position').array as Float32Array));
    nor.push(...(p.getAttribute('normal').array as Float32Array));
    cc.push(...(p.getAttribute('color').array as Float32Array));
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
  return merged;
}
