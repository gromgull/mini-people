import * as THREE from 'three';
import { ROWS } from './palette';
import type { Part } from './trees';

/** A small cider keg: its radius at the bulge, and its length. */
export const KEG_R = 0.095;
export const KEG_L = 0.26;

/**
 * A keg's parts, lying along x: bulging staves, two iron hoops, a bung on
 * top. (The village's kegs and the cooper's work both draw it from here.)
 */
export function kegParts(): Part[] {
  const prof: [number, number][] = [[0.001, -KEG_L / 2], [KEG_R * 0.8, -KEG_L / 2], [KEG_R, 0], [KEG_R * 0.8, KEG_L / 2], [0.001, KEG_L / 2]];
  const body = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 10).rotateZ(Math.PI / 2);
  const parts: Part[] = [{ geo: body, row: ROWS.log[0] }];
  for (const x of [-0.32, 0.32]) parts.push({ geo: new THREE.CylinderGeometry(KEG_R * 0.94, KEG_R * 0.94, 0.014, 10).rotateZ(Math.PI / 2).translate(x * KEG_L, 0, 0), row: ROWS.stone[2] });
  parts.push({ geo: new THREE.CylinderGeometry(0.012, 0.012, 0.03, 5).translate(0, KEG_R, 0), row: ROWS.log[1] }); // bung
  return parts;
}
