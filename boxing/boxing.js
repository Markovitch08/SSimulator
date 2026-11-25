// Slop Boxing: a WebXR boxing game. Hand tracking first (filtered, predicted through dropouts,
// swept for hits), controllers and desktop as fallbacks. Opponents are Richard active ragdolls
// scaled to your height, fighting with a style per opponent (stats for chin, power, fist speed,
// block speed, dodge, aggression), weak spots, dizziness and knockdowns with a referee count.
// Modes: the gym (menu + test dummy), training (technique coach), squat gauntlet, and fights.
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { RAPIER, FIXED, phys, initPhysics, GROUPS, G, grp, bodyAlive } from '../src/physics.js';
import { facet, lambert, basisQuat } from '../src/lowpoly.js';
import { Particles } from '../src/fx.js';
import { sfx, resumeAudio } from '../src/audio.js';
import { loadEnemyModel } from '../src/enemy.js';

export const VERSION = 'boxing 0.5';

// ---------------------------------------------------------------- renderer / scene: a dark arena
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] }));

const BG = 0x0c0e13;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 12, 42);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.02, 200);
const dolly = new THREE.Group(); dolly.add(camera); scene.add(dolly);
camera.position.set(0, 1.65, 0);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const readPos = b => { const t = b.translation(); return V3(t.x, t.y, t.z); };
const readQ = b => { const r = b.rotation(); return new THREE.Quaternion(r.x, r.y, r.z, r.w); };

// areas: the ring in the middle of the stands, the gym floor on the open side
const RING_C = V3(0, 0, 0);
const HUB_C = V3(0, 0, 8);
const TRAIN_C = V3(-5, 0, 8.5);
const SQUAT_C = V3(5, 0, 8.5);
const RING = 2.4;

scene.add(new THREE.HemisphereLight(0x9aa6c0, 0x1a1c22, 0.9));
const key = new THREE.SpotLight(0xfff2dc, 140, 22, 0.62, 0.45, 1.4);
key.position.set(0, 9, 0); key.target.position.copy(RING_C); key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
scene.add(key, key.target);
{ // one soft, wide pool of light over the gym stations (few lights: the Quest's GPU is small)
  const s = new THREE.SpotLight(0xdfe8ff, 160, 22, 0.95, 0.7, 1.4);
  s.position.copy(HUB_C).add(V3(0, 9, 2)); s.target.position.copy(HUB_C).add(V3(0, 0, 0.5)); scene.add(s, s.target);
}
const fill = new THREE.DirectionalLight(0x6f7ea0, 0.35); fill.position.set(-4, 6, 8); scene.add(fill);

// arena dressing
{
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80, 20, 20).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x24272e }));
  floor.receiveShadow = true; scene.add(floor);
  const mat = new THREE.Mesh(facet(new THREE.BoxGeometry(RING * 2 + 0.6, 0.1, RING * 2 + 0.6)), lambert(0xe9e4d8));
  mat.position.set(RING_C.x, -0.04, RING_C.z); mat.receiveShadow = true; scene.add(mat);
  const logo = new THREE.Mesh(new THREE.CircleGeometry(0.9, 6).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xd41f3a }));
  logo.position.set(RING_C.x, 0.012, RING_C.z); scene.add(logo);
  const apron = new THREE.Mesh(facet(new THREE.BoxGeometry(RING * 2 + 0.7, 0.35, RING * 2 + 0.7)), lambert(0x1c2a52));
  apron.position.set(RING_C.x, -0.2, RING_C.z); scene.add(apron);
  const corners = [[1, 1, 0xd41f3a], [-1, -1, 0x2a5bd7], [1, -1, 0xf2f2f2], [-1, 1, 0xf2f2f2]];
  for (const [sx, sz, c] of corners) {
    const post = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6)), lambert(c));
    post.position.set(RING_C.x + sx * RING, 0.7, RING_C.z + sz * RING); post.castShadow = true; scene.add(post);
    const pad = new THREE.Mesh(facet(new THREE.BoxGeometry(0.16, 0.9, 0.16)), lambert(c));
    pad.position.set(RING_C.x + sx * (RING - 0.06), 0.75, RING_C.z + sz * (RING - 0.06)); scene.add(pad);
  }
  const ropeMat = lambert(0xd41f3a), ropeMat2 = lambert(0xf2f2f2);
  [0.45, 0.8, 1.15].forEach((h, i) => { for (let s = 0; s < 4; s++) {
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, RING * 2, 5).rotateZ(Math.PI / 2), i === 1 ? ropeMat2 : ropeMat);
    rope.rotation.y = s * Math.PI / 2; rope.position.set(RING_C.x + (s % 2 ? (s === 1 ? RING : -RING) : 0), h, RING_C.z + (s % 2 ? 0 : (s === 0 ? RING : -RING)));
    scene.add(rope);
  } });
  // stands on three sides of the ring, stepping up and back
  const standMat = lambert(0x181b22), railMat = lambert(0x3a3f4a);
  for (let row = 0; row < 7; row++) {
    const d = 5.2 + row * 0.85, h = 0.25 + row * 0.42;
    const back = new THREE.Mesh(new THREE.BoxGeometry(d * 2 + 0.85, h, 0.85), standMat); back.position.set(0, h / 2, -d); scene.add(back);
    for (const sx of [-1, 1]) { const side = new THREE.Mesh(new THREE.BoxGeometry(0.85, h, d + 3.6), standMat); side.position.set(sx * d, h / 2, (3.6 - d) / 2); scene.add(side); }
  }
  for (const [x, z, w, ry] of [[0, -4.75, 9.5, 0], [4.75, -0.6, 8.3, Math.PI / 2], [-4.75, -0.6, 8.3, Math.PI / 2]]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, 0.06), railMat); rail.position.set(x, 1.0, z); rail.rotation.y = ry; scene.add(rail);
  }
  const banner = text => {
    const c = document.createElement('canvas'); c.width = 1024; c.height = 192; const g = c.getContext('2d');
    g.fillStyle = '#d41f3a'; g.fillRect(0, 0, 1024, 192); g.fillStyle = '#fff'; g.font = 'bold 110px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 512, 100);
    return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) });
  };
  const b1 = new THREE.Mesh(new THREE.PlaneGeometry(8, 1.5), banner('SLOP BOXING')); b1.position.set(0, 5.4, -11.4); scene.add(b1);
  const b2 = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.1), banner('ONE MORE ROUND')); b2.position.set(-11.4, 4.8, -2); b2.rotation.y = Math.PI / 2; scene.add(b2);
  const b3 = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.1), banner('GUARD UP')); b3.position.set(11.4, 4.8, -2); b3.rotation.y = -Math.PI / 2; scene.add(b3);
  const truss = lambert(0x2a2e36), bulb = new THREE.MeshBasicMaterial({ color: 0xfff3d6 });
  for (const s of [-1, 1]) for (const axis of [0, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(axis ? 0.12 : 5.4, 0.12, axis ? 5.4 : 0.12), truss);
    bar.position.set(axis ? s * 2.7 : 0, 6.2, axis ? 0 : s * 2.7); scene.add(bar);
    for (let i = -2; i <= 2; i++) { const l = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.22), bulb); l.position.set(axis ? s * 2.7 : i * 1.1, 6.08, axis ? i * 1.1 : s * 2.7); scene.add(l); }
  }
  for (const [c, col] of [[HUB_C, 0x3a2f2a], [TRAIN_C, 0x22344f], [SQUAT_C, 0x2f3a22]]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.03, 8), lambert(col)); m.position.copy(c).setY(0.015); m.receiveShadow = true; scene.add(m);
  }
}
// the crowd: low-poly fans in the stands, bobbing harder when the fight gets exciting
const crowd = { hype: 0.15, n: 0, people: [] };
{
  const seats = [];
  for (let row = 0; row < 7; row++) {
    const d = 5.2 + row * 0.85, y = 0.25 + row * 0.42 * 1;
    for (let x = -d + 0.4; x <= d - 0.4; x += 0.62) seats.push([x, y + 0.0, -d]);
    for (let z = -d + 0.4; z <= 3.2; z += 0.62) { seats.push([d, y, z]); seats.push([-d, y, z]); }
  }
  crowd.n = seats.length;
  const bodyM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.5, 0.24), new THREE.MeshLambertMaterial(), crowd.n);
  const headM = new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.22, 0.2), new THREE.MeshLambertMaterial(), crowd.n);
  const shirts = [0xd41f3a, 0x2a5bd7, 0xf0c020, 0xeeeeee, 0x333842, 0x1f9a4a, 0x7a3fc0, 0xcf6a2a], skins = [0xf1c7a5, 0xc98f6b, 0x8d5a3b, 0x5a3825, 0xe0ac86];
  const col = new THREE.Color();
  seats.forEach(([x, y, z], i) => {
    bodyM.setColorAt(i, col.setHex(shirts[i % shirts.length]).offsetHSL(0, -0.25, -0.1));
    headM.setColorAt(i, col.setHex(skins[(i * 7) % skins.length]));
    crowd.people.push(Math.random() < 0.12 ? null : { x, y, z, face: Math.atan2(-x, -z), ph: Math.random() * 10, sp: rnd(2, 4) });
  });
  crowd.body = bodyM; crowd.head = headM; scene.add(bodyM, headM);
}
const _m = new THREE.Matrix4(), _qq = new THREE.Quaternion(), _s = V3(1, 1, 1), _p = V3();
function updateCrowd(t) {
  crowd.hype = Math.max(mode === 'fight' ? 0.25 : 0.08, crowd.hype - (1 / 30) * 0.12);
  crowd.people.forEach((p, i) => {
    if (!p) { _m.makeScale(0, 0, 0); crowd.body.setMatrixAt(i, _m); crowd.head.setMatrixAt(i, _m); return; }
    const bob = Math.max(0, Math.sin(t * p.sp + p.ph)) * crowd.hype * 0.35;
    _qq.setFromAxisAngle(UP, p.face);
    _m.compose(_p.set(p.x, p.y + 0.25 + bob, p.z), _qq, _s); crowd.body.setMatrixAt(i, _m);
    _m.compose(_p.set(p.x, p.y + 0.62 + bob, p.z), _qq, _s); crowd.head.setMatrixAt(i, _m);
  });
  crowd.body.instanceMatrix.needsUpdate = true; crowd.head.instanceMatrix.needsUpdate = true;
}
function cheer(amount) { crowd.hype = Math.min(1, crowd.hype + amount); if (amount > 0.15) sfx.crowd(Math.min(1, amount * 1.5)); }

// ---------------------------------------------------------------- physics
await initPhysics();
const world = phys.world;
const particles = new Particles(scene);

const _q = new THREE.Quaternion(), _v = V3(), _w = V3();
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
function driveLin(body, tp, k, maxV, acc, h) {
  const t = body.translation();
  _v.set(tp.x - t.x, tp.y - t.y, tp.z - t.z).multiplyScalar(k);
  if (_v.length() > maxV) _v.setLength(maxV);
  const lv = body.linvel(); _w.set(lv.x, lv.y, lv.z);
  _v.sub(_w); const m = acc * h; if (_v.lengthSq() > m * m) _v.setLength(m);
  body.setLinvel(_w.add(_v), true);
}

// ---------------------------------------------------------------- the Richard model, scaled to you
const models = new Map();
async function modelFor(height) {
  const cm = Math.round(height * 100);
  if (models.has(cm)) return models.get(cm);
  let M;
  try { M = await loadEnemyModel('richard_' + cm, '../models/richard.glb', cm / 100); }
  catch (e) { console.warn('Richard model failed to load, using a box body:', e); M = boxModel(cm / 100); }
  // the glove replaces the hand: drop the hand/finger triangles past the wrist from each forearm
  for (const S of ['L', 'R']) {
    const g = M.geos['lArm' + S][0].geo, pos = g.attributes.position, uv = g.attributes.uv;
    const keepP = [], keepU = [], cut = -(M.rig.LARM - 0.02);
    for (let i = 0; i < pos.count; i += 3) {
      if ((pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 < cut) continue;
      for (let j = i; j < i + 3; j++) { keepP.push(pos.getX(j), pos.getY(j), pos.getZ(j)); if (uv) keepU.push(uv.getX(j), uv.getY(j)); }
    }
    if (keepP.length >= 36) {
      const t = new THREE.BufferGeometry(); t.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
      if (uv) t.setAttribute('uv', new THREE.Float32BufferAttribute(keepU, 2));
      t.computeVertexNormals(); M.geos['lArm' + S] = [{ geo: t, mat: 0 }];
    }
  }
  models.set(cm, M);
  return M;
}
function boxModel(H) {
  const k = H / 1.85;
  const rig = { pelvisH: 0.98 * k, chest: [0, 0.22 * k, 0], head: [0, 0.3 * k, 0], shoulder: [0.2 * k, 0.18 * k, 0], hip: [0.1 * k, -0.06 * k, 0], UARM: 0.27 * k, LARM: 0.25 * k, THIGH: 0.45 * k, SHIN: 0.45 * k, ankleY: 0.07 };
  const box = (w, h, d, y) => [{ geo: new THREE.BoxGeometry(w * k, h * k, d * k).translate(0, y * k, 0), mat: 0 }];
  const geos = { pelvis: box(0.3, 0.18, 0.18, 0), chest: box(0.38, 0.36, 0.22, 0.12), head: box(0.19, 0.24, 0.21, 0.13) };
  for (const S of ['L', 'R']) Object.assign(geos, { ['uArm' + S]: box(0.09, 0.27, 0.09, -0.135), ['lArm' + S]: box(0.08, 0.25, 0.08, -0.125), ['thigh' + S]: box(0.12, 0.45, 0.12, -0.225), ['shin' + S]: box(0.1, 0.45, 0.1, -0.225) });
  return { geos, mats: [lambert(0xc98f6b)], rig };
}
// your height: standing eye height (measured in VR, 1.65 m on desktop) plus the top of the head
const body = { eye: 1.65, measuring: 0, samples: [] };
const heightFromEye = eye => clamp(eye / 0.935, 1.35, 2.15);

// ---------------------------------------------------------------- player: head + two kinematic fists
// Fists are kinematic sensors: they go exactly where your hands are every physics step (no lag,
// no float) and only detect what they touch; the push a hit gives is applied by hand, scaled to
// the hit (an unstoppable kinematic fist would launch the ragdoll across the ring).
const player = { hp: 100, head: V3(0, 1.65, 0), standY: 1.65, flash: 0, dizzy: 0, down: false, knockdowns: 0 };
const FIST_HALF = [0.045, 0.045, 0.055];
const fists = ['left', 'right'].map(side => {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(side === 'left' ? -0.2 : 0.2, 1.3, -0.3));
  const col = world.createCollider(RAPIER.ColliderDesc.cuboid(...FIST_HALF).setSensor(true).setCollisionGroups(GROUPS.phand), b);
  phys.info.set(col.handle, { kind: 'fist', side });
  const mesh = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.055, 1)), lambert(side === 'left' ? 0x2a5bd7 : 0xd41f3a));
  mesh.castShadow = true; scene.add(mesh);
  return {
    side, body: b, col, mesh,
    target: V3(), targetQ: new THREE.Quaternion(), prevT: V3(), prevQ: new THREE.Quaternion(), vel: V3(),
    valid: false, closed: true, lostT: 0, source: 'none',
    armed: true, punch: null,
    kf: { p: V3(), v: V3(), a: V3(), init: false }, lostFrom: null, lastMeasured: V3(), intent: null, sweepFrom: V3(), hitFrame: -1,
    desk: { t: 1, aim: V3() }, tip: null,
  };
});

