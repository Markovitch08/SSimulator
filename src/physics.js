import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

// Fixed simulation step. The research report recommends a fixed high-rate step
// with every motor/AI target updated per step, not per rendered frame.
export const FIXED = 1 / 120;

// Collision groups (membership bits).
export const G = { GROUND: 1, PSWORD: 2, EALIVE: 4, ESWORD: 8, PIECE: 16, DEBRIS: 32, PHAND: 64 };
export const grp = (member, filter) => (member << 16) | filter;

export const GROUPS = {
  ground: grp(G.GROUND, 0xffff),
  psword: grp(G.PSWORD, G.GROUND | G.EALIVE | G.ESWORD | G.PIECE | G.DEBRIS),
  ealive: grp(G.EALIVE, G.GROUND | G.PSWORD | G.PIECE | G.PHAND),
  esword: grp(G.ESWORD, G.PSWORD | G.PHAND),
  piece: grp(G.PIECE, G.GROUND | G.PSWORD | G.PIECE | G.EALIVE | G.PHAND),
  debris: grp(G.DEBRIS, G.GROUND | G.PSWORD | G.PHAND),
  // the fist shoves enemies and their swords but passes through loose junk, so it doesn't
  // knock away the thing you're reaching for
  phand: grp(G.PHAND, G.GROUND | G.EALIVE | G.ESWORD),
  none: 0,
};

export const phys = {
  world: null,
  // collider handle -> { kind, ... }
  info: new Map(),
};

export async function initPhysics() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = FIXED;
  phys.world = world;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setFriction(0.9).setCollisionGroups(GROUPS.ground),
    ground,
  );
  return world;
}

export function hullDesc(geometries) {
  const list = Array.isArray(geometries) ? geometries : [geometries];
  let n = 0;
  for (const g of list) n += g.attributes.position.array.length;
  const pts = new Float32Array(n);
  let o = 0;
  for (const g of list) { pts.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
  return RAPIER.ColliderDesc.convexHull(pts);
}

// Touching a body after it has been removed panics inside Rapier and poisons the
// whole world, so removal is idempotent.
const removed = new WeakSet();
export const bodyAlive = body => !!body && !removed.has(body);
export function removeBody(body) {
  if (!body || removed.has(body)) return;
  removed.add(body);
  const w = phys.world;
  for (let i = 0; i < body.numColliders(); i++) phys.info.delete(body.collider(i).handle);
  w.removeRigidBody(body);
}
