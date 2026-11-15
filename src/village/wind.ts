import { mulberry32 } from '../rng';

/**
 * The wind: each day has its own (from the village's seed and the day), so
 * no two days are quite alike. About a quarter of days are calm, half
 * breezy, a quarter windy; through the day it drifts up and down around
 * that, with gusts on top, and blows from a prevailing direction that
 * wanders a little. The flags by the inn show it; the windmill's sails only
 * turn when it's more than CALM.
 *
 *   strength  0 still … 1 a stiff breeze (the gusts can take it a bit past)
 *   toward    which way it blows (radians, the same sense as a yaw: 0 = +z)
 */

/** Below this it's too calm to turn the windmill's sails. */
export const CALM = 0.22;

interface Day {
  base: number;
  toward: number;
  /** Phases and rates of the slow drift, the direction's wander, the gusts. */
  ph: number[];
}

export class Wind {
  strength = 0;
  toward = 0;
  /** The gusts alone (−1 … 1): flags snap with them. */
  gust = 0;
  private days = new Map<number, Day>();

  /** `fixed`: always this strength (?wind=), for looking at a calm or a windy day on purpose. */
  constructor(private seed: number, private fixed: number | null = null) {}

  private day(n: number): Day {
    let d = this.days.get(n);
    if (!d) {
      const r = mulberry32(this.seed * 7331 + n * 104729 + 17);
      const kind = r();
      const base = kind < 0.25 ? 0.04 + 0.12 * r() : kind < 0.75 ? 0.3 + 0.25 * r() : 0.6 + 0.3 * r();
      // the prevailing way it blows: mostly from the same quarter day to day, now and then round to another
      const toward = (mulberry32(this.seed * 7331 + 5)() * Math.PI * 2 + (r() < 0.7 ? (r() - 0.5) * 1.2 : r() * Math.PI * 2)) % (Math.PI * 2);
      d = { base, toward, ph: Array.from({ length: 6 }, () => r() * Math.PI * 2) };
      this.days.set(n, d);
    }
    return d;
  }

  /** Set it for this day and hour (simulation seconds `t` for the gusts). */
  update(day: number, hours: number, t: number) {
    // (blend across midnight into the next day's)
    const a = this.day(day), b = this.day(day + 1);
    const k = Math.max(0, (hours - 22) / 2);
    const base = this.fixed ?? a.base + (b.base - a.base) * k;
    const p = a.ph;
    // the slow drift: a couple of long swells over the day, never far from the day's own
    const drift = 0.12 * Math.sin((hours / 24) * Math.PI * 2 * 1.7 + p[0]) + 0.08 * Math.sin((hours / 24) * Math.PI * 2 * 4.3 + p[1]);
    this.gust = 0.6 * Math.sin(t * 0.73 + p[2]) * Math.sin(t * 0.31 + p[3]) + 0.4 * Math.sin(t * 2.1 + p[4]) * Math.max(0, Math.sin(t * 0.17 + p[5]));
    this.strength = Math.max(0, base + drift * (0.4 + base) + this.gust * 0.12 * (0.3 + base));
    const wander = 0.35 * Math.sin((hours / 24) * Math.PI * 2 * 2.3 + p[4]);
    const turn = Math.atan2(Math.sin(b.toward - a.toward), Math.cos(b.toward - a.toward)); // (the short way round)
    this.toward = a.toward + turn * k + wander;
  }

  /** In words, for the panel. */
  get words() {
    const s = this.strength;
    return s < 0.08 ? 'still' : s < CALM ? 'calm' : s < 0.45 ? 'a breeze' : s < 0.7 ? 'breezy' : 'windy';
  }
}