const handFactory = new XRHandModelFactory();
const hands = [0, 1].map(i => {
  const hand = renderer.xr.getHand(i);
  const model = handFactory.createHandModel(hand, 'boxes'); model.visible = false; hand.add(model);
  hand.addEventListener('connected', e => { hand.userData.side = e.data.handedness; model.visible = !!e.data.hand; });
  hand.addEventListener('disconnected', () => { hand.userData.side = null; model.visible = false; });
  dolly.add(hand);
  return hand;
});
const grips = [0, 1].map(i => {
  const g = renderer.xr.getControllerGrip(i);
  g.addEventListener('connected', e => { g.userData.side = e.data.handedness; g.userData.gamepad = e.data.gamepad; g.userData.isHand = !!e.data.hand; });
  g.addEventListener('disconnected', () => { g.userData.side = null; });
  dolly.add(g);
  return g;
});
const TIPS = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'];

// ---- hand tracking, made to survive fast punches: an alpha-beta-gamma filter (position,
// velocity, acceleration) with light smoothing, glitch rejection, a 12 ms lead to cancel display
// latency and prediction through dropouts; a hand that reappears far from where it vanished
// scores the gap as a punch; knuckles -> palm -> wrist fallback.
const KF = { a: 0.95, b: 0.8, g: 0.18, lead: 0.012 };
const tmpQ = new THREE.Quaternion();
function jointAt(hand, name) { const j = hand?.joints?.[name]; return j && j.visible ? j : null; }
function measureHand(f) {
  const feed = window.boxing?.handFeed?.[f.side]; // test hook: (time) => position or null
  if (feed) { const p = feed(performance.now()); return p ? { pos: p.clone(), q: camera.getWorldQuaternion(new THREE.Quaternion()), closed: true } : null; }
  const hand = hands.find(h => h.userData.side === f.side);
  if (!hand) return null;
  const kn = jointAt(hand, 'middle-finger-phalanx-proximal'), mc = jointAt(hand, 'middle-finger-metacarpal'), wr = jointAt(hand, 'wrist');
  if (!kn && !mc && !wr) return null;
  const qj = wr || mc || kn, q = qj.getWorldQuaternion(new THREE.Quaternion());
  let pos;
  if (kn) pos = kn.getWorldPosition(V3());
  else { const j = mc || wr, along = mc ? 0.045 : 0.085; pos = j.getWorldPosition(V3()).add(V3(0, 0, -along).applyQuaternion(j.getWorldQuaternion(tmpQ))); }
  let closed = f.closed;
  if (mc) {
    const pc = mc.getWorldPosition(V3());
    let d = 0, n = 0;
    for (const t of TIPS) { const j = jointAt(hand, t); if (j) { d += j.getWorldPosition(V3()).distanceTo(pc); n++; } }
    if (n >= 2) closed = d / n < 0.075;
  }
  const tip = jointAt(hand, 'index-finger-tip');
  f.tip = tip && !closed ? tip.getWorldPosition(V3()) : null;
  return { pos, q, closed };
}
function trackHandFiltered(f, dt) {
  const k = f.kf, m = measureHand(f);
  if (!k.init) { if (!m) return false; k.p.copy(m.pos); k.v.set(0, 0, 0); k.a.set(0, 0, 0); k.init = true; f.lastMeasured.copy(m.pos); }
  k.p.addScaledVector(k.v, dt).addScaledVector(k.a, 0.5 * dt * dt); k.v.addScaledVector(k.a, dt);
  let meas = m;
  if (meas && f.lostT < 0.1 && meas.pos.distanceTo(k.p) > 0.5) meas = null; // a glitch, not a hand
  if (meas) {
    if (f.lostFrom && f.lostT > 0.03) {
      const disp = meas.pos.clone().sub(f.lostFrom), el = f.lostT;
      if (disp.length() > 0.2 && disp.length() / el > 2.5 && meas.pos.distanceTo(player.head) > 0.4) f.intent = { vel: disp.divideScalar(el), pos: meas.pos.clone(), from: f.lostFrom.clone() };
    }
    const r = meas.pos.clone().sub(k.p), h = Math.max(dt, 1 / 240);
    k.p.addScaledVector(r, KF.a); k.v.addScaledVector(r, KF.b / h); k.a.addScaledVector(r, 2 * KF.g / (h * h));
    if (k.v.length() > 20) k.v.setLength(20);
    if (k.a.length() > 400) k.a.setLength(400);
    f.lastMeasured.copy(meas.pos); f.lostT = 0; f.lostFrom = null;
    f.targetQ.copy(meas.q); f.closed = meas.closed;
    f.target.copy(k.p).addScaledVector(k.v, KF.lead);
    return true;
  }
  if (f.lostT >= 0.25) { k.init = false; f.lostFrom = null; return false; }
  if (!f.lostFrom) f.lostFrom = f.lastMeasured.clone();
  f.lostT += dt;
  k.a.multiplyScalar(Math.exp(-10 * dt)); k.v.multiplyScalar(Math.exp(-3 * dt));
  const off = k.p.clone().sub(player.head);
  if (off.length() > 0.85) { off.setLength(0.85); k.p.copy(player.head).add(off); k.v.addScaledVector(off.normalize(), -Math.max(0, k.v.dot(off))); }
  f.target.copy(k.p);
  return true;
}
function trackFists(dt) {
  const xr = renderer.xr.isPresenting;
  for (const f of fists) {
    f.prevT.copy(f.valid ? f.target : f.prevT); f.prevQ.copy(f.targetQ);
    f.sweepFrom.copy(f.prevT);
    let got = false; f.tip = null;
    if (xr || window.boxing?.handFeed?.[f.side]) {
      got = trackHandFiltered(f, dt);
      if (got) f.source = f.lostT > 0 ? 'hand (predicted)' : 'hand';
      if (!got && xr) {
        const g = grips.find(c => c.userData.side === f.side && !c.userData.isHand);
        if (g && g.userData.gamepad) {
          g.getWorldPosition(f.target); g.getWorldQuaternion(f.targetQ);
          f.target.add(V3(0, 0, -0.05).applyQuaternion(f.targetQ));
          f.closed = true; f.source = 'controller'; got = true;
        }
      }
    } else { deskFist(f, dt); got = true; f.source = 'desktop'; }
    if (f.intent) f.sweepFrom.copy(f.intent.from);
    if (got && !f.valid) { f.prevT.copy(f.target); f.sweepFrom.copy(f.target); f.body.setTranslation(f.target, true); }
    f.valid = got;
    if (dt > 0) f.vel.subVectors(f.target, f.prevT).divideScalar(dt);
  }
}
function moveFistsKinematic(k) { // k: how much of this frame's motion is done after this physics step
  for (const f of fists) {
    if (!f.valid) { f.body.setNextKinematicTranslation({ x: f.target.x, y: -10, z: f.target.z }); continue; }
    f.body.setNextKinematicTranslation(f.prevT.clone().lerp(f.target, k));
    f.body.setNextKinematicRotation(f.prevQ.clone().slerp(f.targetQ, k));
  }
}

