import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Detailed models are built from many small pieces; drawn one by one they'd cost a draw call each.
// These fold pieces that never move relative to each other into one mesh per material.

/**
 * Replace the meshes directly under `group` that share a material with one merged mesh each
 * (in the group's space). `keep` meshes are left alone (hit-tested parts, animated pieces).
 */
export function mergeChildren(group: THREE.Object3D, keep: Set<THREE.Object3D> = new Set()) {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of group.children) {
    if (!(c instanceof THREE.Mesh) || keep.has(c) || Array.isArray(c.material) || c.children.length) continue;
    const list = byMat.get(c.material) ?? [];
    list.push(c);
    byMat.set(c.material, list);
  }
  for (const [material, list] of byMat) {
    if (list.length < 2) continue;
    const merged = mergeInto(list, (m) => (m.updateMatrix(), m.matrix), material);
    merged.castShadow = list.some((m) => m.castShadow);
    merged.receiveShadow = list.some((m) => m.receiveShadow);
    for (const m of list) group.remove(m);
    group.add(merged);
  }
}

/**
 * Merge world-space meshes into one per (material, key), e.g. per map chunk. The originals are
 * detached; the merged meshes are returned for the caller to add.
 */
export function mergeWorld(meshes: THREE.Mesh[], keyOf: (m: THREE.Mesh) => string): THREE.Mesh[] {
  const groups = new Map<string, { material: THREE.Material; list: THREE.Mesh[] }>();
  for (const m of meshes) {
    const material = m.material as THREE.Material;
    const key = `${material.uuid}|${keyOf(m)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { material, list: [] }));
    g.list.push(m);
  }
  const out: THREE.Mesh[] = [];
  for (const { material, list } of groups.values()) {
    const merged = mergeInto(list, (m) => (m.updateWorldMatrix(true, false), m.matrixWorld), material);
    merged.castShadow = list.some((m) => m.castShadow);
    merged.receiveShadow = list.some((m) => m.receiveShadow);
    for (const m of list) m.removeFromParent();
    out.push(merged);
  }
  return out;
}

function mergeInto(list: THREE.Mesh[], matrixOf: (m: THREE.Mesh) => THREE.Matrix4, material: THREE.Material) {
  const geos = list.map((m) => {
    let g = m.geometry.clone().applyMatrix4(matrixOf(m));
    if (g.index) g = g.toNonIndexed();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
    g.clearGroups();
    return g;
  });
  const geo = mergeGeometries(geos, false)!;
  for (const g of geos) g.dispose();
  return new THREE.Mesh(geo, material);
}
