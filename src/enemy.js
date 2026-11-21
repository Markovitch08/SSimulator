import * as THREE from 'three';
import { RAPIER, phys, GROUPS, hullDesc, removeBody } from './physics.js';
import { facet, lambert, makeSword, basisQuat } from './lowpoly.js';
import { sfx } from './audio.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ---------------------------------------------------------------------------
// Enemy = hidden procedural "target skeleton" (two-bone IK, no keyframed
// animation, as Half Sword does). The visible body is a jointed physics ragdoll
// whose parts chase that skeleton with strength-limited "muscles" (TABS-style
// wobble). One tonus value scales all muscles: hits sap it, knockdowns drop it
// to near zero, and death removes it and cuts some joints.
// Local frame: +Z = forward (toward the player), +Y = up. Poses are authored
// "right-positive" (x>0 = the enemy's right) and converted with R().
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const R = (x, y, z, out = new THREE.Vector3()) => out.set(-x, y, z);

let GEOS = null;
function geos() {
  if (GEOS) return GEOS;
  const cyl = (rt, rb, h, s) => new THREE.CylinderGeometry(rt, rb, h, s);
  GEOS = {
    pelvis: [facet(cyl(0.15, 0.12, 0.2, 5).scale(1, 1, 0.72), 0.012, 3)],
    chest: [facet(cyl(0.25, 0.15, 0.5, 5).translate(0, 0.25, 0).scale(1, 1, 0.62), 0.015, 5)],
    head: [facet(new THREE.IcosahedronGeometry(0.125, 0).translate(0, 0.17, 0), 0.012, 9)],
    uArm: [facet(cyl(0.065, 0.05, 0.3, 5).translate(0, -0.15, 0), 0.008, 11)],
    lArm: [facet(cyl(0.05, 0.035, 0.27, 5).translate(0, -0.135, 0), 0.006, 13),
      facet(new THREE.IcosahedronGeometry(0.05, 0).translate(0, -0.29, 0), 0.006, 15)],
    thigh: [facet(cyl(0.09, 0.065, 0.44, 5).translate(0, -0.22, 0), 0.01, 17)],
    shin: [facet(cyl(0.065, 0.04, 0.44, 5).translate(0, -0.22, 0), 0.008, 19),
      facet(cyl(0.0, 0.06, 0.17, 3).rotateX(Math.PI / 2).translate(0, -0.44, 0.05))],
  };
  return GEOS;
}

// key, geometry type, damage multiplier, material slot
const PARTS = [
  ['pelvis', 'pelvis', 1.0, 1], ['chest', 'chest', 1.25, 0], ['head', 'head', 1.5, 0],
  ['uArmL', 'uArm', 0.75, 0], ['lArmL', 'lArm', 0.6, 1], ['uArmR', 'uArm', 0.75, 0], ['lArmR', 'lArm', 0.6, 1],
  ['thighL', 'thigh', 0.85, 1], ['shinL', 'shin', 0.7, 0], ['thighR', 'thigh', 0.85, 1], ['shinR', 'shin', 0.7, 0],
];
// [parent, child]; the joint sits at the child's origin
const JOINTS = [
  ['pelvis', 'chest'], ['chest', 'head'], ['chest', 'uArmL'], ['uArmL', 'lArmL'], ['chest', 'uArmR'], ['uArmR', 'lArmR'],
  ['pelvis', 'thighL'], ['thighL', 'shinL'], ['pelvis', 'thighR'], ['thighR', 'shinR'],
];

// Rig proportions. Defaults fit the procedural body; loadEnemyModel() replaces them with
// measurements taken from a skinned model's skeleton.
const DEFAULT_RIG = {
  pelvisH: 0.92, chest: [0, 0.08, 0], head: [0, 0.5, 0], shoulder: [0.22, 0.44, 0], hip: [0.1, -0.07, 0],
  UARM: 0.3, LARM: 0.29, THIGH: 0.44, SHIN: 0.44, ankleY: 0.06,
};
// loaded models: name -> { geos: {partKey: [{ geo, mat }]}, mats: [Material], rig }
export const MODELS = {};