// desktop: fists sit in a guard; left/right click throws that hand at the cursor
const mouse = new THREE.Vector2();
const desk = { slip: 0, duck: 0, keys: new Set() };
const raycaster = new THREE.Raycaster();
addEventListener('pointermove', e => { mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('pointerdown', e => {
  if (e.target !== renderer.domElement) return;
  resumeAudio();
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObjects(buttons.filter(b => b.root.visible).map(b => b.mesh))[0];
  if (hit) { hit.object.userData.button.press(); return; }
  const f = fists[e.button === 2 ? 1 : 0];
  f.desk.aim.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, 0.75); f.desk.t = 0;
});
addEventListener('keydown', e => {
  desk.keys.add(e.code); resumeAudio();
  const ahead = dx => camera.getWorldPosition(V3()).add(camera.getWorldDirection(V3()).multiplyScalar(0.75)).add(V3(dx, -0.05, 0));
  if (e.code === 'KeyJ') { fists[0].desk.t = 0; fists[0].desk.aim.copy(ahead(-0.05)); }
  if (e.code === 'KeyK') { fists[1].desk.t = 0; fists[1].desk.aim.copy(ahead(0.05)); }
  if (e.code === 'Escape') togglePause();
});
addEventListener('keyup', e => desk.keys.delete(e.code));
function deskFist(f, dt) {
  const camP = camera.getWorldPosition(V3()), camQ = camera.getWorldQuaternion(new THREE.Quaternion());
  const guard = V3(f.side === 'left' ? -0.17 : 0.17, -0.2, -0.4).applyQuaternion(camQ).add(camP);
  f.desk.t += dt;
  const out = 0.08, back = 0.14, t = f.desk.t;
  const k = t < out ? t / out : t < out + back ? 1 - (t - out) / back : 0;
  f.target.copy(guard).lerp(f.desk.aim, k * k * (3 - 2 * k));
  f.targetQ.copy(camQ); f.closed = true;
}
function updateDeskHead(dt) {
  if (renderer.xr.isPresenting) return;
  const s = (desk.keys.has('KeyE') ? 1 : 0) - (desk.keys.has('KeyQ') ? 1 : 0);
  const d = desk.keys.has('KeyC') || desk.keys.has('ControlLeft') ? 1 : 0;
  desk.slip += (s * 0.28 - desk.slip) * (1 - Math.exp(-14 * dt));
  desk.duck += (d * 0.4 - desk.duck) * (1 - Math.exp(-14 * dt));
  camera.position.set(desk.slip, body.eye - desk.duck, 0);
  camera.rotation.set(mode === 'fight' || mode === 'squat' ? 0 : -0.3, 0, 0); // look down at the menus
}
function pulse(side, intensity, ms) {
  const s = renderer.xr.getSession?.();
  if (!s) return;
  for (const src of s.inputSources) if (src.handedness === side) src.gamepad?.hapticActuators?.[0]?.pulse?.(Math.min(1, intensity), ms);
}
// how fast the punch really is: for tracked hands the filtered hand (or a dropout's intent)
function punchVel(f) {
  if (f.source.startsWith('hand')) return f.intent && f.intent.vel.length() > f.kf.v.length() ? f.intent.vel.clone() : f.kf.v.clone();
  return f.vel.clone();
}

// ---------------------------------------------------------------- opponents
// Each has a style: stats 0..1 (chin above 1 = tougher), a guard shape, and a pattern for
// when he attacks. Beat one to unlock the next.
const OPPONENTS = [
  { name: 'Sparring Bot', tag: 'the warm-up', style: 'Slow, soft and polite. One round to learn the ropes.', rounds: 1, chin: 0.7, power: 0.35, speed: 0.35, block: 0.25, dodge: 0, aggr: 0.3, feet: 0.4, counter: 0.1, combo: 1, guard: 'loose', pattern: 'basic', tint: 0xb8c4d6, glove: 0x888888 },
  { name: 'Clockwork Carl', tag: 'tick, tock, pow', style: 'Covers up for a few seconds, then lets a short burst go, like he is on a timer. Hit him as he opens up.', rounds: 2, chin: 0.85, power: 0.5, speed: 0.5, block: 0.55, dodge: 0, aggr: 0.4, feet: 0.4, counter: 0.2, combo: 3, guard: 'high', pattern: 'timer', tint: 0xd6c8b0, glove: 0xf0c020 },
  { name: 'Iron Mattress', tag: 'soaks it all up', style: 'Tough chin, tight guard, slow feet. Step to the side and go around his gloves. He waits for you to tire, then counters.', rounds: 3, chin: 1.3, power: 0.65, speed: 0.55, block: 0.8, dodge: 0.05, aggr: 0.3, feet: 0.25, counter: 0.6, combo: 2, guard: 'high', pattern: 'counter', tint: 0xa8b8a0, glove: 0x1f9a4a },
  { name: 'Brother Haymaker', tag: 'swing first, pray later', style: 'Fast feet, always throwing. His elbows-up guard covers his head, so go to the body. Slow to counter after he gets tagged.', rounds: 3, chin: 0.8, power: 0.75, speed: 0.65, block: 0.55, dodge: 0.1, aggr: 0.85, feet: 0.8, counter: 0.15, combo: 3, guard: 'elbows', pattern: 'pressure', tint: 0xc8b0d6, glove: 0x7a3fc0 },
  { name: 'Zip Zigzag', tag: 'small, fast and angry', style: 'Glass jaw, but after you tag him he slips your follow-ups and fires right back. Do not chase.', rounds: 3, chin: 0.6, power: 0.6, speed: 0.85, block: 0.45, dodge: 0.7, aggr: 0.7, feet: 0.9, counter: 0.8, combo: 3, guard: 'high', pattern: 'pressure', tint: 0xe0b8a0, glove: 0xcf6a2a },
  { name: 'The Spindle', tag: 'all offence', style: 'Barely moves and barely defends, but his hands are fast and heavy. One clean shot drops him, and one from him drops you.', rounds: 3, chin: 0.5, power: 1.2, speed: 0.85, block: 0.2, dodge: 0, aggr: 0.6, feet: 0.15, counter: 0.7, combo: 2, guard: 'loose', pattern: 'counter', tint: 0xb0d0d6, glove: 0x111111 },
  { name: 'The Painter', tag: 'waits for the masterpiece', style: 'Patient and slippery. Waits, then counters hard and follows with a flurry. Bait his counter and counter it.', rounds: 4, chin: 1.0, power: 0.85, speed: 0.85, block: 0.6, dodge: 0.9, aggr: 0.3, feet: 0.85, counter: 1.0, combo: 4, guard: 'high', pattern: 'painter', tint: 0xd6d0b0, glove: 0xeeeeee },
  { name: 'The Wall', tag: 'nobody gets through', style: 'A huge, quick guard and almost impossible to knock out. Slow but heavy hands. Jab to move his gloves, then hook around them.', rounds: 4, chin: 1.6, power: 1.15, speed: 0.45, block: 1.0, dodge: 0.05, aggr: 0.45, feet: 0.3, counter: 0.35, combo: 2, guard: 'wide', pattern: 'counter', tint: 0x9aa0a8, glove: 0x2a5bd7 },
  { name: 'Rico Rush', tag: 'never stops coming', style: 'Pushes forward with long combos. Let him throw first and hook him as he finishes. One uppercut from him can put you down.', rounds: 4, chin: 1.0, power: 0.95, speed: 0.85, block: 0.6, dodge: 0.55, aggr: 1.0, feet: 0.85, counter: 0.55, combo: 4, guard: 'high', pattern: 'pressure', tint: 0xd6a8a8, glove: 0xd41f3a },
  { name: 'The Champ', tag: 'the last one', style: 'Hits hardest, hardest to drop, blocks and dodges fast and pressures from every angle. Sidestep, then counter quickly.', rounds: 5, chin: 1.5, power: 1.25, speed: 1.0, block: 0.9, dodge: 0.85, aggr: 0.9, feet: 0.9, counter: 0.9, combo: 4, guard: 'high', pattern: 'pressure', tint: 0xf0d890, glove: 0xf0c020 },
];
const DIFFS = [{ name: 'Easy', k: 0.75 }, { name: 'Normal', k: 1 }, { name: 'Hard', k: 1.2 }];
const save = { unlocked: 1, diff: 1 };
try { Object.assign(save, JSON.parse(localStorage.getItem('slopBoxing') || '{}')); } catch (e) {}
const persist = () => { try { localStorage.setItem('slopBoxing', JSON.stringify(save)); } catch (e) {} };

// ---------------------------------------------------------------- the boxer: an active ragdoll
const MULT = { pelvis: 0.6, chest: 0.85, head: 1.0, uArmL: 0.15, uArmR: 0.15, lArmL: 0.08, lArmR: 0.08, thighL: 0.3, thighR: 0.3, shinL: 0.25, shinR: 0.25 };
const JOINTS = [['pelvis', 'chest', 'chest'], ['chest', 'head', 'head'], ['chest', 'uArmL', 'uArmL'], ['uArmL', 'lArmL', 'lArmL'], ['chest', 'uArmR', 'uArmR'], ['uArmR', 'lArmR', 'lArmR'],
  ['pelvis', 'thighL', 'thighL'], ['thighL', 'shinL', 'shinL'], ['pelvis', 'thighR', 'thighR'], ['thighR', 'shinR', 'shinR']];
const GLOVE_R = 0.075;
const rot = (q, a) => V3(...a).applyQuaternion(q);

class Boxer {
  constructor(M, { mode = 'fight', at = V3(0, 0, -2), yaw = 0, opp = OPPONENTS[0], diff = 1, glove = null, tint = null } = {}) {
    this.M = M; this.RIG = M.rig; this.GLOVE_AT = M.rig.LARM + 0.03;
    this.mode = mode; this.opp = opp; this.dk = DIFFS[diff].k;
    const s = k => clamp(opp[k] * (k === 'chin' ? this.dk : lerp(1, this.dk, 0.8)), 0, 1.8);
    this.st = { chin: s('chin'), power: s('power'), speed: s('speed'), block: s('block'), dodge: s('dodge'), aggr: s('aggr'), feet: s('feet'), counter: s('counter'), combo: opp.combo };
    if (mode === 'coach') Object.assign(this.st, { speed: 0.2, power: 0.3 });
    this.maxHp = 200 * this.st.chin; this.hp = this.maxHp; // ~25-35 clean hits, fewer with weak spots and knockdowns
    this.base = at.clone(); this.home = at.clone(); this.yaw = yaw;
    this.f = V3(Math.sin(yaw), 0, Math.cos(yaw)); this.r = V3(-this.f.z, 0, this.f.x);
    this.tonus = 1; this.state = mode === 'fight' ? 'walkin' : 'guard'; this.t = 0; this.next = rnd(1.5, 2.5); this.hitCd = 0;
    this.weave = Math.random() * 10; this.plan = []; this.atk = null; this.flash = 0;
    this.feet = { L: null, R: null }; this.stepping = null; this.slip = 0; this.duck = 0; this.holdDuck = false;
    this.trauma = 0; this.pain = 0; this.dizzy = 0; this.dizzyT = 0; this.knockdowns = 0; this.downT = 0; this.cover = 0; this.coverZone = 'head';
    this.retreatT = 0; this.counterWin = 0; this.lastPlayerPunch = -9; this.flurry = 0; this.timerPhase = 0;
    this.mat = M.mats[0].clone(); this.mat.emissive = new THREE.Color(0);
    if (tint ?? opp.tint) this.mat.color.setHex(tint ?? opp.tint);
    this.gloveColor = glove ?? opp.glove;
    this.onHitPlayer = (kind, at) => hurtPlayer(this, kind, at);
    this.onDodge = () => onDodge();
    this.onBlocked = () => {};
    this.pose = {};
    this.computePose();
    this.build();
  }
  build() {
    this.parts = {};
    for (const k of Object.keys(MULT)) {
      const p = this.pose[k];
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.p.x, p.p.y, p.p.z).setRotation(p.q).setLinearDamping(0.6).setAngularDamping(1.5));
      const geo = this.M.geos[k][0].geo;
      geo.computeBoundingBox();
      const bb = geo.boundingBox, c = bb.getCenter(V3()), sz = bb.getSize(V3()).multiplyScalar(0.45);
      const col = world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.03, sz.x), Math.max(0.03, sz.y), Math.max(0.03, sz.z)).setTranslation(c.x, c.y, c.z).setDensity(900).setFriction(0.8).setCollisionGroups(GROUPS.ealive), b);
      phys.info.set(col.handle, { kind: 'boxer', boxer: this, part: k });
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.castShadow = true; scene.add(mesh);
      const part = { body: b, col, mesh, gloveCol: null };
      if (k.startsWith('lArm')) {
        const gc = world.createCollider(RAPIER.ColliderDesc.ball(GLOVE_R).setTranslation(0, -this.GLOVE_AT, 0).setDensity(500).setFriction(0.6).setCollisionGroups(GROUPS.ealive), b);
        phys.info.set(gc.handle, { kind: 'boxer', boxer: this, part: k, glove: true });
        const gm = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(GLOVE_R * 1.1, 1)), lambert(this.gloveColor, { emissive: 0x000000 }));
        gm.position.set(0, -this.GLOVE_AT, 0); gm.castShadow = true; mesh.add(gm);
        part.gloveCol = gc; part.gloveMesh = gm;
      }
      this.parts[k] = part;
    }
    for (const [a, b, at] of JOINTS) {
      const A = this.parts[a].body, B = this.parts[b].body, w = this.pose[at].p;
      const la = w.clone().sub(readPos(A)).applyQuaternion(readQ(A).invert());
      const lb = w.clone().sub(readPos(B)).applyQuaternion(readQ(B).invert());
      world.createImpulseJoint(RAPIER.JointData.spherical(la, lb), A, B, true);
    }
  }
  remove() {
    for (const p of Object.values(this.parts)) {
      phys.info.delete(p.col.handle); if (p.gloveCol) phys.info.delete(p.gloveCol.handle);
      if (bodyAlive(p.body)) world.removeRigidBody(p.body);
      scene.remove(p.mesh);
    }
    this.parts = {}; this.mat.dispose();
  }
  glovePos(s) { const b = this.parts['lArm' + s].body; return V3(0, -this.GLOVE_AT, 0).applyQuaternion(readQ(b)).add(readPos(b)); }
  headPos() { const b = this.parts.head.body; return V3(0, 0.12, 0.02).applyQuaternion(readQ(b)).add(readPos(b)); }
  get standing() { return !['down', 'getup', 'ko'].includes(this.state); }

  // ---- the hidden target skeleton
  computePose() {
    const RIG = this.RIG, f = this.f, r = this.r, P = this.pose;
    const dizzy = this.state === 'dizzy';
    const lean = this.atk && this.atk.phase === 'strike' ? 0.18 : this.state === 'stagger' ? -0.12 : this.state === 'hurt' ? 0.35 : 0.05;
    const bob = Math.sin(this.weave * 2.2) * 0.015, sway = Math.sin(this.weave) * (dizzy ? 0.12 : 0.04);
    const face = basisQuat(UP, f);
    const pelvis = this.base.clone().add(V3(0, RIG.pelvisH + bob - this.duck, 0)).addScaledVector(r, sway * 0.5);
    const spineUp = UP.clone().addScaledVector(f, lean + this.duck * 0.6).addScaledVector(r, this.slip * 1.2 + (dizzy ? Math.sin(this.t * 2.3) * 0.15 : 0)).normalize();
    const chestQ = basisQuat(spineUp, f);
    const chest = pelvis.clone().add(rot(face, RIG.chest)).addScaledVector(r, sway + this.slip * 0.4);
    const neck = chest.clone().add(rot(chestQ, RIG.head));
    const headC = neck.clone().add(V3(0, 0.12, 0));
    const look = this.lookDir ? this.lookDir.clone().setY(this.lookDir.y * 0.5) : f.clone();
    if (dizzy) look.addScaledVector(r, Math.sin(this.t * 1.7) * 0.6).add(V3(0, Math.sin(this.t * 1.1) * 0.3, 0)); // eyes drifting
    P.pelvis = { p: pelvis, q: face }; P.chest = { p: chest, q: chestQ };
    P.head = { p: neck, q: basisQuat(spineUp.clone().add(UP).normalize(), look) };
    const g = { loose: [0.24, 0.1, -0.1], high: [0.2, 0.085, -0.03], elbows: [0.16, 0.06, 0.04], wide: [0.27, 0.13, -0.05] }[this.opp.guard] || [0.2, 0.085, -0.03];
    for (const s of ['L', 'R']) {
      const sx = s === 'L' ? 1 : -1; // model +X is the boxer's left
      const sh = chest.clone().add(rot(chestQ, [sx * RIG.shoulder[0], RIG.shoulder[1], RIG.shoulder[2]]));
      let guard = headC.clone().addScaledVector(f, g[0]).addScaledVector(r, -sx * g[1]).add(V3(0, g[2], 0));
      if (this.cover > 0) guard = this.coverZone === 'body' ? chest.clone().addScaledVector(f, 0.16).addScaledVector(r, -sx * 0.1).add(V3(0, -0.08, 0)) : headC.clone().addScaledVector(f, 0.12).addScaledVector(r, -sx * 0.065).add(V3(0, 0.02, 0));
      const glove = this.gloveGoal?.[s] || guard;
      const arm = ik2(sh, glove, RIG.UARM, this.GLOVE_AT, r.clone().multiplyScalar(-sx * 0.7).add(V3(0, -1, 0)).addScaledVector(f, -0.2));
      P['uArm' + s] = { p: sh, q: basisQuat(sh.clone().sub(arm.elbow).normalize(), f) };
      P['lArm' + s] = { p: arm.elbow, q: basisQuat(arm.elbow.clone().sub(arm.end).normalize(), f) };
      const hip = pelvis.clone().add(rot(face, [sx * RIG.hip[0], RIG.hip[1], RIG.hip[2]]));
      const foot = this.feet[s] || this.footHome(s);
      const leg = ik2(hip, foot, RIG.THIGH, RIG.SHIN, f.clone().add(V3(0, 0.2, 0)));
      P['thigh' + s] = { p: hip, q: basisQuat(hip.clone().sub(leg.elbow).normalize(), f) };
      P['shin' + s] = { p: leg.elbow, q: basisQuat(leg.elbow.clone().sub(leg.end).normalize(), f) };
    }
  }
  footHome(s) {
    const sx = s === 'L' ? 1 : -1;
    return this.base.clone().setY(this.RIG.ankleY).addScaledVector(this.r, -sx * 0.17).addScaledVector(this.f, s === 'L' ? 0.1 : -0.1);
  }
  updateFeet(dt) {
    for (const s of ['L', 'R']) if (!this.feet[s]) this.feet[s] = this.footHome(s);
    if (this.stepping) {
      const st = this.stepping; st.t += dt / 0.16;
      const k = Math.min(1, st.t);
      this.feet[st.s].lerpVectors(st.from, st.to, k).setY(this.RIG.ankleY + Math.sin(k * Math.PI) * 0.07);
      if (k >= 1) { this.stepping = null; this.lastStep = st.s; }
      return;
    }
    let pick = null, wd = 0.18;
    for (const s of ['L', 'R']) { const d = this.footHome(s).distanceTo(this.feet[s]); if (d > wd && (s !== this.lastStep || d > 0.3)) { wd = d; pick = s; } }
    if (pick) this.stepping = { s: pick, from: this.feet[pick].clone(), to: this.footHome(pick), t: 0 };
  }
  drive(h) {
    if (this.tonus <= 0.01) return;
    const P = this.pose, tn = this.tonus;
    for (const [k, part] of Object.entries(this.parts)) {
      if (!bodyAlive(part.body)) continue;
      const tgt = P[k];
      const strike = this.atk && this.atk.phase === 'strike' && (k === 'lArm' + this.atk.side || k === 'uArm' + this.atk.side);
      const core = k === 'pelvis' || k === 'chest', head = k === 'head';
      const sp = 0.7 + this.st.speed * 0.6;
      driveLin(part.body, tgt.p, strike ? 45 : core ? 18 : 22, strike ? 11 * sp : 6, (strike ? 700 : core ? 160 : 220) * tn, h);
      driveAng(part.body, tgt.q, strike ? 40 : head || core ? 40 : 22, strike ? 40 : 20, (strike ? 900 : head || core ? 700 : 260) * tn, h);
    }
  }

  // ---- brain
  think(dt, ph) {
    this.t += dt; this.weave += dt * (this.state === 'guard' ? 1.6 : 0.8);
    this.hitCd -= dt; this.flash = Math.max(0, this.flash - dt * 5);
    if (this.state !== 'dizzy') this.dizzy = Math.max(0, this.dizzy - dt * 2.5); // dazing takes hits in quick succession
    this.cover = Math.max(0, this.cover - dt); this.retreatT = Math.max(0, this.retreatT - dt); this.counterWin = Math.max(0, this.counterWin - dt);
    if (this.state === 'down' || this.state === 'ko') { this.tonus = 0; this.downT += dt; return; }
    if (this.state === 'getup') { // muscles come back; the target pose rises from a crouch
      this.downT += dt; this.tonus = Math.min(1, this.tonus + dt * 0.9);
      this.duck = Math.max(0, 0.45 * (1 - this.downT / 1.6)); this.holdDuck = true;
      const pv = readPos(this.parts.pelvis.body); this.base.set(pv.x, 0, pv.z);
      if (this.downT > 1.2 && pv.y < this.RIG.pelvisH * 0.55 && !this.helped) { this.helped = true; this.snapToPose(); } // a ragdoll that can't find its feet gets a hand up
      if (this.downT > 1.8) { this.state = 'guard'; this.holdDuck = false; this.helped = false; this.feet = { L: null, R: null }; }
    }
    const to = V3(ph.x - this.base.x, 0, ph.z - this.base.z), dist = to.length();
    if (dist > 1e-3 && this.mode !== 'dummy') {
      const want = Math.atan2(to.x, to.z);
      let dy = want - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * (1 - Math.exp(-8 * dt));
      this.f.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.r.set(-this.f.z, 0, this.f.x);
    }
    this.lookDir = V3().subVectors(ph, this.headPos()).normalize();
    const tgtTonus = this.state === 'stagger' ? 0.4 : this.state === 'dizzy' ? 0.6 : this.state === 'rest' ? 0.85 : 1;
    if (this.state !== 'getup') this.tonus += (tgtTonus - this.tonus) * (1 - Math.exp(-3 * dt));
    if (this.state === 'dizzy' && (this.dizzyT -= dt) <= 0) { this.state = 'guard'; this.dizzy = 0; }
    if (this.state === 'hurt' && (this.hurtT -= dt) <= 0) this.state = 'guard';

    // ---- footwork
    if (this.mode === 'dummy') this.walkTo(this.home, dt, 1);
    else if (this.mode === 'coach') this.walkTo(this.wantPos || this.home, dt, 1.4);
    else if (this.state === 'rest' || this.state === 'corner') this.walkTo(V3(-RING + 0.6, 0, -RING + 0.6).add(RING_C), dt, 1.2);
    else if (this.state !== 'stagger' && this.state !== 'getup') {
      const st = this.st;
      // preferred range: pressure fighters stand close, patient ones just out of reach; back off
      // when hurt or after taking a big one; never crowd you
      let range = lerp(1.0, 0.72, st.aggr);
      if (this.atk) range = 0.48; // step in to throw
      if (this.state === 'dizzy' || this.state === 'hurt' || this.retreatT > 0) range = 1.35;
      range = Math.max(range, this.atk ? 0.45 : 0.55);
      const cur = Math.atan2(this.base.x - ph.x, this.base.z - ph.z);
      if (this.orbitBase === undefined) this.orbitBase = cur;
      let dc = cur - this.orbitBase; dc = Math.atan2(Math.sin(dc), Math.cos(dc)); this.orbitBase += dc * (1 - Math.exp(-0.3 * dt));
      const a = this.orbitBase + Math.sin(this.t * (0.25 + st.feet * 0.4)) * (0.15 + st.feet * 0.35);
      this.walkTo(V3(ph.x + Math.sin(a) * range, 0, ph.z + Math.cos(a) * range), dt, this.state === 'walkin' ? 0.9 : 0.7 + st.feet * 1.3);
      if (this.state === 'walkin' && dist < 1.3) { this.state = 'guard'; this.next = rnd(0.8, 1.6); }
    }
    if (this.mode === 'fight') {
      this.base.x = clamp(this.base.x, RING_C.x - RING + 0.35, RING_C.x + RING - 0.35);
      this.base.z = clamp(this.base.z, RING_C.z - RING + 0.35, RING_C.z + RING - 0.35);
    }
    this.updateFeet(dt);
    this.slip *= Math.exp(-4 * dt); if (!this.holdDuck) this.duck *= Math.exp(-5 * dt);

    if (this.state === 'stagger') { if ((this.staggerT -= dt) <= 0) this.state = 'guard'; this.cancelAttack(); this.gloveGoal = null; return; }
    if (!['guard', 'dizzy', 'hurt'].includes(this.state)) { this.gloveGoal = null; return; }
    this.gloveGoal = {};
    if (this.mode === 'dummy') {
      for (const s of ['L', 'R']) this.gloveGoal[s] = this.pose['thigh' + s].p.clone().addScaledVector(this.r, (s === 'L' ? 0.12 : -0.12)).add(V3(0, -0.15, 0));
      return;
    }
    if (this.mode === 'coach') { this.demo?.(dt, this); if (this.atk) this.runAttack(dt, ph); return; }
    if (this.state === 'dizzy' || this.state === 'hurt') { this.cover = Math.max(this.cover, 0.3); this.coverZone = this.state === 'hurt' ? 'body' : 'head'; this.cancelAttack(); return; }
    this.defend(dt);
    if (game.state !== 'fight' || referee.who || player.down) { this.cancelAttack(); return; }
    this.offend(dt, ph, dist);
  }

  // reading your fists: block or slip what's coming
  defend(dt) {
    const st = this.st, hp = this.headPos();
    for (const fi of fists) {
      if (!fi.valid) continue;
      const fp = fi.target.clone(), fv = punchVel(fi), sp = fv.length();
      if (sp < 2.2) { if (fi.react) { fi.react = null; this.lastPlayerPunch = this.t; } continue; }
      const toHead = hp.clone().sub(fp), d = toHead.length();
      if (d > 0.75 || fv.dot(toHead.normalize()) < 1.6) continue;
      // one decision per punch, after a reaction time set by his block / dodge speed
      if (!fi.react) {
        const roll = Math.random();
        fi.react = { t: 0, delay: lerp(0.22, 0.06, Math.max(st.block, st.dodge)), what: roll < st.dodge * 0.6 ? 'dodge' : roll < st.dodge * 0.6 + st.block * 0.75 ? 'block' : 'none' };
      }
      fi.react.t += dt;
      if (fi.react.t < fi.react.delay || this.atk?.phase === 'strike') continue;
      const low = fp.y < hp.y - 0.35 || fv.y < -1.5;
      const lateral = Math.abs(fv.dot(this.r)) > sp * 0.55;
      if (fi.react.what === 'dodge') {
        if (lateral && !low) this.duck = 0.2; // under the hook
        else this.slip = (fp.clone().sub(hp).dot(this.r) > 0 ? -1 : 1) * 0.13; // away from the fist
      } else if (fi.react.what === 'block') {
        const s = fp.clone().sub(hp).dot(this.r) > 0 ? 'R' : 'L';
        this.gloveGoal[s] = low ? this.pose.chest.p.clone().addScaledVector(this.f, 0.15).addScaledVector(this.r, s === 'L' ? -0.08 : 0.08) : hp.clone().lerp(fp, 0.45);
      }
    }
    // your punch has just finished and he wasn't hurt by it: that's his counter window
    const since = this.t - this.lastPlayerPunch;
    if (since > 0 && since < 0.1 && !this.atk && !this.countered && Math.random() < st.counter) { this.counterWin = 0.45; }
    this.countered = since < 0.1;
  }

  offend(dt, ph, dist) {
    const st = this.st, pat = this.opp.pattern;
    if (this.atk) { this.runAttack(dt, ph); return; }
    this.next -= dt;
    let go = false, counter = false;
    if (this.counterWin > 0 && dist < 1.1) { go = true; counter = true; this.counterWin = 0; }
    else if (pat === 'timer') {
      // cover up for a few seconds, then a burst
      if (this.timerPhase === 0) { this.cover = 0.3; this.coverZone = 'head'; if (this.next <= 0) { this.timerPhase = 1; this.plan = []; this.next = 0; } }
      if (this.timerPhase === 1) go = this.next <= 0;
    } else if (pat === 'counter' || pat === 'painter') {
      // mostly waits; goes on its own when you've stopped throwing for a while
      if (this.next <= 0 && this.t - this.lastPlayerPunch > lerp(3.5, 1.8, st.aggr)) go = true;
      else if (this.next <= 0) this.next = 0.4;
    } else go = this.next <= 0;
    if (!go || dist > 1.25) return;
    if (!this.plan.length) this.plan = this.pickCombo(counter);
    this.startAttack(this.plan.shift(), { counter });
  }

  // aim at whatever your guard leaves open
  pickCombo(counter) {
    const st = this.st, h = player.head, { fw } = facingFrame();
    const near = f => f.valid && f.target.distanceTo(h) < 0.3 && f.target.clone().sub(h).dot(fw) > 0;
    const lCover = near(fists[0]), rCover = near(fists[1]);
    const pick = () => {
      if (lCover && rCover) return Math.random() < 0.6 ? 'body' : Math.random() < 0.5 ? 'hookL' : 'hookR';
      if (!lCover && !rCover) return Math.random() < 0.55 ? (Math.random() < 0.6 ? 'jab' : 'cross') : 'upper';
      // your left side is open (left fist down): his right hook lands there, and vice versa
      return !lCover ? (Math.random() < 0.7 ? 'hookR' : 'cross') : (Math.random() < 0.7 ? 'hookL' : 'jab');
    };
    let n = 1 + Math.floor(Math.random() * Math.min(st.combo, 1 + st.aggr * 3.5));
    if (this.flurry > 0) { n = Math.max(n, 3); this.flurry = 0; }
    if (counter) n = Math.min(n, 2);
    const out = [];
    for (let i = 0; i < n; i++) out.push(i === 0 && !counter && Math.random() < 0.45 ? 'jab' : pick());
    return out;
  }

  startAttack(kind, { shadow = false, counter = false } = {}) {
    const side = { jab: 'L', cross: 'R', hookL: 'L', hookR: 'R', upperL: 'L', upperR: 'R', upper: Math.random() < 0.5 ? 'L' : 'R', body: Math.random() < 0.5 ? 'L' : 'R' }[kind];
    const sp = this.st.speed;
    const wind = ({ jab: 0.3, cross: 0.45, hookL: 0.5, hookR: 0.5, upper: 0.52, upperL: 0.52, upperR: 0.52, body: 0.42 }[kind]) * lerp(1.5, 0.65, sp) * (counter ? 0.6 : 1);
    const feint = !shadow && !counter && this.mode === 'fight' && Math.random() < 0.12 * this.st.aggr;
    this.atk = { kind, side, phase: 'wind', t: 0, wind, strike: lerp(0.2, 0.12, sp), aim: null, resolved: false, shadow, feint };
  }
  cancelAttack() {
    this.atk = null; this.plan = [];
    for (const s of ['L', 'R']) this.parts['lArm' + s]?.gloveMesh.material.emissive.setRGB(0, 0, 0);
  }
  runAttack(dt, ph) {
    const a = this.atk, s = a.side, side = s === 'L' ? -1 : 1, f = this.f, r = this.r;
    const head = this.headPos();
    a.t += dt;
    const glove = this.parts['lArm' + s].gloveMesh;
    const hook = a.kind.startsWith('hook'), upper = a.kind.startsWith('upper');
    // the tell: slow opponents glow brightly as they load up; the fast ones barely glow
    const glow = this.mode === 'coach' ? 1 : clamp(1.25 - this.st.speed * 0.9 + (this.dk < 1 ? 0.4 : 0), 0.15, 1);
    if (a.phase === 'wind') {
      const k = Math.min(1, a.t / a.wind);
      const back = { jab: 0.06, cross: 0.12, body: 0.06 }[a.kind] ?? 0.05;
      const low = upper ? 0.28 : a.kind === 'body' ? 0.12 : 0.04;
      const outw = hook ? 0.22 : 0.05;
      this.gloveGoal[s] = head.clone().addScaledVector(f, 0.18 - back * k).addScaledVector(r, side * (0.12 + outw * k)).add(V3(0, -0.08 - low * k, 0));
      if (!a.shadow) glove.material.emissive.setRGB(0.9 * k * glow, 0.35 * k * glow, 0);
      if (a.feint && k > 0.55) { this.atk = null; glove.material.emissive.setRGB(0, 0, 0); this.next = rnd(0.2, 0.5); return; }
      if (a.t >= a.wind) {
        a.phase = 'strike'; a.t = 0; a.from = this.glovePos(s);
        const target = a.shadow ? head.clone().addScaledVector(f, 0.75).add(V3(0, -0.05, 0)) : ph.clone();
        a.aim = target.add(V3(0, a.kind === 'body' ? -0.45 : -0.02, 0));
        a.ctrl = hook ? a.from.clone().lerp(a.aim, 0.5).addScaledVector(r, side * 0.35) : upper ? a.from.clone().lerp(a.aim, 0.5).add(V3(0, -0.2, 0)) : a.from.clone().lerp(a.aim, 0.5);
        a.headAtLock = ph.clone();
        sfx.whoosh();
      }
    } else if (a.phase === 'strike') {
      const k = Math.min(1, a.t / a.strike);
      const over = a.aim.clone().addScaledVector(a.aim.clone().sub(a.from).normalize(), 0.12);
      this.gloveGoal[s] = a.from.clone().multiplyScalar((1 - k) * (1 - k)).addScaledVector(a.ctrl, 2 * k * (1 - k)).addScaledVector(over, k * k);
      if (!a.shadow) glove.material.emissive.setRGB(glow, 0.45 * glow, 0.05);
      if (!a.resolved && !a.shadow) {
        const gp = this.glovePos(s);
        const target = a.kind === 'body' ? ph.clone().add(V3(0, -0.45, 0)) : ph;
        if (gp.distanceTo(target) < (a.kind === 'body' ? 0.22 : 0.17)) { a.resolved = true; this.onHitPlayer(a.kind, gp); if (this.opp.pattern === 'painter') this.flurry = 1; }
      }
      if (a.t >= a.strike + 0.06) {
        if (!a.resolved && !a.shadow) { a.resolved = true; this.onDodge({ kind: a.kind, moved: ph.clone().sub(a.headAtLock), at: ph.clone() }); }
        a.phase = 'recover'; a.t = 0;
      }
    } else {
      glove.material.emissive.setRGB(0, 0, 0);
      if (a.t > lerp(0.4, 0.2, this.st.speed)) { // gloves coming back up: that gap is your opening
        this.atk = null;
        if (this.plan.length) this.next = rnd(0.05, 0.15);
        else {
          // roughly 30-50 punches a round, more for aggressive fighters
          this.next = rnd(0.7, 1.3) * lerp(3.0, 1.0, this.st.aggr);
          if (this.opp.pattern === 'timer') { this.timerPhase = 0; this.next = rnd(2.5, 4); }
          if (this.flurry > 0) this.next = 0.1;
        }
      }
    }
  }
  blocked() {
    if (!this.atk || this.atk.phase !== 'strike' || this.atk.resolved || this.atk.shadow) return;
    this.atk.resolved = true; this.atk.phase = 'recover'; this.atk.t = 0;
    this.parts['lArm' + this.atk.side].gloveMesh.material.emissive.setRGB(0, 0, 0);
    this.plan = [];
    stats.blocks++; impact(this.glovePos(this.atk.side), 'block'); sfx.thump(0.7);
    this.onBlocked();
  }
  walkTo(p, dt, speed) {
    const d = V3(p.x - this.base.x, 0, p.z - this.base.z);
    const L = d.length(); if (L < 0.02) return;
    this.base.addScaledVector(d.normalize(), Math.min(L, speed * dt));
  }

  // ---- getting hit: speed, where it landed (weak spots), direction, built-up trauma
  // Light taps (cyan) do nothing. Clean hard shots to the chin, temple, liver or solar plexus do
  // extra, more so in the right direction. Head trauma and body pain build up and make later hits
  // count for more. Enough at once dazes him; a big clean one drops him.
  assess(part, pt, dir, speed, fist, isGlove) {
    const b = this.parts[part].body;
    const local = pt.clone().sub(readPos(b)).applyQuaternion(readQ(b).invert());
    const ldir = dir.clone().normalize().applyQuaternion(readQ(b).invert());
    let zone = part.startsWith('lArm') || part.startsWith('uArm') ? 'arm' : part.startsWith('thigh') || part.startsWith('shin') ? 'leg' : part === 'pelvis' ? 'low' : part === 'chest' ? 'body' : 'head', mult = MULT[part], weak = null;
    if (isGlove) { zone = 'glove'; mult = 0.05; }
    if (part === 'head') {
      if (local.y < 0.08 && local.z > 0.02) { weak = 'CHIN'; mult *= 1.3 + (ldir.y > 0.4 || ldir.z < -0.6 ? 0.15 : 0); }
      else if (Math.abs(local.x) > 0.055 && local.y > 0.06) { weak = 'TEMPLE'; mult *= 1.2 + (Math.abs(ldir.x) > 0.5 ? 0.1 : 0); }
    } else if (part === 'chest') {
      if (local.y < 0.12 && local.x < -0.04) { weak = 'LIVER'; mult *= 1.25 + (Math.abs(ldir.x) > 0.4 ? 0.15 : 0); }
      else if (local.y < 0.15 && Math.abs(local.x) < 0.06 && local.z > 0) { weak = 'SOLAR PLEXUS'; mult *= 1.2; }
    }
    if (speed < 3) return { dmg: 0, zone, weak, tier: zone === 'glove' ? 'block' : 'light' };
    // a typical real punch (5-7 m/s) does 4-9; it tops out at 10 before weak-spot bonuses
    const build = zone === 'head' ? Math.exp(this.trauma / 300) : zone === 'body' ? Math.exp(this.pain / 300) : 1;
    // chin softens or toughens every hit, but a glass jaw only takes up to ~25% extra
    const dmg = Math.min(10, (speed - 3) * 2.2) * mult * build * (fist.closed ? 1 : 0.35) / lerp(1, Math.max(0.4, this.st.chin), 0.6);
    const tier = zone === 'glove' ? 'block' : dmg < 3 ? 'light' : dmg < 7 ? 'solid' : dmg < 10.5 ? 'heavy' : 'huge';
    return { dmg, zone, weak, tier };
  }
  takeHit(part, pt, dir, speed, fist, isGlove) {
    if (!this.standing || this.hitCd > 0 || this.state === 'rest') return null;
    const res = this.assess(part, pt, dir, speed, fist, isGlove);
    this.hitCd = 0.2; // one hit per punch, however many steps the fist overlaps him
    const b = this.parts[part].body;
    if (bodyAlive(b)) b.applyImpulseAtPoint(dir.clone().normalize().multiplyScalar(Math.min(4.5, 0.8 + res.dmg * 0.3)), pt, true); // a snap, not a launch
    impact(pt, res.tier, res.weak && res.dmg >= 6 ? res.weak : null);
    if (res.tier === 'block' || res.dmg < 1) { if (res.tier === 'block') sfx.thump(0.4); return res; }
    this.flash = Math.min(1, res.dmg / 10);
    sfx.hit(Math.min(1, res.dmg / 12)); if (res.dmg > 5) sfx.grunt(Math.min(1, res.dmg / 14), 0.9);
    particles.emit('spark', pt, dir.clone().normalize(), 3 + Math.round(res.dmg / 2), 2);
    if (this.mode !== 'fight') return res; // dummy / coach never go down
    this.hp -= res.dmg; roundLog.player += res.dmg;
    if (res.zone === 'head') this.trauma += res.dmg; else if (res.zone === 'body') this.pain += res.dmg;
    this.tonus = Math.max(0.4, this.tonus - res.dmg * 0.035);
    if (this.atk?.phase === 'wind' && res.dmg > 4) { this.cancelAttack(); this.next = rnd(0.5, 0.9); popup('INTERRUPTED', pt, '#1f9a4a'); }
    cheer(res.dmg / 25);
    // knockdown: a huge clean shot, any solid shot while dazed, or nothing left in the tank
    const clean = res.weak === 'CHIN' || res.weak === 'TEMPLE' || res.weak === 'LIVER';
    // a one-punch knockdown needs a huge clean shot on a head (or body) that's already taken a beating
    if ((res.dmg >= 12 && clean && (this.trauma > 80 || this.pain > 80)) || (this.state === 'dizzy' && res.dmg >= 8) || (this.hp <= 0 && res.dmg >= 5)) { this.knockDown(res, dir); return res; }
    if (res.zone === 'head' && res.dmg > 8) { this.dizzy += res.dmg - 8; if (this.dizzy > 14) { this.state = 'dizzy'; this.dizzyT = rnd(2.5, 4); this.cancelAttack(); popup('DAZED', this.headPos().add(V3(0, 0.3, 0)), '#f0c020'); } }
    if (res.zone === 'body' && res.dmg > 10 && res.weak && this.pain > 50) { this.state = 'hurt'; this.hurtT = 1.2; this.cancelAttack(); sfx.grunt(1, 0.8); }
    // reacting to what landed: pause, back off, or cover the spot that got hit
    if (this.state === 'guard' && Math.random() < res.dmg / 14) {
      const r = Math.random();
      if (r < 0.35) { this.cancelAttack(); this.next = Math.max(this.next, 0.8); }
      else if (r < 0.7) this.retreatT = rnd(0.6, 1.4);
      else { this.cover = rnd(0.8, 1.6); this.coverZone = res.zone === 'body' ? 'body' : 'head'; }
    }
    if (res.dmg >= 9 && this.state === 'guard') { this.state = 'stagger'; this.staggerT = 0.35; this.cancelAttack(); }
    if (this.opp.pattern === 'painter' && res.dmg < 6) this.counterWin = 0.4 * this.st.counter;
    return res;
  }
  knockDown(res, dir) {
    this.state = 'down'; this.tonus = 0; this.downT = 0; this.knockdowns++; this.cancelAttack(); this.dizzy = 0;
    roundLog.oppDowns++;
    this.parts.chest.body.applyImpulseAtPoint(dir.clone().normalize().multiplyScalar(3), readPos(this.parts.chest.body), true);
    // how long he stays down: the harder the shot and the more damage built up, the longer
    this.getUpAt = clamp(3 + res.dmg / 4 + this.trauma / 90 + this.knockdowns * 1.5 - this.st.chin * 2 + (this.hp <= 0 ? 4 : 0), 3, 12);
    sfx.fanfare(); cheer(1); popup('DOWN!', this.headPos().add(V3(0, 0.4, 0)), '#d41f3a', 2);
    referee.start('opp', this.getUpAt);
  }
  getUp() {
    this.state = 'getup'; this.downT = 0; this.tonus = 0.15; this.cover = 2.5; this.coverZone = 'head'; this.retreatT = 2.5;
    this.hp = Math.max(this.hp, this.maxHp * 0.3);
  }
  snapToPose() {
    this.computePose();
    for (const [k, p] of Object.entries(this.parts)) { const t = this.pose[k]; p.body.setTranslation(t.p, true); p.body.setRotation(t.q, true); p.body.setLinvel({ x: 0, y: 0, z: 0 }, true); p.body.setAngvel({ x: 0, y: 0, z: 0 }, true); }
  }
  sync() {
    this.mat.emissive.setScalar(this.flash * 0.45);
    for (const p of Object.values(this.parts)) {
      if (!bodyAlive(p.body)) continue;
      const t = p.body.translation(), r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z); p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}
