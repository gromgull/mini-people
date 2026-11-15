import * as THREE from 'three';

/**
 * A colour grade over the finished (pixel-art) frame, as it's copied to the
 * screen: one pass, so everything (people, houses, grass, sky) is graded
 * alike. Worked in display space, in this order:
 *
 *   greens: green hues pulled toward another hue (olive, sage, teal) and
 *     softened a little: the grass is most of the picture
 *   contrast and saturation
 *   a split tone: the shadows pulled toward one colour, the light toward
 *     another (cool shadows and warm light is most of the "painted" feel)
 *   fade: a wash toward a paper colour (lifts the blacks, pastel)
 *   grain: a still, paper-like speckle and mottle, one per pixel-art pixel
 *     (it doesn't crawl from frame to frame)
 *   vignette (dithered, as is everything: no banding on a flat field)
 *
 * `hike` is the look; `none` leaves the frame exactly as it was rendered.
 */

export interface Grade {
  /** How far green hues go toward `greenTo` (a hue, degrees: 60 yellow-olive, 100 sage, 150 teal). */
  greens: number;
  greenTo: number;
  saturation: number;
  contrast: number;
  /** How far the shadows and the light are pulled toward their colours. */
  split: number;
  shadows: string;
  light: string;
  fade: number;
  paper: string;
  grain: number;
  vignette: number;
}

export const GRADES: Record<string, Grade> = {
  none: { greens: 0, greenTo: 90, saturation: 1, contrast: 1, split: 0, shadows: '#4a5a8a', light: '#ffe0a0', fade: 0, paper: '#f3e6c8', grain: 0, vignette: 0 },
  // muted, pastel, faded, a little paper grain: sage greens, cool teal shadows, warm peach light (Cody Gindy)
  storybook: { greens: 0.5, greenTo: 115, saturation: 0.78, contrast: 0.92, split: 0.3, shadows: '#3c6f7a', light: '#ffd6ad', fade: 0.12, paper: '#f2e2c4', grain: 0.025, vignette: 0.12 },
  // bright but harmonised: warm olive greens, purple-blue shadows, golden light (A Short Hike)
  hike: { greens: 0.5, greenTo: 58, saturation: 1.0, contrast: 1.06, split: 0.28, shadows: '#4b4690', light: '#ffdc80', fade: 0.02, paper: '#fff1d6', grain: 0, vignette: 0.2 },
  // halfway: softer greens, a little less colour, a gentle warm/cool split
  soft: { greens: 0.3, greenTo: 88, saturation: 0.88, contrast: 0.96, split: 0.16, shadows: '#47607e', light: '#ffe2bc', fade: 0.06, paper: '#f4e8d0', grain: 0.015, vignette: 0.08 },
};

/** The grade named by ?grade= (none, storybook, hike, soft), else hike: the look. */
export function gradeFromQuery(q: URLSearchParams): Grade {
  return { ...(GRADES[q.get('grade') ?? ''] ?? GRADES.hike) };
}

/** The material that copies the frame to the screen, graded (see setGrade each frame). */
export function gradeMaterial(map: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uGreens: { value: 0 },
      uGreenTo: { value: 90 },
      uSat: { value: 1 },
      uContrast: { value: 1 },
      uSplit: { value: 0 },
      uShadows: { value: new THREE.Color() },
      uLight: { value: new THREE.Color() },
      uFade: { value: 0 },
      uPaper: { value: new THREE.Color() },
      uGrain: { value: 0 },
      uVignette: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 uTexel;
      uniform float uGreens, uGreenTo, uSat, uContrast, uSplit, uFade, uGrain, uVignette;
      uniform vec3 uShadows, uLight, uPaper;
      varying vec2 vUv;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }

      vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
      }
      vec3 hsv2rgb(vec3 c) {
        vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
        return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
      }

      void main() {
        vec4 src = texture2D(map, vUv);
        // (to display space to grade, back to linear for the output conversion)
        vec3 c = sRGBTransferOETF(vec4(src.rgb, 1.0)).rgb;
        // greens toward the chosen hue (and a little softer), the more so the greener
        if (uGreens > 0.0) {
          vec3 hsv = rgb2hsv(c);
          float hue = hsv.x * 360.0;
          float w = smoothstep(55.0, 85.0, hue) * (1.0 - smoothstep(150.0, 180.0, hue)) * smoothstep(0.08, 0.3, hsv.y);
          hsv.x = mix(hue, uGreenTo, uGreens * w) / 360.0;
          hsv.y *= 1.0 - 0.3 * uGreens * w;
          c = hsv2rgb(hsv);
        }
        c = (c - 0.5) * uContrast + 0.5;
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(vec3(l), c, uSat);
        // split tone: shadows toward one colour, light toward the other
        l = dot(c, vec3(0.299, 0.587, 0.114));
        float ws = 1.0 - smoothstep(0.0, 0.62, l);
        float wl = smoothstep(0.38, 1.0, l);
        c = mix(c, c * 0.35 + uShadows * 0.65, uSplit * ws);
        c = mix(c, c * (uLight * 1.15), uSplit * wl);
        // the wash toward paper
        c = mix(c, uPaper, uFade);
        // still grain, per pixel-art pixel: a fine speckle and a slow mottle
        vec2 px = floor(vUv / uTexel);
        float g = (hash(px) - 0.5) + 0.35 * (noise(px / 7.0) - 0.5);
        c += g * uGrain;
        // vignette
        vec2 d = vUv - 0.5;
        float r = length(d * vec2(1.0, 0.8)) * 1.6;
        c *= 1.0 - uVignette * r * r * r; // (no edge to it anywhere: it just gathers toward the corners)
        // a dither of a third of a step, so smooth changes don't band (only when grading at all)
        if (uGreens + uSplit + uFade + uVignette + abs(uSat - 1.0) + abs(uContrast - 1.0) > 0.0) c += (hash(gl_FragCoord.xy) - 0.5) / 255.0 * 1.5;
        c = clamp(c, 0.0, 1.0);
        gl_FragColor = vec4(sRGBTransferEOTF(vec4(c, 1.0)).rgb, src.a);
        #include <colorspace_fragment>
      }`,
    depthTest: false,
    depthWrite: false,
  });
}

/** Set a grade material's uniforms from a Grade (and the frame's size in pixels). */
export function setGrade(m: THREE.ShaderMaterial, g: Grade, w: number, h: number) {
  const u = m.uniforms;
  u.uTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  u.uGreens.value = g.greens;
  u.uGreenTo.value = g.greenTo;
  u.uSat.value = g.saturation;
  u.uContrast.value = g.contrast;
  u.uSplit.value = g.split;
  // (the grade works in display space: the colours as written, not linearised)
  u.uShadows.value.set(g.shadows).convertLinearToSRGB();
  u.uLight.value.set(g.light).convertLinearToSRGB();
  u.uFade.value = g.fade;
  u.uPaper.value.set(g.paper).convertLinearToSRGB();
  u.uGrain.value = g.grain;
  u.uVignette.value = g.vignette;
}