// Cut a skinned humanoid (glTF) into the 11 rigid ragdoll parts by dominant bone weight,
// re-expressed in each part's local frame (origin at the proximal joint, limb along -Y,
// +Z forward), and measure the rig from its bones.
export async function loadEnemyModel(name, url, targetHeight = 1.85) {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  let mesh = null;
  gltf.scene.traverse(o => { if (o.isSkinnedMesh && !mesh) mesh = o; });
  if (!mesh) throw new Error('model has no skinned mesh');
  const geo = mesh.geometry, bones = mesh.skeleton.bones;
  const N = geo.attributes.position.count;
  let verts = [];
  for (let i = 0; i < N; i++) verts.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
  let bp = bones.map(b => b.getWorldPosition(new THREE.Vector3()));
  // normalise: feet on the floor, centred, scaled to targetHeight
  const box = new THREE.Box3().setFromPoints(verts);
  const sc = targetHeight / (box.max.y - box.min.y);
  const off = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const norm = v => v.sub(off).multiplyScalar(sc);
  verts.forEach(norm); bp.forEach(norm);

  const kindOf = name => {
    const n = name.toLowerCase();
    if (/rodik|pole|target|end$/.test(n)) return null;
    if (/spine2|chest|upperchest/.test(n)) return 'chest';
    if (/spine|hip|pelvis|root/.test(n)) return 'pelvis';
    if (/neck|head/.test(n)) return 'head';
    if (/upperarm|shoulder|clavicle/.test(n)) return 'uArm';
    if (/forearm|foearm|lowerarm|hand|wrist|manik|finger/.test(n)) return 'lArm';
    if (/thigh|upleg|upperleg/.test(n)) return 'thigh';
    if (/calf|shin|lowerleg|knee|foot|toe|ankle|pieik/.test(n)) return 'shin';
    return null;
  };
  const find = (re, sign) => bones.findIndex((b, i) => re.test(b.name.toLowerCase()) && (sign === 0 || Math.sign(bp[i].x) === sign));
  const need = (re, sign) => { const i = find(re, sign); if (i < 0) throw new Error('model missing bone ' + re); return bp[i].clone(); };
  // face +Z: toes should be in front of the ankles
  const ankleR = need(/^foot|ankle/, 0);
  const toeVerts = verts.filter(v => v.y < ankleR.y + 0.05 && Math.abs(v.x - ankleR.x) < 0.15);
  const toeZ = toeVerts.reduce((a, v) => a + v.z - ankleR.z, 0);
  if (toeZ < 0) { verts.forEach(v => { v.x = -v.x; v.z = -v.z; }); bp.forEach(v => { v.x = -v.x; v.z = -v.z; }); }
  // the enemy's right is -X when facing +Z
  const sideOf = i => (bp[i].x > 0 ? 'L' : 'R');
  const partOfBone = bones.map((b, i) => {
    const k = kindOf(b.name);
    if (!k) return null;
    return (k === 'pelvis' || k === 'chest' || k === 'head') ? k : k + sideOf(i);
  });

  const P0 = need(/spine1|^hips?|pelvis/, 0), C0 = need(/spine2|chest/, 0), H0 = need(/neck/, 0);
  const J = {};
  for (const [side, sg] of [['L', 1], ['R', -1]]) {
    J['sh' + side] = need(/shoulder|upperarm/, sg); J['el' + side] = need(/foearm|forearm|lowerarm/, sg);
    J['ha' + side] = need(/^hand/, sg); J['hip' + side] = need(/thigh|upleg/, sg);
    J['kn' + side] = need(/calf|shin|lowerleg/, sg); J['an' + side] = need(/^foot/, sg);
  }
  const fwd = new THREE.Vector3(0, 0, 1);
  const frames = { pelvis: [P0, new THREE.Quaternion()], chest: [C0, new THREE.Quaternion()], head: [H0, new THREE.Quaternion()] };
  for (const S of ['L', 'R']) {
    frames['uArm' + S] = [J['sh' + S], basisQuat(J['sh' + S].clone().sub(J['el' + S]), fwd, new THREE.Quaternion())];
    frames['lArm' + S] = [J['el' + S], basisQuat(J['el' + S].clone().sub(J['ha' + S]), fwd, new THREE.Quaternion())];
    frames['thigh' + S] = [J['hip' + S], basisQuat(J['hip' + S].clone().sub(J['kn' + S]), fwd, new THREE.Quaternion())];
    frames['shin' + S] = [J['kn' + S], basisQuat(J['kn' + S].clone().sub(J['an' + S]), fwd, new THREE.Quaternion())];
  }

  // assign each triangle to the part with the most skin weight on its corners
  const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight, uv = geo.attributes.uv;
  const idx = geo.index ? geo.index.array : [...Array(N).keys()];
  const out = {};
  for (const k of Object.keys(frames)) out[k] = { pos: [], uv: [] };
  const score = {};
  for (let t = 0; t < idx.length; t += 3) {
    for (const k in score) delete score[k];
    for (let c = 0; c < 3; c++) {
      const v = idx[t + c];
      for (let j = 0; j < 4; j++) {
        const part = partOfBone[si.getComponent(v, j)];
        if (part) score[part] = (score[part] || 0) + sw.getComponent(v, j);
      }
    }
    let best = null, bw = 0;
    for (const k in score) if (score[k] > bw) { bw = score[k]; best = k; }
    if (!best) continue;
    const [o, q] = frames[best];
    const qi = q.clone().invert();
    for (let c = 0; c < 3; c++) {
      const v = idx[t + c];
      const l = verts[v].clone().sub(o).applyQuaternion(qi);
      out[best].pos.push(l.x, l.y, l.z);
      if (uv) out[best].uv.push(uv.getX(v), uv.getY(v));
    }
  }
  const geos = {};
  for (const [k, d] of Object.entries(out)) {
    if (d.pos.length < 12 * 3) throw new Error('model part too small: ' + k);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
    if (d.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
    g.computeVertexNormals();
    geos[k] = [{ geo: g, mat: 0 }];
  }
  const map = mesh.material.map || null;
  if (map) { map.magFilter = THREE.NearestFilter; map.needsUpdate = true; }

  const rel = (a, b) => a.clone().sub(b).toArray();
  const RIG = {};
  Object.assign(RIG, {
    pelvisH: P0.y - 0.03, chest: rel(C0, P0), head: rel(H0, C0),
    shoulder: [Math.abs(J.shR.x - C0.x), J.shR.y - C0.y, J.shR.z - C0.z],
    hip: [Math.abs(J.hipR.x - P0.x), J.hipR.y - P0.y, J.hipR.z - P0.z],
    UARM: J.shR.distanceTo(J.elR), LARM: J.elR.distanceTo(J.haR),
    THIGH: J.hipR.distanceTo(J.knR), SHIN: J.knR.distanceTo(J.anR), ankleY: J.anR.y,
  });
  MODELS[name] = { geos, mats: [new THREE.MeshLambertMaterial({ map, flatShading: true })], rig: RIG };
  return MODELS[name];
}

// For models with no skeleton (static meshes in a relaxed A/T pose): find landmarks from
// the shape (hands = lowest/outermost arm points, ankles = shoe tops, ...), fit the same
// skeleton, and give each triangle to the nearest bone segment allowed for its mesh.
// opts.roles: mesh index -> 'head' | 'torso' | 'arms' | 'legs' | 'feet'; opts.facing: -1 if
// the model faces -Z.
export async function loadStaticModel(name, url, opts, targetHeight = 1.85) {
  const gltf = await new GLTFLoader().loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  gltf.scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  const all = [];
  const src = meshes.map((m, mi) => {
    const pos = m.geometry.attributes.position, verts = [];
    for (let i = 0; i < pos.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld); verts.push(v); all.push(v); }
    return { mesh: m, verts, role: opts.roles[mi] };
  });
  const box = new THREE.Box3().setFromPoints(all);
  const sc = targetHeight / (box.max.y - box.min.y);
  const off = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  for (const v of all) { v.sub(off).multiplyScalar(sc); if (opts.facing === -1) { v.x = -v.x; v.z = -v.z; } }
  const byRole = r => src.filter(m => m.role === r).flatMap(m => m.verts);
  const head = byRole('head'), arms = byRole('arms'), legs = byRole('legs'), feet = byRole('feet'), torso = byRole('torso');
  const mean = vs => vs.reduce((a, v) => a.add(v), new THREE.Vector3()).divideScalar(vs.length);
  const extreme = (vs, f) => vs.reduce((a, v) => (f(v) > f(a) ? v : a));

  const neckY = Math.min(...head.map(v => v.y)), topY = Math.max(...head.map(v => v.y));
  const headC = mean(head);
  const pantsTop = Math.max(...legs.map(v => v.y));
  const hipY = pantsTop - 0.13;
  const torsoZ = mean(legs.filter(v => v.y > pantsTop - 0.1)).z;
  const J = {};
  for (const [S, sg] of [['L', 1], ['R', -1]]) {
    const side = arms.filter(v => Math.sign(v.x) === sg);
    const tip = extreme(side, v => -v.y);                      // fingertips: lowest point of the arm
    // shoulder: the arm mesh may start below a sleeve, so measure the torso just under the neck
    const band = torso.filter(v => Math.sign(v.x) === sg && v.y > neckY - 0.16 && v.y < neckY - 0.06);
    const outer = band.length ? Math.max(...band.map(v => Math.abs(v.x))) : 0.2;
    const sh = new THREE.Vector3(sg * outer * 0.78, neckY - 0.1, band.length ? mean(band).z : torsoZ);
    const palm = tip.clone().addScaledVector(sh.clone().sub(tip).normalize(), 0.08);
    const el = sh.clone().lerp(palm, 0.5); el.z -= 0.03;
    const shoe = feet.filter(v => Math.sign(v.x) === sg);
    const an = new THREE.Vector3(mean(shoe).x, Math.max(...shoe.map(v => v.y)) + 0.02, mean(shoe).z - 0.03);
    const hip = new THREE.Vector3(sg * THREE.MathUtils.clamp(Math.abs(an.x), 0.08, 0.11), hipY, torsoZ);
    const kn = hip.clone().lerp(an, 0.5); kn.z += 0.03;
    Object.assign(J, { ['sh' + S]: sh, ['ha' + S]: palm, ['tip' + S]: tip, ['el' + S]: el, ['hip' + S]: hip, ['kn' + S]: kn, ['an' + S]: an });
  }
  const P0 = new THREE.Vector3(0, hipY + 0.05, torsoZ), C0 = new THREE.Vector3(0, hipY + 0.17, torsoZ);
  const H0 = new THREE.Vector3(headC.x, neckY, headC.z);
  const fwd = new THREE.Vector3(0, 0, 1);
  const frames = { pelvis: [P0, new THREE.Quaternion()], chest: [C0, new THREE.Quaternion()], head: [H0, new THREE.Quaternion()] };
  const segs = { pelvis: [P0.clone().setY(hipY - 0.05), C0, 0.15], chest: [C0, H0, 0.17], head: [H0, new THREE.Vector3(H0.x, topY, H0.z), 0.1] };
  for (const S of ['L', 'R']) {
    frames['uArm' + S] = [J['sh' + S], basisQuat(J['sh' + S].clone().sub(J['el' + S]), fwd, new THREE.Quaternion())];
    frames['lArm' + S] = [J['el' + S], basisQuat(J['el' + S].clone().sub(J['ha' + S]), fwd, new THREE.Quaternion())];
    frames['thigh' + S] = [J['hip' + S], basisQuat(J['hip' + S].clone().sub(J['kn' + S]), fwd, new THREE.Quaternion())];
    frames['shin' + S] = [J['kn' + S], basisQuat(J['kn' + S].clone().sub(J['an' + S]), fwd, new THREE.Quaternion())];
    segs['uArm' + S] = [J['sh' + S], J['el' + S], 0.06];
    segs['lArm' + S] = [J['el' + S], J['tip' + S], 0.05];
    segs['thigh' + S] = [J['hip' + S], J['kn' + S], 0.08];
    segs['shin' + S] = [J['kn' + S], J['an' + S].clone().setY(0), 0.06];
  }
  const allowed = {
    head: ['head'], torso: ['chest', 'pelvis', 'uArmL', 'uArmR'], arms: ['uArmL', 'uArmR', 'lArmL', 'lArmR', 'chest'],
    legs: ['pelvis', 'thighL', 'thighR', 'shinL', 'shinR'], feet: ['shinL', 'shinR'],
  };
  // materials (one per source mesh), kept close to the originals but flat-shaded
  const mats = src.map(({ mesh }) => {
    const m = mesh.material;
    return new THREE.MeshLambertMaterial({ map: m.map || null, color: m.color ? m.color.clone() : 0xffffff, vertexColors: !!mesh.geometry.attributes.color, flatShading: true });
  });
  const out = {}; // part -> mat index -> {pos, uv, col}
  const line = new THREE.Line3(), cp = new THREE.Vector3(), cen = new THREE.Vector3();
  src.forEach(({ mesh, verts, role }, mi) => {
    const g = mesh.geometry, uv = g.attributes.uv, col = g.attributes.color;
    const idx = g.index ? g.index.array : [...Array(verts.length).keys()];
    for (let t = 0; t < idx.length; t += 3) {
      cen.copy(verts[idx[t]]).add(verts[idx[t + 1]]).add(verts[idx[t + 2]]).divideScalar(3);
      let best = null, bd = Infinity;
      for (const k of allowed[role] || Object.keys(segs)) {
        const [a, b, r] = segs[k];
        const d = line.set(a, b).closestPointToPoint(cen, true, cp).distanceTo(cen) - r;
        if (d < bd) { bd = d; best = k; }
      }
      const [o, q] = frames[best];
      const qi = q.clone().invert();
      const bucket = ((out[best] ||= {})[mi] ||= { pos: [], uv: [], col: [] });
      for (let c = 0; c < 3; c++) {
        const v = idx[t + c];
        const l = verts[v].clone().sub(o).applyQuaternion(qi);
        bucket.pos.push(l.x, l.y, l.z);
        if (uv) bucket.uv.push(uv.getX(v), uv.getY(v));
        if (col) bucket.col.push(col.getX(v), col.getY(v), col.getZ(v));
      }
    }
  });
  const geos = {};
  for (const k of Object.keys(frames)) {
    if (!out[k]) throw new Error('static model: no triangles for ' + k);
    geos[k] = Object.entries(out[k]).map(([mi, d]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
      if (d.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
      if (d.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3));
      g.computeVertexNormals();
      return { geo: g, mat: +mi };
    });
  }
  const rel = (a, b) => a.clone().sub(b).toArray();
  const rig = {
    pelvisH: P0.y - 0.03, chest: rel(C0, P0), head: rel(H0, C0),
    shoulder: [Math.abs(J.shR.x - C0.x), J.shR.y - C0.y, J.shR.z - C0.z],
    hip: [Math.abs(J.hipR.x - P0.x), J.hipR.y - P0.y, J.hipR.z - P0.z],
    UARM: J.shR.distanceTo(J.elR), LARM: J.elR.distanceTo(J.haR),
    THIGH: J.hipR.distanceTo(J.knR), SHIN: J.knR.distanceTo(J.anR), ankleY: J.anR.y,
  };
  MODELS[name] = { geos, mats, rig };
  return MODELS[name];
}