function ik2(root, goal, a, b, hint) {
  const dir = goal.clone().sub(root); let d = dir.length();
  dir.normalize();
  d = clamp(d, Math.abs(a - b) + 0.02, a + b - 0.005);
  const end = root.clone().addScaledVector(dir, d);
  const x = (a * a - b * b + d * d) / (2 * d), hgt = Math.sqrt(Math.max(0, a * a - x * x));
  const bend = hint.clone().addScaledVector(dir, -hint.dot(dir));
  if (bend.lengthSq() < 1e-6) bend.set(0, -1, 0).addScaledVector(dir, dir.y);
  bend.normalize();
  return { elbow: root.clone().addScaledVector(dir, x).addScaledVector(bend, hgt), end };
}

// ---------------------------------------------------------------- impact feedback
// an expanding ring at the hit point, coloured by how much it did (cyan = nothing, yellow =
// solid, orange = heavy, red = huge), plus the weak spot's name if one was hit
const IMPACT_COL = { light: 0x7fe7ff, block: 0x9aa3ae, solid: 0xffd54a, heavy: 0xff8a2a, huge: 0xff2a3a };
const impacts = [];
const ringGeo = new THREE.RingGeometry(0.03, 0.05, 12);
function impact(pt, tier, weak) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: IMPACT_COL[tier] || 0xffffff, transparent: true, depthTest: false, side: THREE.DoubleSide }));
  m.position.copy(pt); m.lookAt(camera.getWorldPosition(V3())); m.renderOrder = 998; scene.add(m);
  impacts.push({ m, t: 0, big: tier === 'huge' ? 2.2 : tier === 'heavy' ? 1.6 : 1 });
  if (weak) popup(weak + '!', pt.clone().add(V3(0, 0.18, 0)), '#' + new THREE.Color(IMPACT_COL[tier]).getHexString());
}
function updateImpacts(dt) {
  for (let i = impacts.length - 1; i >= 0; i--) {
    const p = impacts[i]; p.t += dt;
    const k = p.t / 0.25; p.m.scale.setScalar(1 + k * 3 * p.big); p.m.material.opacity = 1 - k;
    if (k >= 1) { scene.remove(p.m); p.m.material.dispose(); impacts.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- fists hitting boxers
let frameNo = 0, hitStop = 0;
function fistHit(f, info, pt, v, sp) {
  const bx = info.boxer;
  if (info.glove && bx.atk && bx.atk.phase === 'strike' && 'lArm' + bx.atk.side === info.part) { bx.blocked(); pulse(f.side, 0.6, 50); f.hitFrame = frameNo; return; }
  if (sp < 2) return;
  const res = bx.takeHit(info.part, pt, v, sp, f, !!info.glove);
  if (!res) return;
  f.hitFrame = frameNo;
  lastHit.zone = res.weak || res.zone; lastHit.dmg = res.dmg; lastHit.tier = res.tier;
  pulse(f.side, 0.3 + res.dmg / 30, 25 + res.dmg * 2);
  if (res.dmg > 1) hitStop = Math.min(0.07, 0.012 + res.dmg * 0.004);
  if (bx.mode === 'fight' && res.dmg > 1) {
    stats.landed++; stats.dmg += res.dmg; combo.n++; combo.t = 1.6; combo.best = Math.max(combo.best, combo.n);
    if (combo.n >= 3) popup(combo.n + ' HIT COMBO', pt.clone().add(V3(0, 0.3, 0)), '#f0a020');
  }
}
function processFistContacts() { // fist sensors overlapping boxer parts
  for (const f of fists) {
    if (!f.valid) continue;
    const v = punchVel(f);
    world.intersectionPairsWith(f.col, other => {
      const info = phys.info.get(other.handle);
      if (info && info.kind === 'boxer') fistHit(f, info, f.target.clone(), v, v.length());
    });
  }
}
const FIST_SWEEP = grp(G.PHAND, G.EALIVE);
function sweepFists() {
  for (const f of fists) {
    if (!f.valid || f.hitFrame === frameNo) continue;
    const seg = f.target.clone().sub(f.sweepFrom), len = seg.length();
    if (len < 0.03) continue;
    const v = punchVel(f), sp = v.length();
    if (sp < 2.5) continue;
    const dir = seg.clone().normalize();
    const side = Math.abs(dir.y) < 0.9 ? V3().crossVectors(dir, UP).normalize() : V3(1, 0, 0);
    const upv = V3().crossVectors(side, dir);
    let best = null;
    for (const off of [V3(), side.clone().multiplyScalar(0.04), upv.clone().multiplyScalar(-0.04)]) {
      const o = f.sweepFrom.clone().add(off);
      const hit = world.castRay(new RAPIER.Ray(o, dir), len, true, undefined, FIST_SWEEP);
      if (hit && (!best || hit.timeOfImpact < best.toi)) best = { toi: hit.timeOfImpact, col: hit.collider, o };
    }
    if (!best) continue;
    const info = phys.info.get(best.col.handle);
    if (info && info.kind === 'boxer') fistHit(f, info, best.o.clone().addScaledVector(dir, best.toi), v, sp);
  }
}

// ---------------------------------------------------------------- you getting hit
const hurtSphere = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd41f3a, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false }));
hurtSphere.renderOrder = 999; camera.add(hurtSphere);
const blackout = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false }));
blackout.renderOrder = 1001; camera.add(blackout);
function hurtPlayer(bx, kind, at) {
  if (game.state !== 'fight' || player.down) return;
  const base = { jab: 6, cross: 10, hookL: 11, hookR: 11, upper: 13, body: 8 }[kind];
  const dmg = base * bx.st.power * (bx.state === 'dizzy' ? 0.5 : 1) * (0.85 + Math.random() * 0.3);
  player.hp = Math.max(0, player.hp - dmg); player.flash = 1; player.dizzy = Math.min(1, player.dizzy + dmg / 35);
  roundLog.opp += dmg;
  stats.taken++; sfx.hurt(); sfx.hit(0.7); combo.n = 0;
  pulse('left', 0.8, 120); pulse('right', 0.8, 120);
  popup('-' + Math.round(dmg), at, '#d41f3a');
  cheer(dmg / 40);
  if (player.hp <= 0 || (kind.startsWith('upper') && dmg > 18 && player.dizzy > 0.7)) playerDown();
}
function playerDown() {
  player.down = true; player.knockdowns++; roundLog.youDowns++;
  referee.start('you', clamp(4 + player.knockdowns * 1.5 + Math.random() * 2, 4, 9));
  sfx.fanfare(); cheer(1);
  boxer.state = 'corner'; boxer.cancelAttack();
}
function onDodge() { stats.dodges++; popup('DODGE', player.head.clone().add(V3(0, 0.25, -0.4)), '#1f9a4a'); sfx.chime(1); }

