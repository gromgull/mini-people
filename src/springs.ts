/**
 * Second-order dynamics (after t3ssel8r, "Giving Personality to Procedural
 * Animations"). A critically/under/over-damped follower of an input signal:
 *   f  – natural frequency (Hz): how quickly it responds
 *   z  – damping ratio: <1 wobbles/overshoots, 1 is critical, >1 sluggish
 *   r  – initial response: 0 lags in, 1 matches immediately, >1 overshoots
 *        (anticipation), <0 starts by moving the wrong way (wind-up)
 */
export interface SpringParams {
  f: number;
  z: number;
  r: number;
}

export class Spring {
  y = 0;
  private yd = 0;
  private xp = 0;
  private ready = false;

  update(dt: number, x: number, p: SpringParams): number {
    if (!this.ready) {
      this.y = this.xp = x;
      this.yd = 0;
      this.ready = true;
      return x;
    }
    if (dt <= 0) return this.y;
    const w = 2 * Math.PI * p.f;
    const k1 = p.z / (Math.PI * p.f);
    const k2 = 1 / (w * w);
    const k3 = (p.r * p.z) / w;
    const xd = (x - this.xp) / dt;
    this.xp = x;
    // clamp k2 so large steps (e.g. 8 fps "on twos") stay stable without jitter
    const k2s = Math.max(k2, (dt * dt) / 2 + (dt * k1) / 2, dt * k1);
    this.y += dt * this.yd;
    this.yd += (dt * (x + k3 * xd - this.y - k1 * this.yd)) / k2s;
    return this.y;
  }
}
