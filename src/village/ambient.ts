import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * The village as a moving picture (?ambient=1): nobody at the controls, a
 * camera that looks after itself. It alternates
 *
 *   wide   the whole village, turning slowly round its middle (once in
 *          about nine minutes), the angle drifting a little: 90-120 s
 *   close  down lower and closer on something going on (people at work,
 *          the band and the dancing, supper at the tables, the windmill
 *          turning, the cat), looking in from the village's side (so the
 *          houses are behind it, not in the way), drifting a little: 30-60 s
 *
 * and glides from one to the next (never a cut). What's "going on" is
 * scored by whoever's asked (`interests`): nearby things add up (a crowd at
 * work beats one person), and places it's been to lately count for little.
 * Late at night it keeps to the wide view, turning slower.
 */

export interface Interest {
  x: number;
  z: number;
  score: number;
  /** How close to go (the camera's zoom), and how high to look (m). */
  zoom?: number;
  height?: number;
}

/** A shot as it stands at its start: where it looks, from which way round and how high, how close; and how it moves on. */
interface Shot {
  x: number;
  y: number;
  z: number;
  az: number;
  el: number;
  zoom: number;
  /** Turning (rad/s), and the look point's drift (m/s along x, z). */
  spin: number;
  drift: [number, number];
  kind: 'wide' | 'close';
}

/** Once round the village in this many seconds (wide); close up, a third as fast. */
const ROUND = 540;
const GLIDE = 9;
const R = 300; // (how far back the camera sits: an orthographic view doesn't change with it)
const deg = THREE.MathUtils.degToRad;

const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Director {
  private from: Shot;
  private to: Shot;
  private shotT = 0;
  private fromT = 0;
  private until: number;
  private recent: { x: number; z: number }[] = [];

  /**
   * `wide`: the middle of the village and a zoom that fits all of it from
   * any side; `interests`: what's going on now; `quiet`: late at night.
   */
  constructor(
    private camera: THREE.OrthographicCamera,
    private controls: OrbitControls,
    private wide: { x: number; z: number; zoom: number },
    private interests: () => Interest[],
    private quiet: () => boolean,
  ) {
    this.to = this.wideShot(deg(25));
    this.from = this.to;
    this.until = 90 + Math.random() * 30;
    controls.enabled = false;
  }

  private wideShot(az: number): Shot {
    const w = this.wide;
    return { x: w.x, y: 0.5, z: w.z, az, el: deg(36 + Math.random() * 6), zoom: w.zoom, spin: ((Math.PI * 2) / ROUND) * (this.quiet() ? 0.6 : 1), drift: [0, 0], kind: 'wide' };
  }

  /** The most interesting thing going on (somewhere it hasn't just been), or nothing. */
  private pick(): Interest | null {
    const all = this.interests();
    if (!all.length) return null;
    // what's near adds up (a crowd at work, the band); somewhere seen lately counts for little
    const scored = all.map((a) => {
      let s = 0;
      for (const b of all) if (Math.hypot(a.x - b.x, a.z - b.z) < 2.5) s += b.score;
      if (this.recent.some((r) => Math.hypot(r.x - a.x, r.z - a.z) < 4)) s *= 0.15;
      return { a, s };
    });
    // a weighted pick among them (the best most likely, but not always)
    const total = scored.reduce((n, x) => n + x.s * x.s, 0);
    let r = Math.random() * total;
    for (const x of scored) {
      r -= x.s * x.s;
      if (r <= 0) return x.a;
    }
    return scored[scored.length - 1].a;
  }

  /** Where a shot is now, `t` seconds in. */
  private at(s: Shot, t: number) {
    return { x: s.x + s.drift[0] * t, y: s.y, z: s.z + s.drift[1] * t, az: s.az + s.spin * t, el: s.el, zoom: s.zoom };
  }

  /** The next shot: close up on something (if there's anything worth it and it isn't the dead of night), else wide again. */
  private next(now: { az: number }) {
    const wasWide = this.to.kind === 'wide';
    let shot: Shot | null = null;
    if (wasWide && !this.quiet()) {
      const i = this.pick();
      if (i) {
        // look in from the village's middle side (the houses are round the edge: behind it, not in front)
        const az = Math.atan2(this.wide.x - i.x, this.wide.z - i.z) + (Math.random() - 0.5) * 0.8;
        const dir = Math.random() < 0.5 ? 1 : -1;
        const sway = (Math.random() - 0.5) * 0.04;
        shot = {
          x: i.x,
          y: i.height ?? 0.5,
          z: i.z,
          az,
          el: deg(20 + Math.random() * 10),
          zoom: i.zoom ?? 2.8,
          spin: ((Math.PI * 2) / ROUND / 3) * dir,
          drift: [Math.cos(az) * sway, -Math.sin(az) * sway],
          kind: 'close',
        };
        this.recent.push({ x: i.x, z: i.z });
        if (this.recent.length > 3) this.recent.shift();
        this.until = 30 + Math.random() * 30;
      }
    }
    if (!shot) {
      shot = this.wideShot(now.az);
      this.until = (this.quiet() ? 150 : 90) + Math.random() * 30;
    }
    return shot;
  }

  /** Move the camera on (call once a frame, before the controls' update). */
  update(dt: number) {
    this.shotT += dt;
    this.fromT += dt;
    const cur = this.view();
    if (this.shotT >= this.until) {
      // the next shot starts from wherever this one's got to
      this.from = { ...this.to, ...this.at(this.to, this.shotT) };
      this.fromT = 0;
      this.to = this.next(cur);
      this.shotT = 0;
    }
    this.apply(this.view());
  }

  /** Where the camera is now: gliding from the last shot into this one. */
  private view() {
    const k = smooth(this.shotT / GLIDE);
    const a = this.at(this.from, this.fromT), b = this.at(this.to, this.shotT);
    const mix = (u: number, v: number) => u + (v - u) * k;
    return {
      x: mix(a.x, b.x),
      y: mix(a.y, b.y),
      z: mix(a.z, b.z),
      az: a.az + wrap(b.az - a.az) * k, // (the short way round)
      el: mix(a.el, b.el),
      zoom: Math.exp(mix(Math.log(a.zoom), Math.log(b.zoom))), // (zooming evenly, not all at the end)
    };
  }

  private apply(v: ReturnType<Director['view']>) {
    const target = this.controls.target.set(v.x, v.y, v.z);
    this.camera.position.set(target.x + Math.sin(v.az) * Math.cos(v.el) * R, target.y + Math.sin(v.el) * R, target.z + Math.cos(v.az) * Math.cos(v.el) * R);
    this.camera.zoom = v.zoom;
    this.camera.updateProjectionMatrix();
  }
}