// ---------------------------------------------------------------- the referee's count
let blackoutTarget = 0;
const referee = {
  who: null, t: 0, upAt: 0, n: 0,
  start(who, upAt) { this.who = who; this.t = 0; this.upAt = upAt; this.n = 0; },
  say(n) { try { const u = new SpeechSynthesisUtterance(String(n)); u.rate = 1.1; u.pitch = 0.8; speechSynthesis.speak(u); } catch (e) { sfx.beep(); } },
  update(dt) {
    if (!this.who) return;
    this.t += dt;
    const n = Math.floor(this.t);
    if (n > this.n && n <= 10) { this.n = n; this.say(n); popup(String(n), this.who === 'you' ? player.head.clone().add(camera.getWorldDirection(V3()).multiplyScalar(0.8)) : boxer.headPos().add(V3(0, 0.5, 0)), '#ffffff', 2.5); }
    if (this.who === 'opp') {
      if (this.upAt < 10 && this.t >= this.upAt && boxer.state === 'down') boxer.getUp();
      if (boxer.knockdowns >= 3 && this.t > 2) { this.who = null; boxer.state = 'ko'; endFight('win', 'T.K.O.'); }
      // mandatory eight count; still not up at ten is a knockout
      else if (this.n >= 8 && boxer.state === 'guard') { this.who = null; boxer.retreatT = 1.5; popup('FIGHT!', boxer.headPos().add(V3(0, 0.4, 0)), '#d41f3a', 1.5); bell(1); }
      else if (this.n >= 10 && !boxer.standing) { this.who = null; boxer.state = 'ko'; endFight('win', 'K.O.'); }
    } else {
      blackoutTarget = this.t < this.upAt ? 0.92 : 0;
      if (this.t >= this.upAt && this.n >= 8) {
        if (player.knockdowns >= 3) { this.who = null; endFight('lose', 'T.K.O.'); return; }
        this.who = null; player.down = false; player.hp = Math.max(25, 70 - player.knockdowns * 15); player.dizzy = 0.5;
        boxer.state = 'guard'; bell(1);
      }
    }
  },
};

