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
  ['pelvis', 'pelvis', 1.0, 1], ['chest', 'chest', 1.25, 0], ['head', 'head', 1.9, 0],
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
const RIG = {
  pelvisH: 0.92, chest: [0, 0.08, 0], head: [0, 0.5, 0], shoulder: [0.22, 0.44, 0], hip: [0.1, -0.07, 0],
  UARM: 0.3, LARM: 0.29, THIGH: 0.44, SHIN: 0.44, ankleY: 0.06,
};
let MODEL = null; // { geos: {partKey: geometry}, map }

// Cut a skinned humanoid (glTF) into the 11 rigid ragdoll parts by dominant bone weight,
// re-expressed in each part's local frame (origin at the proximal joint, limb along -Y,
// +Z forward), and measure the rig from its bones.
export async function loadEnemyModel(url, targetHeight = 1.85) {
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
    geos[k] = g;
  }
  const map = mesh.material.map || null;
  if (map) { map.magFilter = THREE.NearestFilter; map.needsUpdate = true; }

  const rel = (a, b) => a.clone().sub(b).toArray();
  Object.assign(RIG, {
    pelvisH: P0.y - 0.03, chest: rel(C0, P0), head: rel(H0, C0),
    shoulder: [Math.abs(J.shR.x - C0.x), J.shR.y - C0.y, J.shR.z - C0.z],
    hip: [Math.abs(J.hipR.x - P0.x), J.hipR.y - P0.y, J.hipR.z - P0.z],
    UARM: J.shR.distanceTo(J.elR), LARM: J.elR.distanceTo(J.haR),
    THIGH: J.hipR.distanceTo(J.knR), SHIN: J.knR.distanceTo(J.anR), ankleY: J.anR.y,
  });
  MODEL = { geos, map };
  return RIG;
}

// Attack move set: hand position + blade direction keyframes (right-positive local space)
// [windup, mid, end]. w = windup time range, s = strike time, lunge = forward speed during
// the strike, range = [min, max] distance it is used from, weight = how often it is picked.
const ATTACKS = {
  overhead: { w: [0.3, 0.55], s: 0.22, dmg: 16, lunge: 1.3, range: [0, 1.6], weight: 3,
    keys: [{ h: [0.15, 1.85, -0.05], b: [0, 0.35, -1] }, { h: [0.12, 1.75, 0.32], b: [0, 1, 0.2] }, { h: [0.05, 1.05, 0.62], b: [0, -0.45, 1] }] },
  side: { w: [0.25, 0.5], s: 0.22, dmg: 15, lunge: 1.0, range: [0, 1.6], weight: 3,
    keys: [{ h: [0.55, 1.45, -0.05], b: [0.85, 0.3, -0.4] }, { h: [0.2, 1.38, 0.5], b: [0.15, 0.15, 1] }, { h: [-0.35, 1.2, 0.42], b: [-0.85, -0.05, 0.55] }] },
  backhand: { w: [0.25, 0.45], s: 0.2, dmg: 14, lunge: 1.0, range: [0, 1.6], weight: 3,
    keys: [{ h: [-0.35, 1.45, 0.0], b: [-0.85, 0.3, -0.35] }, { h: [-0.05, 1.38, 0.5], b: [-0.1, 0.15, 1] }, { h: [0.5, 1.25, 0.35], b: [0.85, 0, 0.5] }] },
  diagDown: { w: [0.3, 0.5], s: 0.22, dmg: 16, lunge: 1.2, range: [0, 1.6], weight: 3,
    keys: [{ h: [0.4, 1.75, -0.05], b: [0.6, 0.6, -0.5] }, { h: [0.15, 1.5, 0.45], b: [0.1, 0.35, 1] }, { h: [-0.3, 1.0, 0.45], b: [-0.6, -0.5, 0.6] }] },
  diagUp: { w: [0.25, 0.45], s: 0.22, dmg: 14, lunge: 1.0, range: [0, 1.6], weight: 2,
    keys: [{ h: [-0.3, 0.95, 0.1], b: [-0.6, -0.6, 0.3] }, { h: [0.0, 1.25, 0.5], b: [0, 0.2, 1] }, { h: [0.3, 1.7, 0.3], b: [0.5, 0.8, 0.3] }] },
  hipCut: { w: [0.3, 0.5], s: 0.22, dmg: 13, lunge: 1.0, range: [0, 1.6], weight: 2,
    keys: [{ h: [0.55, 1.1, -0.05], b: [0.85, -0.1, -0.4] }, { h: [0.15, 1.05, 0.5], b: [0.1, -0.1, 1] }, { h: [-0.4, 1.0, 0.4], b: [-0.85, -0.1, 0.5] }] },
  thrust: { w: [0.25, 0.45], s: 0.2, dmg: 18, lunge: 1.6, range: [0, 1.7], weight: 2,
    keys: [{ h: [0.22, 1.3, -0.12], b: [0, 0.1, 1] }, { h: [0.15, 1.33, 0.25], b: [0, 0.08, 1] }, { h: [0.06, 1.36, 0.66], b: [0, 0.05, 1] }] },
  jab: { w: [0.1, 0.2], s: 0.13, dmg: 9, lunge: 0.8, range: [0, 1.5], weight: 2,
    keys: [{ h: [0.18, 1.38, 0.08], b: [0, 0.05, 1] }, { h: [0.12, 1.4, 0.35], b: [0, 0.04, 1] }, { h: [0.08, 1.42, 0.6], b: [0, 0.04, 1] }] },
  lunge: { w: [0.25, 0.4], s: 0.32, dmg: 20, lunge: 3.2, range: [1.5, 2.7], weight: 3,
    keys: [{ h: [0.2, 1.15, -0.1], b: [0, 0.2, 1] }, { h: [0.15, 1.25, 0.3], b: [0, 0.1, 1] }, { h: [0.06, 1.35, 0.66], b: [0, 0.05, 1] }] },
};
// guard stances held between attacks; attacks start from wherever the sword is,
// so rotating guards hides which attack is coming
const GUARDS = [
  { h: [0.24, 1.5, 0.18], b: [0.05, 0.85, 0.42] },   // high (ox)
  { h: [0.18, 1.15, 0.3], b: [-0.05, 0.35, 1] },     // middle, point at you (plow)
  { h: [0.2, 1.0, 0.3], b: [0, -0.5, 1] },           // low (fool)
  { h: [0.3, 1.45, -0.02], b: [0.25, 0.5, -0.85] },  // sword on shoulder
];
const MARCH = GUARDS[0];
const rnd = (a, b) => a + Math.random() * (b - a);
const jit = (arr, s) => arr.map(v => v + (Math.random() - 0.5) * 2 * s);

