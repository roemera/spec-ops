import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { AiState } from '@spec-ops/shared';
import { PAL } from './palette';

// Enemy laser sights: a red line from every enemy rifle to whatever it points at, so you can see
// where they look. Faint while patrolling, stronger when suspicious or searching (their scanning
// sweeps it about), deep red and thicker once alert, and steady when locked on (about to shoot well).
// A laser pointing straight at your eyes shows as a red glare at its rifle.

const RANGE = 350; // m
const GLARE_ANGLE = (3 * Math.PI) / 180; // rad off your eyes at which the glare starts

export interface LaserSource {
  muzzle: THREE.Object3D; // the barrel's end
  aim: THREE.Object3D; // points down -z
  state: AiState;
  locked: boolean;
}

const STRENGTH: Record<AiState, number> = { patrol: 0.55, suspicious: 0.8, search: 0.75, alert: 0.92 };

export class Lasers {
  private calm: { line: LineSegments2; mat: LineMaterial };
  private hot: { line: LineSegments2; mat: LineMaterial };
  private dots: THREE.InstancedMesh;
  private glares: THREE.Sprite[] = [];
  private glareMat: THREE.SpriteMaterial;
  private red = new THREE.Color(PAL.enemy);
  private fade = new THREE.Color(PAL.horizon);

  constructor(private scene: THREE.Scene, private physics: RAPIER.World) {
    const make = (width: number) => {
      const mat = new LineMaterial({ linewidth: width, vertexColors: true, transparent: true, opacity: 0.9, fog: true, depthWrite: false });
      const line = new LineSegments2(new LineSegmentsGeometry(), mat);
      line.frustumCulled = false;
      line.renderOrder = 1;
      scene.add(line);
      return { line, mat };
    };
    this.calm = make(2);
    this.hot = make(3.5);
    this.dots = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: PAL.enemy }), 128);
    this.dots.frustumCulled = false;
    this.dots.count = 0;
    scene.add(this.dots);
    // Glare: a soft red disc, drawn over everything at the muzzle.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.15, 'rgba(255,60,40,0.95)');
    g.addColorStop(1, 'rgba(227,34,26,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    this.glareMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false, fog: false });
  }

  update(sources: Iterable<LaserSource>, camera: THREE.Camera, width: number, height: number) {
    const calm: number[] = [], calmCol: number[] = [], hot: number[] = [], hotCol: number[] = [];
    const from = new THREE.Vector3(), dir = new THREE.Vector3(), to = new THREE.Vector3(), eye = camera.getWorldPosition(new THREE.Vector3());
    const toEye = new THREE.Vector3(), m = new THREE.Matrix4(), col = new THREE.Color(), end = new THREE.Color();
    let dots = 0, glares = 0;
    for (const s of sources) {
      s.muzzle.getWorldPosition(from);
      s.aim.getWorldDirection(dir).negate(); // the rifle points down -z
      const hit = this.physics.castRay(new RAPIER.Ray(from, dir), RANGE, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
      const len = hit ? hit.timeOfImpact : RANGE;
      to.copy(from).addScaledVector(dir, len);
      // Colour: from faint pink (patrolling) to full red (alert); fading toward the sky down its length.
      const k = s.locked ? 1 : STRENGTH[s.state];
      col.copy(this.fade).lerp(this.red, k);
      end.copy(col).lerp(this.fade, Math.min(0.5, len / RANGE));
      const [pos, cols] = s.state === 'alert' ? [hot, hotCol] : [calm, calmCol];
      pos.push(from.x, from.y, from.z, to.x, to.y, to.z);
      cols.push(col.r, col.g, col.b, end.r, end.g, end.b);
      // A dot where it lands, a few pixels across at any distance.
      if (hit && dots < 128) {
        const d = to.distanceTo(eye);
        m.compose(to.clone().addScaledVector(dir, -0.03), new THREE.Quaternion(), new THREE.Vector3().setScalar(Math.max(0.02, d * 0.0025 * (s.locked ? 1.6 : 1))));
        this.dots.setMatrixAt(dots++, m);
      }
      // Glare: the beam reaches you and points (nearly) at your eyes.
      toEye.copy(eye).sub(from);
      const dEye = toEye.length();
      const angle = dir.angleTo(toEye.normalize());
      if (angle < GLARE_ANGLE && len > dEye - 2) {
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
        g.scale.setScalar(dEye * 0.06 * (0.3 + strength) * (s.locked ? 1.4 : 1));
        glares++;
      }
    }
    this.set(this.calm, calm, calmCol, width, height);
    this.set(this.hot, hot, hotCol, width, height);
    this.dots.count = dots;
    this.dots.instanceMatrix.needsUpdate = true;
    for (let i = glares; i < this.glares.length; i++) this.glares[i].visible = false;
  }

  private set(l: { line: LineSegments2; mat: LineMaterial }, pos: number[], col: number[], width: number, height: number) {
    l.line.visible = pos.length > 0;
    if (!pos.length) return;
    // Rebuild the geometry: a few dozen segments a frame, cheap enough.
    l.line.geometry.dispose();
    const geo = new LineSegmentsGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    l.line.geometry = geo;
    l.mat.resolution.set(width, height);
  }
}