// ---------------------------------------------------------------- floating text
const popups = [];
function popup(text, pos, color = '#ffffff', scale = 1) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.font = 'bold 40px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = '#000a'; g.strokeText(text, 128, 32); g.fillStyle = color; g.fillText(text, 128, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  s.scale.set(0.4 * scale, 0.1 * scale, 1); s.position.copy(pos); s.renderOrder = 1000; scene.add(s);
  popups.push({ s, t: 0 });
}
function updatePopups(dt) {
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i]; p.t += dt; p.s.position.y += dt * 0.3; p.s.material.opacity = 1 - p.t / 1.1;
    if (p.t > 1.1) { scene.remove(p.s); p.s.material.map.dispose(); p.s.material.dispose(); popups.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- punch classification + workout
const stats = { thrown: 0, landed: 0, dmg: 0, taken: 0, blocks: 0, dodges: 0, squats: 0, speedSum: 0, kcal: 0, time: 0 };
const combo = { n: 0, t: 0, best: 0 };
const squat = { down: false };
const lastPunch = { name: '-', speed: 0, best: 0 };
const lastHit = { zone: '-', dmg: 0, tier: 'light' };
function facingFrame() {
  const fw = camera.getWorldDirection(V3()).setY(0);
  if (fw.lengthSq() < 1e-4) fw.set(0, 0, -1);
  fw.normalize();
  return { fw, rt: V3(-fw.z, 0, fw.x) };
}
function classify(f, p) {
  const d = p.vel.clone().normalize(), { fw, rt } = facingFrame();
  const fwd = d.dot(fw), up = d.y, inward = d.dot(rt) * (f.side === 'left' ? 1 : -1);
  const lead = f.side === 'left';
  const low = p.pos.y < p.head.y - 0.42;
  let type;
  if (up > 0.55) type = lead ? 'lead uppercut' : 'rear uppercut';
  else if (inward > 0.5 && fwd < 0.8) type = lead ? 'lead hook' : 'rear hook';
  else if (fwd > 0.45) type = lead ? 'jab' : 'cross';
  else type = 'swing';
  return { type, low, name: low && type !== 'swing' && !type.includes('upper') ? 'body ' + (type.includes('hook') ? 'hook' : 'shot') : type };
}
function trackPunches(dt) {
  stats.time += dt;
  for (const f of fists) {
    if (!f.valid) { f.punch = null; f.armed = true; continue; }
    const v = punchVel(f); let st = { sp: v.length(), vel: v, pos: f.target.clone() };
    if (f.intent) { const isp = f.intent.vel.length(); if (isp > st.sp) st = { sp: isp, vel: f.intent.vel.clone(), pos: f.intent.pos.clone() }; f.intent = null; }
    const sp = st.sp;
    const outward = sp > 0 && st.vel.dot(st.pos.clone().sub(player.head).normalize()) > 0.3 * sp;
    if (f.armed && sp > 2.5 && outward) { f.armed = false; f.punch = { peak: sp, vel: st.vel, pos: st.pos, head: player.head.clone() }; stats.thrown++; }
    if (!f.armed && f.punch) {
      if (sp > f.punch.peak) { f.punch.peak = sp; f.punch.vel = st.vel; f.punch.pos = st.pos; }
      if (sp < 1.4) {
        f.armed = true;
        const p = f.punch; f.punch = null;
        stats.speedSum += p.peak; stats.kcal += 0.12 + p.peak * 0.03;
        const c = classify(f, p);
        lastPunch.name = c.name; lastPunch.speed = p.peak; lastPunch.best = Math.max(lastPunch.best, p.peak);
        trainer.onPunch(f, c, p);
      }
    }
  }
  player.standY = Math.max(player.head.y, player.standY - dt * 0.01);
  if (!squat.down && player.head.y < player.standY - 0.22) { squat.down = true; stats.squats++; stats.kcal += 0.3; }
  if (squat.down && player.head.y > player.standY - 0.1) squat.down = false;
  stats.kcal += dt * 0.07;
  combo.t -= dt; if (combo.t <= 0) combo.n = 0;
}

// ---------------------------------------------------------------- UI: boards and buttons
// Buttons are physical: poke them with a fingertip or punch them with a fist (or click on
// desktop). They light up as a hand comes near and click in when pressed.
const UI = { accent: '#d41f3a', text: '#ffffff', dim: '#ffffffa0' };
function makeBoard(w, h, cw, ch, pos, yaw = 0) {
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  mesh.position.copy(pos); mesh.rotation.y = yaw; scene.add(mesh);
  return { c, g: c.getContext('2d'), tex, mesh };
}
function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function panel(b, title, sub) {
  const { g, c } = b; g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(20,24,33,.94)'; rrect(g, 0, 0, c.width, c.height, 28); g.fill();
  g.fillStyle = UI.accent; g.fillRect(28, 0, c.width - 56, 8);
  if (title) { g.fillStyle = UI.text; g.textAlign = 'left'; g.font = 'bold 44px system-ui'; g.fillText(title, 36, 70); }
  if (sub) { g.fillStyle = UI.dim; g.font = '26px system-ui'; g.fillText(sub, 36, 108); }
}
function wrap(g, text, x, y, w, lh) {
  let line = '';
  for (const word of text.split(' ')) { const t = line ? line + ' ' + word : word; if (g.measureText(t).width > w && line) { g.fillText(line, x, y); y += lh; line = word; } else line = t; }
  if (line) g.fillText(line, x, y);
  return y + lh;
}
const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

const buttons = [];
class Button {
  constructor({ label, sub = '', w = 0.32, h = 0.15, color = '#2c3442', pos, yaw = 0, pitch = 0, onPress, visible = () => true, big = false }) {
    Object.assign(this, { label, sub, w, h, color, onPress, visible, hover: 0, cd: 0, push: 0, big });
    this.c = document.createElement('canvas'); this.c.width = 512; this.c.height = Math.round(512 * h / w);
    this.tex = new THREE.CanvasTexture(this.c);
    const face = new THREE.MeshBasicMaterial({ map: this.tex });
    const side = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.6) });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), [side, side, side, side, face, side]);
    this.root = new THREE.Group(); this.root.position.copy(pos); this.root.rotation.set(pitch, yaw, 0, 'YXZ');
    this.root.add(this.mesh); scene.add(this.root);
    this.mesh.userData.button = this; buttons.push(this); this.prevZ = {};
    this.draw();
  }
  setLabel(label, sub = this.sub) { if (label !== this.label || sub !== this.sub) { this.label = label; this.sub = sub; this.draw(); } }
  draw() {
    const g = this.c.getContext('2d'), W = this.c.width, H = this.c.height, hv = this.hover;
    g.clearRect(0, 0, W, H);
    g.fillStyle = this.color; rrect(g, 0, 0, W, H, 26); g.fill();
    if (hv > 0) { g.fillStyle = `rgba(255,255,255,${0.2 * hv})`; rrect(g, 0, 0, W, H, 26); g.fill(); g.lineWidth = 10; g.strokeStyle = `rgba(255,255,255,${0.85 * hv})`; rrect(g, 5, 5, W - 10, H - 10, 22); g.stroke(); }
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const fs = this.big ? 62 : Math.min(52, Math.round(H * 0.42));
    g.font = `bold ${fs}px system-ui`;
    g.fillText(this.label, W / 2, this.sub ? H * 0.42 : H / 2);
    if (this.sub) { g.font = `${Math.round(fs * 0.48)}px system-ui`; g.fillStyle = '#ffffffc8'; g.fillText(this.sub, W / 2, H * 0.74); }
    this.tex.needsUpdate = true;
  }
  press() {
    if (this.cd > 0 || !this.root.visible) return;
    this.cd = 0.5; this.push = 1; sfx.thump(0.5); sfx.chime(1.3);
    for (const f of fists) pulse(f.side, 0.4, 30);
    this.onPress();
  }
  update(dt, pointers) {
    this.cd -= dt; this.root.visible = this.visible();
    let hv = 0;
    if (this.root.visible) {
      this.root.updateMatrixWorld();
      const inv = this.root.matrixWorld.clone().invert();
      for (const [id, p] of pointers) {
        const l = p.clone().applyMatrix4(inv);
        const inside = Math.abs(l.x) < this.w / 2 + 0.02 && Math.abs(l.y) < this.h / 2 + 0.02;
        if (inside && l.z < 0.14 && l.z > -0.1) hv = Math.max(hv, 1 - Math.max(0, l.z) / 0.14);
        // pressed when a hand pushes through the face from the front
        if (inside && this.prevZ[id] !== undefined && this.prevZ[id] > 0.015 && l.z <= 0.015) this.press();
        this.prevZ[id] = inside && l.z > -0.1 ? l.z : undefined;
      }
    } else this.prevZ = {};
    if (Math.abs(hv - this.hover) > 0.08 || (hv === 0 && this.hover !== 0)) { this.hover = hv; this.draw(); }
    this.push = Math.max(0, this.push - dt * 4);
    this.mesh.position.z = -0.025 * this.push + 0.012 * this.hover;
  }
}
function uiPointers() {
  const ps = [];
  for (const f of fists) { if (!f.valid) continue; ps.push([f.side, f.target]); if (f.tip) ps.push([f.side + 'tip', f.tip]); }
  return ps;
}

// ---------------------------------------------------------------- technique trainer
const TECH = [
  { name: 'Jab', kind: 'punch', want: c => c.type === 'jab' && !c.low, demo: 'jab', tip: 'Lead (left) hand straight out from your chin, and snap it straight back. Fast, not hard.' },
  { name: 'Cross', kind: 'punch', want: c => c.type === 'cross' && !c.low, demo: 'cross', tip: 'Rear (right) hand straight down the middle. Turn your back hip and heel so the whole body throws it.' },
  { name: 'Lead hook', kind: 'punch', want: c => c.type === 'lead hook', demo: 'hookL', tip: 'Left elbow up level with the fist, arm bent about 90°. Pivot on the front foot and swing across, not out.' },
  { name: 'Rear hook', kind: 'punch', want: c => c.type === 'rear hook', demo: 'hookR', tip: 'Same shape with the right hand: elbow up, rotate the hips and shoulders together.' },
  { name: 'Lead uppercut', kind: 'punch', want: c => c.type === 'lead uppercut', demo: 'upperL', tip: 'Dip a little, then drive up from the legs. The fist travels up under the chin line.' },
  { name: 'Rear uppercut', kind: 'punch', want: c => c.type === 'rear uppercut', demo: 'upperR', tip: 'Drop the right shoulder slightly and rise through it. Short and tight, no wind-up.' },
  { name: 'Body shot', kind: 'punch', want: c => c.low && c.type !== 'swing', demo: 'body', tip: 'Bend your knees to get level with the stomach, then punch. Don’t just reach down with the arm.' },
  { name: 'High guard', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'jab' : 'cross'), demo: 'block', tip: 'Both fists up by your cheeks, elbows in. Let his glove land on your gloves. Eyes on him.', ok: e => e.type === 'blocked' || (e.type === 'hit' && guardUp()) },
  { name: 'Slip', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'jab' : 'cross'), demo: 'slip', tip: 'As the straight comes, move your head a few inches to the side by bending knees and waist. Small and quick.', ok: e => e.type === 'dodge' && Math.abs(e.moved.dot(facingFrame().rt)) > 0.09 },
  { name: 'Duck', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'hookL' : 'hookR'), demo: 'duck', tip: 'Under a hook: bend the knees, not your back, and drop your head below it. Hands stay up.', ok: e => e.type === 'dodge' && e.moved.y < -0.14 },
  { name: 'Roll (bob & weave)', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'hookL' : 'hookR'), demo: 'roll', tip: 'Duck in a U under the hook: down, across, and back up on the other side, ready to punch.', ok: e => e.type === 'dodge' && e.moved.y < -0.1 && Math.abs(e.moved.dot(facingFrame().rt)) > 0.06 },
  { name: 'Parry', kind: 'defend', attack: () => 'jab', demo: 'parry', tip: 'Tap his incoming jab aside with your glove. A small slap is enough to knock it off line.', ok: e => e.type === 'blocked' },
];
function guardUp() {
  const h = player.head, { fw } = facingFrame();
  return fists.every(f => f.valid && f.target.distanceTo(h) < 0.32 && f.target.clone().sub(h).dot(fw) > 0.02);
}
const trainer = {
  idx: 0, phase: 'demo', t: 0, reps: 0, goal: 5, done: new Set(), msg: '', msgT: 0, nextAtk: 0, demoN: 0,
  select(i) { this.idx = (i + TECH.length) % TECH.length; this.phase = 'demo'; this.t = 0; this.reps = 0; this.demoN = 0; if (coach) { coach.cancelAttack(); coach.wantPos = null; coach.demo = null; coach.holdDuck = false; } this.say(''); },
  say(m, ok) { this.msg = m; this.msgT = 1.6; this.msgOk = ok; },
  get tech() { return TECH[this.idx]; },
  update(dt) {
    const T = this.tech; this.t += dt; this.msgT -= dt;
    const ph = player.head;
    if (this.phase === 'demo') {
      coach.wantPos = null;
      if (T.kind === 'punch') { coach.demo = null; if (!coach.atk && this.t > 1.0) { coach.startAttack(T.demo, { shadow: true }); this.t = 0; this.demoN++; } }
      else coach.demo = (dt, c) => defenceDemo(T.demo, c, this.t);
      if (this.demoN >= 3 || (T.kind === 'defend' && this.t > 5)) { this.phase = 'try'; this.t = 0; coach.demo = null; coach.duck = 0; coach.slip = 0; coach.holdDuck = false; this.say('YOUR TURN'); }
    } else if (this.phase === 'try') {
      if (T.kind === 'defend') {
        const dir = V3(coach.home.x - ph.x, 0, coach.home.z - ph.z).normalize();
        coach.wantPos = V3(ph.x, 0, ph.z).addScaledVector(dir, 0.72);
        if (!coach.atk && V3(coach.base.x - coach.wantPos.x, 0, coach.base.z - coach.wantPos.z).length() < 0.12) { this.nextAtk -= dt; if (this.nextAtk <= 0) { coach.startAttack(T.attack()); this.nextAtk = 1.6; } }
      } else coach.wantPos = null;
      if (this.reps >= this.goal) { this.phase = 'done'; this.done.add(this.idx); coach.wantPos = null; coach.cancelAttack(); sfx.fanfare(); this.say('NICE WORK!', true); }
    }
  },
  onPunch(f, c) {
    if (mode !== 'train' || this.phase !== 'try' || this.tech.kind !== 'punch') return;
    if (this.tech.want(c)) { this.reps++; this.say('✓ ' + c.name.toUpperCase(), true); sfx.chime(1 + this.reps * 0.2); }
    else this.say('that was a ' + c.name + ', try again');
  },
  onDefence(e) {
    if (mode !== 'train' || this.phase !== 'try' || this.tech.kind !== 'defend') return;
    if (this.tech.ok(e)) { this.reps++; this.say('✓ ' + this.tech.name.toUpperCase(), true); sfx.chime(1 + this.reps * 0.2); }
    else this.say(e.type === 'hit' ? 'got you, try again' : e.type === 'blocked' ? 'blocked, but try the ' + this.tech.name.toLowerCase() : 'missed you, but not with a ' + this.tech.name.toLowerCase());
  },
  draw(b) {
    const { g } = b, T = this.tech;
    panel(b, T.name.toUpperCase() + (this.done.has(this.idx) ? '  ✓' : ''), (T.kind === 'punch' ? 'PUNCH' : 'DEFENCE') + '  ·  ' + (this.idx + 1) + ' of ' + TECH.length + '  ·  ' + this.done.size + ' mastered');
    g.textAlign = 'left'; g.font = '30px system-ui'; g.fillStyle = '#fff';
    const y = wrap(g, T.tip, 36, 170, 696, 40);
    g.font = 'bold 36px system-ui'; g.fillStyle = this.phase === 'done' ? '#5be37d' : '#4fc3ff';
    const status = this.phase === 'demo' ? '1. Watch the coach' : this.phase === 'try' ? (T.kind === 'punch' ? '2. Your turn: throw it (at the air is fine)' : '2. Your turn: he’ll throw slowly at you') : '✓ Done! Press NEXT';
    g.fillText(status, 36, Math.max(y + 20, 380));
    for (let i = 0; i < this.goal; i++) { g.fillStyle = i < this.reps ? '#1f9a4a' : '#ffffff22'; rrect(g, 36 + i * 80, 420, 66, 30, 8); g.fill(); }
    if (this.msgT > 0 && this.msg) { g.font = 'bold 38px system-ui'; g.fillStyle = this.msgOk ? '#5be37d' : '#ff8a8a'; g.fillText(this.msg, 36, 512); }
    b.tex.needsUpdate = true;
  },
};
function defenceDemo(kind, c, t) {
  const cyc = t % 1.8, k = Math.sin(Math.min(1, cyc / 0.9) * Math.PI);
  const headC = c.pose.head.p.clone().add(V3(0, 0.12, 0));
  c.duck = 0; c.slip = 0; c.holdDuck = true;
  if (kind === 'block') { for (const s of ['L', 'R']) c.gloveGoal[s] = headC.clone().addScaledVector(c.f, 0.13).addScaledVector(c.r, (s === 'L' ? -1 : 1) * 0.07).add(V3(0, 0.02 * k, 0)); }
  else if (kind === 'slip') c.slip = (Math.floor(t / 1.8) % 2 ? 1 : -1) * 0.14 * k;
  else if (kind === 'duck') c.duck = 0.26 * k;
  else if (kind === 'roll') { const u = Math.min(1, cyc / 1.1); c.duck = 0.24 * Math.sin(u * Math.PI); c.slip = 0.13 * Math.cos(u * Math.PI); }
  else if (kind === 'parry') c.gloveGoal.R = headC.clone().addScaledVector(c.f, 0.3).addScaledVector(c.r, -0.18 * k + 0.08).add(V3(0, -0.04, 0));
}

