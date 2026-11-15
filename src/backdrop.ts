import * as THREE from 'three';
import { ROWS, ROW_COUNT } from './palette';
import { mulberry32 } from './rng';

/**
 * The land round about, beyond the horizon: snow-capped mountains on one
 * side, rolling green hills on the flanks, and the open valley (with only
 * low, far-off hills) toward the sunset.
 *
 * The camera is orthographic, so the horizon is a straight line at a fixed
 * depth along the view (where the ground fades out), not a circle; and
 * anything further back is simply drawn higher up. So each layer of ridges
 * is built once in an unrolled panorama (compass direction, height, depth)
 * and a vertex shader lays it along that line every frame: the bit of land
 * in the direction you're looking sits straight ahead, the rest slides off
 * to the sides as you turn. Each layer sits at its own depth past the
 * horizon (further = higher on screen), follows a pan by its own fraction
 * (parallax), and fades toward the horizon's haze by its own amount
 * (distance). They're lit like everything else, with the normals they'd
 * really have at their compass direction: the sun setting in the valley
 * lights up the mountains opposite it.
 */

/** Compass directions (radians, as atan2(x, z) of the direction from the village). */
// the snow-capped mountains: a little round from due north, so the noon sun (at 35°) clears them;
// the morning sun comes up behind them
const PEAKS_AT = -0.35;
const VALLEY_AT = Math.PI; // the open valley (the sun sets at about 185°)

interface LayerSpec {
  /** How far past the horizon (× the horizon's distance; further = higher on screen). */
  depth: number;
  /** How much of a pan it follows (1 = glued to the view; less = nearer). */
  follow: number;
  /** How much it fades into the haze. */
  air: number;
  /** Rows of the ridge, front to back, and how deep (world units) the whole ridge is. */
  rows: number;
  deep: number;
  /** Gullies and spurs down its slopes, this many round the compass (they catch the light differently). */
  gully: number;
  /** Crest height (world units) round the compass. */
  crest: (az: number) => number;
  /** Which colour row a facet gets, from its height, slope (normal's up part) and compass direction. */
  row: (y: number, up: number, az: number, crest: number) => number;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** 1 within `flat` of `at`, falling smoothly to 0 by `flat + fade` either side. */
const plateau = (az: number, at: number, flat: number, fade: number) => {
  const d = (Math.abs(wrap(az - at)) - flat) / fade;
  return d <= 0 ? 1 : d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
};
/** Down out of sight (under the horizon) where the valley opens: nothing at all toward the sunset. */
const VALLEY_FLAT = 0.001; // (open only right at the sunset)
const VALLEY_FADE = 0.5; // rising either side over ±30°
const DOWN = -1.5;

/** 1 at `at`, falling smoothly to 0 by `width` either side. */
const near = (az: number, at: number, width: number) => {
  const d = Math.abs(wrap(az - at)) / width;
  return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
};

/** Seeded, seamless round the compass: a sum of sines of whole frequencies. */
function wave(r: () => number, lo: number, hi: number, n: number) {
  const parts = Array.from({ length: n }, (_, k) => {
    const f = Math.round(lo * (hi / lo) ** (k / Math.max(1, n - 1)));
    return { f, a: (1 / f) * (0.6 + 0.8 * r()), p: r() * Math.PI * 2 };
  });
  const norm = parts.reduce((s, q) => s + q.a, 0);
  return (az: number) => parts.reduce((s, q) => s + q.a * Math.sin(q.f * az + q.p), 0) / norm; // about −1 … 1
}

export class Backdrop {
  readonly group = new THREE.Group();
  private layers: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; spec: LayerSpec }[] = [];
  private _fwd = new THREE.Vector3();

  constructor(
    private atlas: THREE.Texture,
    private shared: { uLightView: THREE.IUniform; uTint: THREE.IUniform; uWrap: THREE.IUniform; uHaze: THREE.IUniform },
    seed = 1,
  ) {
    this.build(seed);
  }

