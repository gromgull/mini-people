import * as THREE from 'three';
import type { Person } from './body';
import { type ActionPose, type PropKit, reachFist, smooth } from './actionkit';
import type { Chore, ChoreOut } from './chores';

/**
 * Hands on something that moves: each frame the hands are solved onto world
 * points given by whoever started it (a crank handle going round, a frame to
 * steady yourself on), with a lean into the work. Lasts until release().
 */

export interface HoldPlan {
  right: (() => THREE.Vector3 | null) | null;
  left: (() => THREE.Vector3 | null) | null;
  lean: number;
  /** Bob with the work: crouch amount and how fast (0 = still). */
  bob?: () => number;
}

export class Hold implements Chore {
  private plan: HoldPlan = { right: null, left: null, lean: 0 };
  private releasing = -1;
  private t = 0;
  private w = 0;

  constructor(private p: Person, _kit: PropKit) {}

  aim(plan: HoldPlan) {
    this.plan = plan;
  }

  /** Let go (takes a moment). */
  release() {
    if (this.releasing < 0) this.releasing = this.t;
  }

  start() {
    this.releasing = -1;
    this.t = 0;
  }

  pre(t: number, _dt: number, P: ActionPose, _tempo: number, out: ChoreOut) {
    this.t = t;
    const off = this.releasing >= 0 ? smooth((t - this.releasing) / 0.4) : 0;
    if (off >= 1) return false;
    const w = (this.w = smooth(t / 0.4) * (1 - off));
    out.holdSpeed = true;
    P.spineX += this.plan.lean * w;
    P.crouch += (this.plan.bob?.() ?? 0) * w;
    P.headX += 0.15 * w;
    for (const sd of ['L', 'R'] as const) Object.assign(P.arms[sd], { w, x: -1.0, z: 0.2, elbow: 1.0, stiff: 2 });
    return true;
  }

  post() {
    const p = this.p;
    p.root.updateMatrixWorld(true);
    for (const [side, get] of [['R', this.plan.right], ['L', this.plan.left]] as const) {
      const at = get?.();
      if (at) reachFist(p, side, p.root.worldToLocal(at.clone()), this.w);
    }
  }

  hide() {}
  dispose() {}
}
