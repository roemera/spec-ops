import * as THREE from 'three';

// Falling snow: a box of flakes that travels with the camera and wraps round, all moved on the GPU.
// The flakes drift with the wind at full speed, so they are how you read the wind before a long shot.

const BOX = 60; // m: the cube of flakes around the camera
const FALL = 1.2; // m/s
const FLUTTER = 0.35; // m of side-to-side wobble per flake

const vertex = /* glsl */ `
uniform vec3 uOffset;
uniform vec3 uCam;
uniform float uTime;
uniform float uSize;
uniform float uScale;
attribute float aPhase;
varying float vAlpha;
void main() {
  vec3 p = position + uOffset;
  p.x += sin(uTime * 1.3 + aPhase * 6.283) * ${FLUTTER.toFixed(2)};
  p.z += cos(uTime * 1.1 + aPhase * 6.283) * ${FLUTTER.toFixed(2)};
  // Wrap into a box centred on the camera, so the snow never runs out.
  p = mod(p - uCam + ${(BOX / 2).toFixed(1)}, ${BOX.toFixed(1)}) - ${(BOX / 2).toFixed(1)} + uCam;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  gl_PointSize = clamp(uSize * projectionMatrix[1][1] * uScale / d, 1.0, 28.0);
  // Fade at the box's edge (no popping) and right in front of the lens.
  vAlpha = smoothstep(${(BOX / 2).toFixed(1)}, ${(BOX * 0.3).toFixed(1)}, d) * smoothstep(0.25, 1.2, d);
}`;

const fragment = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  gl_FragColor = vec4(uColor, vAlpha * (1.0 - smoothstep(0.25, 0.5, r)) * 0.9);
}`;

export class Snowfall {
  private mat: THREE.ShaderMaterial;
  private offset = new THREE.Vector3();
  private time = 0;

  /** `amount` 0..1: light flurries to a heavy fall. */
  constructor(scene: THREE.Scene, amount: number) {
    const count = Math.round(2500 + 14000 * amount);
    const pos = new Float32Array(count * 3), phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos.set([Math.random() * BOX, Math.random() * BOX, Math.random() * BOX], i * 3);
      phase[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uOffset: { value: this.offset },
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uSize: { value: 0.05 + 0.03 * amount }, // m across: heavier snow, bigger flakes
        uScale: { value: 500 },
        uColor: { value: new THREE.Color(0xffffff) },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
    });
    const points = new THREE.Points(geo, this.mat);
    points.frustumCulled = false; // it is always around the camera
    points.renderOrder = 2;
    scene.add(points);
  }

  /** Move the flakes: falling, and carried by the wind (m/s). `viewHeight` is the canvas height in pixels. */
  update(dt: number, camera: THREE.Camera, wind: { x: number; z: number }, viewHeight: number) {
    this.time += dt;
    this.offset.x += wind.x * dt;
    this.offset.z += wind.z * dt;
    this.offset.y -= FALL * dt;
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    u.uScale.value = viewHeight / 2;
    camera.getWorldPosition(u.uCam.value);
  }
}
