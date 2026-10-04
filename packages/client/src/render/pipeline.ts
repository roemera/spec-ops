import * as THREE from 'three';
import { MAX_PIXEL_RATIO } from '@spec-ops/shared';

// Full-resolution, antialiased, shadowed. The world first, then the first-person rifle on top
// (its own scene and camera, depth cleared, so it never pokes into walls or warps with the fov).

export class Pipeline {
  readonly renderer: THREE.WebGLRenderer;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = false;
  }

  /** Match the canvas to its CSS size. Returns the aspect ratio. */
  resize(width: number, height: number): number {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    return width / height;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, overlay?: { scene: THREE.Scene; camera: THREE.Camera }) {
    this.renderer.clear();
    this.renderer.render(scene, camera);
    if (overlay) {
      this.renderer.clearDepth();
      this.renderer.render(overlay.scene, overlay.camera);
    }
  }
}
