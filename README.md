# Mini People

Tiny generative people that walk, work, chat, fiddle and dance in the browser.

**▶ [Live demo](https://gromgull.github.io/mini-people/)**

![A wandering crowd](docs/wander.png)

## Why

Lemmings, Cannon Fodder, Sensible Soccer and The Settlers had characters only
a handful of pixels tall, yet they felt alive. That came almost entirely from
*how they moved*. This project asks how far you can push that idea when
everything is procedural:

- **Procedural people.** Every person is grown from a small genome (height,
  build, head size, nose, hair style, beard, clothes, colours, …) and built from
  primitive meshes at runtime. There are no sprites and no models.
- **Procedural animation.** Nothing is keyframed. Walking, waving, hammering,
  sawing, sitting, falling and dancing are computed every frame on one shared
  rig. The gait comes from stride, duty cycle, bounce, sway, hip roll and arm
  swing, and actions are layered on top with springs, inverse kinematics
  (planar and two-bone) and a small ragdoll for falls.
- **Personality encoded in motion.** Each person also carries a *persona*,
  six sliders: `weight`, `energy`, `dainty`, `posture`, `swagger` and `sloppy`.
  These don't select animations. They bend the same procedural motion: a heavy
  person plants their feet and rolls their shoulders, an energetic one bounces,
  a sloppy one flops their arms. The persona can be set by hand, picked from
  presets, or derived from the body. The hope is that you can tell people
  apart in a crowd of 100 by their walk alone, the way you recognise a friend
  across a street before you can see their face.

![The same body with different personas](docs/compare.png)

*Compare mode: one body, seven personalities (neutral, heavy, dainty, clumsy,
swagger, tired, eager).*

The same approach carries over to sound. Everything is synthesised with Web
Audio from the same genome, with no samples:

- **Footsteps** are heavier for heavier people.
- **Voices** are gibberish whose pitch and vowel character follow body size.
- **Tools and props** have their own sounds: hammer, saw and box.
- **Fiddle tunes** are generated in AABB form over chord progressions. Several
  fiddlers split into melody, harmony and bass parts that play in time
  together.

## What's in it

- **Modes**
  - *parade*: a marching ring.
  - *wander*: a free-roaming square where people walk around each other and
    start doing things.
  - *stand*: a grid.
  - *compare*: persona lanes.
  - *single*: one person up close. With *walk* on, they stroll a loop while
    acting.
- **Actions:** wave, hammer, jump, trip, carry a box, sit on a bench, talk
  (with turn-taking, nods and gestures), saw a log, fiddle, dance, chop down a
  pine, pick (and eat) an apple, and fish. Dancers and fiddlers share one beat.
  Props are conjured and fitted to the person: the trunk stands where *their*
  axe lands, the apple hangs where *their* hand reaches.
- **Faces:** googly eyes that look at each other, the camera, the cursor or
  whatever just happened, plus noses, mouths that gasp, and beards.
- **Look:** cel shading through a palette atlas, pixelation, outlines, banded
  haze toward a horizon, a sky and drifting clouds. There's also an optional
  "animate on twos" low frame rate.

## Controls

| | |
|---|---|
| click | select a person (also turns sound on) |
| shift + click | shove them |
| `1`–`9`, `0` | wave / hammer / jump / trip / carry / sit / talk / saw / fiddle / dance |
| `C` / `A` / `F` | chop a tree / pick an apple / fish |
| `W` | toggle walking (single mode) |
| drag / scroll | orbit / zoom (orbit low to see the sky) |

The panel on the right has the rest: crowd size and seed, gait and persona
sliders for the selected person, looks, and sound levels.

### URL parameters

Handy for sharing a particular scene, e.g.
`?mode=single&who=3&walk` or `?mode=wander&count=80&seed=7`.

| Parameter | Effect |
|---|---|
| `mode` | `single` · `stand` · `parade` · `wander` · `compare` |
| `seed` | which crowd you get |
| `count` | how many people |
| `who` | which person single mode shows |
| `walk` | single mode starts walking |
| `spacing` | how spread out the crowd is |
| `speed` | walking speed |
| `persona` | how strongly personality shows (0 = none) |
| `auto` | random actions in parade / stand |
| `zoom` | camera zoom |
| `az` / `el` | camera angle |
| `px` | pixel size |
| `fps` | animate on twos (e.g. 10) |
| `maxfps` | render frame-rate cap (default 30; 0 = uncapped) |
| `smooth=1` | smooth shading instead of bands |
| `outline=0` | no outlines |
| `sky=0` | no sky or horizon |
| `time` | time of day in hours, 0–24 (default 10; 18 ≈ sunset, 0 = midnight) |
| `daycycle=0` | stop the clock (by default a day passes in `daymin` minutes) |
| `daymin` | real minutes per day when the clock runs (default 30) |
| `grass=0` | plain ground, no grass patches |
| `flowers` | flower density, 0–1 (0 = none) |
| `trees=0` | no forest or apple trees |
| `pond=0` | no pond |
| `look` | where everyone looks: `auto` · `cursor` · `camera` · `selected` |
| `mute` | start silent |
| `nogui` | hide the panel |
| `paused` | start paused |
| `t` | simulate this many seconds before the first frame |

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
```

Pushing to `main` deploys to GitHub Pages
(`.github/workflows/pages.yml`).

The `scripts/` folder holds the headless test and inspection tools, driven by
Playwright with software WebGL. They need `npx playwright install chromium`
once.

- `npm run shot`: boots the app, renders about 30 scenes into `screenshots/`,
  and fails on any console error.
- `node scripts/sounds.mjs`: renders every sound recipe offline to WAV, plus a
  spectrogram sheet.
- `node scripts/tune-sheet.mjs`: prints generated fiddle tunes as chords and
  three parts, bar by bar.
- Other probes check gait, stance, trips and crowd overlaps.

## Code tour

| File | What it does |
|---|---|
| `src/genome.ts` | the random genome: shape genes, looks, persona |
| `src/body.ts` | builds a person's meshes and joint hierarchy from a genome |
| `src/persona.ts` | personality sliders, presets, and how they turn into gait style |
| `src/gait.ts`, `src/animate.ts` | the walk cycle and per-frame posing |
| `src/springs.ts`, `src/ik.ts`, `src/ragdoll.ts` | secondary motion, inverse kinematics, falling over |
| `src/actions.ts` | the action runner: each action's props and pose layers |
| `src/chores.ts` | chopping, apple picking and fishing, with their conjured trees, pool and catch |
| `src/actionkit.ts` | shared action helpers: pose types, easing, FK prop fitting |
| `src/gaze.ts` | eyes and head: who looks at whom |
| `src/wander.ts` | the roaming crowd: targets, steering, personal space |
| `src/tune.ts` | AABB fiddle tunes with melody, harmony and bass parts |
| `src/audio.ts` | all sound synthesis |
| `src/materials.ts`, `src/palette.ts`, `src/environment.ts` | toon shading, colours, haze, sky, clouds |
| `src/main.ts` | scene, modes, GUI, input and the main loop |

Built with [three.js](https://threejs.org/), [lil-gui](https://lil-gui.georgealways.com/)
and [Vite](https://vitejs.dev/).