  /** Build (or rebuild) the land for this seed. */
  build(seed: number) {
    for (const l of this.layers) {
      l.mesh.geometry.dispose();
      l.mat.dispose();
      this.group.remove(l.mesh);
    }
    this.layers = [];
    const r = mulberry32(seed * 7919 + 101);
    // the mountains: jagged peaks where they stand, low far ranges elsewhere
    const jag = wave(r, 7, 60, 9);
    const big = wave(r, 2, 6, 3);
    const ranges = wave(r, 16, 34, 3); // the far ranges' own ups and downs
    const peaksW = 1.0 + r() * 0.25;
    // (world units: the sky's own band is only a few metres high in this view: the
    // sun's whole climb is drawn within ~2.7 m of the horizon, and the peaks stay under it)
    const far: LayerSpec = {
      depth: 1.06,
      follow: 1,
      air: 0.3,
      rows: 7,
      deep: 3,
      gully: 34,
      crest: (az) => {
        const m = near(az, PEAKS_AT, peaksW);
        const ridged = 1 - Math.abs(jag(az)); // sharp tops
        const h = 0.45 + 0.3 * (0.5 + 0.5 * big(az)) + 0.25 * (0.5 + 0.5 * ranges(az)) + m * (0.7 + 0.5 * big(az + 1) + 1.2 * ridged * ridged);
        const open = plateau(az, VALLEY_AT, VALLEY_FLAT, VALLEY_FADE);
        return h + (DOWN - h) * open;
      },
      row: (y, up, az, crest) => {
        const m = near(az, PEAKS_AT, peaksW);
        if (m > 0.25 && y > 1.45 + 0.25 * jag(az * 3) && up > 0.3) return ROWS.cloud[0]; // snow
        if (m > 0.25 && y > 1.0) return ROWS.stone[up > 0.7 ? 1 : 2]; // rock
        if (y > crest * 0.55 && m < 0.2) return ROWS.pine[1]; // far wooded ranges
        return ROWS.pine[up > 0.75 ? 0 : 2];
      },
    };
    // rolling green hills on the flanks, low toward the valley and in front of the peaks
    const roll = wave(r, 4, 24, 6);
    const humps = wave(r, 14, 26, 3); // a few to a view
    const lump = wave(r, 10, 30, 4);
    const woods = wave(r, 6, 20, 4);
    const hills: LayerSpec = {
      depth: 1.02,
      follow: 0.92,
      air: 0.1,
      rows: 5,
      deep: 1.6,
      gully: 14,
      crest: (az) => {
        const under = near(az, PEAKS_AT, 0.6); // in front of the peaks: lower, so the peaks show
        const h = (0.3 + 0.6 * (0.5 + 0.5 * roll(az)) + 0.75 * (0.5 + 0.5 * humps(az)) + 0.12 * lump(az)) * (1 - 0.55 * under);
        // the valley: they part completely (a touch wider than the far ranges, so those taper behind)
        const open = plateau(az, VALLEY_AT, VALLEY_FLAT + 0.08, VALLEY_FADE);
        return h + (DOWN - h) * open;
      },
      // meadows and woods (woods on the steeper sides, and in patches)
      row: (_y, up, az) => (woods(az) > 0.1 || up < 0.7 ? ROWS.pine[up > 0.8 ? 0 : 2] : ROWS.leaf[up > 0.9 ? 1 : 2]),
    };
    for (const spec of [far, hills]) this.addLayer(spec);
  }

