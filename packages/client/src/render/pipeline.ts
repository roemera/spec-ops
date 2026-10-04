import * as THREE from 'three';
import { VIEW_HEIGHT, VIEW_WIDTH } from '@spec-ops/shared';

// Low-res render -> colour-crushed, dithered post pass -> nearest-neighbour upscale (CSS).

// Vertex snapping grid (coarser than the render target gives the PS1 wobble).
const SNAP = new THREE.Vector2(VIEW_WIDTH / 3, VIEW_HEIGHT / 3);

/** Patch a material so its vertices snap to a coarse screen grid. */
export function wobble<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnap = { value: SNAP };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform vec2 uSnap;\nvoid main() {')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        if (gl_Position.w > 0.0) {
          gl_Position.xy = floor(gl_Position.xy / gl_Position.w * uSnap + 0.5) / uSnap * gl_Position.w;
        }`,
      );
  };
  return mat;
}

const postVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const postFrag = /* glsl */ `
uniform sampler2D tScene;
uniform float uLevels;
varying vec2 vUv;
float bayer4(vec2 p) {
  int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
  int i = x + y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i]) + 0.5) / 16.0 - 0.5;
}
void main() {
  // the render target holds linear colour; posterise in display (sRGB) space
  vec3 c = pow(texture2D(tScene, vUv).rgb, vec3(1.0 / 2.2));
  // push saturation: loud on purpose
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  c = clamp(mix(vec3(l), c, 1.35), 0.0, 1.0);
  c = floor(c * uLevels + bayer4(gl_FragCoord.xy) + 0.5) / uLevels;
  gl_FragColor = vec4(c, 1.0);
}
`;

export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;
  private target: THREE.WebGLRenderTarget;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.target = new THREE.WebGLRenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { tScene: { value: this.target.texture }, uLevels: { value: 6 } },
        vertexShader: postVert,
        fragmentShader: postFrag,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.postScene.add(quad);
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
  }

  clear(color: THREE.ColorRepresentation) {
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(color);
    this.renderer.clear();
  }
}
