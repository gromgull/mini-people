import type * as THREE from 'three';
import type { Person } from './body';
import type { Crowd } from './crowd';
import type { Stage } from './stage';

/**
 * The frame both pages run (the village and the debug page): the same steps
 * in the same order, each page filling in only its own parts.
 *
 *   simulate → sweep stray sounds → follow → camera controls → light →
 *   scenery (what's shown, what moves on its own) → shadows → sky and
 *   horizon → (labels, panel) → render
 *
 * and, once it's drawn a couple of frames, the test hook on window.__mini
 * (a common base, plus whatever the page adds).
 */

export interface AppHooks {
  /** Paused (the light and the sky's clock stand still too). */
  paused(): boolean;
  /** Run the world on by this much real time; return false if it didn't step at all (sounds aren't swept then). */
  simulate(dt: number): boolean;
  /** Keep the camera on whoever it's following (`first`: the very first frame, jump there). */
  follow?(dt: number, first: boolean): void;
  /** What's shown, and anything that changes with time but isn't simulated (the pond's ripples, …). */
  scenery?(): void;
  /** The page's own shadows to turn away from the sun (the crowd's are done). */
  shadows?(): void;
  /** How far out from the view's middle things are (keeps them inside the horizon). */
  extent(): number;
  /** Just before drawing (labels, the panel). */
  beforeRender?(frame: number): void;
  /** What the page adds to window.__mini. */
  testHook(): Record<string, unknown>;
}

/** What every page's window.__mini has (the scripts in scripts/ rely on it). */
export interface TestHookBase {
  ready: true;
  renderer: THREE.WebGLRenderer;
  camera: THREE.OrthographicCamera;
  /** The orbit controls (the camera's pivot is controls.target). */
  controls: Stage['controls'];
  people: Person[];
}

export function runApp(stage: Stage, crowd: Crowd, h: AppHooks) {
  let frames = 0;
  stage.run((start) => {
    const dt = stage.delta();
    crowd.frameTick();
    const paused = h.paused();
    const simulated = paused ? false : h.simulate(dt);
    // stop continuous sounds whose owner stopped reporting (a mode switch, a pause…)
    if (simulated || paused) crowd.sweep();
    h.follow?.(dt, frames === 0);
    stage.controls.update();
    stage.updateLight(dt, paused);
    h.scenery?.();
    crowd.orientShadows();
    h.shadows?.();
    stage.updateEnvironment(dt, h.extent());
    h.beforeRender?.(frames);
    stage.render(start, crowd.people.length);
    if (++frames === 2) {
      // (getters stay getters: the people are swapped for new ones on a rebuild, the clock runs on)
      const base: TestHookBase = {
        ready: true,
        renderer: stage.renderer,
        camera: stage.camera,
        controls: stage.controls,
        get people() {
          return crowd.people;
        },
      };
      (window as unknown as { __mini: unknown }).__mini = Object.defineProperties(base, Object.getOwnPropertyDescriptors(h.testHook()));
    }
  });
}
