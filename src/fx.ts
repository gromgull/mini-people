import * as THREE from 'three';

/** Tiny pooled spark burst (hammer impacts). Pure ballistic points, no physics. */
export class Sparks {
  private pool: { m: THREE.Mesh; v: THREE.Vector3; life: number }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, count = 64) {
    const geo = new THREE.OctahedronGeometry(0.014, 0);
    const mats = ['#fff6c0', '#ffd24a', '#ffffff'].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, mats[i % mats.length]);
      m.visible = false;
      m.raycast = () => {};
      scene.add(m);
      this.pool.push({ m, v: new THREE.Vector3(), life: 0 });
    }
  }

  burst(at: THREE.Vector3, n = 7, power = 1) {
    for (let i = 0; i < n; i++) {
      const s = this.pool[this.next++ % this.pool.length];
      const a = Math.random() * Math.PI * 2;
      const h = 0.6 + Math.random() * 1.2;
      s.v.set(Math.cos(a) * h, 1.2 + Math.random() * 1.5, Math.sin(a) * h).multiplyScalar(power);
      s.m.position.copy(at);
      s.life = 0.25 + Math.random() * 0.2;
      s.m.visible = true;
    }
  }

  update(dt: number) {
    for (const s of this.pool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.v.y -= 12 * dt;
      s.m.position.addScaledVector(s.v, dt);
      s.m.scale.setScalar(Math.max(0.01, s.life * 3));
      if (s.life <= 0 || s.m.position.y < 0) s.m.visible = false;
    }
  }
}