  private addLayer(spec: LayerSpec) {
    const N = 360; // across the compass (a facet a degree)
    const M = spec.rows;
    const REF = 30; // world units per radian, for the facets' slopes
    const BASE = -2; // the front edge, underground (so there's no gap under the horizon; the ground hides it)
    // the ridge's profile front to back: up from the base to the crest, then a little down
    const prof = (t: number) => (t < 0.72 ? Math.sin((t / 0.72) * Math.PI * 0.5) ** 0.8 : 1 - 0.35 * ((t - 0.72) / 0.28) ** 2);
    const jitter = mulberry32(Math.floor(spec.depth * 1000));
    const phase = jitter() * 6.28;
    const H: number[][] = [];
    const crest: number[] = [];
    for (let i = 0; i <= N; i++) {
      const az = (i / N) * Math.PI * 2 - Math.PI;
      crest[i] = spec.crest(az);
      H[i] = [];
      for (let j = 0; j <= M; j++) {
        const t = j / M;
        // gullies and spurs running down the slope (slanting a little), and a jostle so it's facets, not a sheet
        const g = j > 0 && j < M ? Math.sin(spec.gully * az + t * 2.2 + phase) * 0.09 * crest[i] * Math.sin(Math.PI * t) : 0;
        const bump = j > 0 && j < M ? (jitter() - 0.5) * 0.05 * crest[i] : 0;
        H[i][j] = BASE + (crest[i] - BASE) * prof(t) + g + bump;
      }
    }
    // (wrap seamlessly: the last column is the first)
    H[N] = H[0];
    const pos: number[] = [];
    const nrm: number[] = [];
    const rows: number[] = [];
    const P = (i: number, j: number) => new THREE.Vector3(((i / N) * Math.PI * 2 - Math.PI) * REF, H[i][j], (j / M) * spec.deep);
    const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
      const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
      if (n.y < 0) n.negate();
      const cy = (a.y + b.y + c.y) / 3;
      const az = (a.x + b.x + c.x) / 3 / REF;
      const row = spec.row(cy, n.y, az, spec.crest(az));
      for (const v of [a, b, c]) {
        pos.push(v.x / REF, v.y, v.z); // (x stored as the compass direction)
        nrm.push(n.x, n.y, n.z);
        rows.push(row);
      }
    };
    for (let i = 0; i < N; i++)
      for (let j = 0; j < M; j++) {
        const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1);
        // (unrolled, the last column's compass direction is +π: keep it as such, the shader wraps)
        tri(a, d, b);
        tri(b, d, c);
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('aRow', new THREE.Float32BufferAttribute(rows, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        uAtlas: { value: this.atlas },
        uRows: { value: ROW_COUNT },
        uTarget: { value: new THREE.Vector3() },
        uViewAz: { value: 0 },
        uDepth: { value: 30 },
        uPan: { value: 0 },
        uScale: { value: 1 },
        uAir: { value: spec.air },
      },
      vertexShader: /* glsl */ `
        attribute float aRow;
        uniform vec3 uTarget;
        uniform float uViewAz;
        uniform float uDepth;
        uniform float uPan;
        uniform float uScale;
        varying vec3 vN;
        varying float vRow;
        varying float vAhead;
        varying float vY;
        varying float vAz;
        void main() {
          float az = position.x;
          vAz = az;
          float rel = atan(sin(az - uViewAz), cos(az - uViewAz));
          vAhead = cos(rel);
          vec3 fwd = vec3(sin(uViewAz), 0.0, cos(uViewAz));
          vec3 right = vec3(-cos(uViewAz), 0.0, sin(uViewAz));
          vec3 dir = vec3(sin(az), 0.0, cos(az));
          // along the horizon line: straight ahead at the layer's depth, out to the side by
          // how far round the compass it is (as the sun and clouds are), shifted for parallax
          vec3 side = (dir - fwd * dot(dir, fwd)) * uDepth;
          vec3 p = uTarget + fwd * (uDepth + position.z * uScale) + side - right * uPan;
          p.y = position.y * uScale;
          vY = p.y;
          // lit as it really faces: across, up, and out from the village at its own compass direction
          vec3 tangent = vec3(cos(az), 0.0, -sin(az));
          vec3 n = normal.x * tangent + normal.y * vec3(0.0, 1.0, 0.0) + normal.z * dir;
          vN = normalize(mat3(viewMatrix) * n);
          vRow = aRow;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        uniform float uRows;
        uniform vec3 uLightView;
        uniform float uWrap;
        uniform vec3 uTint;
        uniform vec3 uHaze;
        uniform float uAir;
        varying vec3 vN;
        varying float vRow;
        varying float vAhead;
        varying float vY;
        varying float vAz;
        void main() {
          if (vAhead < 0.05) discard; // behind you (and the seam round the back)
          float ndl = dot(normalize(vN), uLightView);
          float u = clamp((ndl + uWrap) / (1.0 + uWrap), 0.001, 0.999);
          vec3 c = texture2D(uAtlas, vec2(u, (vRow + 0.5) / uRows)).rgb * uTint;
          // valley mist: the feet fade right into the horizon's haze (as the ground does just in
          // front of them), clearing with height in a few bands with a ragged top
          float rag = 0.1 * sin(vAz * 37.0 + 1.7) + 0.07 * sin(vAz * 91.0 + 0.3) + 0.05 * sin(vAz * 173.0 + 2.9);
          float mist = 1.0 - smoothstep(0.0, 0.45, vY + rag);
          mist = floor(mist * 4.0 + 0.5) / 4.0;
          // and distance: toward that same haze
          gl_FragColor = vec4(mix(c, uHaze, max(uAir, mist)), 1.0);
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    this.group.add(mesh);
    this.layers.push({ mesh, mat, spec });
  }

  /** Lay the land along the horizon for this view. */
  update(camera: THREE.OrthographicCamera, target: THREE.Vector3, far: number) {
    const fwd = this._fwd.subVectors(target, camera.position).setY(0).normalize();
    const viewAz = Math.atan2(fwd.x, fwd.z);
    // how far the view is panned across, from the middle of the world (for parallax)
    const across = -target.x * Math.cos(viewAz) + target.z * Math.sin(viewAz);
    for (const l of this.layers) {
      const u = l.mat.uniforms;
      u.uTarget.value.copy(target).setY(0);
      u.uViewAz.value = viewAz;
      u.uDepth.value = far * l.spec.depth;
      u.uPan.value = across * (1 - l.spec.follow);
      u.uScale.value = 1;
    }
  }
}
