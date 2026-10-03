#!/usr/bin/env node
/**
 * Optimise raw CC0 assets from .cache/raw (see tools/fetch_assets.py) into public/assets.
 *  - PBR textures  -> WebP (diff / nor / arm), max 2K
 *  - Poly Haven props -> simplified, meshopt-compressed GLB with WebP textures
 *  - Quaternius character -> meshopt GLB with WebP textures
 *  - Quaternius animation library -> animation-only GLB (rotation tracks + pelvis translation)
 * Run: node tools/build-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup, prune, weld, simplify, textureCompress, meshopt, resample, flatten, join,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const RAW = path.join(ROOT, '.cache', 'raw');
const OUT = path.join(ROOT, 'public', 'assets');

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

const only = process.argv[2];
const mk = (p) => fs.mkdirSync(p, { recursive: true });

// ---------------------------------------------------------------- textures
async function textures() {
  const src = path.join(RAW, 'polyhaven', 'textures');
  for (const id of fs.readdirSync(src)) {
    const dst = path.join(OUT, 'textures', id);
    mk(dst);
    const size = id === 'asphalt_02' ? 2048 : 1024;
    for (const [from, to, q] of [['diff', 'diff', 82], ['nor_gl', 'nor', 88], ['arm', 'arm', 80]]) {
      const inFile = path.join(src, id, `${id}_${from}.jpg`);
      if (!fs.existsSync(inFile)) continue;
      const outFile = path.join(dst, `${to}.webp`);
      await sharp(inFile).resize(size, size, { fit: 'inside' }).webp({ quality: q, effort: 5 }).toFile(outFile);
    }
    console.log('texture', id);
  }
  const hdrDir = path.join(OUT, 'hdri');
  mk(hdrDir);
  for (const f of fs.readdirSync(path.join(RAW, 'polyhaven', 'hdri'))) {
    fs.copyFileSync(path.join(RAW, 'polyhaven', 'hdri', f), path.join(hdrDir, f));
    console.log('hdri', f);
  }
}

// ---------------------------------------------------------------- props
// id -> [simplify ratio, texture size]
const PROPS = {
  fire_hydrant: [0.03, 512],
  metal_trash_can: [0.15, 512],
  painted_wooden_bench: [1, 512],
  exterior_aircon_unit: [0.1, 512],
  utility_box_01: [0.4, 512],
  concrete_road_barrier: [0.02, 512],
  wooden_crate_01: [0.3, 512],
  Barrel_01: [0.6, 512],
  lateral_sea_marker: [0.15, 512],
  planter_box_01: [0.25, 512],
  wooden_picnic_table: [0.2, 512],
  water_manhole_cover: [0.2, 512],
};

async function props() {
  const dst = path.join(OUT, 'models', 'props');
  mk(dst);
  for (const [id, [ratio, tex]] of Object.entries(PROPS)) {
    const dir = path.join(RAW, 'polyhaven', 'models', id);
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.gltf'));
    const doc = await io.read(path.join(dir, file));
    const before = triCount(doc);
    await doc.transform(
      dedup(), flatten(), join(), weld(),
      ...(ratio < 1 ? [simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.004, lockBorder: false })] : []),
      prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [tex, tex], quality: 82 }),
      meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
    );
    await io.write(path.join(dst, `${id}.glb`), doc);
    console.log('prop', id, before, '->', triCount(doc), 'tris');
  }
}

function triCount(doc) {
  let n = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const idx = p.getIndices();
    n += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
  }
  return Math.round(n);
}

// ---------------------------------------------------------------- character
async function character() {
  const base = path.join(RAW, 'quaternius', 'ubc', 'Universal Base Characters[Standard]');
  const dir = path.join(base, 'Base Characters', 'Godot - UE');
  // The pack references a couple of image names that ship under a different filename.
  for (const [want, have] of [['T_Hair_1_Normal_png.png', 'T_Hair_1_Normal.png'], ['T_Eye_Normal_png.png', 'T_Eye_Normal.png']]) {
    if (!fs.existsSync(path.join(dir, want))) fs.copyFileSync(path.join(dir, have), path.join(dir, want));
  }
  const dst = path.join(OUT, 'models', 'characters');
  mk(dst);
  for (const name of ['Superhero_Male_FullBody']) {
    const doc = await io.read(path.join(dir, `${name}.gltf`));
    await doc.transform(
      dedup(), prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }),
    );
    // No quantisation: the clothing shader reads bind-pose vertex positions in metres.
    await io.write(path.join(dst, 'civilian_male.glb'), doc);
    console.log('character', name, triCount(doc));
  }
  const hairDir = path.join(base, 'Hairstyles', 'Origin at 0', 'glTF (Godot)');
  for (const name of ['Hair_SimpleParted']) {
    const doc = await io.read(path.join(hairDir, `${name}.gltf`));
    await doc.transform(
      dedup(), prune(),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 85 }),
    );
    await io.write(path.join(dst, `${name.toLowerCase()}.glb`), doc);
    console.log('hair', name, triCount(doc));
  }
}

// ---------------------------------------------------------------- animations
const KEEP_ANIMS = ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Driving_Loop', 'Interact'];

async function animations() {
  const file = path.join(RAW, 'quaternius', 'ual', 'Universal Animation Library[Standard]', 'Unreal-Godot', 'UAL1_Standard.glb');
  const doc = await io.read(file);
  const root = doc.getRoot();
  // Pelvis height ratio between the animation mannequin and the base character.
  const charDoc = await io.read(path.join(RAW, 'quaternius', 'ubc', 'Universal Base Characters[Standard]', 'Base Characters', 'Godot - UE', 'Superhero_Male_FullBody.gltf'));
  const pelvisOf = (d) => d.getRoot().listNodes().find((n) => n.getName() === 'pelvis').getTranslation();
  const ratio = pelvisOf(charDoc)[2] / pelvisOf(doc)[2];
  for (const anim of root.listAnimations()) {
    if (!KEEP_ANIMS.includes(anim.getName())) { anim.dispose(); continue; }
    for (const ch of anim.listChannels()) {
      const target = ch.getTargetNode()?.getName();
      const p = ch.getTargetPath();
      const keep = p === 'rotation' || (p === 'translation' && target === 'pelvis');
      if (!keep) { const s = ch.getSampler(); ch.dispose(); s.dispose(); continue; }
      if (p === 'translation') {
        const out = ch.getSampler().getOutput();
        const arr = out.getArray().slice();
        for (let i = 0; i < arr.length; i++) arr[i] *= ratio;
        out.setArray(arr);
      }
    }
  }
  for (const mesh of root.listMeshes()) mesh.dispose();
  for (const node of root.listNodes()) if (node.getMesh() === null && node.getSkin()) node.setSkin(null);
  for (const mat of root.listMaterials()) mat.dispose();
  await doc.transform(resample(), prune({ keepLeaves: true }), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const dst = path.join(OUT, 'models', 'characters');
  mk(dst);
  await io.write(path.join(dst, 'anim_locomotion.glb'), doc);
  console.log('animations', root.listAnimations().map((a) => a.getName()).join(', '), 'pelvis ratio', ratio.toFixed(3));
}

const steps = { textures, props, character, animations };
for (const [name, fn] of Object.entries(steps)) {
  if (only && only !== name) continue;
  await fn();
}
console.log('assets built ->', OUT);
