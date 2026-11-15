# TODO

## Save the village and come back to it

Keep a village's state in `localStorage` (keyed by seed, e.g.
`mini-village:331400`, with a format version so an old save is ignored
rather than breaking anything), written every half-minute or so and when
the tab is hidden or closed.

- **Saved:** the clock (day, hour, sim time) and the stats; every item
  (kind, store and slot or on the ground, dryness / cider left / what's on
  a plate); logs; trees, apples and field strips with their timers; the
  windmill's grain and sails, the oven's heat, the lamp; where everyone and
  the dog stand. The layout and the wind come from the seed and the day,
  so they needn't be saved.
- **Not saved: anyone mid-task.** On restore everyone starts their next
  decision fresh where they stand, with the loose ends tidied first: an
  armful goes where it was heading, a carried log onto the pile, seats and
  bookings all clear (diners re-claim theirs if it's still supper).
- **Time away:** decide between standing still, the clock jumping on by
  the time away (capped at a day or two: trees, wheat and apples grow,
  ovens cool, nobody works in the gap; the suggested one), or simulating
  the gap (only feasible capped at a few minutes).
- A "start afresh" button, and `?fresh` to ignore the save.
- The village test does a round trip: half a day, save, reload, on to the
  end, with every consistency check across the reload.

## Tests

- Scenes draw from `Math.random`, and three.js draws it too for every new
  object's uuid, so adding meshes at start-up shifts the debug page's
  seeded scenes (the shot baseline has had to be renewed for it). Give the
  scenes their own seeded random generator.

## From the code review (still open)

- `village/main.ts`: move the talk system out (`social.ts`); a module for
  the burning, drying and lamp economy; inn-relative placements into
  `layout.ts`; group the `Village` interface; drop the unused
  `Village.ladders`.
- Duplicated code: the talk vs chat overlays; the person and dog rig
  builders (joints, parts, eyes, blink).
- Shader uniforms are wired by hand, and the lighting code appears three
  times; `Crowd` is a grab-bag and doesn't own its people.
- `audio.ts`: repetitive sound recipes.
- Rates in mixed units (sim seconds vs game hours).
- Dead code: `Forest.standing` (unused), `horse.pieces` (set and cleared in the same step, so always empty when read).