// ---------------------------------------------------------------- squat gauntlet
// Red bars sweep in at head height: squat under them. Blue walls come from one side: lean the
// other way. Yellow pads float in: punch them before they pass. Scaled to your height.
const gauntlet = { active: false, t: 0, len: 75, score: 0, streak: 0, best: 0, ducked: 0, missed: 0, punched: 0, items: [], next: 0, over: false };
const barMat = new THREE.MeshLambertMaterial({ color: 0xff3355, emissive: 0x661020 });
const wallMat = new THREE.MeshLambertMaterial({ color: 0x4fc3ff, emissive: 0x103a55, transparent: true, opacity: 0.85 });
const padMat = new THREE.MeshLambertMaterial({ color: 0xf0c020, emissive: 0x4a3a00 });
function gauntletClear() { gauntlet.items.forEach(i => scene.remove(i.m)); gauntlet.items = []; }
function gauntletStart() { gauntletClear(); Object.assign(gauntlet, { active: true, t: 0, score: 0, streak: 0, ducked: 0, missed: 0, punched: 0, next: 2, over: false }); bell(1); }
function gauntletSpawn() {
  const difficulty = Math.min(1, gauntlet.t / gauntlet.len);
  const r = Math.random(), eye = body.eye;
  let it;
  if (r < 0.5) { // a bar to squat under: its bottom edge sits well below your standing eye line
    const bottom = eye - 0.22 - 0.1 * difficulty;
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 0.16), barMat); m.position.set(SQUAT_C.x, bottom + 0.08, SQUAT_C.z - 10);
    it = { kind: 'duck', m, bottom };
  } else if (r < 0.75) { // a wall from one side: lean or step the other way
    const side = Math.random() < 0.5 ? -1 : 1;
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 0.14), wallMat); m.position.set(SQUAT_C.x + side * 0.5, eye - 0.15, SQUAT_C.z - 10);
    it = { kind: 'wall', m, side };
  } else { // a pad to punch
    const x = rnd(-0.25, 0.25), y = eye - rnd(0.2, 0.45);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 10).rotateX(Math.PI / 2), padMat); m.position.set(SQUAT_C.x + x, y, SQUAT_C.z - 10);
    it = { kind: 'pad', m };
  }
  it.speed = lerp(3.2, 5.5, difficulty); scene.add(it.m); gauntlet.items.push(it);
  gauntlet.next = lerp(1.7, 0.85, difficulty) * rnd(0.85, 1.15);
}
function gauntletScore(ok, label, at) {
  if (ok) { gauntlet.streak++; gauntlet.best = Math.max(gauntlet.best, gauntlet.streak); gauntlet.score += 10 * Math.min(5, 1 + Math.floor(gauntlet.streak / 5)); popup(label, at, '#5be37d'); sfx.chime(1 + Math.min(1, gauntlet.streak * 0.05)); }
  else { gauntlet.streak = 0; gauntlet.missed++; popup(label, at, '#ff6a6a'); sfx.hurt(); player.flash = 0.8; }
}
function updateGauntlet(dt) {
  if (!gauntlet.active) return;
  gauntlet.t += dt;
  if (gauntlet.t < gauntlet.len) { gauntlet.next -= dt; if (gauntlet.next <= 0) gauntletSpawn(); }
  else if (!gauntlet.items.length) { gauntlet.over = true; gauntlet.active = false; bell(3); sfx.fanfare(); }
  const h = player.head, pz = SQUAT_C.z;
  for (let i = gauntlet.items.length - 1; i >= 0; i--) {
    const it = gauntlet.items[i];
    const z0 = it.m.position.z; it.m.position.z += it.speed * dt;
    if (it.kind === 'pad') {
      for (const f of fists) if (f.valid && !it.hit && f.target.distanceTo(it.m.position) < 0.16 && punchVel(f).length() > 1.8) { it.hit = true; gauntlet.punched++; gauntletScore(true, 'POW', it.m.position.clone()); sfx.hit(0.6); particles.emit('spark', it.m.position, null, 8, 2); }
      if (it.hit) { scene.remove(it.m); gauntlet.items.splice(i, 1); continue; }
    }
    if (!it.judged && z0 < pz && it.m.position.z >= pz) {
      it.judged = true;
      if (it.kind === 'duck') { const ok = h.y < it.bottom - 0.04; if (ok) gauntlet.ducked++; gauntletScore(ok, ok ? 'UNDER!' : 'BONK', h.clone().add(V3(0, 0.3, -0.5))); }
      else if (it.kind === 'wall') { const ok = (h.x - SQUAT_C.x) * it.side < -0.08; gauntletScore(ok, ok ? 'DODGED' : 'BONK', h.clone().add(V3(0, 0.3, -0.5))); }
      else gauntletScore(false, 'MISSED PAD', it.m.position.clone());
    }
    if (it.m.position.z > pz + 2) { scene.remove(it.m); gauntlet.items.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- modes, fights, rounds
const ROUND_LEN = 120, REST = 30;
const game = { state: 'menu', clock: 0, round: 1, rounds: 3, cards: [], result: null };
let roundLog = { player: 0, opp: 0, youDowns: 0, oppDowns: 0 };
let mode = 'hub', paused = false, menuPage = 'main', oppIdx = 0;
let boxer = null, dummy = null, coach = null;

async function buildGymBoxers() {
  const M = await modelFor(heightFromEye(body.eye));
  dummy?.remove(); coach?.remove();
  dummy = new Boxer(M, { mode: 'dummy', at: V3(1.3, 0, -0.75).add(HUB_C), yaw: Math.atan2(-1.3, 0.75), glove: 0x888888, tint: 0xb8c4d6 });
  coach = new Boxer(M, { mode: 'coach', at: V3(0, 0, -1.4).add(TRAIN_C), yaw: 0, glove: 0xd41f3a });
  coach.onHitPlayer = (kind, at) => { popup('HIT', at, '#d41f3a'); sfx.thump(0.6); trainer.onDefence({ type: 'hit' }); };
  coach.onDodge = info => trainer.onDefence({ type: 'dodge', moved: info.moved });
  coach.onBlocked = () => trainer.onDefence({ type: 'blocked' });
}
function moveTo(c) { dolly.position.copy(c); for (const f of fists) { f.valid = false; f.kf.init = false; } }
async function startFight(i) {
  oppIdx = i; const opp = OPPONENTS[i];
  mode = 'fight'; paused = false; moveTo(RING_C);
  const M = await modelFor(heightFromEye(body.eye));
  boxer?.remove(); boxer = new Boxer(M, { mode: 'fight', opp, diff: save.diff, at: V3(0, 0, -2).add(RING_C) });
  Object.assign(player, { hp: 100, down: false, knockdowns: 0, dizzy: 0 });
  game.state = 'intro'; game.clock = 4; game.round = 1; game.rounds = opp.rounds; game.cards = []; game.result = null;
  roundLog = { player: 0, opp: 0, youDowns: 0, oppDowns: 0 };
  combo.n = 0; referee.who = null; cheer(0.6);
}
function toGym() {
  mode = 'hub'; paused = false; menuPage = 'main'; moveTo(HUB_C);
  boxer?.remove(); boxer = null; referee.who = null; blackoutTarget = 0; player.down = false;
  gauntlet.active = false; gauntletClear();
}
function toTraining() { mode = 'train'; paused = false; moveTo(TRAIN_C); trainer.select(trainer.idx); }
function toSquat() { mode = 'squat'; paused = false; moveTo(SQUAT_C); gauntlet.over = false; gauntlet.active = false; gauntletClear(); }
function bell(n = 1) { for (let i = 0; i < n; i++) setTimeout(() => sfx.bell(), i * 280); }
// 10-point must: the round goes to whoever did more damage; each knockdown costs a point
function scoreRound() {
  let you = 10, opp = 10;
  if (roundLog.player > roundLog.opp * 1.05) opp = 9; else if (roundLog.opp > roundLog.player * 1.05) you = 9;
  you -= roundLog.youDowns; opp -= roundLog.oppDowns;
  game.cards.push([you, opp]); roundLog = { player: 0, opp: 0, youDowns: 0, oppDowns: 0 };
}
function endFight(result, how) {
  game.state = 'over'; game.result = { result, how };
  boxer.cancelAttack();
  if (result === 'win') { if (oppIdx + 1 >= save.unlocked) { save.unlocked = Math.min(OPPONENTS.length, oppIdx + 2); persist(); } cheer(1); sfx.fanfare(); }
  bell(3);
}
function updateGame(dt) {
  if (mode === 'train') { trainer.update(dt); return; }
  if (mode === 'squat') { updateGauntlet(dt); return; }
  if (mode !== 'fight') return;
  referee.update(dt);
  if (game.state === 'intro') { game.clock -= dt; if (game.clock <= 0) { game.state = 'fight'; game.clock = ROUND_LEN; bell(1); popup('FIGHT!', V3(0, 2, -1.2).add(RING_C), '#d41f3a', 2); } }
  else if (game.state === 'fight') {
    if (!referee.who) game.clock -= dt;
    player.hp = Math.min(100, player.hp + dt * 0.4); player.dizzy = Math.max(0, player.dizzy - dt * 0.12);
    if (game.clock <= 0 && !referee.who) {
      scoreRound();
      if (game.round >= game.rounds) {
        const t = game.cards.reduce((a, [y, o]) => [a[0] + y, a[1] + o], [0, 0]);
        endFight(t[0] > t[1] ? 'win' : t[0] < t[1] ? 'lose' : 'draw', 'DECISION ' + t[0] + '-' + t[1]);
      } else { game.state = 'rest'; game.clock = REST; boxer.state = 'rest'; boxer.cancelAttack(); bell(3); }
    }
  } else if (game.state === 'rest') {
    game.clock -= dt; player.hp = Math.min(100, player.hp + dt * 1.5); player.dizzy = 0;
    if (game.clock <= 0) nextRound();
  }
}
function nextRound() { game.round++; game.state = 'fight'; game.clock = ROUND_LEN; boxer.state = 'guard'; boxer.knockdowns = 0; player.knockdowns = 0; bell(1); }
function togglePause() { if (mode === 'hub') return; paused = !paused; }

// ---------------------------------------------------------------- boards and buttons
const mainBoard = makeBoard(1.4, 0.4, 900, 257, V3(0, 2.0, -1.2).add(HUB_C));
const oppBoard = makeBoard(1.25, 0.8, 900, 576, V3(0, 1.9, -1.2).add(HUB_C));
const dummyBoard = makeBoard(0.7, 0.38, 560, 304, V3(1.3, 2.15, -0.95).add(HUB_C), -1.05);
const workoutBoard = makeBoard(0.7, 0.86, 512, 630, V3(-1.4, 1.6, -0.5).add(HUB_C), 1.05);
const trainBoard = makeBoard(1.2, 0.84, 768, 540, V3(0.95, 1.85, -1.15).add(TRAIN_C), -0.5);
const squatBoard = makeBoard(1.1, 0.7, 768, 490, V3(-1.0, 2.0, -1.2).add(SQUAT_C), 0.45);
const ringBoard = makeBoard(2.4, 1.2, 1024, 512, V3(0, 3.1, -RING - 0.6).add(RING_C));
const pauseBoard = makeBoard(0.8, 0.3, 640, 240, V3(), 0);

// main menu: four big tiles at chest height, tilted up toward you
const tile = (label, sub, color, x, onPress) => new Button({ label, sub, color, w: 0.32, h: 0.22, big: true, pos: V3(x, 1.25, -0.6).add(HUB_C), pitch: -0.5, onPress, visible: () => mode === 'hub' && menuPage === 'main' });
const menuTiles = [
  tile('FIGHT', 'career', '#d41f3a', -0.525, () => { menuPage = 'opp'; oppIdx = Math.min(save.unlocked - 1, oppIdx); }),
  tile('TRAIN', 'technique coach', '#2a5bd7', -0.175, () => toTraining()),
  tile('SQUAT', 'gauntlet', '#1f9a4a', 0.175, () => toSquat()),
  tile('HEIGHT', '', '#3a4150', 0.525, () => measureHeight()),
];
const oppBtn = (label, color, x, y, w, onPress) => new Button({ label, color, w, h: 0.12, pos: V3(x, 1.25 + y, -0.62).add(HUB_C), pitch: -0.5, onPress, visible: () => mode === 'hub' && menuPage === 'opp' });
const oppButtons = [
  oppBtn('◀', '#2c3442', -0.5, 0.04, 0.15, () => { oppIdx = (oppIdx + OPPONENTS.length - 1) % OPPONENTS.length; }),
  oppBtn('▶', '#2c3442', 0.5, 0.04, 0.15, () => { oppIdx = (oppIdx + 1) % OPPONENTS.length; }),
  oppBtn('FIGHT!', '#d41f3a', 0, 0.04, 0.36, () => { if (oppIdx < save.unlocked) startFight(oppIdx); else sfx.beep(); }),
  oppBtn('← BACK', '#3a4150', -0.27, -0.12, 0.22, () => { menuPage = 'main'; }),
  oppBtn('Normal', '#3a4150', 0.27, -0.12, 0.22, () => { save.diff = (save.diff + 1) % DIFFS.length; persist(); }),
];
const backBtn = (c, x, vis) => new Button({ label: '← GYM', color: '#3a4150', w: 0.22, h: 0.12, pos: V3(x, 1.05, -0.5).add(c), pitch: -0.5, onPress: () => toGym(), visible: vis });
const trainButtons = [
  new Button({ label: '◀ PREV', color: '#2c3442', pos: V3(-0.4, 1.25, -0.55).add(TRAIN_C), pitch: -0.5, yaw: 0.25, onPress: () => trainer.select(trainer.idx - 1), visible: () => mode === 'train' && !paused }),
  new Button({ label: 'NEXT ▶', color: '#2c3442', pos: V3(0.4, 1.25, -0.55).add(TRAIN_C), pitch: -0.5, yaw: -0.25, onPress: () => trainer.select(trainer.idx + 1), visible: () => mode === 'train' && !paused }),
  backBtn(TRAIN_C, -0.55, () => mode === 'train' && !paused),
];
const squatButtons = [
  new Button({ label: 'START', sub: '75 seconds', color: '#1f9a4a', w: 0.32, h: 0.2, big: true, pos: V3(0.4, 1.25, -0.55).add(SQUAT_C), pitch: -0.5, yaw: -0.3, onPress: () => gauntletStart(), visible: () => mode === 'squat' && !gauntlet.active && !paused }),
  backBtn(SQUAT_C, -0.4, () => mode === 'squat' && !gauntlet.active && !paused),
];
const restSkip = new Button({ label: 'SKIP REST', color: '#2c3442', pos: V3(0.75, 1.3, -0.4).add(RING_C), pitch: -0.4, yaw: -0.6, onPress: () => nextRound(), visible: () => mode === 'fight' && game.state === 'rest' && !paused });
const overButtons = [
  new Button({ label: 'NEXT FIGHT', color: '#d41f3a', pos: V3(-0.36, 1.3, -0.55).add(RING_C), pitch: -0.45, onPress: () => startFight(Math.min(OPPONENTS.length - 1, oppIdx + 1)), visible: () => mode === 'fight' && game.state === 'over' && game.result?.result === 'win' && oppIdx + 1 < OPPONENTS.length }),
  new Button({ label: 'REMATCH', color: '#2c3442', pos: V3(0, 1.3, -0.55).add(RING_C), pitch: -0.45, onPress: () => startFight(oppIdx), visible: () => mode === 'fight' && game.state === 'over' }),
  new Button({ label: '← GYM', color: '#3a4150', pos: V3(0.36, 1.3, -0.55).add(RING_C), pitch: -0.45, onPress: () => toGym(), visible: () => mode === 'fight' && game.state === 'over' }),
];
const pauseButtons = [
  new Button({ label: 'RESUME', color: '#1f9a4a', pos: V3(), onPress: () => { paused = false; }, visible: () => paused }),
  new Button({ label: 'QUIT TO GYM', color: '#d41f3a', pos: V3(), onPress: () => toGym(), visible: () => paused }),
];
// a MENU button on the back of your left wrist: tap it with the other hand to pause
const wristBtn = new Button({ label: 'MENU', color: '#d41f3a', w: 0.09, h: 0.05, pos: V3(), onPress: () => togglePause(), visible: () => mode !== 'hub' && fists[0].valid && renderer.xr.isPresenting });

function placePauseMenu() {
  const { fw } = facingFrame(), h = player.head;
  const c = h.clone().addScaledVector(fw, 0.55).add(V3(0, -0.22, 0)), yaw = Math.atan2(-fw.x, -fw.z);
  pauseBoard.mesh.position.copy(c).add(V3(0, 0.22, 0)); pauseBoard.mesh.rotation.set(0, yaw, 0);
  const rt = V3(-fw.z, 0, fw.x);
  pauseButtons[0].root.position.copy(c).addScaledVector(rt, -0.18); pauseButtons[1].root.position.copy(c).addScaledVector(rt, 0.18);
  for (const b of pauseButtons) b.root.rotation.set(-0.3, yaw, 0, 'YXZ');
}
function placeWristButton() {
  const f = fists[0];
  if (!f.valid) return;
  wristBtn.root.position.copy(f.target).add(V3(0, 0.05, 0.1).applyQuaternion(f.targetQ)); // back along the forearm, on top
  wristBtn.root.lookAt(camera.getWorldPosition(V3()));
}

function drawBoards() {
  if (mode === 'hub') {
    mainBoard.mesh.visible = menuPage === 'main'; oppBoard.mesh.visible = menuPage === 'opp';
    if (menuPage === 'main') {
      const b = mainBoard, g = b.g; panel(b);
      g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = 'bold 84px system-ui'; g.fillText('SLOP BOXING', 450, 112);
      g.font = '30px system-ui'; g.fillStyle = UI.dim; g.fillText('punch or poke a button to choose', 450, 170);
      g.fillStyle = '#ffffff70'; g.font = '24px system-ui'; g.fillText('dummy on your right · workout stats on your left', 450, 220);
      b.tex.needsUpdate = true;
      menuTiles[3].setLabel(body.measuring > 0 ? 'STAND TALL' : 'MY HEIGHT', body.measuring > 0 ? 'measuring…' : heightFromEye(body.eye).toFixed(2) + ' m  ·  re-measure');
    } else {
      const b = oppBoard, g = b.g;
      const o = OPPONENTS[oppIdx], locked = oppIdx >= save.unlocked;
      panel(b, (oppIdx + 1) + '/' + OPPONENTS.length + '  ' + o.name.toUpperCase(), locked ? '🔒 beat ' + OPPONENTS[oppIdx - 1].name + ' to unlock' : '“' + o.tag + '”  ·  ' + o.rounds + ' round' + (o.rounds > 1 ? 's' : '') + '  ·  ' + DIFFS[save.diff].name);
      g.textAlign = 'left'; g.font = '28px system-ui'; g.fillStyle = '#fff';
      wrap(g, o.style, 36, 160, 828, 36);
      [['Power', o.power], ['Hand speed', o.speed], ['Chin', o.chin], ['Defence', Math.max(o.block, o.dodge)], ['Aggression', o.aggr], ['Footwork', o.feet]].forEach(([l, v], i) => {
        const x = 36 + (i % 2) * 430, y = 330 + Math.floor(i / 2) * 62;
        g.fillStyle = UI.dim; g.font = '24px system-ui'; g.fillText(l, x, y);
        g.fillStyle = '#ffffff22'; rrect(g, x + 150, y - 22, 240, 24, 8); g.fill();
        g.fillStyle = UI.accent; rrect(g, x + 150, y - 22, 240 * clamp(v / 1.6, 0.04, 1), 24, 8); g.fill();
      });
      g.fillStyle = '#ffffff70'; g.font = '22px system-ui'; g.fillText('◀ ▶ to browse  ·  tap the difficulty to change it', 36, 548);
      b.tex.needsUpdate = true;
      oppButtons[4].setLabel(DIFFS[save.diff].name);
      oppButtons[2].setLabel(locked ? 'LOCKED' : 'FIGHT!');
    }
    let b = dummyBoard, g = b.g; panel(b, 'TEST DUMMY', 'find the weak spots: chin, temple, liver');
    g.textAlign = 'left'; g.font = 'bold 40px system-ui'; g.fillStyle = '#f0a020'; g.fillText(lastPunch.name.toUpperCase(), 36, 172);
    g.font = '28px system-ui'; g.fillStyle = '#fff'; g.fillText(lastPunch.speed.toFixed(1) + ' m/s   (best ' + lastPunch.best.toFixed(1) + ')', 36, 218);
    g.fillStyle = '#' + new THREE.Color(IMPACT_COL[lastHit.tier] || 0xffffff).getHexString(); g.fillText('hit: ' + String(lastHit.zone).toLowerCase() + '  ·  ' + Math.round(lastHit.dmg) + ' dmg', 36, 264);
    b.tex.needsUpdate = true;
    drawWorkout(workoutBoard);
  }
  if (mode === 'train') trainer.draw(trainBoard);
  if (mode === 'squat') {
    const b = squatBoard, g = b.g;
    panel(b, 'SQUAT GAUNTLET', gauntlet.active ? 'red bars: squat under · blue walls: lean away · yellow: punch' : gauntlet.over ? 'done! press START to go again' : 'squat under bars, lean from walls, punch the pads');
    g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = 'bold 96px system-ui'; g.fillText(String(gauntlet.score), 36, 250);
    g.font = '30px system-ui'; g.fillStyle = UI.dim;
    g.fillText('time ' + mmss(Math.max(0, gauntlet.len - gauntlet.t)) + '   streak ' + gauntlet.streak + '   best ' + gauntlet.best, 36, 310);
    g.fillText('squats ' + gauntlet.ducked + '   pads ' + gauntlet.punched + '   bonks ' + gauntlet.missed, 36, 360);
    g.fillText('squats this session: ' + stats.squats, 36, 410);
    b.tex.needsUpdate = true;
  }
  if (mode === 'fight' && boxer) {
    const b = ringBoard, { g } = b; panel(b);
    const o = boxer.opp;
    g.textAlign = 'center'; g.font = 'bold 40px system-ui'; g.fillStyle = UI.dim; g.fillText('YOU  vs  ' + o.name.toUpperCase() + '  ·  ' + DIFFS[save.diff].name, 512, 62);
    g.font = 'bold 56px system-ui'; g.fillStyle = '#fff';
    const head = { intro: 'GET READY', fight: 'ROUND ' + game.round + ' of ' + game.rounds, rest: 'REST', over: game.result ? (game.result.result === 'win' ? 'YOU WIN' : game.result.result === 'lose' ? 'YOU LOSE' : 'DRAW') : '' }[game.state] || '';
    g.fillText(referee.who ? (referee.who === 'opp' ? o.name.toUpperCase() + ' IS DOWN' : 'YOU ARE DOWN') : head, 512, 130);
    g.font = 'bold 150px system-ui'; g.fillStyle = referee.who ? '#ffd54a' : game.state === 'fight' && game.clock < 10 ? '#ff6a6a' : '#fff';
    g.fillText(referee.who ? String(Math.max(1, referee.n)) : game.state === 'over' ? game.result.how : mmss(Math.max(0, game.clock)), 512, 285);
    g.font = '30px system-ui'; g.fillStyle = UI.dim;
    g.fillText(game.cards.map(([y, op], i) => 'R' + (i + 1) + ' ' + y + '-' + op).join('   ') || 'judges score each round on damage landed', 512, 360);
    g.font = 'bold 36px system-ui'; g.fillStyle = combo.n >= 2 ? '#f0a020' : '#ffffff60';
    g.fillText(combo.n >= 2 ? combo.n + ' HIT COMBO' : 'knockdowns: you scored ' + boxer.knockdowns + ', took ' + player.knockdowns, 512, 425);
    g.font = '24px system-ui'; g.fillStyle = '#ffffff70';
    g.fillText('block or slip his glowing glove · go where his guard isn’t · chin, temple and liver hurt most', 512, 480);
    b.tex.needsUpdate = true;
  }
  if (paused) {
    const b = pauseBoard, g = b.g; panel(b);
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = 'bold 64px system-ui'; g.fillText('PAUSED', 320, 110);
    g.font = '24px system-ui'; g.fillStyle = UI.dim; g.fillText('wrist MENU button, controller menu button or Esc', 320, 170);
    b.tex.needsUpdate = true;
  }
}
function drawWorkout(b) {
  panel(b, 'WORKOUT', 'this session');
  const { g } = b;
  const rows = [
    ['time', mmss(stats.time)], ['punches', stats.thrown], ['landed', stats.landed + (stats.thrown ? '  (' + Math.round(100 * stats.landed / stats.thrown) + '%)' : '')],
    ['avg speed', (stats.thrown ? (stats.speedSum / Math.max(1, stats.thrown)).toFixed(1) : '0.0') + ' m/s'],
    ['squats', stats.squats], ['dodges', stats.dodges], ['blocks', stats.blocks],
    ['calories (est.)', Math.round(stats.kcal) + ' kcal'], ['tracking', fists.map(f => f.source).join(' / ')],
  ];
  g.font = '28px system-ui';
  rows.forEach(([k, v], i) => { g.textAlign = 'left'; g.fillStyle = UI.dim; g.fillText(k, 36, 160 + i * 50); g.fillStyle = '#fff'; g.textAlign = 'right'; g.fillText(String(v), 476, 160 + i * 50); });
  b.tex.needsUpdate = true;
}

// ---------------------------------------------------------------- measuring your height
function measureHeight() { body.measuring = 2.2; body.samples = []; popup('STAND UP STRAIGHT', player.head.clone().add(V3(0, 0.05, -0.6)), '#ffffff', 1.4); }
function updateMeasure(dt) {
  if (body.measuring <= 0) return;
  body.measuring -= dt;
  if (renderer.xr.isPresenting) body.samples.push(camera.position.y);
  if (body.measuring > 0) return;
  if (body.samples.length > 10) {
    const s = body.samples.sort((a, b) => a - b), eye = s[Math.floor(s.length * 0.8)];
    if (eye > 1.1 && eye < 2.1) { body.eye = eye; player.standY = eye; }
  }
  popup('opponents: ' + heightFromEye(body.eye).toFixed(2) + ' m tall', player.head.clone().add(V3(0, 0.05, -0.6)), '#5be37d', 1.4);
  buildGymBoxers(); layoutForHeight();
}
function layoutForHeight() { // menus at about chest height for you
  const dy = (body.eye - 1.65) * 0.8;
  for (const b of buttons) { if (b === wristBtn || pauseButtons.includes(b)) continue; if (b.baseY === undefined) b.baseY = b.root.position.y; b.root.position.y = b.baseY + dy; }
  for (const bd of [mainBoard, oppBoard, dummyBoard, workoutBoard, trainBoard, squatBoard]) { if (bd.baseY === undefined) bd.baseY = bd.mesh.position.y; bd.mesh.position.y = bd.baseY + dy; }
}

renderer.xr.addEventListener('sessionstart', () => {
  resumeAudio(); camera.position.set(0, 0, 0);
  const s = renderer.xr.getSession();
  const rates = s?.supportedFrameRates ? [...s.supportedFrameRates].filter(r => r <= 120) : [];
  if (rates.length && s.updateTargetFrameRate) s.updateTargetFrameRate(Math.max(...rates)).catch(() => {});
  setTimeout(() => measureHeight(), 1500); // opponents your height
});
renderer.xr.addEventListener('sessionend', () => { camera.position.set(0, body.eye, 0); });

// ---------------------------------------------------------------- loop
await buildGymBoxers();
moveTo(HUB_C);
const clock = new THREE.Clock();
let acc = 0, boardT = 0, crowdT = 0, wasMenuPressed = false, lastPaused = false;
document.getElementById('loading')?.remove();
document.getElementById('ver').textContent = VERSION;
renderer.setAnimationLoop(() => {
  const maxDt = window.boxing?.maxDt || 0.05; // tests on slow software rendering raise this
  let dt = Math.min(clock.getDelta(), maxDt);
  const T = clock.elapsedTime;
  updateDeskHead(dt);
  camera.getWorldPosition(player.head);
  trackFists(dt);
  // a controller's B/Y or menu button opens the pause menu too
  const gpMenu = [...(renderer.xr.getSession?.()?.inputSources || [])].some(s => s.gamepad?.buttons?.[5]?.pressed || s.gamepad?.buttons?.[12]?.pressed);
  if (gpMenu && !wasMenuPressed) togglePause(); wasMenuPressed = gpMenu;
  if (paused !== lastPaused) { lastPaused = paused; if (paused) placePauseMenu(); }
  pauseBoard.mesh.visible = paused;
  if (hitStop > 0) { hitStop -= dt; dt *= 0.15; }
  if (!paused) {
    acc += dt;
    let n = Math.floor(acc / FIXED); acc -= n * FIXED; n = Math.min(n, Math.ceil(maxDt / FIXED) + 2);
    const active = mode === 'fight' ? [boxer] : mode === 'hub' ? [dummy] : mode === 'train' ? [coach] : [];
    for (let i = 0; i < n; i++) {
      for (const b of active) { if (!b) continue; b.think(FIXED, player.head); b.computePose(); b.drive(FIXED); }
      moveFistsKinematic((i + 1) / n);
      world.step();
      processFistContacts();
    }
    sweepFists();
    updateGame(dt);
  }
  trackPunches(dt);
  updateMeasure(dt);
  placeWristButton();
  const ptrs = uiPointers();
  for (const b of buttons) b.update(dt, ptrs);
  for (const f of fists) {
    f.mesh.visible = f.valid && !f.source.startsWith('hand');
    f.mesh.position.copy(f.target); f.mesh.quaternion.copy(f.targetQ);
  }
  for (const b of [dummy, coach, boxer]) b?.sync();
  if ((crowdT -= dt) <= 0) { crowdT = 1 / 30; updateCrowd(T); }
  particles.update(dt);
  updatePopups(dt); updateImpacts(dt);
  player.flash = Math.max(0, player.flash - dt * 2.5);
  hurtSphere.material.opacity = Math.max(player.flash * 0.45, mode === 'fight' && player.dizzy > 0.4 ? (player.dizzy - 0.4) * 0.5 * (0.6 + 0.4 * Math.sin(T * 5)) : 0);
  blackout.material.opacity += ((mode === 'fight' && referee.who === 'you' ? blackoutTarget : 0) - blackout.material.opacity) * Math.min(1, dt * 4);
  if ((boardT -= dt) <= 0) { boardT = 0.1; drawBoards(); }
  document.getElementById('hp').textContent = mode === 'fight' ? Math.round(player.hp) : '-';
  frameNo++;
  renderer.render(scene, camera);
});

window.boxing = { scene, renderer, camera, game, player, fists, stats, combo, trainer, gauntlet, lastPunch, lastHit, OPPONENTS, save, buttons, referee, body,
  get boxer() { return boxer; }, get dummy() { return dummy; }, get coach() { return coach; }, get mode() { return mode; }, get paused() { return paused; }, get menuPage() { return menuPage; },
  startFight, toGym, toTraining, toSquat, gauntletStart, togglePause, measureHeight, Boxer };
