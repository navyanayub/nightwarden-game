#!/usr/bin/env node
// Print a quick summary of a glTF/GLB file: meshes, materials, textures, skins, animations, node tree.
// Usage: node tools/inspect-gltf.mjs file.glb [listAnims]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(process.argv[2]);
const root = doc.getRoot();
console.log('meshes', root.listMeshes().map((m) => m.getName() + ':' + m.listPrimitives().map((p) => p.getAttribute('POSITION').getCount()).join('+')));
console.log('materials', root.listMaterials().map((m) => m.getName()));
console.log('textures', root.listTextures().map((t) => `${t.getName()} ${t.getMimeType()} ${t.getSize()}`));
for (const s of root.listSkins()) console.log('skin', s.getName(), s.listJoints().length);
const anims = root.listAnimations();
console.log('anims', anims.length);
if (process.argv[3]) for (const a of anims) console.log('  ', a.getName(), a.listChannels().length, a.listSamplers()[0]?.getInput()?.getMax([])?.[0]);
function walk(n, d) {
  if (d > 3) return;
  const f = (a) => a.map((v) => v.toFixed(3)).join(',');
  console.log(' '.repeat(d * 2) + n.getName(), f(n.getTranslation()), f(n.getRotation()), f(n.getScale()));
  n.listChildren().forEach((c) => walk(c, d + 1));
}
for (const sc of root.listScenes()) sc.listChildren().forEach((n) => walk(n, 0));
