import * as THREE from 'three';

// Deterministic jitter keyed by vertex position so seams stay closed, then
// de-index so every triangle gets its own flat normal.
export function facet(geo, jitter = 0, seed = 7) {
  if (jitter > 0) {
    const p = geo.attributes.position;
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
    const map = new Map();
    for (let i = 0; i < p.count; i++) {
      const k = `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
      let o = map.get(k);
      if (!o) { o = [rnd() * jitter, rnd() * jitter, rnd() * jitter]; map.set(k, o); }
      p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
    }
  }
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

// Build a flat-shaded geometry from a triangle list, flipping any triangle whose
// normal points toward `center` (works for convex shapes).
export function convexTris(tris, center) {
  const pos = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const n = new THREE.Vector3(), cen = new THREE.Vector3();
  for (const [p0, p1, p2] of tris) {
    a.fromArray(p0); b.fromArray(p1); c.fromArray(p2);
    n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    cen.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(center);
    if (n.dot(cen) < 0) pos.push(...p0, ...p2, ...p1);
    else pos.push(...p0, ...p1, ...p2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });

// Sword in local space: origin = centre of the grip (where the fist is),
// blade along +Y, edges face ±Z, flats face ±X.
export function makeSword({ blade = 0xc9d3dc, guard = 0x3a3f47, grip = 0x2a1f1a, emissive = 0x000000 } = {}) {
  const len = 0.85, w = 0.027, t = 0.0075, y0 = 0.1, y1 = y0 + len * 0.8, y2 = y0 + len;
  const ring = (y, s) => [[t * s, y, 0], [0, y, w * s], [-t * s, y, 0], [0, y, -w * s]];
  const r0 = ring(y0, 1), r1 = ring(y1, 0.82), tip = [0, y2, 0];
  const tris = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    tris.push([r0[i], r0[j], r1[j]], [r0[i], r1[j], r1[i]], [r1[i], r1[j], tip]);
  }
  tris.push([r0[0], r0[1], r0[2]], [r0[0], r0[2], r0[3]]);
  const bladeGeo = convexTris(tris, new THREE.Vector3(0, (y0 + y2) / 2, 0));

  const bladeMat = new THREE.MeshStandardMaterial({ color: blade, flatShading: true, metalness: 0.55, roughness: 0.35, emissive });
  const group = new THREE.Group();
  const bladeMesh = new THREE.Mesh(bladeGeo, bladeMat);
  group.add(bladeMesh);
  const guardGeo = facet(new THREE.OctahedronGeometry(1, 0).scale(0.028, 0.024, 0.12).translate(0, 0.09, 0));
  group.add(new THREE.Mesh(guardGeo, lambert(guard)));
  const gripGeo = facet(new THREE.CylinderGeometry(0.017, 0.02, 0.17, 6));
  group.add(new THREE.Mesh(gripGeo, lambert(grip)));
  const pommelGeo = facet(new THREE.OctahedronGeometry(0.032, 0).translate(0, -0.1, 0));
  group.add(new THREE.Mesh(pommelGeo, lambert(guard)));
  group.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
  return { group, bladeGeo, guardGeo, gripGeo, bladeMat, tipY: y2, baseY: y0 };
}

// Orthonormal basis quaternion: local +Y -> yAxis, local +Z as close to zHint as possible.
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4();
export function basisQuat(yAxis, zHint, out = new THREE.Quaternion()) {
  _y.copy(yAxis).normalize();
  _z.copy(zHint).addScaledVector(_y, -zHint.dot(_y));
  if (_z.lengthSq() < 1e-6) { _z.set(1, 0, 0).addScaledVector(_y, -_y.x); }
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}
