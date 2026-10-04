/**
 * Lit traffic-signal lenses: one instanced disc per lens (red / amber / green for every signal
 * head), coloured each frame from the junction's signal phase so every head shows the state
 * the traffic AI is actually obeying.
 */
import * as THREE from 'three';
import type { CityData } from '../world/CityLayout';
import { signalState, type GNode, type LaneGraph } from './LaneGraph';

const ON: THREE.Color[] = [new THREE.Color(7, 0.35, 0.12), new THREE.Color(7, 3.0, 0.15), new THREE.Color(0.35, 6, 2.6)];
const OFF: THREE.Color[] = [new THREE.Color(0.05, 0.004, 0.002), new THREE.Color(0.05, 0.025, 0.002), new THREE.Color(0.003, 0.04, 0.02)];

export class SignalLights {
  readonly mesh: THREE.InstancedMesh;
  private heads: { node: GNode; axis: 'ns' | 'ew'; base: number }[] = [];
  private last: number[] = [];

  constructor(city: CityData, graph: LaneGraph) {
    const signals = city.props.filter((p) => p.type === 'signal');
    const sigNodes = graph.nodes.filter((n) => n.signal);
    const geo = new THREE.CircleGeometry(0.115, 14);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, signals.length * 3);
    this.mesh.name = 'signalLenses';
    this.mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    let i = 0;
    for (const p of signals) {
      let node = sigNodes[0];
      let bd = Infinity;
      for (const n of sigNodes) {
        const d = Math.hypot(n.x - p.x, n.z - p.z);
        if (d < bd) {
          bd = d;
          node = n;
        }
      }
      if (!node || bd > 40) continue;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      for (let k = 0; k < 3; k++) {
        const local = new THREE.Vector3(0, 3.2 - k * 0.36, 0.37).applyQuaternion(q);
        m.compose(new THREE.Vector3(p.x + local.x, p.y + local.y, p.z + local.z), q, one);
        this.mesh.setMatrixAt(i + k, m);
        this.mesh.setColorAt(i + k, OFF[2 - k]);
      }
      this.heads.push({ node, axis: p.v === 1 ? 'ew' : 'ns', base: i });
      this.last.push(-1);
      i += 3;
    }
    this.mesh.count = i;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(time: number): void {
    let dirty = false;
    this.heads.forEach((h, j) => {
      const st = signalState(h.node, h.axis, time); // 0 red, 1 amber, 2 green
      if (st === this.last[j]) return;
      this.last[j] = st;
      dirty = true;
      // Lens order top->bottom: red, amber, green.
      const lit = st === 0 ? 0 : st === 1 ? 1 : 2;
      for (let k = 0; k < 3; k++) this.mesh.setColorAt(h.base + k, k === lit ? ON[k] : OFF[k]);
    });
    if (dirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
