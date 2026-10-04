import type { GameMap, Point } from './mapgen.ts';
import { AMMO_BOX, MEDKIT_HEAL } from './constants.ts';
import type { Pickup } from './protocol.ts';

/**
 * The supplies at each base: an ammo box and a medkit on the ground by a hut door (or in the
 * middle of the clearing if it has no hut). The same for everyone from the map; the server hands
 * out ids.
 */
export function baseSupplies(map: GameMap): Array<Omit<Pickup, 'id'>> {
  const out: Array<Omit<Pickup, 'id'>> = [];
  for (const o of map.outposts) {
    const hut = map.objects.find((c) => c.kind === 'cabin' && Math.hypot(c.x - o.x, c.z - o.z) < o.r);
    let spot: Point, along: Point;
    if (hut) {
      // In front of the door (huts face -z locally, the door off to one side), a step out.
      const [w, , d] = hut.size, s = Math.sin(hut.rotY), c = Math.cos(hut.rotY);
      const local = (x: number, z: number): Point => ({ x: hut.x + x * c + z * s, z: hut.z - x * s + z * c });
      spot = local(-w * 0.15, -d / 2 - 1.1);
      along = { x: c, z: -s };
    } else {
      spot = { x: o.x, z: o.z };
      along = { x: 1, z: 0 };
    }
    const at = (p: Point): [number, number, number] => [p.x, map.heightAt(p.x, p.z), p.z];
    out.push({ kind: 'ammo', pos: at(spot), amount: AMMO_BOX });
    out.push({ kind: 'med', pos: at({ x: spot.x - along.x * 0.9, z: spot.z - along.z * 0.9 }), amount: MEDKIT_HEAL });
  }
  return out;
}
