import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { AiState } from '@spec-ops/shared';
import { ENEMY_COLOR, PAL } from './palette';

// Enemy laser sights: a line from every enemy rifle to whatever it points at, so you can see
// where they look, in the enemy's mood colour. Thin, faint and yellow while patrolling, stronger
// and orange when suspicious or searching (their scanning sweeps it about), bold and red once
// alert. Beams stop in pine branches (the canopy sensors in world.ts, which only lasers look for),
// so a laser in a tree's crown ends there. Direction and length are smoothed so the lines glide rather than flicker, and each beam fades
// out over the last few metres before your eyes.

const RANGE = 350; // m
const TURN_SMOOTH = 6; // 1/s: how quickly a laser follows its rifle
const LENGTH_SMOOTH = 8; // 1/s: how quickly its length follows what it hits
const NEAR_FADE = [2, 15]; // m from your eyes: beams fade out over this, so one aimed at you doesn't fill the view

export interface LaserSource {
  id: number;
  muzzle: THREE.Object3D; // the barrel's end
  aim: THREE.Object3D; // points down -z
  state: AiState;
  locked: boolean;
}

type Tier = 'calm' | 'wary' | 'alert';
const TIER: Record<AiState, Tier> = { patrol: 'calm', suspicious: 'wary', search: 'wary', alert: 'alert' };

export class Lasers {
  private lines: Record<Tier, { line: LineSegments2; mat: LineMaterial }>;
  private smooth = new Map<number, { dir: THREE.Vector3; len: number }>();

  constructor(private scene: THREE.Scene, private physics: RAPIER.World) {
    const make = (color: number, width: number, opacity: number) => {
      const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity, fog: true, depthWrite: false });
      // Fade near the camera, using the view depth the line shader already passes along for fog.
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <fog_fragment>',
          `#include <fog_fragment>
          gl_FragColor.a *= smoothstep(${NEAR_FADE[0].toFixed(1)}, ${NEAR_FADE[1].toFixed(1)}, vFogDepth);`,
        );
      };
      const line = new LineSegments2(new LineSegmentsGeometry(), mat);
      line.frustumCulled = false;
      line.renderOrder = 1;
      scene.add(line);
      return { line, mat };
    };
    this.lines = { calm: make(ENEMY_COLOR.patrol, 1.5, 0.5), wary: make(ENEMY_COLOR.suspicious, 2, 0.75), alert: make(PAL.enemy, 3, 0.95) };
  }

  update(sources: Iterable<LaserSource>, dt: number, width: number, height: number) {
    const pos: Record<Tier, number[]> = { calm: [], wary: [], alert: [] };
    const from = new THREE.Vector3(), dir = new THREE.Vector3(), to = new THREE.Vector3();
    const turnK = 1 - Math.exp(-dt * TURN_SMOOTH), lenK = 1 - Math.exp(-dt * LENGTH_SMOOTH);
    const seen = new Set<number>();
    for (const s of sources) {
      seen.add(s.id);
      s.muzzle.getWorldPosition(from);
      s.aim.getWorldDirection(dir).negate(); // the rifle points down -z
      let sm = this.smooth.get(s.id);
      if (!sm) this.smooth.set(s.id, (sm = { dir: dir.clone(), len: RANGE }));
      sm.dir.lerp(dir, turnK).normalize();
      const hit = this.physics.castRay(new RAPIER.Ray(from, sm.dir), RANGE, false); // sensors too: branches stop a laser
      sm.len += ((hit ? hit.timeOfImpact : RANGE) - sm.len) * lenK;
      to.copy(from).addScaledVector(sm.dir, sm.len);
      pos[s.locked ? 'alert' : TIER[s.state]].push(from.x, from.y, from.z, to.x, to.y, to.z);
    }
    for (const id of this.smooth.keys()) if (!seen.has(id)) this.smooth.delete(id);
    for (const tier of ['calm', 'wary', 'alert'] as const) this.set(this.lines[tier], pos[tier], width, height);
  }

  private set(l: { line: LineSegments2; mat: LineMaterial }, pos: number[], width: number, height: number) {
    l.line.visible = pos.length > 0;
    if (!pos.length) return;
    // Rebuild the geometry: a few dozen segments a frame, cheap enough.
    l.line.geometry.dispose();
    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    l.line.geometry = geo;
    l.mat.resolution.set(width, height);
  }
}