// Move set: two flowing slashes. Each is a smooth curve for the hand and the blade
// direction (right-positive local space) that starts where the other one ends, so they
// chain into a figure-eight like a real swordsman's cuts. The ragdoll's muscles chase
// the curve, so momentum and lag come from the physics.
const curve = pts => new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)), false, 'centripetal');
const MOVES = {
  forehand: { // high right, diagonal down through the target, follow through low left
    hand: curve([[0.35, 1.75, -0.05], [0.25, 1.65, 0.35], [0.0, 1.35, 0.6], [-0.3, 1.05, 0.45], [-0.4, 0.95, 0.15]]),
    blade: curve([[0.45, 0.6, -0.65], [0.15, 0.9, 0.4], [-0.15, 0.2, 1], [-0.65, -0.45, 0.6], [-0.7, -0.6, -0.2]]),
    twist: [0.55, -0.5], dmg: 16, next: 'backhand',
  },
  backhand: { // low left, rising across the body, finishing high right (ready for a forehand)
    hand: curve([[-0.4, 1.0, 0.1], [-0.25, 1.2, 0.5], [0.05, 1.4, 0.62], [0.35, 1.55, 0.4], [0.4, 1.7, 0.0]]),
    blade: curve([[-0.8, -0.2, -0.2], [-0.6, 0.15, 0.75], [0.1, 0.3, 1], [0.7, 0.45, 0.5], [0.5, 0.65, -0.55]]),
    twist: [-0.5, 0.5], dmg: 14, next: 'forehand',
  },
};
// Extend each cut backwards with a coil point: a bigger wind-up arc that flows straight
// into the strike instead of stopping at the start pose.
for (const mv of Object.values(MOVES)) {
  for (const key of ['hand', 'blade']) {
    const pts = mv[key].points;
    const coil = pts[0].clone().addScaledVector(pts[0].clone().sub(pts[1]), key === 'hand' ? 0.7 : 0.5);
    if (key === 'hand') coil.y += 0.08;
    mv[key] = new THREE.CatmullRomCurve3([coil, ...pts], false, 'centripetal');
  }
  mv.twist = [mv.twist[0] * 1.25, mv.twist[1] * 1.1];
}
// ready stances held between attacks
const GUARDS = [
  { h: [0.25, 1.35, 0.25], b: [0.05, 0.75, 0.65] },  // middle, point up toward you
  { h: [0.32, 1.6, 0.05], b: [0.35, 0.75, -0.55] },  // sword cocked over the right shoulder
];
const MARCH = GUARDS[0];
const rnd = (a, b) => a + Math.random() * (b - a);
const smooth = t => t * t * (3 - 2 * t);

