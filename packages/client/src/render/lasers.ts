import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { AiState } from '@spec-ops/shared';
import { PAL } from './palette';

// Enemy laser sights: a red line from every enemy rifle to whatever it points at, so you can see
// where they look. Thin and faint while patrolling, stronger when suspicious or searching (their
// scanning sweeps it about), bold once alert. A laser pointed straight at your eyes shows as a red
// glare at its rifle. Direction and length are smoothed so the lines glide rather than flicker, and
// each beam fades out over the last few metres before your eyes.

const RANGE = 350; // m
const GLARE_ANGLE = (3 * Math.PI) / 180; // rad off your eyes at which the glare starts
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
  private glares: THREE.Sprite[] = [];
  private glareMat: THREE.SpriteMaterial;
  private smooth = new Map<number, { dir: THREE.Vector3; len: number }>();

  constructor(private scene: THREE.Scene, private physics: RAPIER.World) {
    const make = (width: number, opacity: number) => {
      const mat = new LineMaterial({ color: PAL.enemy, linewidth: width, transparent: true, opacity, fog: true, depthWrite: false });
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
    this.lines = { calm: make(1.5, 0.45), wary: make(2, 0.7), alert: make(3, 0.95) };
    // Glare: a soft red disc, drawn over everything at the muzzle.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,80,60,1)');
    g.addColorStop(0.2, 'rgba(227,34,26,0.9)');
    g.addColorStop(1, 'rgba(227,34,26,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.glareMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, fog: false });
  }

  update(sources: Iterable<LaserSource>, camera: THREE.Camera, dt: number, width: number, height: number) {
    const pos: Record<Tier, number[]> = { calm: [], wary: [], alert: [] };
    const from = new THREE.Vector3(), dir = new THREE.Vector3(), to = new THREE.Vector3(), eye = camera.getWorldPosition(new THREE.Vector3());
    const toEye = new THREE.Vector3();
    const turnK = 1 - Math.exp(-dt * TURN_SMOOTH), lenK = 1 - Math.exp(-dt * LENGTH_SMOOTH);
    const seen = new Set<number>();
    let glares = 0;
    for (const s of sources) {
      seen.add(s.id);
      s.muzzle.getWorldPosition(from);
      s.aim.getWorldDirection(dir).negate(); // the rifle points down -z
      let sm = this.smooth.get(s.id);
      if (!sm) this.smooth.set(s.id, (sm = { dir: dir.clone(), len: RANGE }));
      sm.dir.lerp(dir, turnK).normalize();
      const hit = this.physics.castRay(new RAPIER.Ray(from, sm.dir), RANGE, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
      sm.len += ((hit ? hit.timeOfImpact : RANGE) - sm.len) * lenK;
      to.copy(from).addScaledVector(sm.dir, sm.len);
      pos[s.locked ? 'alert' : TIER[s.state]].push(from.x, from.y, from.z, to.x, to.y, to.z);
      // Glare: the beam reaches you and points (nearly) at your eyes.
      toEye.copy(eye).sub(from);
      const dEye = toEye.length();
      const angle = sm.dir.angleTo(toEye.normalize());
      if (angle < GLARE_ANGLE && sm.len > dEye - 2) {
        let g = this.glares[glares];
        if (!g) {
          g = new THREE.Sprite(this.glareMat);
          g.renderOrder = 3;
          this.scene.add(g);
          this.glares.push(g);
        }
        const strength = 1 - angle / GLARE_ANGLE;
        g.visible = true;
        g.position.copy(from);
        g.scale.setScalar(dEye * 0.05 * (0.3 + strength));
        glares++;
      }
    }
    for (const id of this.smooth.keys()) if (!seen.has(id)) this.smooth.delete(id);
    for (const tier of ['calm', 'wary', 'alert'] as const) this.set(this.lines[tier], pos[tier], width, height);
    for (let i = glares; i < this.glares.length; i++) this.glares[i].visible = false;
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
