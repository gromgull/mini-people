import * as THREE from 'three';

/**
 * Chimney smoke: puffs that leave a chimney top, rise (slowing as they go),
 * drift downwind with a little wander, swell and fade. Each puff is a
 * low-poly ball with its own see-through material, coloured by the time of
 * day like everything else (dusky at dusk, dim at night). Driven by
 * simulation time, so it pauses and fast-forwards with the world.
 */

interface Puff {
  mesh: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  age: number;
  life: number;
  vel: THREE.Vector3;
  size: number;
  spin: number;
}

export interface Chimney {
  at: THREE.Vector3;
  /** Puffs per second (0 = no fire). */
  rate: number;
  /** How thick: scales the puffs. */
  heavy: number;
  next: number;
}

const BASE = new THREE.Color('#e4e1da');
const geo = new THREE.IcosahedronGeometry(1, 0);

export class Smoke {
  readonly group = new THREE.Group();
  readonly chimneys: Chimney[] = [];
  private puffs: Puff[] = [];
  private free: Puff[] = [];
  private t = 0;
  /** Which way the smoke blows (world xz, per second at full height). */
  wind = new THREE.Vector2(0.16, -0.06);

  add(at: THREE.Vector3, rate: number, heavy = 1) {
    const c: Chimney = { at: at.clone(), rate, heavy, next: Math.random() / Math.max(0.1, rate) };
    this.chimneys.push(c);
    return c;
  }

  private emit(c: Chimney) {
    const vel = new THREE.Vector3((Math.random() - 0.5) * 0.06, 0.42 + Math.random() * 0.12, (Math.random() - 0.5) * 0.06);
    this.puff(c.at, (0.07 + Math.random() * 0.03) * c.heavy, 3.2 + Math.random() * 1.6, vel);
  }

  /** One puff, anywhere: a pipe's wisp, a breath of smoke (size: starting radius; it swells about fourfold). */
  puff(at: THREE.Vector3, size: number, life: number, vel: THREE.Vector3) {
    const p =
      this.free.pop() ??
      (() => {
        const mat = new THREE.MeshBasicMaterial({ color: BASE.clone(), transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.raycast = () => {};
        mesh.renderOrder = 3;
        this.group.add(mesh);
        return { mesh, age: 0, life: 0, vel: new THREE.Vector3(), size: 0, spin: 0 } as Puff;
      })();
    p.age = 0;
    p.life = life;
    p.vel.copy(vel);
    p.size = size;
    p.spin = (Math.random() - 0.5) * 1.5;
    p.mesh.position.copy(at);
    p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    p.mesh.visible = true;
    this.puffs.push(p);
  }

  /** Advance by dt seconds of simulation; `tint` is the daylight colour. */
  update(dt: number, tint: THREE.Color) {
    this.t += dt;
    for (const c of this.chimneys) {
      if (c.rate <= 0) {
        c.next = Math.max(c.next, this.t);
        continue;
      }
      while (this.t >= c.next) {
        this.emit(c);
        c.next += (0.6 + Math.random() * 0.8) / c.rate;
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.mesh.visible = false;
        this.puffs.splice(i, 1);
        this.free.push(p);
        continue;
      }
      // rise slows; the wind takes over the higher it gets
      const rise = p.vel.y * (1 - 0.7 * k);
      const drift = Math.min(1, k * 2.5);
      p.mesh.position.x += (p.vel.x + this.wind.x * drift + 0.3 * p.size * Math.sin(this.t * 1.3 + p.spin * 5)) * dt;
      p.mesh.position.y += rise * dt;
      p.mesh.position.z += (p.vel.z + this.wind.y * drift) * dt;
      p.mesh.rotation.y += p.spin * dt;
      p.mesh.scale.setScalar(p.size * (1 + 3.2 * Math.sqrt(k)));
      // fade in quickly, out slowly
      p.mesh.material.opacity = 0.62 * Math.min(1, k * 8) * (1 - k) ** 1.4;
      p.mesh.material.color.copy(BASE).multiply(tint);
    }
  }
}
