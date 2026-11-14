import { Houses } from '../houses';
import { Stage, lookFromQuery } from '../stage';

/**
 * The village: a little settlement where people do jobs that feed each
 * other (see the plan in README). Work in progress.
 */

const look = lookFromQuery();
const stage = new Stage(look);
const houses = new Houses(stage.toon, stage.outline, stage.shadowMat);
stage.scene.add(houses.group);
stage.camera.zoom = 0.5;
stage.camera.updateProjectionMatrix();

let frames = 0;
function frame(start: number) {
  const dt = stage.delta();
  stage.controls.update();
  stage.updateLight(dt, false);
  houses.updateShadows(stage.lightWorld, look.shadowLength);
  stage.updateEnvironment(dt, 12);
  stage.render(start, 0);
  if (++frames === 2) (window as any).__mini = { ready: true, renderer: stage.renderer, camera: stage.camera, people: [] };
}

stage.resize();
stage.run(frame);