// what comes off when a joint is cut while alive
const CHAINS = {
  head: ['head'], uArmL: ['uArmL', 'lArmL', 'sword2'], lArmL: ['lArmL', 'sword2'], uArmR: ['uArmR', 'lArmR', 'sword'], lArmR: ['lArmR', 'sword'],
  thighL: ['thighL', 'shinL'], shinL: ['shinL'], thighR: ['thighR', 'shinR'], shinR: ['shinR'],
};
// Enemy types. Andrew is the heavier, dual-wielding one.
export const TYPES = {
  richard: { model: 'richard', hp: 500, cutMul: 1, bleedMul: 1, kdDmg: 75, kdChance: 0.25, str: 1, dual: false, weight: 0.65 },
  andrew: { model: 'andrew', hp: 850, cutMul: 1.6, bleedMul: 0.55, kdDmg: 120, kdChance: 0.12, str: 1.35, dual: true, weight: 0.35 },
};
const CUT_DMG = 60, HEAD_CUT_DMG = 100; // decapitation needs a really clean, hard cut
// sword mount: a steel plate under the pommel sits on a ball joint just past the wrist
const MOUNT = 0.135, PALM = 0.04;
// muscle strength per part
const STR = { pelvis: 1.3, chest: 1.4, head: 1.8, uArmR: 1.5, lArmR: 1.4, uArmL: 0.9, lArmL: 0.8, thighL: 1, shinL: 0.9, thighR: 1, shinR: 0.9 };
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
// capped velocity-domain PD toward a target orientation / position
function driveAng(body, tq, k, maxW, acc, h) {
  const r = body.rotation();
  _q.set(r.x, r.y, r.z, r.w).invert().premultiply(tq);
  if (_q.w < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
  const ang = 2 * Math.acos(Math.min(1, _q.w));
  if (ang < 1e-4) _v.set(0, 0, 0);
  else { const s = Math.sqrt(1 - _q.w * _q.w); _v.set(_q.x / s, _q.y / s, _q.z / s).multiplyScalar(Math.min(maxW, ang * k)); }
  const av = body.angvel(); _w.set(av.x, av.y, av.z);
  _v.sub(_w); const m = acc * h; if (_v.lengthSq() > m * m) _v.setLength(m);
  body.setAngvel(_w.add(_v), true);
}
function driveLin(body, tp, ff, k, maxV, acc, h) {
  const t = body.translation();
  _v.set(tp.x - t.x, tp.y - t.y, tp.z - t.z).multiplyScalar(k).add(ff);
  if (_v.length() > maxV) _v.setLength(maxV);
  const lv = body.linvel(); _w.set(lv.x, lv.y, lv.z);
  _v.sub(_w); const m = acc * h; if (_v.lengthSq() > m * m) _v.setLength(m);
  body.setLinvel(_w.add(_v), true);
}

const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3(), tD = new THREE.Vector3();
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion();
const eul = new THREE.Euler();

function twoBone(root, target, l1, l2, pole, outMid, outEnd) {
  const dir = tA.subVectors(target, root);
  let len = dir.length();
  dir.divideScalar(len || 1);
  len = THREE.MathUtils.clamp(len, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  const a = (l1 * l1 + len * len - l2 * l2) / (2 * len);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const pp = tB.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (pp.lengthSq() < 1e-6) pp.set(0, 0, 1);
  pp.normalize();
  outMid.copy(root).addScaledVector(dir, a).addScaledVector(pp, h);
  outEnd.copy(root).addScaledVector(dir, len);
}

export class Enemy {
  constructor(ctx, pos, typeName = 'richard') {
    this.ctx = ctx;
    this.type = TYPES[typeName] || TYPES.richard;
    this.model = MODELS[this.type.model] || MODELS.richard || null;
    this.rig = this.model ? this.model.rig : DEFAULT_RIG;
    this.root = new THREE.Vector3(pos.x, 9, pos.z);
    this.vy = 0;
    this.vel = new THREE.Vector3();
    this.knock = new THREE.Vector3();
    this.lean = new THREE.Vector3(); this.leanW = new THREE.Vector3();
    const p = ctx.player.head;
    this.yaw = Math.atan2(p.x - pos.x, p.z - pos.z);
    this.state = 'fall'; this.stateT = 0;
    this.hp = this.type.hp; this.dead = false;
    this.voice = rnd(0.82, 1.18);
    this.guard = (Math.random() * GUARDS.length) | 0; this.guardT = rnd(1, 3);
    this.pref = rnd(1.0, 1.8); this.prefT = rnd(1, 3);
    this.dodge = new THREE.Vector3();
    this.move = null; this.atkPhase = null; this.combo = 0;
    this.armed = true; this.lost = new Set(); this.stumps = []; this.crippled = false;
    this.freeze = 0; this.flash = 0; this.hitCd = 0; this.clashCd = 0;
    this.atkCd = 0.6 + Math.random() * 0.5; this.thinkT = 0; this.phase = Math.random() * 6;
    this.attack = null; this.hitDone = false;
    this.strafe = Math.random() < 0.5 ? -1 : 1;
    // smoothed right-hand target (right-positive local) and blade direction (local)
    this.hand = R(0.3, 2.0, 0.1); this.blade = R(0.1, 1, 0.2).normalize();
    this.handL = R(-0.3, 2.0, 0.1); this.bladeL = R(-0.1, 1, 0.2).normalize();
    this.atkSide = 'R'; this.lastSide = 'L';
    this.pose = {};

    // materials per enemy so hit flashes are individual
    const MODEL = this.model;
    this.mats = MODEL
      ? MODEL.mats.map(m => { const c = m.clone(); c.emissive = new THREE.Color(0); return c; })
      : [lambert(0xd41f3a, { emissive: 0x000000 }), lambert(0x8f1024, { emissive: 0x000000 })];
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd23a });
    const partGeos = (key, type) => (MODEL ? MODEL.geos[key].map(e => e.geo) : geos()[type]);
    const partMats = (key, slot) => (MODEL ? MODEL.geos[key].map(e => this.mats[e.mat]) : null);
    this.parts = {};
    for (const [key, type, mult, slot] of PARTS) {
      const group = new THREE.Group();
      const pm = partMats(key, slot);
      partGeos(key, type).forEach((g, gi) => { const m = new THREE.Mesh(g, pm ? pm[gi] : this.mats[slot]); m.castShadow = true; group.add(m); });
      if (key === 'head' && !this.model) {
        for (const s of [-1, 1]) {
          const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 3).rotateX(Math.PI / 2), this.eyeMat);
          eye.position.set(s * 0.045, 0.19, 0.108); eye.rotation.z = s * 0.5 + Math.PI;
          group.add(eye);
        }
      }
      ctx.scene.add(group);
      this.parts[key] = { key, type, mult, mesh: group, body: null };
      this.pose[key] = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    }
    this.sword = makeSword({ blade: 0x6b7079, guard: 0x22252a, grip: 0x1a1414 });
    {
      const steel = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.7, roughness: 0.35, flatShading: true });
      const plate = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.06, 0.06, 0.018, 6).translate(0, -MOUNT, 0)), steel);
      const stem = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.012, 0.012, 0.04, 6).translate(0, -0.115, 0)), steel);
      this.sword.group.add(plate, stem);
      const cuff = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.052, 0.058, 0.07, 6, 1, true).translate(0, -this.rig.LARM + 0.03, 0)),
        new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.7, roughness: 0.35, flatShading: true, side: THREE.DoubleSide }));
      this.parts.lArmR.mesh.add(cuff);
      this.sword.group.traverse(o => { if (o.isMesh) o.castShadow = true; });
    }
    ctx.scene.add(this.sword.group);
    if (this.type.dual) {
      this.sword2 = makeSword({ blade: 0x6b7079, guard: 0x22252a, grip: 0x1a1414 });
      const steel = new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.7, roughness: 0.35, flatShading: true });
      this.sword2.group.add(new THREE.Mesh(facet(new THREE.CylinderGeometry(0.06, 0.06, 0.018, 6).translate(0, -MOUNT, 0)), steel),
        new THREE.Mesh(facet(new THREE.CylinderGeometry(0.012, 0.012, 0.04, 6).translate(0, -0.115, 0)), steel));
      this.parts.lArmL.mesh.add(new THREE.Mesh(facet(new THREE.CylinderGeometry(0.052, 0.058, 0.07, 6, 1, true).translate(0, -this.rig.LARM + 0.03, 0)),
        new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 0.7, roughness: 0.35, flatShading: true, side: THREE.DoubleSide })));
      this.sword2.group.traverse(o => { if (o.isMesh) o.castShadow = true; });
      ctx.scene.add(this.sword2.group);
      this.pose.sword2 = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    }
    this.pose.sword = { p: new THREE.Vector3(), q: new THREE.Quaternion() };

    this.computePose(0);
    const w = phys.world;
    for (const part of Object.values(this.parts)) {
      const ps = this.pose[part.key];
      part.body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(ps.p.x, ps.p.y, ps.p.z).setRotation(ps.q)
        .setLinearDamping(0.05).setAngularDamping(2.5).setGravityScale(1.8).setCcdEnabled(true));
      part.col = w.createCollider(hullDesc(partGeos(part.key, part.type)).setDensity(985).setFriction(0.45).setCollisionGroups(GROUPS.ealive), part.body);
      phys.info.set(part.col.handle, { kind: 'enemy', enemy: this, part: part.key });
    }
    const sp = this.pose.sword;
    this.swordBody = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(sp.p.x, sp.p.y, sp.p.z).setRotation(sp.q)
      .setAngularDamping(2).setCcdEnabled(true));
    this.swordCol = w.createCollider(hullDesc([this.sword.bladeGeo, this.sword.guardGeo, this.sword.gripGeo]).setDensity(3000).setCollisionGroups(GROUPS.esword), this.swordBody);
    phys.info.set(this.swordCol.handle, { kind: 'esword', enemy: this });
    if (this.sword2) {
      const s2 = this.pose.sword2;
      this.sword2Body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(s2.p.x, s2.p.y, s2.p.z).setRotation(s2.q).setAngularDamping(2).setCcdEnabled(true));
      this.sword2Col = w.createCollider(hullDesc([this.sword2.bladeGeo, this.sword2.guardGeo, this.sword2.gripGeo]).setDensity(3000).setCollisionGroups(GROUPS.esword), this.sword2Body);
      phys.info.set(this.sword2Col.handle, { kind: 'esword', enemy: this });
      this.armed2 = true;
    }
    // joints: each child hangs off its parent at the child's origin; the sword is held at the fist
    this.joints = {};
    for (const [a, b] of JOINTS) {
      const pa = this.pose[a];
      const anchor = new THREE.Vector3().subVectors(this.pose[b].p, pa.p).applyQuaternion(pa.q.clone().invert());
      const j = w.createImpulseJoint(RAPIER.JointData.spherical(anchor, { x: 0, y: 0, z: 0 }), this.parts[a].body, this.parts[b].body, true);
      j.setContactsEnabled(false);
      this.joints[b] = j;
    }
    this.joints.sword = w.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: -(this.rig.LARM + PALM), z: 0 }, { x: 0, y: -MOUNT, z: 0 }), this.parts.lArmR.body, this.swordBody, true);
    this.joints.sword.setContactsEnabled(false);
    if (this.sword2) {
      this.joints.sword2 = w.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: -(this.rig.LARM + PALM), z: 0 }, { x: 0, y: -MOUNT, z: 0 }), this.parts.lArmL.body, this.sword2Body, true);
      this.joints.sword2.setContactsEnabled(false);
    }
    this.tonus = 1; this.tonusTarget = 1;
    this.syncMeshes();

    // landing marker
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.6, 3).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xd41f3a, transparent: true, opacity: 0.8 }));
    this.marker.position.set(pos.x, 0.01, pos.z);
    ctx.scene.add(this.marker);
  }

  get yawQ() { return qA.setFromAxisAngle(UP, this.yaw); }
  toWorld(v, out) { return out.copy(v).applyAxisAngle(UP, this.yaw).add(this.root); }
  toLocal(v, out) { return out.copy(v).sub(this.root).applyAxisAngle(UP, -this.yaw); }
  dirToWorld(v, out) { return out.copy(v).applyAxisAngle(UP, this.yaw); }

  setState(s, t = 0) { this.state = s; this.stateT = 0; this.stateDur = t; }

  update(dt) {
    if (this.dead) return;
    const ctx = this.ctx, P = ctx.player;
    let adt = dt;
    if (this.freeze > 0) { this.freeze -= dt; adt = dt * 0.1; } // per-enemy hit-stop
    this.stateT += adt; this.atkCd -= adt; this.thinkT -= adt; this.hitCd -= dt; this.clashCd -= dt;
    this.flash = Math.max(0, this.flash - dt * 6);
    // stumps bleed and drain health
    if (this.stumps.length) {
      this.bleedT = (this.bleedT || 0) - dt;
      for (const st of this.stumps) {
        const b = this.parts[st.part].body, t = b.translation(), r = b.rotation();
        const wp = tA.copy(st.local).applyQuaternion(qA.set(r.x, r.y, r.z, r.w)).add(tB.set(t.x, t.y, t.z));
        if (this.bleedT <= 0) ctx.particles.emit('blood', wp, tC.copy(wp).sub(tB).normalize(), 2, 1.2);
      }
      if (this.bleedT <= 0) this.bleedT = 0.05;
      this.hp -= 4 * this.type.bleedMul * this.stumps.length * dt;
      if (this.hp <= 0) {
        const c = this.parts.chest.body.translation();
        this.die({ part: 'chest', point: new THREE.Vector3(c.x, c.y + 0.3, c.z), dir: new THREE.Vector3(0, 0, 0), speed: 1, dmg: 0 });
        return;
      }
    }
    if (this.state === 'attack' && !(this.atkSide === 'L' ? this.armed2 : this.armed)) this.setState('stagger', 0.5);

    const toP = tC.set(P.head.x - this.root.x, 0, P.head.z - this.root.z);
    const dist = toP.length();
    const desiredYaw = Math.atan2(toP.x, toP.z);
    let turn = 5;
    const want = tD.set(0, 0, 0); // desired planar velocity (world)
    let handT = MARCH.h, bladeT = MARCH.b, handK = 14, leanF = 0.14, twist = 0;
    let crouch = 0;
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

    switch (this.state) {
      case 'fall': {
        handT = [0.35, 2.05, 0.1]; bladeT = [0.3, 1, -0.2]; handK = 8;
        this.marker.material.opacity = 0.5 + 0.4 * Math.sin(performance.now() / 80);
        turn = 0;
        break;
      }
      case 'land': {
        crouch = 0.3 * Math.sin(Math.min(1, this.stateT / this.stateDur) * Math.PI);
        this.tonusTarget = 1;
        if (this.stateT >= this.stateDur) this.setState('approach');
        break;
      }
      case 'down': {
        // limp on the floor; muscles almost off
        turn = 0;
        if (this.stateT >= this.stateDur) {
          const pb = this.parts.pelvis.body.translation();
          this.root.set(pb.x, 0, pb.z);
          this.tonusTarget = 1;
          this.setState('getup', 1.1);
        }
        break;
      }
      case 'getup': {
        crouch = 0.35 * (1 - this.stateT / this.stateDur);
        turn = 2;
        if (this.stateT >= this.stateDur) { this.setState('approach'); this.atkCd = Math.max(this.atkCd, 0.4); }
        break;
      }
      case 'approach': {
        // close distance, hold a preferred range, back off, circle; pick an attack that fits the range
        const g = GUARDS[this.guard];
        handT = g.h; bladeT = g.b;
        this.guardT -= adt;
        if (this.guardT <= 0) { this.guard = (Math.random() * GUARDS.length) | 0; this.guardT = rnd(1.2, 3.5); }
        this.prefT -= adt;
        if (this.prefT <= 0) { this.pref = rnd(1.0, 2.1); this.prefT = rnd(1.5, 3.5); if (Math.random() < 0.35) this.strafe *= -1; }
        const speed = 1.8;
        if (!this.canFight) { want.copy(toP).normalize().multiplyScalar(dist < 4 ? -1.3 : 0); handT = [0.15, 1.2, 0.2]; bladeT = [0, 1, 0]; }
        else if (dist > this.pref + 0.25) want.copy(toP).normalize().multiplyScalar(speed);
        else if (dist < 0.85) want.copy(toP).normalize().multiplyScalar(-1.2);
        else want.copy(right).multiplyScalar(this.strafe * rnd(0.5, 0.9));
        if (this.atkCd <= 0 && dist < 1.75 && this.canFight) this.startAttack(Math.random() < 0.65 ? 'forehand' : 'backhand');
        if (this.state === 'approach') this.reactToThreat(toP, right);
        break;
      }
      case 'dodge': {
        want.copy(this.dodge); leanF = -0.12;
        if (this.stateT >= this.stateDur) {
          this.setState('approach');
          if (Math.random() < 0.5) this.atkCd = 0; // counter-attack right out of the dodge
        }
        break;
      }
      case 'block': {
        // pick a block that matches where the player's blade is heading (right-positive local)
        const pred = tA.copy(P.tip).addScaledVector(P.tipVel, 0.12);
        const loc = this.toLocal(pred, new THREE.Vector3());
        const px = -loc.x, py = loc.y;
        const side = px >= 0 ? 1 : -1;
        let pose;
        if (py > 1.6) pose = { h: [0.12, 1.75, 0.32], b: [-1, 0.12, 0.15], tw: 0 };                     // overhead: blade across above the head
        else if (py < 0.95) pose = { h: [0.22 * side, 1.05, 0.36], b: [0.25 * side, -1, 0.35], tw: 0.25 * side }; // low: point down at that side
        else if (side > 0) pose = { h: [0.32, 1.38, 0.3], b: [0.12, 1, 0.12], tw: 0.3 };              // right: blade upright on the right
        else pose = { h: [-0.2, 1.38, 0.38], b: [-0.12, 1, 0.12], tw: -0.35 };                        // left: blade upright across to the left
        handT = pose.h; bladeT = pose.b; handK = 32; twist = pose.tw; leanF = -0.1;
        // hold while the attack keeps coming, then maybe riposte
        const near = P.tip.distanceTo(this.toWorld(R(0, 1.35, 0), tB)) < 1.1 && P.tipVel.length() > 2;
        if (near && this.stateT < 0.9) this.stateDur = Math.max(this.stateDur, this.stateT + 0.15);
        if (this.stateT >= this.stateDur) { this.setState('approach'); if (Math.random() < 0.5) this.atkCd = 0; }
        break;
      }
      case 'attack': {
        const mv = MOVES[this.move];
        const s = this.stateT;
        if (this.atkPhase === 'windup') {
          // quick coil that keeps moving: sweep from wherever the sword is to the coil point
          // while still walking in, then go straight into the cut with no pause
          const u = Math.min(1, s / this.windup), e = smooth(u);
          const h0 = mv.hand.points[0], b0 = mv.blade.points[0];
          handT = [THREE.MathUtils.lerp(this.windFrom.h.x, h0.x, e), THREE.MathUtils.lerp(this.windFrom.h.y, h0.y, e), THREE.MathUtils.lerp(this.windFrom.h.z, h0.z, e)];
          bladeT = [THREE.MathUtils.lerp(this.windFrom.b.x, b0.x, e), THREE.MathUtils.lerp(this.windFrom.b.y, b0.y, e), THREE.MathUtils.lerp(this.windFrom.b.z, b0.z, e)];
          handK = 28; twist = mv.twist[0] * e; leanF = -0.08 * e;
          want.copy(toP).normalize().multiplyScalar(dist > 1.1 ? 1.6 : 0.4);
          // a fighter can abandon a wind-up to defend against an incoming cut
          if (u < 0.7 && Math.random() < 0.5) { this.reactToThreat(toP, right); if (this.state !== 'attack') break; }
          if (u >= 1) { this.atkPhase = 'strike'; this.stateT = 0; }
        } else if (this.atkPhase === 'strike') {
          // accelerate through the cut and decelerate in the follow-through; step into it
          const u = Math.min(1, s / this.strike), e = smooth(u);
          const hp = mv.hand.getPoint(e, tA), bp = mv.blade.getPoint(e, tB);
          handT = [hp.x, hp.y, hp.z]; bladeT = [bp.x, bp.y, bp.z]; handK = 45;
          twist = THREE.MathUtils.lerp(mv.twist[0], mv.twist[1], e);
          leanF = 0.1 + Math.sin(u * Math.PI) * 0.3;
          want.copy(fwd).multiplyScalar(Math.sin(u * Math.PI) * 1.8); turn = 2;
          if (!this.hitDone && u > 0.2 && u < 0.88) this.checkPlayerHit();
          if (u >= 1) {
            if (this.combo > 0 && dist < 2.0 && this.canFight) {
              // flow straight into the opposite cut: it starts where this one ended
              // (a dual wielder alternates hands instead)
              this.combo--; this.move = mv.next; this.hitDone = false;
              if (this.type.dual) { this.pickSide(); this.move = Math.random() < 0.6 ? 'forehand' : 'backhand'; }
              this.atkPhase = 'windup'; this.stateT = 0; this.windup = rnd(0.1, 0.18); this.strike = rnd(0.5, 0.62); this.snapWindFrom();
            } else { this.atkPhase = 'recover'; this.stateT = 0; }
          }
        } else {
          this.reactToThreat(toP, right);
          if (this.state !== 'attack') break;
          const he = mv.hand.points[mv.hand.points.length - 1], be = mv.blade.points[mv.blade.points.length - 1];
          handT = [he.x, he.y, he.z]; bladeT = [be.x, be.y, be.z]; handK = 5; leanF = 0.15; twist = mv.twist[1] * 0.6;
          if (s >= this.recover) { this.setState('approach'); this.atkCd = rnd(0.4, 1.3); }
        }
        break;
      }
      case 'stagger': {
        handK = 8; leanF = -0.05;
        handT = [0.35, 1.3, -0.15]; bladeT = [0.6, 0.6, -0.3];
        this.sword.bladeMat.emissive.setRGB(0, 0, 0);
        if (this.stateT >= this.stateDur) { this.setState('approach'); this.atkCd = Math.max(this.atkCd, 0.35); }
        break;
      }
    }

    // separation from other enemies
    for (const o of ctx.enemies) {
      if (o === this || o.dead) continue;
      const dx = this.root.x - o.root.x, dz = this.root.z - o.root.z, d2 = dx * dx + dz * dz;
      if (d2 < 0.7 && d2 > 1e-6) { const d = Math.sqrt(d2); want.x += dx / d * 1.5; want.z += dz / d * 1.5; }
    }

    // integrate planar motion
    if (this.state !== 'fall') {
      this.vel.lerp(want, 1 - Math.exp(-8 * adt));
      this.root.addScaledVector(this.vel, adt).addScaledVector(this.knock, dt);
      this.knock.multiplyScalar(Math.exp(-5 * dt));
      let dy = desiredYaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += THREE.MathUtils.clamp(dy, -turn * adt, turn * adt);
    }
    // torso lean spring (hit reactions)
    this.leanW.addScaledVector(this.lean, -70 * dt).multiplyScalar(Math.exp(-9 * dt));
    this.lean.addScaledVector(this.leanW, dt);
    if (this.lean.length() > 0.8) this.lean.setLength(0.8);

    // a left-handed cut is the right-handed curve mirrored; the right hand holds guard meanwhile
    const mir = a => [-a[0], a[1], a[2]];
    let leftH = null, leftB = null;
    if (this.state === 'attack' && this.atkSide === 'L') {
      leftH = mir(handT); leftB = mir(bladeT); twist = -twist;
      const g = GUARDS[this.guard]; handT = g.h; bladeT = g.b;
    } else if (this.sword2 && this.armed2 && this.state !== 'fall') {
      const g = GUARDS[(this.guard + 1) % GUARDS.length]; leftH = mir(g.h); leftB = mir(g.b);
    }
    this.leanF = THREE.MathUtils.lerp(this.leanF ?? 0, leanF, 1 - Math.exp(-10 * adt));
    // smooth hand targets (local space) -> a little lag = weight
    const k = 1 - Math.exp(-handK * adt);
    this.hand.lerp(R(handT[0], handT[1], handT[2], tA), k);
    this.blade.lerp(R(bladeT[0], bladeT[1], bladeT[2], tA).normalize(), k).normalize();
    // left arm: march swing or guard fist
    let lh;
    if (this.state === 'fall') lh = R(-0.35, 2.0, 0.15, tB);
    else if (this.state === 'attack' || this.state === 'block') lh = R(-0.28, 1.25, 0.3, tB);
    else lh = R(-0.3, 1.0 + crouch * 0, 0.14 * Math.sin(this.phase + Math.PI), tB);
    if (leftH) {
      const kl = this.state === 'attack' && this.atkSide === 'L' ? k : 1 - Math.exp(-10 * adt);
      lh = R(leftH[0], leftH[1], leftH[2], tB);
      this.handL.lerp(lh, kl);
      this.bladeL.lerp(R(leftB[0], leftB[1], leftB[2], tA).normalize(), kl).normalize();
    } else this.handL.lerp(lh, 1 - Math.exp(-10 * adt));


    this.twist = THREE.MathUtils.lerp(this.twist ?? 0, twist, 1 - Math.exp(-12 * adt));
    this.crouch = crouch;
    this.computePose(adt);
    this.bodyState(dt);
    this.drive(dt);
  }

  // read the player's blade (predicted ~0.2 s ahead) and block or dodge if it is coming at us
  reactToThreat(toP, right) {
    if (this.thinkT > 0 || !this.armed) return;
    const P = this.ctx.player;
    this.thinkT = rnd(0.1, 0.2); // reaction delay
    const pred = tA.copy(P.tip).addScaledVector(P.tipVel, 0.2);
    const chest = this.toWorld(R(0, 1.35, 0), tB);
    const swing = new THREE.Line3(P.tip, pred).closestPointToPoint(chest, true, new THREE.Vector3());
    if (P.tipVel.length() < 2.5 || swing.distanceTo(chest) > 1.15) return;
    const r = Math.random();
    if (r < 0.62) this.setState('block', 0.35);
    else if (r < 0.74) { this.dodge.copy(toP).normalize().multiplyScalar(-3.2); this.setState('dodge', 0.28); }
    else if (r < 0.84) { this.dodge.copy(right).multiplyScalar((Math.random() < 0.5 ? -1 : 1) * 3); this.setState('dodge', 0.28); }
  }

  // remember where the sword is right now (right-positive local), so the wind-up starts from it
  snapWindFrom() {
    this.windFrom = this.atkSide === 'L'
      ? { h: this.handL.clone(), b: this.bladeL.clone() } // mirror of right-positive = local
      : { h: new THREE.Vector3(-this.hand.x, this.hand.y, this.hand.z), b: new THREE.Vector3(-this.blade.x, this.blade.y, this.blade.z) };
  }

  get canFight() { return this.armed || !!this.armed2; }

  pickSide() {
    const want = this.type.dual ? (this.lastSide === 'R' ? 'L' : 'R') : 'R';
    this.atkSide = (want === 'L' ? this.armed2 : this.armed) ? want : (this.armed ? 'R' : 'L');
    this.lastSide = this.atkSide;
  }

  startAttack(move) {
    this.move = move;
    this.pickSide();
    this.windup = rnd(0.18, 0.3); this.strike = rnd(0.5, 0.62); this.recover = rnd(0.3, 0.5);
    this.snapWindFrom();
    this.combo = Math.random() < 0.55 ? (Math.random() < 0.4 ? 2 : 1) : 0;
    this.atkPhase = 'windup';
    this.hitDone = false;
    this.setState('attack');
  }

  computePose(adt) {
    const yq = qB.setFromAxisAngle(UP, this.yaw);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(yq);
    const rightW = new THREE.Vector3(-1, 0, 0).applyQuaternion(yq);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // long, unhurried strides: one step per ~0.75 m
    this.phase += speed * adt / 0.75 * Math.PI;
    const amp = Math.min(0.36, speed * 0.26), lift = Math.min(0.16, speed * 0.1);
    const bob = Math.abs(Math.cos(this.phase)) * amp * 0.12;

    const leanAng = this.lean.length();
    const leanQ = leanAng > 1e-4 ? new THREE.Quaternion().setFromAxisAngle(tA.copy(this.lean).divideScalar(leanAng), leanAng) : new THREE.Quaternion();
    const local = new THREE.Quaternion().setFromEuler(eul.set(this.leanF ?? 0.1, this.twist ?? 0, 0));
    const pelvisQ = new THREE.Quaternion().copy(leanQ).slerp(new THREE.Quaternion(), 0.6).multiply(yq);
    const chestQ = new THREE.Quaternion().copy(leanQ).multiply(yq).multiply(local);

    const P = this.pose;
    P.pelvis.p.copy(this.root).add(tA.set(0, this.rig.pelvisH - bob - (this.crouch || 0), 0));
    P.pelvis.q.copy(pelvisQ);
    P.chest.p.copy(P.pelvis.p).add(tA.fromArray(this.rig.chest).applyQuaternion(pelvisQ));
    P.chest.q.copy(chestQ);
    P.head.p.copy(P.chest.p).add(tA.fromArray(this.rig.head).applyQuaternion(chestQ));
    P.head.q.copy(leanQ).multiply(yq); // head stays level and faces the player

    // arms
    for (const side of ['R', 'L']) {
      const sx = side === 'R' ? -this.rig.shoulder[0] : this.rig.shoulder[0];
      const sh = P['uArm' + side].p.copy(P.chest.p).add(tA.set(sx, this.rig.shoulder[1], this.rig.shoulder[2]).applyQuaternion(chestQ));
      const handLocal = side === 'R' ? this.hand : this.handL;
      const target = this.toWorld(handLocal, new THREE.Vector3());
      const pole = new THREE.Vector3().addScaledVector(fwd, -0.6).addScaledVector(rightW, side === 'R' ? 0.7 : -0.7).add(tA.set(0, -0.6, 0));
      const elbow = P['lArm' + side].p;
      const hand = new THREE.Vector3();
      twoBone(sh, target, this.rig.UARM, this.rig.LARM, pole, elbow, hand);
      basisQuat(tA.subVectors(sh, elbow), fwd, P['uArm' + side].q);
      basisQuat(tA.subVectors(elbow, hand), fwd, P['lArm' + side].q);
      if (side === 'R') {
        const bladeW = this.dirToWorld(this.blade, new THREE.Vector3());
        const edgeHint = new THREE.Vector3().crossVectors(rightW, bladeW);
        if (edgeHint.lengthSq() < 1e-3) edgeHint.copy(fwd);
        basisQuat(bladeW, edgeHint, P.sword.q);
        const mountW = tB.subVectors(hand, elbow).normalize().multiplyScalar(PALM).add(hand);
        P.sword.p.copy(tC.set(0, MOUNT, 0).applyQuaternion(P.sword.q)).add(mountW);
      } else if (this.sword2) {
        const bladeW = this.dirToWorld(this.bladeL, new THREE.Vector3());
        const edgeHint = new THREE.Vector3().crossVectors(tC.copy(rightW).negate(), bladeW);
        if (edgeHint.lengthSq() < 1e-3) edgeHint.copy(fwd);
        basisQuat(bladeW, edgeHint, P.sword2.q);
        const mountW = tB.subVectors(hand, elbow).normalize().multiplyScalar(PALM).add(hand);
        P.sword2.p.copy(tC.set(0, MOUNT, 0).applyQuaternion(P.sword2.q)).add(mountW);
      }
    }

    // legs (procedural gait, feet planted by IK)
    const moveDir = speed > 0.05 ? tC.set(this.vel.x / speed, 0, this.vel.z / speed) : tC.copy(fwd);
    for (const side of ['L', 'R']) {
      const hx = side === 'R' ? -this.rig.hip[0] : this.rig.hip[0];
      const hip = P['thigh' + side].p.copy(P.pelvis.p).add(tA.set(hx, this.rig.hip[1], this.rig.hip[2]).applyQuaternion(pelvisQ));
      const ph = this.phase + (side === 'R' ? Math.PI : 0);
      let foot;
      if (this.state === 'fall') {
        foot = new THREE.Vector3(hip.x, hip.y - (this.rig.THIGH + this.rig.SHIN) + 0.04, hip.z).addScaledVector(fwd, Math.sin(performance.now() / 150 + ph) * 0.06);
      } else {
        foot = new THREE.Vector3(hip.x, this.rig.ankleY + Math.max(0, Math.cos(ph)) * lift, hip.z)
          .addScaledVector(moveDir, Math.sin(ph) * amp).addScaledVector(rightW, side === 'R' ? 0.03 : -0.03);
      }
      const pole = new THREE.Vector3().copy(fwd).add(tA.set(0, 0.2, 0));
      const knee = P['shin' + side].p;
      const ankle = new THREE.Vector3();
      twoBone(hip, foot, this.rig.THIGH, this.rig.SHIN, pole, knee, ankle);
      basisQuat(tA.subVectors(hip, knee), fwd, P['thigh' + side].q);
      basisQuat(tA.subVectors(knee, ankle), fwd, P['shin' + side].q);
    }
  }

  // "Muscles": every part chases its target-skeleton pose with capped velocity
  // corrections (a PD drive with limited strength), all scaled by one tonus value.
  drive(h) {
    const T = this.tonus;
    if (T < 0.01) return;
    for (const part of Object.values(this.parts)) {
      const ps = this.pose[part.key];
      if (this.lost.has(part.key)) continue;
      driveAng(part.body, ps.q, 24, 26, 700 * STR[part.key] * this.type.str * T, h);
    }
    const ff = tA.copy(this.vel).add(this.knock);
    if (this.state !== 'fall') {
      driveLin(this.parts.pelvis.body, this.pose.pelvis.p, ff, 12, 7, 95 * T, h);
      driveLin(this.parts.chest.body, this.pose.chest.p, ff, 9, 6, 45 * T, h);
      if (!this.lost.has('head')) driveLin(this.parts.head.body, this.pose.head.p, ff, 9, 6, 35 * T, h);
    }
    const swing2 = this.state === 'attack' && this.atkPhase === 'strike' && this.atkSide === 'L';
    if (this.sword2 && this.armed2) {
      const s2 = this.pose.sword2;
      driveAng(this.sword2Body, s2.q, 26, 30, (swing2 ? 650 : 1100) * T, h);
      driveLin(this.sword2Body, s2.p, ff, 14, 12, (swing2 ? 55 : 90) * T, h);
    }
    if (!this.armed) return;
    // looser grip while swinging, so the blade carries momentum like a real ragdoll cut
    const swinging = this.state === 'attack' && this.atkPhase === 'strike' && this.atkSide === 'R';
    const sp = this.pose.sword;
    driveAng(this.swordBody, sp.q, 26, 30, (swinging ? 650 : 1100) * T, h);
    driveLin(this.swordBody, sp.p, ff, 14, 12, (swinging ? 55 : 90) * T, h);
  }

  // root follows the real body; detect knockdowns; landing from the drop
  bodyState(dt) {
    this.tonus += (this.tonusTarget - this.tonus) * (1 - Math.exp(-(this.tonusTarget > this.tonus ? 2.2 : 8) * dt));
    const pb = this.parts.pelvis.body.translation();
    if (this.state === 'fall') {
      this.root.y = Math.max(0, pb.y - 0.92);
      if (pb.y < this.rig.pelvisH + 0.12) {
        // land on the feet: the legs soak up most of the fall instead of crumpling
        for (const part of Object.values(this.parts)) {
          const v = part.body.linvel();
          part.body.setLinvel({ x: v.x * 0.3, y: v.y * 0.12, z: v.z * 0.3 }, true);
          part.body.setGravityScale(1, true);
        }
        this.root.y = 0; this.ctx.onLand(this); this.ctx.scene.remove(this.marker);
        this.tonus = 0.9; this.setState('land', 0.45);
      }
      return;
    }
    const dx = pb.x - this.root.x, dz = pb.z - this.root.z, d = Math.hypot(dx, dz);
    if (d > 0.2) { const f = 1 - 0.2 / d; this.root.x += dx * f; this.root.z += dz * f; }
    if (this.state === 'down' || this.state === 'getup' || this.state === 'land') return;
    const r = this.parts.chest.body.rotation();
    const up = tB.set(0, 1, 0).applyQuaternion(qA.set(r.x, r.y, r.z, r.w));
    if (pb.y < 0.5 || up.y < 0.3) this.knockDown(rnd(1.0, 1.6));
  }

  knockDown(t) {
    this.setState('down', t);
    this.tonusTarget = 0.08;
    this.atkPhase = null;
    this.sword.bladeMat.emissive.setRGB(0, 0, 0);
  }

  syncMeshes() {
    if (this.dead) return;
    const f = this.flash;
    for (const m of this.mats) m.emissive.setRGB(f, f, f);
    for (const part of Object.values(this.parts)) {
      if (this.lost.has(part.key)) continue;
      const t = part.body.translation(), r = part.body.rotation();
      part.mesh.position.set(t.x, t.y, t.z); part.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    if (this.sword2 && this.armed2) {
      const t2 = this.sword2Body.translation(), r2 = this.sword2Body.rotation();
      this.sword2.group.position.set(t2.x, t2.y, t2.z); this.sword2.group.quaternion.set(r2.x, r2.y, r2.z, r2.w);
    }
    if (!this.armed) return;
    const t = this.swordBody.translation(), r = this.swordBody.rotation();
    this.sword.group.position.set(t.x, t.y, t.z); this.sword.group.quaternion.set(r.x, r.y, r.z, r.w);
  }

  // Enemy blade segment vs a capsule around the player's head/torso.
  checkPlayerHit() {
    const P = this.ctx.player;
    const sb = this.atkSide === 'L' && this.sword2 ? this.sword2Body : this.swordBody;
    const st = sb.translation(), sr = sb.rotation();
    const sq = qA.set(sr.x, sr.y, sr.z, sr.w), spos = tC.set(st.x, st.y, st.z);
    const a = new THREE.Vector3(0, this.sword.baseY, 0).applyQuaternion(sq).add(spos);
    const b = new THREE.Vector3(0, this.sword.tipY, 0).applyQuaternion(sq).add(spos);
    const segP = new THREE.Line3(a, b);
    const top = P.head, bot = new THREE.Vector3(P.head.x, P.head.y - 0.8, P.head.z);
    let best = Infinity;
    for (let i = 0; i <= 6; i++) {
      const q = new THREE.Vector3().lerpVectors(top, bot, i / 6);
      const c = segP.closestPointToPoint(q, true, new THREE.Vector3());
      // head (top sample) is a tighter sphere than the torso below it
      best = Math.min(best, c.distanceTo(q) - (i === 0 ? 0.12 : 0.18));
    }
    if (best < 0) { this.hitDone = true; this.ctx.damagePlayer(MOVES[this.move].dmg, this); }
  }

  takeHit(hit) {
    if (this.dead) return;
    const ctx = this.ctx;
    this.hp -= hit.dmg;
    this.flash = 1;
    ctx.particles.emit('blood', hit.point, hit.dir, 6 + Math.round(hit.dmg / 4), 2.5);
    if (this.hp <= 0) { this.die(hit); return; }
    if (hit.cut && hit.dmg >= (hit.part === 'head' ? HEAD_CUT_DMG : CUT_DMG) * this.type.cutMul && CHAINS[hit.part] && !this.lost.has(hit.part)) {
      if (hit.part === 'head') { this.hp = 0; this.die(hit); return; } // decapitation
      this.cutLimb(hit.part, hit);
    }
    sfx.hit(Math.min(1, hit.dmg / 70));
    sfx.grunt(Math.min(1, 0.3 + hit.dmg / 80), this.voice);
    this.freeze = 0.07;
    const dh = tA.set(hit.dir.x, 0, hit.dir.z);
    if (dh.lengthSq() > 1e-4) {
      dh.normalize();
      this.knock.addScaledVector(dh, Math.min(3.5, 0.6 + hit.speed * 0.3));
      const axis = new THREE.Vector3().crossVectors(UP, dh);
      this.leanW.addScaledVector(axis, Math.min(9, hit.speed * (hit.part === 'head' ? 1.1 : 0.7)));
    }
    this.sword.bladeMat.emissive.setRGB(0, 0, 0);
    const body = this.parts[hit.part].body;
    const imp = body.mass() * Math.min(hit.speed, 10) * 0.35;
    body.applyImpulseAtPoint({ x: hit.dir.x * imp, y: hit.dir.y * imp * 0.5, z: hit.dir.z * imp }, hit.point, true);
    this.tonus *= 0.72;
    if (this.state === 'fall' || this.state === 'down' || this.state === 'getup') return;
    if (hit.dmg > this.type.kdDmg && Math.random() < this.type.kdChance) this.knockDown(rnd(1.0, 1.6));
    else this.setState('stagger', 0.3 + Math.min(0.3, hit.dmg / 150));
  }

  onClash(rel) {
    if (this.dead || this.clashCd > 0) return false;
    this.clashCd = 0.15;
    const parried = this.state === 'attack' && ((this.atkPhase === 'strike' && this.stateT < this.strike * 0.8) || (this.atkPhase === 'windup' && this.stateT > this.windup * 0.6));
    if (parried) {
      this.sword.bladeMat.emissive.setRGB(0, 0, 0);
      this.hitDone = true;
      this.knock.addScaledVector(new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 1.6);
      this.setState('stagger', 0.75);
    }
    return parried;
  }

  cutLimb(key, hit) {
    const ctx = this.ctx, w = phys.world;
    const parentKey = JOINTS.find(([, b]) => b === key)[0];
    const pb = this.parts[parentKey].body, kb = this.parts[key].body;
    const t = kb.translation(), pt = pb.translation(), pr = pb.rotation();
    const jp = new THREE.Vector3(t.x, t.y, t.z);
    w.removeImpulseJoint(this.joints[key], true);
    for (const k of CHAINS[key]) {
      if (k === 'sword') { this.dropSword(); continue; }
      if (k === 'sword2') { this.dropSword2(); continue; }
      if (this.lost.has(k)) continue;
      this.lost.add(k);
      const part = this.parts[k];
      part.col.setCollisionGroups(GROUPS.piece);
      part.body.setLinearDamping(0.05); part.body.setAngularDamping(1.2);
      ctx.pieces.add(part.mesh, part.body, 35);
    }
    const imp = kb.mass() * Math.min(hit.speed, 10) * 0.5;
    kb.applyImpulse({ x: hit.dir.x * imp, y: imp * 0.4, z: hit.dir.z * imp }, true);
    kb.setAngvel({ x: (Math.random() - 0.5) * 14, y: (Math.random() - 0.5) * 14, z: (Math.random() - 0.5) * 14 }, true);
    // the stump keeps bleeding from the parent's joint
    const local = jp.clone().sub(tA.set(pt.x, pt.y, pt.z)).applyQuaternion(qA.set(pr.x, pr.y, pr.z, pr.w).invert());
    this.stumps.push({ part: parentKey, local });
    ctx.particles.emit('blood', jp, hit.dir, 40, 3);
    ctx.pieces.shards(jp, hit.dir, Math.min(hit.speed, 8), 0xb3001b, 4);
    sfx.splat(); sfx.grunt(1, this.voice * 1.1, 0.6);
    if (key.startsWith('thigh') || key.startsWith('shin')) { this.crippled = true; this.knockDown(1e9); }
  }

  dropSword2() {
    if (!this.sword2 || !this.armed2) return;
    this.armed2 = false;
    phys.world.removeImpulseJoint(this.joints.sword2, true);
    this.sword2Col.setCollisionGroups(GROUPS.piece);
    this.ctx.pieces.add(this.sword2.group, this.sword2Body, 35);
  }

  dropSword() {
    if (!this.armed) return;
    this.armed = false;
    phys.world.removeImpulseJoint(this.joints.sword, true);
    this.sword.bladeMat.emissive.setRGB(0, 0, 0);
    this.swordCol.setCollisionGroups(GROUPS.piece);
    this.ctx.pieces.add(this.sword.group, this.swordBody, 35);
  }

  die(hit) {
    this.dead = true;
    const ctx = this.ctx, w = phys.world;
    ctx.scene.remove(this.marker);
    for (const part of Object.values(this.parts)) {
      if (this.lost.has(part.key)) continue;
      const body = part.body;
      part.col.setCollisionGroups(GROUPS.piece);
      body.setLinearDamping(0.05); body.setAngularDamping(1.2);
      const t = body.translation();
      const f = Math.exp(-tA.set(t.x, t.y, t.z).distanceTo(hit.point) / 0.45);
      const v = body.linvel();
      const add = tB.copy(hit.dir).multiplyScalar(Math.min(hit.speed, 11) * (part.key === hit.part ? 0.85 : 0.45 * f)).addScaledVector(UP, 1.2 * f);
      body.setLinvel({ x: v.x + add.x, y: v.y + add.y, z: v.z + add.z }, true);
      ctx.pieces.add(part.mesh, body, 35);
    }

    // choose which joints to cut: the struck part always comes off, plus a few more
    const cuts = new Set();
    if (hit.part !== 'pelvis') cuts.add(hit.part);
    if (hit.part === 'head' || hit.part === 'chest' || hit.speed > 7 ? Math.random() < 0.8 : Math.random() < 0.35) cuts.add('head');
    for (const k of ['uArmL', 'uArmR']) if (Math.random() < 0.6) cuts.add(k);
    for (const k of ['lArmL', 'lArmR']) if (Math.random() < 0.35) cuts.add(k);
    for (const k of ['shinL', 'shinR']) if (Math.random() < 0.2) cuts.add(k);
    const extra = ['uArmL', 'uArmR', 'head', 'lArmL', 'lArmR', 'shinL'];
    while (cuts.size < 3) cuts.add(extra[(Math.random() * extra.length) | 0]);

    for (const [a, b] of JOINTS) {
      if (!cuts.has(b) || this.lost.has(b)) continue;
      const pb = this.parts[b].body, ta = this.parts[a].body.translation(), tb = pb.translation();
      w.removeImpulseJoint(this.joints[b], true);
      const jp = new THREE.Vector3(tb.x, tb.y, tb.z);
      const out = tA.set(tb.x - ta.x, tb.y - ta.y, tb.z - ta.z).normalize();
      const v = pb.linvel();
      pb.setLinvel({ x: v.x + out.x * 2 + (Math.random() - 0.5) * 2, y: v.y + 1.5 + Math.random() * 1.5, z: v.z + out.z * 2 + (Math.random() - 0.5) * 2 }, true);
      pb.setAngvel({ x: (Math.random() - 0.5) * 16, y: (Math.random() - 0.5) * 16, z: (Math.random() - 0.5) * 16 }, true);
      ctx.particles.emit('blood', jp, out, 18, 2.2);
      ctx.pieces.shards(jp, out, 2, 0xb3001b, 2);
    }

    // the sword drops as a loose physics piece
    this.dropSword(); this.dropSword2();

    ctx.pieces.shards(hit.point, hit.dir, Math.min(hit.speed, 10), 0xd41f3a, 8);
    ctx.particles.emit('blood', hit.point, hit.dir, 70, 3.5);
    for (const m of this.mats) m.emissive.setRGB(0, 0, 0);
    sfx.splat(); sfx.grunt(1, this.voice * 0.85, 0.7);
    ctx.onKill(this, hit);
  }

  destroy() {
    // severed limbs and a dropped sword already belong to the pieces list, which clears them
    for (const part of Object.values(this.parts)) {
      if (this.lost.has(part.key)) continue;
      removeBody(part.body);
      this.ctx.scene.remove(part.mesh);
    }
    if (this.armed) { removeBody(this.swordBody); this.ctx.scene.remove(this.sword.group); }
    if (this.sword2 && this.armed2) { removeBody(this.sword2Body); this.ctx.scene.remove(this.sword2.group); }
    this.ctx.scene.remove(this.marker);
    this.dead = true;
  }
}
