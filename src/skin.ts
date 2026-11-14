import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MAX_BONES } from './materials';

/**
 * One draw call per character (plus one for its outline).
 *
 * The body is still built as a tree of part meshes hanging off the joints,
 * and everything (animation, IK, props, the gaze moving pupils, the mouth
 * swapping to an 'O', blinking) keeps working on that tree. But the parts
 * are no longer drawn: they move to a hidden layer, and their geometry is
 * merged into one mesh where each vertex records which part it came from.
 * Just before drawing, each part's matrix (relative to the root) goes into a
 * uniform array, and the vertex shader places the vertex with it: rigid
 * skinning, one "bone" per part. A hidden part gets a zero matrix, which
 * collapses its triangles to nothing.
 */

/** Layer the original part meshes move to: the camera doesn't render it, picking does. */
export const PARTS_LAYER = 1;

export interface Skin {
  mesh: THREE.Mesh;
  outline: THREE.Mesh;
  parts: THREE.Object3D[];
  dispose(): void;
}

const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const ZERO = new Array(16).fill(0);

function shown(o: THREE.Object3D, root: THREE.Object3D) {
  for (let x: THREE.Object3D | null = o; x && x !== root; x = x.parent) if (!x.visible) return false;
  return true;
}

/**
 * Merge every mesh under `root` drawn with `toon` into one skinned mesh.
 * Call once, right after building, before any props are attached.
 */
export function bakeSkin(root: THREE.Object3D, toon: THREE.Material, mats: { toon: THREE.ShaderMaterial; outline: THREE.ShaderMaterial }, height: number): Skin {
  const parts: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).material === toon) parts.push(o as THREE.Mesh);
  });
  if (parts.length > MAX_BONES) throw new Error(`too many parts to skin: ${parts.length}`);
  const geos = parts.map((m, i) => {
    let g = m.geometry.clone();
    if (g.index) g = g.toNonIndexed(); // mixed indexed/non-indexed won't merge; this always does
    const n = g.getAttribute('position').count;
    g.setAttribute('aBone', new THREE.BufferAttribute(new Float32Array(n).fill(i), 1));
    const edged = m.children.some((c) => (c as THREE.Mesh).isMesh);
    g.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(n).fill(edged ? 1 : 0), 1));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'aRow', 'aBone', 'aEdge'].includes(k)) g.deleteAttribute(k);
    return g;
  });
  const geo = mergeGeometries(geos, false)!;
  geos.forEach((g) => g.dispose());
  // vertices are in their parts' own frames, so the computed bounds mean
  // nothing: use a generous sphere around the person instead
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height * 0.5, 0), height * 1.6);

  const bones = new Float32Array(16 * MAX_BONES);
  const fill = () => {
    _inv.copy(root.matrixWorld).invert();
    parts.forEach((m, i) => {
      if (shown(m, root)) _m.multiplyMatrices(_inv, m.matrixWorld).toArray(bones, i * 16);
      else bones.set(ZERO, i * 16);
    });
  };
  let filledFrame = -1;
  const mesh = new THREE.Mesh(geo, mats.toon);
  const outline = new THREE.Mesh(geo, mats.outline);
  for (const [m, mat] of [[mesh, mats.toon], [outline, mats.outline]] as const) {
    m.raycast = () => {};
    m.onBeforeRender = (renderer) => {
      // once per frame is enough (the outline pass reuses it)
      const f = renderer.info.render.frame;
      if (f !== filledFrame) {
        filledFrame = f;
        fill();
      }
      mat.uniforms.uBones.value = bones;
      mat.uniformsNeedUpdate = true;
    };
    root.add(m);
  }
  // the parts stay in the tree for posing and picking, but aren't drawn
  for (const m of parts) m.traverse((o) => o.layers.set(PARTS_LAYER));

  return {
    mesh,
    outline,
    parts,
    dispose: () => geo.dispose(),
  };
}
