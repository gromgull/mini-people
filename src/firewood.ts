import * as THREE from 'three';
import { withRow } from './body';
import type { PropKit } from './actionkit';
import { ROWS } from './palette';
import { bake, type Part } from './trees';

/**
 * A piece of firewood: a quarter of a log split lengthwise, bark on the
 * round side and pale wood on the split faces and the ends. Along x.
 */
export const PIECE_L = 0.3;
export const PIECE_R = 0.07;

let geo: { flat: THREE.BufferGeometry; smooth: THREE.BufferGeometry } | null = null;

function pieceGeometry() {
  if (geo) return geo;
  const r = PIECE_R, L = PIECE_L;
  const q = Math.PI / 2;
  // the round (bark) quarter, its axis along x, the split corner at the origin
  const bark = new THREE.CylinderGeometry(r, r, L, 4, 1, true, 0, q).rotateZ(Math.PI / 2);
  const parts: Part[] = [{ geo: bark, row: ROWS.bark[0] }];
  // the two split faces (y = 0 facing down, z = 0 facing back), each facing out
  parts.push({ geo: new THREE.PlaneGeometry(L, r).rotateX(Math.PI / 2).translate(0, 0, r / 2), row: ROWS.food[0] });
  parts.push({ geo: new THREE.PlaneGeometry(L, r).rotateY(Math.PI).translate(0, r / 2, 0), row: ROWS.food[0] });
  // the ends: quarter discs facing −x and +x
  parts.push({ geo: new THREE.CircleGeometry(r, 4, 0, q).rotateY(-Math.PI / 2).translate(-L / 2, 0, 0), row: ROWS.food[0] });
  parts.push({ geo: new THREE.CircleGeometry(r, 4, Math.PI / 2, q).rotateY(Math.PI / 2).translate(L / 2, 0, 0), row: ROWS.food[0] });
  // centre it on its middle
  for (const p of parts) p.geo.translate(0, -r * 0.4, -r * 0.4);
  geo = bake(parts.map((p) => ({ geo: withRow(p.geo, p.row), row: p.row })));
  return geo;
}

/** One piece (a toon mesh with its outline). */
export function makePiece(kit: PropKit) {
  const g = pieceGeometry();
  const m = new THREE.Mesh(g.flat, kit.toon);
  const o = new THREE.Mesh(g.smooth, kit.outline);
  m.raycast = o.raycast = () => {};
  m.add(o);
  return m;
}