// muscle strength per part
const STR = { pelvis: 1.2, chest: 1.2, head: 1.0, uArmR: 1.5, lArmR: 1.4, uArmL: 0.9, lArmL: 0.8, thighL: 1, shinL: 0.9, thighR: 1, shinR: 0.9 };
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
  constructor(ctx, pos) {
    this.ctx = ctx;
    this.root = new THREE.Vector3(pos.x, 14, pos.z);
    this.vy = 0;
    this.vel = new THREE.Vector3();
    this.knock = new THREE.Vector3();
    this.lean = new THREE.Vector3(); this.leanW = new THREE.Vector3();
    const p = ctx.player.head;
    this.yaw = Math.atan2(p.x - pos.x, p.z - pos.z);
    this.state = 'fall'; this.stateT = 0;
    this.hp = 220; this.dead = false;
    this.guard = (Math.random() * GUARDS.length) | 0; this.guardT = rnd(1, 3);
    this.pref = rnd(1.0, 1.8); this.prefT = rnd(1, 3);
    this.dodge = new THREE.Vector3();
    this.atk = null; this.atkPhase = null; this.feint = null; this.combo = 0;
    this.freeze = 0; this.flash = 0; this.hitCd = 0; this.clashCd = 0;
    this.atkCd = 0.6 + Math.random() * 0.5; this.thinkT = 0; this.phase = Math.random() * 6;
    this.attack = null; this.hitDone = false;
    this.strafe = Math.random() < 0.5 ? -1 : 1;
    // smoothed right-hand target (right-positive local) and blade direction (local)
    this.hand = R(0.3, 2.0, 0.1); this.blade = R(0.1, 1, 0.2).normalize();
    this.handL = R(-0.3, 2.0, 0.1);
    this.pose = {};

    // materials per enemy so hit flashes are individual
    this.mats = MODEL
      ? [new THREE.MeshLambertMaterial({ map: MODEL.map, flatShading: true, emissive: 0x000000 })]
      : [lambert(0xd41f3a, { emissive: 0x000000 }), lambert(0x8f1024, { emissive: 0x000000 })];
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd23a });
    const partGeos = (key, type) => (MODEL ? [MODEL.geos[key]] : geos()[type]);
    this.parts = {};
    for (const [key, type, mult, slot] of PARTS) {
      const group = new THREE.Group();
      for (const g of partGeos(key, type)) { const m = new THREE.Mesh(g, this.mats[MODEL ? 0 : slot]); m.castShadow = true; group.add(m); }
      if (key === 'head' && !MODEL) {
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
    ctx.scene.add(this.sword.group);
    this.pose.sword = { p: new THREE.Vector3(), q: new THREE.Quaternion() };

    this.computePose(0);
    const w = phys.world;
    for (const part of Object.values(this.parts)) {
      const ps = this.pose[part.key];
      part.body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(ps.p.x, ps.p.y, ps.p.z).setRotation(ps.q)
        .setLinearDamping(0.3).setAngularDamping(2.5).setCcdEnabled(true));
      part.col = w.createCollider(hullDesc(partGeos(part.key, part.type)).setDensity(985).setFriction(0.45).setCollisionGroups(GROUPS.ealive), part.body);
      phys.info.set(part.col.handle, { kind: 'enemy', enemy: this, part: part.key });
    }
    const sp = this.pose.sword;
    this.swordBody = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(sp.p.x, sp.p.y, sp.p.z).setRotation(sp.q)
      .setAngularDamping(2).setCcdEnabled(true));
    this.swordCol = w.createCollider(hullDesc([this.sword.bladeGeo, this.sword.guardGeo, this.sword.gripGeo]).setDensity(3000).setCollisionGroups(GROUPS.esword), this.swordBody);
    phys.info.set(this.swordCol.handle, { kind: 'esword', enemy: this });
    // joints: each child hangs off its parent at the child's origin; the sword is held at the fist
    this.joints = {};
    for (const [a, b] of JOINTS) {
      const pa = this.pose[a];
      const anchor = new THREE.Vector3().subVectors(this.pose[b].p, pa.p).applyQuaternion(pa.q.clone().invert());
      const j = w.createImpulseJoint(RAPIER.JointData.spherical(anchor, { x: 0, y: 0, z: 0 }), this.parts[a].body, this.parts[b].body, true);
      j.setContactsEnabled(false);
      this.joints[b] = j;
    }
    this.joints.sword = w.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: -RIG.LARM, z: 0 }, { x: 0, y: 0, z: 0 }), this.parts.lArmR.body, this.swordBody, true);
    this.joints.sword.setContactsEnabled(false);
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
        crouch = 0.28 * (1 - this.stateT / this.stateDur);
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
        if (dist > this.pref + 0.25) want.copy(toP).normalize().multiplyScalar(speed);
        else if (dist < 0.85) want.copy(toP).normalize().multiplyScalar(-1.2);
        else want.copy(right).multiplyScalar(this.strafe * rnd(0.5, 0.9));
        if (this.atkCd <= 0) {
          const opts = Object.entries(ATTACKS).filter(([, a]) => dist >= a.range[0] && dist <= a.range[1]);
          if (opts.length) this.startAttack(opts);
        }
        if (this.state === 'approach' && this.thinkT <= 0) {
          this.thinkT = rnd(0.12, 0.25); // reaction delay
          // read the player's blade: predict the tip ~0.2 s ahead
          const pred = tA.copy(P.tip).addScaledVector(P.tipVel, 0.2);
          const chest = this.toWorld(R(0, 1.35, 0), tB);
          const swing = new THREE.Line3(P.tip, pred).closestPointToPoint(chest, true, new THREE.Vector3());
          if (P.tipVel.length() > 3 && swing.distanceTo(chest) < 0.9) {
            const r = Math.random();
            if (r < 0.4) this.setState('block', 0.4);
            else if (r < 0.58) { this.dodge.copy(toP).normalize().multiplyScalar(-3.2); this.setState('dodge', 0.28); }
            else if (r < 0.72) { this.dodge.copy(right).multiplyScalar((Math.random() < 0.5 ? -1 : 1) * 3); this.setState('dodge', 0.28); }
          }
        }
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
        // move own blade onto the predicted line of the player's blade
        const pred = tA.copy(P.tip).addScaledVector(P.tipVel, 0.15);
        const chest = this.toWorld(R(0, 1.35, 0.1), tB);
        const d = pred.sub(chest); const l = Math.min(0.5, d.length());
        const handW = chest.addScaledVector(d.normalize(), l);
        const loc = this.toLocal(handW, new THREE.Vector3());
        handT = [-loc.x, loc.y, Math.max(0.2, loc.z)];
        const bw = new THREE.Vector3().crossVectors(P.bladeDir, fwd);
        if (bw.lengthSq() < 1e-3) bw.copy(UP);
        bw.normalize(); if (bw.y < 0) bw.negate(); bw.y += 0.3;
        const bl = bw.applyAxisAngle(UP, -this.yaw).normalize();
        bladeT = [-bl.x, bl.y, bl.z]; handK = 30;
        if (this.stateT >= this.stateDur) { this.setState('approach'); if (Math.random() < 0.45) this.atkCd = 0; }
        break;
      }
      case 'attack': {
        const atk = this.atk;
        const s = this.stateT;
        const twistOf = k => THREE.MathUtils.clamp(k.h[0] * 0.8, -0.45, 0.45); // torso turns toward the windup side
        if (this.atkPhase === 'feint') {
          // fake windup for a different attack, then switch
          const k = this.feint.keys[0];
          handT = k.h; bladeT = k.b; handK = 10; leanF = -0.08; twist = twistOf(k);
          if (s >= this.feint.windup) { this.atkPhase = 'windup'; this.stateT = 0; atk.windup *= 0.5; }
        } else if (this.atkPhase === 'windup') {
          const k = atk.keys[0];
          handT = k.h; bladeT = k.b; handK = atk.windup < 0.22 ? 22 : 11; leanF = -0.08; twist = twistOf(k);
          const glow = Math.max(0, (s - atk.windup + 0.12) / 0.12) * 0.35; // faint, late tell
          this.sword.bladeMat.emissive.setRGB(glow, 0.02, 0.02);
          want.copy(toP).normalize().multiplyScalar(dist > 1.2 ? 0.8 : 0);
          if (s >= atk.windup) { this.atkPhase = 'strike'; this.stateT = 0; }
        } else if (this.atkPhase === 'strike') {
          const u = Math.pow(Math.min(1, s / atk.strike), 1.4);
          const seg = u < 0.5 ? 0 : 1, f = u < 0.5 ? u * 2 : (u - 0.5) * 2;
          const a = atk.keys[seg], b = atk.keys[seg + 1];
          handT = [a.h[0] + (b.h[0] - a.h[0]) * f, a.h[1] + (b.h[1] - a.h[1]) * f, a.h[2] + (b.h[2] - a.h[2]) * f];
          bladeT = [a.b[0] + (b.b[0] - a.b[0]) * f, a.b[1] + (b.b[1] - a.b[1]) * f, a.b[2] + (b.b[2] - a.b[2]) * f];
          handK = 70; leanF = atk.lunge > 2 ? 0.5 : 0.35; twist = -twistOf(atk.keys[0]);
          want.copy(fwd).multiplyScalar(atk.lunge); turn = 1.5;
          this.sword.bladeMat.emissive.setRGB(0.35, 0.03, 0.03);
          if (!this.hitDone) this.checkPlayerHit();
          if (s >= atk.strike) {
            this.sword.bladeMat.emissive.setRGB(0, 0, 0);
            if (this.combo > 0 && dist < 1.9) {
              // chain straight into another attack from where this one ended
              this.combo--;
              const opts = Object.entries(ATTACKS).filter(([n, x]) => n !== atk.name && x.range[0] < 1.4);
              this.atk = this.buildAttack(...opts[(Math.random() * opts.length) | 0]);
              this.atk.windup = rnd(0.12, 0.26);
              this.hitDone = false; this.atkPhase = 'windup'; this.stateT = 0;
            } else { this.atkPhase = 'recover'; this.stateT = 0; }
          }
        } else {
          const k = atk.keys[2];
          handT = k.h; bladeT = k.b; handK = 6; leanF = 0.2;
          if (s >= atk.recover) { this.setState('approach'); this.atkCd = rnd(0.3, 1.4); }
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

    // smooth hand targets (local space) -> a little lag = weight
    const k = 1 - Math.exp(-handK * adt);
    this.hand.lerp(R(handT[0], handT[1], handT[2], tA), k);
    this.blade.lerp(R(bladeT[0], bladeT[1], bladeT[2], tA).normalize(), k).normalize();
    // left arm: march swing or guard fist
    let lh;
    if (this.state === 'fall') lh = R(-0.35, 2.0, 0.15, tB);
    else if (this.state === 'attack' || this.state === 'block') lh = R(-0.28, 1.25, 0.3, tB);
    else lh = R(-0.3, 1.0 + crouch * 0, 0.14 * Math.sin(this.phase + Math.PI), tB);
    this.handL.lerp(lh, 1 - Math.exp(-10 * adt));

    this.leanF = THREE.MathUtils.lerp(this.leanF ?? 0, leanF, 1 - Math.exp(-10 * adt));
    this.twist = THREE.MathUtils.lerp(this.twist ?? 0, twist, 1 - Math.exp(-12 * adt));
    this.crouch = crouch;
    this.computePose(adt);
    this.bodyState(dt);
    this.drive(dt);
  }

  // Each attack instance gets its own timing and slightly jittered path, so no two swings look identical.
  buildAttack(name, def) {
    const keys = def.keys.map(k => ({ h: jit(k.h, 0.07), b: jit(k.b, 0.15) }));
    return { name, keys, windup: rnd(def.w[0], def.w[1]), strike: def.s * rnd(0.9, 1.15), recover: rnd(0.25, 0.55), dmg: def.dmg, lunge: def.lunge };
  }

  startAttack(opts) {
    let total = 0;
    for (const [, a] of opts) total += a.weight;
    let r = Math.random() * total, pick = opts[0];
    for (const o of opts) { r -= o[1].weight; if (r <= 0) { pick = o; break; } }
    this.atk = this.buildAttack(...pick);
    this.feint = null;
    if (pick[0] !== 'lunge' && Math.random() < 0.22) {
      const others = Object.entries(ATTACKS).filter(([n]) => n !== pick[0] && n !== 'lunge');
      this.feint = this.buildAttack(...others[(Math.random() * others.length) | 0]);
      this.feint.windup = rnd(0.2, 0.35);
    }
    this.combo = Math.random() < 0.4 ? (Math.random() < 0.35 ? 2 : 1) : 0;
    this.atkPhase = this.feint ? 'feint' : 'windup';
    this.hitDone = false;
    this.setState('attack');
  }

  computePose(adt) {
    const yq = qB.setFromAxisAngle(UP, this.yaw);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(yq);
    const rightW = new THREE.Vector3(-1, 0, 0).applyQuaternion(yq);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.phase += speed * adt / 0.42 * Math.PI;
    const amp = Math.min(0.22, speed * 0.16), lift = Math.min(0.12, speed * 0.09);
    const bob = Math.abs(Math.cos(this.phase)) * amp * 0.12;

    const leanAng = this.lean.length();
    const leanQ = leanAng > 1e-4 ? new THREE.Quaternion().setFromAxisAngle(tA.copy(this.lean).divideScalar(leanAng), leanAng) : new THREE.Quaternion();
    const local = new THREE.Quaternion().setFromEuler(eul.set(this.leanF ?? 0.1, this.twist ?? 0, 0));
    const pelvisQ = new THREE.Quaternion().copy(leanQ).slerp(new THREE.Quaternion(), 0.6).multiply(yq);
    const chestQ = new THREE.Quaternion().copy(leanQ).multiply(yq).multiply(local);

    const P = this.pose;
    P.pelvis.p.copy(this.root).add(tA.set(0, RIG.pelvisH - bob - (this.crouch || 0), 0));
    P.pelvis.q.copy(pelvisQ);
    P.chest.p.copy(P.pelvis.p).add(tA.fromArray(RIG.chest).applyQuaternion(pelvisQ));
    P.chest.q.copy(chestQ);
    P.head.p.copy(P.chest.p).add(tA.fromArray(RIG.head).applyQuaternion(chestQ));
    P.head.q.copy(chestQ);

    // arms
    for (const side of ['R', 'L']) {
      const sx = side === 'R' ? -RIG.shoulder[0] : RIG.shoulder[0];
      const sh = P['uArm' + side].p.copy(P.chest.p).add(tA.set(sx, RIG.shoulder[1], RIG.shoulder[2]).applyQuaternion(chestQ));
      const handLocal = side === 'R' ? this.hand : this.handL;
      const target = this.toWorld(handLocal, new THREE.Vector3());
      const pole = new THREE.Vector3().addScaledVector(fwd, -0.6).addScaledVector(rightW, side === 'R' ? 0.7 : -0.7).add(tA.set(0, -0.6, 0));
      const elbow = P['lArm' + side].p;
      const hand = new THREE.Vector3();
      twoBone(sh, target, RIG.UARM, RIG.LARM, pole, elbow, hand);
      basisQuat(tA.subVectors(sh, elbow), fwd, P['uArm' + side].q);
      basisQuat(tA.subVectors(elbow, hand), fwd, P['lArm' + side].q);
      if (side === 'R') {
        const bladeW = this.dirToWorld(this.blade, new THREE.Vector3());
        const edgeHint = new THREE.Vector3().crossVectors(rightW, bladeW);
        if (edgeHint.lengthSq() < 1e-3) edgeHint.copy(fwd);
        P.sword.p.copy(hand);
        basisQuat(bladeW, edgeHint, P.sword.q);
      }
    }

    // legs (procedural gait, feet planted by IK)
    const moveDir = speed > 0.05 ? tC.set(this.vel.x / speed, 0, this.vel.z / speed) : tC.copy(fwd);
    for (const side of ['L', 'R']) {
      const hx = side === 'R' ? -RIG.hip[0] : RIG.hip[0];
      const hip = P['thigh' + side].p.copy(P.pelvis.p).add(tA.set(hx, RIG.hip[1], RIG.hip[2]).applyQuaternion(pelvisQ));
      const ph = this.phase + (side === 'R' ? Math.PI : 0);
      let foot;
      if (this.state === 'fall') {
        foot = new THREE.Vector3(hip.x, hip.y - 0.8, hip.z).addScaledVector(fwd, Math.sin(performance.now() / 120 + ph) * 0.2);
      } else {
        foot = new THREE.Vector3(hip.x, RIG.ankleY + Math.max(0, Math.cos(ph)) * lift, hip.z)
          .addScaledVector(moveDir, Math.sin(ph) * amp).addScaledVector(rightW, side === 'R' ? 0.03 : -0.03);
      }
      const pole = new THREE.Vector3().copy(fwd).add(tA.set(0, 0.2, 0));
      const knee = P['shin' + side].p;
      const ankle = new THREE.Vector3();
      twoBone(hip, foot, RIG.THIGH, RIG.SHIN, pole, knee, ankle);
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
      driveAng(part.body, ps.q, 16, 20, 320 * STR[part.key] * T, h);
    }
    const ff = tA.copy(this.vel).add(this.knock);
    if (this.state !== 'fall') {
      driveLin(this.parts.pelvis.body, this.pose.pelvis.p, ff, 9, 6, 55 * T, h);
      driveLin(this.parts.chest.body, this.pose.chest.p, ff, 6, 5, 16 * T, h);
    }
    const sp = this.pose.sword;
    driveAng(this.swordBody, sp.q, 26, 30, 1100 * T, h);
    driveLin(this.swordBody, sp.p, ff, 14, 12, 90 * T, h);
  }

  // root follows the real body; detect knockdowns; landing from the drop
  bodyState(dt) {
    this.tonus += (this.tonusTarget - this.tonus) * (1 - Math.exp(-(this.tonusTarget > this.tonus ? 2.2 : 8) * dt));
    const pb = this.parts.pelvis.body.translation();
    if (this.state === 'fall') {
      this.root.y = Math.max(0, pb.y - 0.92);
      if (pb.y < 1.25) {
        this.root.y = 0; this.ctx.onLand(this); this.ctx.scene.remove(this.marker);
        this.tonus = 0.3; this.setState('land', 0.6);
      }
      return;
    }
    const dx = pb.x - this.root.x, dz = pb.z - this.root.z, d = Math.hypot(dx, dz);
    if (d > 0.2) { const f = 1 - 0.2 / d; this.root.x += dx * f; this.root.z += dz * f; }
    if (this.state === 'down' || this.state === 'getup') return;
    const r = this.parts.chest.body.rotation();
    const up = tB.set(0, 1, 0).applyQuaternion(qA.set(r.x, r.y, r.z, r.w));
    if (pb.y < 0.5 || up.y < 0.3) this.knockDown(rnd(1.0, 1.6));
  }

  knockDown(t) {
    this.setState('down', t);
    this.tonusTarget = 0.08;
    this.atk = null; this.atkPhase = null;
    this.sword.bladeMat.emissive.setRGB(0, 0, 0);
  }

  syncMeshes() {
    if (this.dead) return;
    const f = this.flash;
    for (const m of this.mats) m.emissive.setRGB(f, f, f);
    for (const part of Object.values(this.parts)) {
      const t = part.body.translation(), r = part.body.rotation();
      part.mesh.position.set(t.x, t.y, t.z); part.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    const t = this.swordBody.translation(), r = this.swordBody.rotation();
    this.sword.group.position.set(t.x, t.y, t.z); this.sword.group.quaternion.set(r.x, r.y, r.z, r.w);
  }

  // Enemy blade segment vs a capsule around the player's head/torso.
  checkPlayerHit() {
    const P = this.ctx.player;
    const st = this.swordBody.translation(), sr = this.swordBody.rotation();
    const sq = qA.set(sr.x, sr.y, sr.z, sr.w), spos = tC.set(st.x, st.y, st.z);
    const a = new THREE.Vector3(0, this.sword.baseY, 0).applyQuaternion(sq).add(spos);
    const b = new THREE.Vector3(0, this.sword.tipY, 0).applyQuaternion(sq).add(spos);
    const segP = new THREE.Line3(a, b);
    const top = P.head, bot = new THREE.Vector3(P.head.x, P.head.y - 0.8, P.head.z);
    let best = Infinity;
    for (let i = 0; i <= 6; i++) {
      const q = new THREE.Vector3().lerpVectors(top, bot, i / 6);
      const c = segP.closestPointToPoint(q, true, new THREE.Vector3());
      best = Math.min(best, c.distanceTo(q));
    }
    if (best < 0.2) { this.hitDone = true; this.ctx.damagePlayer(this.atk.dmg, this); }
  }

  takeHit(hit) {
    if (this.dead) return;
    const ctx = this.ctx;
    this.hp -= hit.dmg;
    this.flash = 1;
    ctx.particles.emit('blood', hit.point, hit.dir, 6 + Math.round(hit.dmg / 4), 2.5);
    if (this.hp <= 0) { this.die(hit); return; }
    sfx.hit(Math.min(1, hit.dmg / 70));
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
    this.tonus *= 0.5;
    if (this.state === 'fall' || this.state === 'down' || this.state === 'getup') return;
    if (hit.dmg > 45 && Math.random() < 0.35) this.knockDown(rnd(1.0, 1.6));
    else this.setState('stagger', 0.3 + Math.min(0.3, hit.dmg / 150));
  }

  onClash(rel) {
    if (this.dead || this.clashCd > 0) return false;
    this.clashCd = 0.15;
    const parried = this.state === 'attack' && (this.atkPhase === 'strike' || (this.atkPhase === 'windup' && this.stateT > this.atk.windup * 0.6));
    if (parried) {
      this.sword.bladeMat.emissive.setRGB(0, 0, 0);
      this.hitDone = true;
      this.knock.addScaledVector(new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), 1.6);
      this.setState('stagger', 0.75);
    }
    return parried;
  }

  die(hit) {
    this.dead = true;
    const ctx = this.ctx, w = phys.world;
    ctx.scene.remove(this.marker);
    for (const part of Object.values(this.parts)) {
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
      if (!cuts.has(b)) continue;
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
    w.removeImpulseJoint(this.joints.sword, true);
    this.sword.bladeMat.emissive.setRGB(0, 0, 0);
    this.swordCol.setCollisionGroups(GROUPS.piece);
    ctx.pieces.add(this.sword.group, this.swordBody, 35);

    ctx.pieces.shards(hit.point, hit.dir, Math.min(hit.speed, 10), 0xd41f3a, 8);
    ctx.particles.emit('blood', hit.point, hit.dir, 70, 3.5);
    for (const m of this.mats) m.emissive.setRGB(0, 0, 0);
    sfx.splat();
    ctx.onKill(this, hit);
  }

  destroy() {
    for (const part of Object.values(this.parts)) {
      removeBody(part.body);
      this.ctx.scene.remove(part.mesh);
    }
    removeBody(this.swordBody);
    this.ctx.scene.remove(this.sword.group);
    this.ctx.scene.remove(this.marker);
    this.dead = true;
  }
}
