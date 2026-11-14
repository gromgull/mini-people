import * as THREE from 'three';
import type { Stage } from '../stage';
import type { Actor } from '../actions';
import { Spot } from './things';
import type { Obstacle } from './walk';

/**
 * The inn's tables: the same farmhouse table (two benches, two places on
 * each) set down in front of the inn, and their seats. A diner of any size
 * sits at a seat by standing in front of its bench, at their own distance
 * from it (Actor.sitFit), and the table's real top and edge go to their
 * eating (so they reach the table that's there, not one made for them).
 */

export interface TableDims {
  top: number;
  edge: number;
  W: number;
  h: number;
  nearZ: number;
  farZ: number;
  seatW: number;
  cx: number;
  L: number;
}

/** Where someone's at with their supper. */
export type SeatState = 'free' | 'claimed' | 'seated' | 'served' | 'done';

export interface Seat {
  id: number;
  table: InnTable;
  /** Along the bench (table frame x). */
  x: number;
  /** On the far bench (facing back toward the inn). */
  far: boolean;
  state: SeatState;
  /** Who's (going to be) sitting there. */
  diner: number;
  /** Where their plate goes, once they're sat (moves to fit them). */
  plate: Spot;
}

export class InnTable {
  readonly group: THREE.Group;
  readonly obstacle: Obstacle;
  readonly seats: Seat[] = [];

  constructor(stage: Stage, furniture: THREE.Group, readonly dims: TableDims, readonly x: number, readonly z: number, readonly yaw: number, box: { x: number; z: number; hx: number; hz: number }, firstId: number) {
    this.group = furniture;
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    stage.scene.add(this.group);
    const c = this.world(box.x, box.z);
    this.obstacle = { kind: 'box', x: c.x, z: c.z, yaw, hx: box.hx, hz: box.hz };
    let id = firstId;
    for (const far of [false, true]) for (const sx of [0, dims.seatW]) {
      const plate = new Spot(stage, 'plate', new THREE.Vector3(x, dims.top, z), yaw, { x, z, yaw });
      this.seats.push({ id: id++, table: this, x: sx, far, state: 'free', diner: -1, plate });
    }
  }

  /** Table frame → world. */
  world(lx: number, lz: number) {
    return new THREE.Vector3(lx, 0, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw).add(new THREE.Vector3(this.x, 0, this.z));
  }

  /**
   * For this person at this seat: where they stand to sit down (and which
   * way they face), the approach (in from the end of the bench), and the
   * table as they see it (its top, how far ahead its edge is, the bench height).
   */
  sitFor(seat: Seat, actor: Actor) {
    const d = this.dims;
    const back = -actor.sitFit().benchZ; // their feet are this far ahead of the bench's middle
    const z = seat.far ? d.farZ - back : d.nearZ + back;
    const edge = seat.far ? z - (d.edge + d.W) : d.edge - z;
    const at = this.world(seat.x, z);
    const endX = seat.x <= d.cx ? d.cx - d.L / 2 - 0.45 : d.cx + d.L / 2 + 0.45;
    const via = this.world(endX, z);
    return {
      x: at.x,
      z: at.z,
      yaw: this.yaw + (seat.far ? Math.PI : 0),
      via: { x: via.x, z: via.z },
      table: { top: d.top, edge, h: d.h },
    };
  }

  /** Where to stand to put a plate at (world) `at` on this table: at the nearer end of the table, level with it. */
  serveFrom(at: THREE.Vector3) {
    const d = this.dims;
    const local = at.clone().sub(new THREE.Vector3(this.x, 0, this.z)).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
    const left = local.x <= d.cx;
    const endX = left ? d.cx - d.L / 2 - 0.32 : d.cx + d.L / 2 + 0.32;
    const p = this.world(endX, local.z);
    return { x: p.x, z: p.z, yaw: this.yaw + (left ? Math.PI / 2 : -Math.PI / 2) };
  }
}
