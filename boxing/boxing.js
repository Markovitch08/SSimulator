// Slop Boxing: a WebXR boxing gym. Hand tracking first (fists from the tracked joints, with
// a short prediction through tracking dropouts on fast punches), controllers as a fallback,
// mouse/keyboard on desktop. A hub with a test dummy and a technique coach, and a ring
// where active-ragdoll Richards get tougher every knockout.
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { RAPIER, FIXED, phys, initPhysics, GROUPS, G, grp, bodyAlive } from '../src/physics.js';
import { facet, lambert, basisQuat } from '../src/lowpoly.js';
import { Particles } from '../src/fx.js';
import { sfx, resumeAudio } from '../src/audio.js';
import { loadEnemyModel } from '../src/enemy.js';

export const VERSION = 'boxing 0.3';

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] }));

// the same simulation void as Slop Blade: pale sky, faceted floor with a triangle grid,
// slowly tumbling low-poly rocks in the distance
const BG = 0xdde1e6;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 14, 60);
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.02, 200);
const dolly = new THREE.Group(); dolly.add(camera); scene.add(dolly);
camera.position.set(0, 1.65, 0);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a929c, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(4, 9, 3); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 30 });
scene.add(sun, sun.target);

const RING_C = new THREE.Vector3(0, 0, 0);   // the ring
const HUB_C = new THREE.Vector3(0, 0, 9);    // the hub: dummy, coach, menu pads
{
  // smooth-shaded and cut into bands: 90 m triangles running under the camera get mis-clipped
  // (whole sectors drawn black, or over things standing on them)
  const floor = new THREE.Mesh(new THREE.RingGeometry(0.001, 90, 6, 40).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xcdd2d8 })); // hex, cut into 2 m bands
  floor.receiveShadow = true; scene.add(floor);
  const pts = [], R = 34, s = 1.2, h = s * Math.sqrt(3) / 2;
  for (const a of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
    const dx = Math.cos(a), dz = Math.sin(a), nx = -dz, nz = dx;
    for (let k = -Math.floor(R / h); k <= Math.floor(R / h); k++) {
      const o = k * h, half = Math.sqrt(Math.max(0, R * R - o * o));
      pts.push(nx * o - dx * half, 0.004, nz * o - dz * half, nx * o + dx * half, 0.004, nz * o + dz * half);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9aa3ae, transparent: true, opacity: 0.55 })));
  const hex = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.68, 6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd41f3a }));
  hex.position.copy(HUB_C).setY(0.006); scene.add(hex);
}
const decor = [];
{
  const shapes = [new THREE.TetrahedronGeometry(1, 0), new THREE.OctahedronGeometry(1, 0), new THREE.IcosahedronGeometry(1, 0)].map(g => facet(g));
  const mat = lambert(0xc4cad1);
  for (let i = 0; i < 34; i++) {
    const m = new THREE.Mesh(shapes[i % 3], mat);
    const a = Math.random() * Math.PI * 2, r = 32 + Math.random() * 40;
    m.position.set(Math.cos(a) * r, 2 + Math.random() * 22, Math.sin(a) * r);
    m.scale.setScalar(1.5 + Math.random() * 5);
    m.userData.spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.25);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    scene.add(m); decor.push(m);
  }
}

// the ring: a canvas mat, four corner posts, three ropes a side
const RING = 2.4; // half-size: the ropes sit at +-RING
{
  const mat = new THREE.Mesh(facet(new THREE.BoxGeometry(RING * 2 + 0.6, 0.1, RING * 2 + 0.6)), lambert(0xe9e4d8));
  mat.position.y = -0.04; mat.receiveShadow = true; scene.add(mat);
  const apron = new THREE.Mesh(facet(new THREE.BoxGeometry(RING * 2 + 0.7, 0.3, RING * 2 + 0.7)), lambert(0x2c3442));
  apron.position.y = -0.2; scene.add(apron);
  const corners = [[1, 1, 0xd41f3a], [-1, -1, 0x2a5bd7], [1, -1, 0xf2f2f2], [-1, 1, 0xf2f2f2]];
  for (const [sx, sz, c] of corners) {
    const post = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6)), lambert(c));
    post.position.set(sx * RING, 0.7, sz * RING); post.castShadow = true; scene.add(post);
  }
  const ropeMat = lambert(0xd41f3a);
  for (const h of [0.45, 0.8, 1.15]) for (let s = 0; s < 4; s++) {
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, RING * 2, 5).rotateZ(Math.PI / 2), ropeMat);
    rope.rotation.y = s * Math.PI / 2; rope.position.set(...(s % 2 ? [s === 1 ? RING : -RING, h, 0] : [0, h, s === 0 ? RING : -RING]));
    scene.add(rope);
  }
}

// ---------------------------------------------------------------- physics + the Richard model
await initPhysics();
const world = phys.world;
const particles = new Particles(scene);

let MODEL;
try { MODEL = await loadEnemyModel('richard', '../models/richard.glb'); }
catch (e) { console.warn('Richard model failed to load, using a box body:', e); MODEL = boxModel(); }
// fallback body in the same part frames loadEnemyModel produces (joint at the origin, limbs along -Y)
function boxModel() {
  const rig = { pelvisH: 0.98, chest: [0, 0.22, 0], head: [0, 0.3, 0], shoulder: [0.2, 0.18, 0], hip: [0.1, -0.06, 0], UARM: 0.27, LARM: 0.25, THIGH: 0.45, SHIN: 0.45, ankleY: 0.07 };
  const box = (w, h, d, y) => [{ geo: new THREE.BoxGeometry(w, h, d).translate(0, y, 0), mat: 0 }];
  const geos = { pelvis: box(0.3, 0.18, 0.18, 0), chest: box(0.38, 0.36, 0.22, 0.12), head: box(0.19, 0.24, 0.21, 0.13) };
  for (const S of ['L', 'R']) Object.assign(geos, { ['uArm' + S]: box(0.09, 0.27, 0.09, -0.135), ['lArm' + S]: box(0.08, 0.25, 0.08, -0.125), ['thigh' + S]: box(0.12, 0.45, 0.12, -0.225), ['shin' + S]: box(0.1, 0.45, 0.1, -0.225) });
  return { geos, mats: [lambert(0xc98f6b)], rig };
}
const RIG = MODEL.rig;
// the glove replaces the hand: drop the hand/finger triangles past the wrist from each forearm
for (const S of ['L', 'R']) {
  const g = MODEL.geos['lArm' + S][0].geo, pos = g.attributes.position, uv = g.attributes.uv;
  const keepP = [], keepU = [], cut = -(RIG.LARM - 0.02);
  for (let i = 0; i < pos.count; i += 3) {
    if ((pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 < cut) continue;
    for (let j = i; j < i + 3; j++) { keepP.push(pos.getX(j), pos.getY(j), pos.getZ(j)); if (uv) keepU.push(uv.getX(j), uv.getY(j)); }
  }
  if (keepP.length >= 36) {
    const t = new THREE.BufferGeometry(); t.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
    if (uv) t.setAttribute('uv', new THREE.Float32BufferAttribute(keepU, 2));
    t.computeVertexNormals(); MODEL.geos['lArm' + S] = [{ geo: t, mat: 0 }];
  }
}
const GLOVE_R = 0.075, GLOVE_AT = RIG.LARM + 0.03; // glove centre beyond the wrist

const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
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
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const readPos = b => { const t = b.translation(); return V3(t.x, t.y, t.z); };
const readQ = b => { const r = b.rotation(); return new THREE.Quaternion(r.x, r.y, r.z, r.w); };

// ---------------------------------------------------------------- player: head + two physical fists
const player = { hp: 100, head: V3(0, 1.65, 0), standY: 1.65, flash: 0 };
const FIST_HALF = [0.045, 0.045, 0.055];
const fists = ['left', 'right'].map(side => {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(side === 'left' ? -0.2 : 0.2, 1.3, -0.3).setGravityScale(0).setCcdEnabled(true).setLinearDamping(0.5).setAngularDamping(2));
  const col = world.createCollider(RAPIER.ColliderDesc.cuboid(...FIST_HALF).setDensity(2200).setFriction(0.8).setCollisionGroups(GROUPS.phand), body);
  phys.info.set(col.handle, { kind: 'fist', side });
  const mesh = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.055, 1)), lambert(side === 'left' ? 0x2a5bd7 : 0xd41f3a));
  mesh.castShadow = true; scene.add(mesh);
  return {
    side, body, col, mesh,
    target: V3(), targetQ: new THREE.Quaternion(), valid: false, closed: true, teleport: true,
    last: V3(), lastVel: V3(), lostT: 0, source: 'none',
    armed: true, punch: null, // punch counting / classification
    kf: { p: V3(), v: V3(), a: V3(), init: false }, lostFrom: null, lastMeasured: V3(), intent: null, sweepFrom: V3(), hitFrame: -1,
    desk: { t: 1, aim: V3() },  // desktop punch animation
  };
});

// hand tracking: three.js fills in the 25 joints; a low-poly box hand shows them
const handFactory = new XRHandModelFactory();
const hands = [0, 1].map(i => {
  const hand = renderer.xr.getHand(i);
  // hidden until a tracked hand actually connects (before that its boxes sit at the origin, 1 m big)
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

// ---- hand tracking, made to survive fast punches
// 1. a constant-acceleration (alpha-beta-gamma) filter per fist: smooths jitter, rejects glitch
//    jumps, and keeps predicting along speed + acceleration through frames where tracking drops
// 2. when a hand reappears after a dropout far from where it vanished, the gap was a punch:
//    it's scored from the distance covered over the time lost ("intent")
// 3. the whole path since last frame is swept for hits (sweepFists), not just where the fist is
// 4. if the knuckles drop out, fall back to the palm, then to the wrist, projected along the hand
const KF = { a: 0.85, b: 0.55, g: 0.12 };
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
  else { // a joint's -Z runs along the bone toward the fingertips
    const j = mc || wr, along = mc ? 0.045 : 0.085;
    pos = j.getWorldPosition(V3()).add(V3(0, 0, -along).applyQuaternion(j.getWorldQuaternion(tmpQ)));
  }
  let closed = f.closed;
  if (mc) {
    const pc = mc.getWorldPosition(V3());
    let d = 0, n = 0;
    for (const t of TIPS) { const j = jointAt(hand, t); if (j) { d += j.getWorldPosition(V3()).distanceTo(pc); n++; } }
    if (n >= 2) closed = d / n < 0.075; // fingertips curled in near the palm
  }
  return { pos, q, closed };
}
function trackHandFiltered(f, dt) {
  const k = f.kf, m = measureHand(f);
  if (!k.init) {
    if (!m) return false;
    k.p.copy(m.pos); k.v.set(0, 0, 0); k.a.set(0, 0, 0); k.init = true; f.lastMeasured.copy(m.pos);
  }
  // predict
  k.p.addScaledVector(k.v, dt).addScaledVector(k.a, 0.5 * dt * dt); k.v.addScaledVector(k.a, dt);
  let meas = m;
  if (meas && f.lostT < 0.1 && meas.pos.distanceTo(k.p) > 0.5) meas = null; // a glitch, not a hand
  if (meas) {
    if (f.lostFrom && f.lostT > 0.03) {
      const disp = meas.pos.clone().sub(f.lostFrom), el = f.lostT;
      const reach = meas.pos.distanceTo(player.head);
      if (disp.length() > 0.2 && disp.length() / el > 2.5 && reach > 0.4) f.intent = { vel: disp.divideScalar(el), pos: meas.pos.clone(), from: f.lostFrom.clone() };
    }
    const r = meas.pos.clone().sub(k.p), h = Math.max(dt, 1 / 240);
    k.p.addScaledVector(r, KF.a); k.v.addScaledVector(r, KF.b / h); k.a.addScaledVector(r, 2 * KF.g / (h * h));
    if (k.v.length() > 20) k.v.setLength(20);
    if (k.a.length() > 300) k.a.setLength(300);
    f.lastMeasured.copy(meas.pos); f.lostT = 0; f.lostFrom = null;
    f.targetQ.copy(meas.q); f.closed = meas.closed;
    f.target.copy(k.p);
    return true;
  }
  if (f.lostT >= 0.25) { k.init = false; f.lostFrom = null; return false; }
  // lost: coast on, easing off, and never further than an arm's length from your head
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
    f.sweepFrom.copy(f.valid ? f.target : f.sweepFrom);
    let got = false;
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
    f.valid = got;
    if (f.teleport && f.valid) { // after moving between hub and ring: jump there instead of flying
      f.body.setTranslation(f.target, true); f.body.setLinvel({ x: 0, y: 0, z: 0 }, true); f.sweepFrom.copy(f.target); f.teleport = false;
    }
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
  const padHit = raycaster.intersectObjects(pads.filter(p => p.mesh.visible).map(p => p.mesh))[0];
  if (padHit) { pressPad(padHit.object.userData.pad); return; }
  const f = fists[e.button === 2 ? 1 : 0];
  f.desk.aim.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, 0.75); f.desk.t = 0;
});
addEventListener('keydown', e => {
  desk.keys.add(e.code); resumeAudio();
  const ahead = (dx, dy = -0.05) => camera.getWorldPosition(V3()).add(camera.getWorldDirection(V3()).multiplyScalar(0.75)).add(V3(dx, dy, 0));
  if (e.code === 'KeyJ') { fists[0].desk.t = 0; fists[0].desk.aim.copy(ahead(-0.05)); }
  if (e.code === 'KeyK') { fists[1].desk.t = 0; fists[1].desk.aim.copy(ahead(0.05)); }
  if (e.code === 'Enter' && mode === 'hub') startFight();
  if (e.code === 'KeyH' && mode === 'fight') toHub();
  if (e.code === 'BracketRight') trainer.select(trainer.idx + 1);
  if (e.code === 'BracketLeft') trainer.select(trainer.idx - 1);
});
addEventListener('keyup', e => desk.keys.delete(e.code));
function deskFist(f, dt) {
  const camP = camera.getWorldPosition(V3()), camQ = camera.getWorldQuaternion(new THREE.Quaternion());
  const guard = V3(f.side === 'left' ? -0.17 : 0.17, -0.2, -0.4).applyQuaternion(camQ).add(camP);
  f.desk.t += dt;
  const out = 0.09, back = 0.16, t = f.desk.t;
  const k = t < out ? t / out : t < out + back ? 1 - (t - out) / back : 0;
  f.target.copy(guard).lerp(f.desk.aim, k * k * (3 - 2 * k));
  f.targetQ.copy(camQ); f.closed = true;
}
function updateDeskHead(dt) {
  if (renderer.xr.isPresenting) return;
  const s = (desk.keys.has('KeyE') ? 1 : 0) - (desk.keys.has('KeyQ') ? 1 : 0);
  const d = desk.keys.has('KeyC') || desk.keys.has('ControlLeft') ? 1 : 0;
  desk.slip += (s * 0.28 - desk.slip) * (1 - Math.exp(-14 * dt));
  desk.duck += (d * 0.32 - desk.duck) * (1 - Math.exp(-14 * dt));
  camera.position.set(desk.slip, 1.65 - desk.duck, 0);
}
function driveFists(h) {
  for (const f of fists) {
    if (!f.valid) continue;
    driveLin(f.body, f.target, 60, 16, 900, h);
    driveAng(f.body, f.targetQ, 40, 40, 900, h);
  }
}
// haptics for controller users (bare hands have none: feedback is sound, hit-stop and flashes)
function pulse(side, intensity, ms) {
  const s = renderer.xr.getSession?.();
  if (!s) return;
  for (const src of s.inputSources) if (src.handedness === side) src.gamepad?.hapticActuators?.[0]?.pulse?.(Math.min(1, intensity), ms);
}

// ---------------------------------------------------------------- the boxer: a Richard active ragdoll
// Each model part rides a rigid body whose origin is its joint (limbs hang along -Y), driven
// toward a hidden target pose by capped velocity "muscles" scaled by tonus. Arms and legs are
// 2-bone IK. Modes: 'fight' (the ring), 'dummy' (hub punching dummy), 'coach' (trainer).
const MULT = { pelvis: 0.8, chest: 1.0, head: 1.4, uArmL: 0.25, uArmR: 0.25, lArmL: 0.12, lArmR: 0.12, thighL: 0.35, thighR: 0.35, shinL: 0.3, shinR: 0.3 };
const JOINTS = [['pelvis', 'chest', 'chest'], ['chest', 'head', 'head'], ['chest', 'uArmL', 'uArmL'], ['uArmL', 'lArmL', 'lArmL'], ['chest', 'uArmR', 'uArmR'], ['uArmR', 'lArmR', 'lArmR'],
  ['pelvis', 'thighL', 'thighL'], ['thighL', 'shinL', 'shinL'], ['pelvis', 'thighR', 'thighR'], ['thighR', 'shinR', 'shinR']];
const NAMES = ['Kid Slop', 'Iron Mattress', 'The Polygon', 'Bad Normals', 'Low-Poly Joe', 'Z-Fighter', 'Mister Mipmap', 'The Culler'];
const GLOVE_COLORS = [0x1f9a4a, 0xf0c020, 0x7a3fc0, 0x111111];
const rot = (q, a) => V3(...a).applyQuaternion(q);

class Boxer {
  constructor({ mode = 'fight', level = 1, at = V3(0, 0, -2), yaw = 0, glove = null, tint = null } = {}) {
    this.mode = mode; this.level = level;
    this.name = NAMES[(level - 1) % NAMES.length] + (level > NAMES.length ? ' ' + 'I'.repeat(Math.ceil(level / NAMES.length)) : '');
    this.maxHp = 260 + level * 60; this.hp = this.maxHp;
    this.speed = mode === 'coach' ? 0.6 : 1 + (level - 1) * 0.12;
    this.blockSkill = mode === 'fight' ? Math.min(0.75, 0.15 + level * 0.08) : 0;
    this.base = at.clone(); this.home = at.clone(); this.yaw = yaw;
    this.f = V3(Math.sin(yaw), 0, Math.cos(yaw)); this.r = V3(-this.f.z, 0, this.f.x);
    this.tonus = 1; this.state = mode === 'fight' ? 'walkin' : 'guard'; this.t = 0; this.next = rnd(1.2, 2); this.hitCd = 0;
    this.weave = Math.random() * 10; this.plan = []; this.atk = null; this.flash = 0;
    this.feet = { L: null, R: null }; this.stepping = null; this.koT = 0; this.slip = 0; this.duck = 0;
    this.gloveColor = glove ?? GLOVE_COLORS[(level - 1) % GLOVE_COLORS.length];
    this.mat = MODEL.mats[0].clone(); this.mat.emissive = new THREE.Color(0);
    if (tint) this.mat.color.setHex(tint);
    // callbacks: who cares when this boxer's punch lands, misses or is blocked
    this.onHitPlayer = (kind, at) => hurtPlayer(this, kind, at);
    this.onDodge = info => onDodge(info);
    this.onBlocked = () => {};
    this.pose = {};
    this.computePose();
    this.build();
  }

  build() {
    this.parts = {};
    for (const k of Object.keys(MULT)) {
      const p = this.pose[k];
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.p.x, p.p.y, p.p.z).setRotation(p.q).setLinearDamping(0.6).setAngularDamping(1.5));
      const geo = MODEL.geos[k][0].geo;
      geo.computeBoundingBox();
      const bb = geo.boundingBox, c = bb.getCenter(V3()), sz = bb.getSize(V3()).multiplyScalar(0.45);
      const col = world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.03, sz.x), Math.max(0.03, sz.y), Math.max(0.03, sz.z)).setTranslation(c.x, c.y, c.z).setDensity(900).setFriction(0.8).setCollisionGroups(GROUPS.ealive), body);
      phys.info.set(col.handle, { kind: 'boxer', boxer: this, part: k });
      const mesh = new THREE.Mesh(geo, this.mat);
      mesh.castShadow = true; scene.add(mesh);
      const part = { body, col, mesh, gloveCol: null };
      if (k.startsWith('lArm')) { // boxing glove over the hand
        const gc = world.createCollider(RAPIER.ColliderDesc.ball(GLOVE_R).setTranslation(0, -GLOVE_AT, 0).setDensity(500).setFriction(0.6).setCollisionGroups(GROUPS.ealive), body);
        phys.info.set(gc.handle, { kind: 'boxer', boxer: this, part: k, glove: true });
        const gm = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(GLOVE_R * 1.1, 1)), lambert(this.gloveColor, { emissive: 0x000000 }));
        gm.position.set(0, -GLOVE_AT, 0); gm.castShadow = true; mesh.add(gm);
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

  glovePos(s) { const b = this.parts['lArm' + s].body; return V3(0, -GLOVE_AT, 0).applyQuaternion(readQ(b)).add(readPos(b)); }
  headPos() { const b = this.parts.head.body; return V3(0, 0.12, 0.02).applyQuaternion(readQ(b)).add(readPos(b)); }

  // ---- the hidden target skeleton
  computePose() {
    const f = this.f, r = this.r, P = this.pose;
    const lean = this.atk && this.atk.phase === 'strike' ? 0.18 : this.state === 'stagger' ? -0.12 : 0.05;
    const bob = Math.sin(this.weave * 2.2) * 0.015, sway = Math.sin(this.weave) * 0.04;
    const face = basisQuat(UP, f);
    const pelvis = this.base.clone().add(V3(0, RIG.pelvisH + bob - this.duck, 0)).addScaledVector(r, sway * 0.5);
    const spineUp = UP.clone().addScaledVector(f, lean + this.duck * 0.6).addScaledVector(r, this.slip * 1.2).normalize();
    const chestQ = basisQuat(spineUp, f);
    const chest = pelvis.clone().add(rot(face, RIG.chest)).addScaledVector(r, sway + this.slip * 0.4);
    const neck = chest.clone().add(rot(chestQ, RIG.head));
    const headC = neck.clone().add(V3(0, 0.12, 0));
    P.pelvis = { p: pelvis, q: face }; P.chest = { p: chest, q: chestQ };
    P.head = { p: neck, q: basisQuat(spineUp.clone().add(UP).normalize(), this.lookDir ? this.lookDir.clone().setY(this.lookDir.y * 0.5) : f) };
    for (const s of ['L', 'R']) {
      const sx = s === 'L' ? 1 : -1; // model +X is the boxer's left
      const sh = chest.clone().add(rot(chestQ, [sx * RIG.shoulder[0], RIG.shoulder[1], RIG.shoulder[2]]));
      const guard = headC.clone().addScaledVector(f, 0.2).addScaledVector(r, -sx * 0.085).add(V3(0, -0.03, 0));
      const glove = this.gloveGoal?.[s] || guard;
      const arm = ik2(sh, glove, RIG.UARM, GLOVE_AT, r.clone().multiplyScalar(-sx * 0.7).add(V3(0, -1, 0)).addScaledVector(f, -0.2));
      P['uArm' + s] = { p: sh, q: basisQuat(sh.clone().sub(arm.elbow).normalize(), f) };
      P['lArm' + s] = { p: arm.elbow, q: basisQuat(arm.elbow.clone().sub(arm.end).normalize(), f) };
      const hip = pelvis.clone().add(rot(face, [sx * RIG.hip[0], RIG.hip[1], RIG.hip[2]]));
      const foot = this.feet[s] || this.footHome(s);
      const leg = ik2(hip, foot, RIG.THIGH, RIG.SHIN, f.clone().add(V3(0, 0.2, 0)));
      P['thigh' + s] = { p: hip, q: basisQuat(hip.clone().sub(leg.elbow).normalize(), f) };
      P['shin' + s] = { p: leg.elbow, q: basisQuat(leg.elbow.clone().sub(leg.end).normalize(), f) };
    }
  }
  footHome(s) { // boxing stance: left foot forward, right foot back, a bit wider than the hips
    const sx = s === 'L' ? 1 : -1;
    return this.base.clone().setY(RIG.ankleY).addScaledVector(this.r, -sx * 0.17).addScaledVector(this.f, s === 'L' ? 0.1 : -0.1);
  }

  updateFeet(dt) {
    for (const s of ['L', 'R']) if (!this.feet[s]) this.feet[s] = this.footHome(s);
    if (this.stepping) {
      const st = this.stepping; st.t += dt / 0.16;
      const k = Math.min(1, st.t);
      this.feet[st.s].lerpVectors(st.from, st.to, k).setY(RIG.ankleY + Math.sin(k * Math.PI) * 0.07);
      if (k >= 1) { this.stepping = null; this.lastStep = st.s; }
      return;
    }
    let pick = null, wd = 0.18;
    for (const s of ['L', 'R']) {
      const d = this.footHome(s).distanceTo(this.feet[s]);
      if (d > wd && (s !== this.lastStep || d > 0.3)) { wd = d; pick = s; }
    }
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
      driveLin(part.body, tgt.p, strike ? 45 : core ? 18 : 22, strike ? 12 * this.speed : 6, (strike ? 700 : core ? 160 : 220) * tn, h);
      // neck and trunk hold firm, or the head lolls
      driveAng(part.body, tgt.q, strike ? 40 : head || core ? 40 : 22, strike ? 40 : 20, (strike ? 900 : head || core ? 700 : 260) * tn, h);
    }
  }

  // ---- brain
  think(dt, ph) {
    this.t += dt; this.weave += dt * (this.state === 'guard' ? 1.6 : 0.8);
    this.hitCd -= dt; this.flash = Math.max(0, this.flash - dt * 5);
    if (this.state === 'ko') { this.tonus = 0; this.koT += dt; return; }
    const to = V3(ph.x - this.base.x, 0, ph.z - this.base.z), dist = to.length();
    if (dist > 1e-3 && this.mode !== 'dummy') {
      const want = Math.atan2(to.x, to.z);
      let dy = want - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * (1 - Math.exp(-8 * dt));
      this.f.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.r.set(-this.f.z, 0, this.f.x);
    }
    this.lookDir = V3().subVectors(ph, this.headPos()).normalize();
    const tgtTonus = this.state === 'stagger' ? 0.35 : this.state === 'rest' ? 0.8 : 1;
    this.tonus += (tgtTonus - this.tonus) * (1 - Math.exp(-3 * dt));

    // footwork
    if (this.mode === 'dummy') this.walkTo(this.home, dt, 1);
    else if (this.mode === 'coach') this.walkTo(this.wantPos || this.home, dt, 1.4);
    else if (this.state === 'rest') this.walkTo(V3(-RING + 0.6, 0, -RING + 0.6).add(RING_C), dt, 1.2);
    else if (this.state !== 'stagger') {
      const range = this.atk ? 0.6 : 0.95;
      const cur = Math.atan2(this.base.x - ph.x, this.base.z - ph.z);
      if (this.orbitBase === undefined) this.orbitBase = cur;
      let dc = cur - this.orbitBase; dc = Math.atan2(Math.sin(dc), Math.cos(dc)); this.orbitBase += dc * (1 - Math.exp(-0.3 * dt));
      const a = this.orbitBase + Math.sin(this.t * 0.35) * 0.3; // a gentle sway, never a chase around you
      this.walkTo(V3(ph.x + Math.sin(a) * range, 0, ph.z + Math.cos(a) * range), dt, this.state === 'walkin' ? 0.9 : 1.4);
      if (this.state === 'walkin' && dist < 1.15) { this.state = 'guard'; this.next = rnd(0.6, 1.2); }
    }
    if (this.mode === 'fight') {
      this.base.x = THREE.MathUtils.clamp(this.base.x, RING_C.x - RING + 0.35, RING_C.x + RING - 0.35);
      this.base.z = THREE.MathUtils.clamp(this.base.z, RING_C.z - RING + 0.35, RING_C.z + RING - 0.35);
    }
    this.updateFeet(dt);
    this.slip *= Math.exp(-4 * dt); if (!this.holdDuck) this.duck *= Math.exp(-5 * dt);

    if (this.state === 'stagger') { if ((this.staggerT -= dt) <= 0) this.state = 'guard'; this.cancelAttack(); this.gloveGoal = null; return; }
    if (this.state !== 'guard') { this.gloveGoal = null; return; }
    this.gloveGoal = {};

    if (this.mode === 'dummy') { // arms hang at its sides
      for (const s of ['L', 'R']) this.gloveGoal[s] = this.pose['thigh' + s].p.clone().addScaledVector(this.r, (s === 'L' ? 0.12 : -0.12)).add(V3(0, -0.15, 0));
      return;
    }
    if (this.mode === 'coach') { this.demo?.(dt, this); if (this.atk) this.runAttack(dt, ph); return; }

    // defence: an incoming fast fist may get a glove put in its way
    for (const fi of fists) {
      if (!fi.valid || this.atk?.phase === 'strike') continue;
      const fp = readPos(fi.body), lv = fi.body.linvel(), fv = V3(lv.x, lv.y, lv.z), hp = this.headPos();
      const toHead = hp.clone().sub(fp);
      if (fv.length() > 2.5 && toHead.length() < 0.6 && fv.dot(toHead.normalize()) > 2) {
        if (!fi.blockRoll || fi.blockRoll.until < this.t) fi.blockRoll = { until: this.t + 0.4, ok: Math.random() < this.blockSkill };
        if (fi.blockRoll.ok) {
          const s = fp.clone().sub(hp).dot(this.r) > 0 ? 'R' : 'L';
          this.gloveGoal[s] = hp.clone().lerp(fp, 0.45);
        }
      }
    }
    // offence: telegraph (wind-up + glowing glove), then a committed strike at where your head WAS
    if (!this.atk) {
      this.next -= dt;
      if (this.next <= 0 && dist < 1.3 && game.state === 'fight') {
        if (!this.plan.length) this.plan = this.pickCombo();
        this.startAttack(this.plan.shift());
      }
    } else this.runAttack(dt, ph);
  }

  pickCombo() {
    const all = ['jab', 'cross', 'hookL', 'hookR', 'upper', 'body'];
    const n = this.level < 2 ? 1 : this.level < 4 ? (Math.random() < 0.5 ? 1 : 2) : 1 + Math.floor(Math.random() * 3);
    const out = [];
    for (let i = 0; i < n; i++) out.push(i === 0 && Math.random() < 0.5 ? 'jab' : all[Math.floor(Math.random() * all.length)]);
    return out;
  }

  // shadow = a demonstration thrown at the air in front of him, not at you
  startAttack(kind, { shadow = false } = {}) {
    const side = { jab: 'L', cross: 'R', hookL: 'L', hookR: 'R', upperL: 'L', upperR: 'R', upper: Math.random() < 0.5 ? 'L' : 'R', body: Math.random() < 0.5 ? 'L' : 'R' }[kind];
    const wind = ({ jab: 0.32, cross: 0.48, hookL: 0.52, hookR: 0.52, upper: 0.55, upperL: 0.55, upperR: 0.55, body: 0.45 }[kind]) / this.speed;
    this.atk = { kind, side, phase: 'wind', t: 0, wind, strike: 0.16 / Math.sqrt(this.speed), aim: null, resolved: false, shadow };
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
    if (a.phase === 'wind') {
      // the telegraph: glove drawn back and down, glowing hotter
      const k = Math.min(1, a.t / a.wind);
      const back = { jab: 0.06, cross: 0.12, body: 0.06 }[a.kind] ?? 0.05;
      const low = upper ? 0.28 : a.kind === 'body' ? 0.12 : 0.04;
      const outw = hook ? 0.22 : 0.05;
      this.gloveGoal[s] = head.clone().addScaledVector(f, 0.18 - back * k).addScaledVector(r, side * (0.12 + outw * k)).add(V3(0, -0.08 - low * k, 0));
      if (!a.shadow) glove.material.emissive.setRGB(0.9 * k, 0.35 * k, 0);
      if (a.t >= a.wind) {
        a.phase = 'strike'; a.t = 0; a.from = this.glovePos(s);
        const target = a.shadow ? head.clone().addScaledVector(f, 0.75).add(V3(0, -0.05, 0)) : ph.clone();
        a.aim = target.add(V3(0, a.kind === 'body' ? -0.45 : -0.02, 0)); // locked: slip or duck now
        a.ctrl = hook ? a.from.clone().lerp(a.aim, 0.5).addScaledVector(r, side * 0.35) : upper ? a.from.clone().lerp(a.aim, 0.5).add(V3(0, -0.2, 0)) : a.from.clone().lerp(a.aim, 0.5);
        a.headAtLock = ph.clone();
        sfx.whoosh();
      }
    } else if (a.phase === 'strike') {
      const k = Math.min(1, a.t / a.strike);
      const over = a.aim.clone().addScaledVector(a.aim.clone().sub(a.from).normalize(), 0.12);
      this.gloveGoal[s] = a.from.clone().multiplyScalar((1 - k) * (1 - k)).addScaledVector(a.ctrl, 2 * k * (1 - k)).addScaledVector(over, k * k);
      if (!a.shadow) glove.material.emissive.setRGB(1, 0.45, 0.05);
      if (!a.resolved && !a.shadow) {
        const gp = this.glovePos(s);
        const target = a.kind === 'body' ? ph.clone().add(V3(0, -0.45, 0)) : ph;
        if (gp.distanceTo(target) < (a.kind === 'body' ? 0.22 : 0.17)) { a.resolved = true; this.onHitPlayer(a.kind, gp); }
      }
      if (a.t >= a.strike + 0.06) {
        if (!a.resolved && !a.shadow) { a.resolved = true; this.onDodge({ kind: a.kind, moved: ph.clone().sub(a.headAtLock), at: ph.clone() }); }
        a.phase = 'recover'; a.t = 0;
      }
    } else {
      glove.material.emissive.setRGB(0, 0, 0);
      if (a.t > 0.28 / this.speed) { // the gloves coming back up: that gap is your opening
        this.atk = null;
        this.next = this.plan.length ? rnd(0.05, 0.15) : rnd(0.9, 1.8) / this.speed;
      }
    }
  }

  blocked() { // his glove met your fist mid-strike
    if (!this.atk || this.atk.phase !== 'strike' || this.atk.resolved || this.atk.shadow) return;
    this.atk.resolved = true; this.atk.phase = 'recover'; this.atk.t = 0;
    this.parts['lArm' + this.atk.side].gloveMesh.material.emissive.setRGB(0, 0, 0);
    this.plan = [];
    stats.blocks++; popup('BLOCK', this.glovePos(this.atk.side), '#2a5bd7'); sfx.thump(0.7);
    this.onBlocked();
  }

  walkTo(p, dt, speed) {
    const d = V3(p.x - this.base.x, 0, p.z - this.base.z);
    const L = d.length(); if (L < 0.02) return;
    this.base.addScaledVector(d.normalize(), Math.min(L, speed * dt));
  }

  takeHit(part, pt, dir, speed, fist, isGlove) {
    if (this.state === 'ko' || this.hitCd > 0) return 0;
    let dmg = Math.min(28, Math.max(0, speed - 1.5) * 4.2) * (isGlove ? 0.08 : MULT[part]) * (fist.closed ? 1 : 0.4);
    if (this.state === 'rest' || dmg < 0.5) return 0;
    this.hitCd = 0.12; this.flash = 1;
    const b = this.parts[part].body;
    if (bodyAlive(b)) b.applyImpulseAtPoint(dir.clone().multiplyScalar(2 + dmg * 0.5), pt, true);
    this.tonus = Math.max(0.25, this.tonus - dmg * 0.025);
    if (isGlove) { popup('BLOCKED', pt, '#8a929c'); sfx.thump(0.4); return 0; }
    sfx.hit(Math.min(1, dmg / 25)); if (dmg > 6) sfx.grunt(Math.min(1, dmg / 30), 0.9);
    particles.emit('spark', pt, dir, 4 + Math.round(dmg / 3), 2);
    if (this.mode !== 'fight') { popup(String(Math.round(dmg)), pt.clone().add(V3(0, 0.15, 0)), '#ffffff'); return dmg; } // dummy / coach never go down
    this.hp -= dmg;
    if (this.atk?.phase === 'wind' && dmg > 4) { this.cancelAttack(); this.next = rnd(0.6, 1); popup('INTERRUPTED', pt, '#1f9a4a'); }
    if (this.hp <= 0) {
      this.hp = 0; this.state = 'ko'; this.tonus = 0; this.koT = 0; this.cancelAttack();
      b.applyImpulseAtPoint(dir.clone().multiplyScalar(14), pt, true);
      sfx.fanfare(); popup('K.O.!', pt.clone().add(V3(0, 0.3, 0)), '#d41f3a', 2);
    } else if (dmg >= 14 && this.state === 'guard') { this.state = 'stagger'; this.staggerT = 0.55; this.cancelAttack(); }
    return dmg;
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

// two-bone IK: returns the elbow/knee and the reachable end point
function ik2(root, goal, a, b, hint) {
  const dir = goal.clone().sub(root); let d = dir.length();
  dir.normalize();
  d = THREE.MathUtils.clamp(d, Math.abs(a - b) + 0.02, a + b - 0.005);
  const end = root.clone().addScaledVector(dir, d);
  const x = (a * a - b * b + d * d) / (2 * d), hgt = Math.sqrt(Math.max(0, a * a - x * x));
  const bend = hint.clone().addScaledVector(dir, -hint.dot(dir));
  if (bend.lengthSq() < 1e-6) bend.set(0, -1, 0).addScaledVector(dir, dir.y);
  bend.normalize();
  return { elbow: root.clone().addScaledVector(dir, x).addScaledVector(bend, hgt), end };
}

// ---------------------------------------------------------------- fists hitting boxers
let frameNo = 0;
// one place that turns "fist met boxer part" into a block or a hit
function fistHit(f, info, pt, v, sp) {
  const bx = info.boxer;
  if (info.glove && bx.atk && bx.atk.phase === 'strike' && 'lArm' + bx.atk.side === info.part) { bx.blocked(); pulse(f.side, 0.6, 50); f.hitFrame = frameNo; return; }
  if (sp < 2) return;
  const dmg = bx.takeHit(info.part, pt, v.clone().normalize(), sp, f, !!info.glove);
  if (dmg <= 0) return;
  f.hitFrame = frameNo;
  if (f.punch) f.punch.hit = { boxer: bx, dmg, part: info.part };
  pulse(f.side, 0.4 + dmg / 30, 30 + dmg * 2);
  hitStop = Math.min(0.06, 0.015 + dmg * 0.0015);
  if (bx.mode === 'fight') {
    stats.landed++; stats.dmg += dmg; combo.n++; combo.t = 1.6; combo.best = Math.max(combo.best, combo.n);
    if (combo.n >= 3) popup(combo.n + ' HIT COMBO', pt.clone().add(V3(0, 0.25, 0)), '#f0a020');
  }
}
// how fast the punch really is: for tracked hands the filtered hand (or a dropout's intent),
// not the physics fist, which can overshoot while catching up
function punchVel(f) {
  if (f.source.startsWith('hand')) return f.intent && f.intent.vel.length() > f.kf.v.length() ? f.intent.vel.clone() : f.kf.v.clone();
  const lv = f.body.linvel(); return V3(lv.x, lv.y, lv.z);
}
function processFistContacts() {
  for (const f of fists) {
    const v = punchVel(f);
    world.contactPairsWith(f.col, other => {
      const info = phys.info.get(other.handle);
      if (!info || info.kind !== 'boxer') return;
      let pt = null;
      world.contactPair(f.col, other, m => { if (!pt && m.numSolverContacts() > 0) { const p = m.solverContactPoint(0); pt = V3(p.x, p.y, p.z); } });
      if (pt) fistHit(f, info, pt, v, v.length());
    });
  }
}
// swept hits: the tracked path since last frame (or across a dropout) is ray-cast against the
// boxers, three rays wide, so a fast fist can't pass through a head between two samples
const FIST_SWEEP = grp(G.PHAND, G.EALIVE);
function sweepFists(dt) {
  for (const f of fists) {
    if (!f.valid || f.hitFrame === frameNo) continue;
    const seg = f.target.clone().sub(f.sweepFrom), len = seg.length();
    if (len < 0.03) continue;
    const sp = f.source.startsWith('hand') ? punchVel(f).length() : len / Math.max(dt, 1 / 120);
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
    if (!info || info.kind !== 'boxer') continue;
    fistHit(f, info, best.o.clone().addScaledVector(dir, best.toi), dir.clone().multiplyScalar(sp), sp);
  }
}

// ---------------------------------------------------------------- the player getting hit
const hurtSphere = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd41f3a, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false }));
hurtSphere.renderOrder = 999; camera.add(hurtSphere);
function hurtPlayer(bx, kind, at) {
  if (game.state !== 'fight') return;
  const dmg = { jab: 6, cross: 10, hookL: 11, hookR: 11, upper: 12, body: 8 }[kind] * (1 + (bx.level - 1) * 0.08);
  player.hp = Math.max(0, player.hp - dmg); player.flash = 1;
  stats.taken++; sfx.hurt(); sfx.hit(0.7); combo.n = 0;
  pulse('left', 0.8, 120); pulse('right', 0.8, 120);
  popup('-' + Math.round(dmg), at, '#d41f3a');
  if (player.hp <= 0) { game.state = 'down'; game.t = 0; sfx.fanfare(); }
}
function onDodge() { stats.dodges++; popup('DODGE', player.head.clone().add(V3(0, 0.25, -0.4)), '#1f9a4a'); sfx.chime(1); }

// ---------------------------------------------------------------- floating text
const popups = [];
function popup(text, pos, color = '#ffffff', scale = 1) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.font = 'bold 40px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = '#0008'; g.strokeText(text, 128, 32); g.fillStyle = color; g.fillText(text, 128, 32);
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
// A punch starts when a fist passes 2.5 m/s and ends when it drops under 1.4. Its type comes
// from the direction of travel at peak speed, in the frame of where you're facing:
// mostly forward = straight (jab with the lead/left hand, cross with the rear/right),
// mostly sideways toward your centre = hook, mostly upward = uppercut; low = to the body.
const stats = { thrown: 0, landed: 0, dmg: 0, taken: 0, blocks: 0, dodges: 0, squats: 0, speedSum: 0, kcal: 0, time: 0 };
const combo = { n: 0, t: 0, best: 0 };
const squat = { down: false };
const lastPunch = { name: '-', speed: 0, best: 0, dmg: 0 };
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
  if (game.state === 'fight' || game.state === 'rest' || mode === 'hub') stats.time += dt;
  for (const f of fists) {
    if (!f.valid) { f.punch = null; f.armed = true; continue; }
    let st = f.step || { sp: 0, vel: V3(), pos: readPos(f.body) }; f.step = null;
    // tracked hands: the filtered hand velocity, not the physics fist chasing it (that overshoots)
    if (f.source.startsWith('hand')) st = { sp: f.kf.v.length(), vel: f.kf.v.clone(), pos: f.target.clone() };
    if (f.intent) { const isp = f.intent.vel.length(); if (isp > st.sp) st = { sp: isp, vel: f.intent.vel.clone(), pos: f.intent.pos.clone() }; f.intent = null; } // a punch the cameras lost mid-flight
    const sp = st.sp;
    // only a fist moving away from your head starts a punch (pulling back to guard isn't one)
    const outward = sp > 0 && st.vel.dot(st.pos.clone().sub(player.head).normalize()) > 0.3 * sp;
    if (f.armed && sp > 2.5 && outward) { f.armed = false; f.punch = { peak: sp, vel: st.vel, pos: st.pos, head: player.head.clone() }; stats.thrown++; }
    if (!f.armed && f.punch) {
      if (sp > f.punch.peak) { f.punch.peak = sp; f.punch.vel = st.vel; f.punch.pos = st.pos; }
      if (sp < 1.4) {
        f.armed = true;
        const p = f.punch; f.punch = null;
        stats.speedSum += p.peak; stats.kcal += 0.12 + p.peak * 0.03;
        const c = classify(f, p);
        lastPunch.name = c.name; lastPunch.speed = p.peak; lastPunch.best = Math.max(lastPunch.best, p.peak); lastPunch.dmg = p.hit?.dmg || 0;
        trainer.onPunch(f, c, p);
      }
    }
  }
  player.standY = Math.max(player.head.y, player.standY - dt * 0.01);
  if (!squat.down && player.head.y < player.standY - 0.22) { squat.down = true; stats.squats++; stats.kcal += 0.3; }
  if (squat.down && player.head.y > player.standY - 0.1) squat.down = false;
  if (game.state === 'fight' || mode === 'hub') stats.kcal += dt * 0.07;
  combo.t -= dt; if (combo.t <= 0) combo.n = 0;
}

// ---------------------------------------------------------------- canvas boards
function makeBoard(w, h, cw, ch, pos, yaw = 0) {
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  mesh.position.copy(pos); mesh.rotation.y = yaw; scene.add(mesh);
  return { c, g: c.getContext('2d'), tex, mesh };
}
const panel = (b, title) => { const { g, c } = b; g.clearRect(0, 0, c.width, c.height); g.fillStyle = 'rgba(20,24,30,.9)'; g.fillRect(0, 0, c.width, c.height); if (title) { g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = 'bold 40px system-ui'; g.fillText(title, 32, 58); } };
// text that wraps inside a width
function wrap(g, text, x, y, w, lh) {
  let line = '';
  for (const word of text.split(' ')) {
    const t = line ? line + ' ' + word : word;
    if (g.measureText(t).width > w && line) { g.fillText(line, x, y); y += lh; line = word; } else line = t;
  }
  if (line) g.fillText(line, x, y);
  return y + lh;
}
const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const scoreBoard = makeBoard(2.2, 1.1, 1024, 512, V3(0, 2.9, -RING - 0.4).add(RING_C));
const workoutRing = makeBoard(0.9, 1.125, 512, 640, V3(RING + 0.5, 1.7, -0.6).add(RING_C), -Math.PI / 3);
const workoutHub = makeBoard(0.8, 1.0, 512, 640, V3(1.75, 1.6, -0.3).add(HUB_C), -Math.PI / 2.6);
const dummyBoard = makeBoard(0.9, 0.45, 512, 256, V3(0.35, 2.25, -1.25).add(HUB_C));
const trainBoard = makeBoard(1.3, 0.95, 768, 560, V3(-1.15, 2.35, -1.55).add(HUB_C), Math.PI / 6);
const hubTitle = makeBoard(1.6, 0.4, 800, 200, V3(0, 3.0, -2.2).add(HUB_C));

function drawWorkout(b) {
  panel(b, 'WORKOUT');
  const { g } = b;
  const rows = [
    ['time', mmss(stats.time)], ['punches thrown', stats.thrown], ['landed (ring)', stats.landed + (stats.thrown ? '  (' + Math.round(100 * stats.landed / stats.thrown) + '%)' : '')],
    ['avg punch speed', (stats.thrown ? (stats.speedSum / Math.max(1, stats.thrown)).toFixed(1) : '0.0') + ' m/s'],
    ['ducks / squats', stats.squats], ['dodges', stats.dodges], ['blocks', stats.blocks], ['hits taken', stats.taken],
    ['est. calories', Math.round(stats.kcal) + ' kcal'], ['fists', fists.map(f => f.source).join(' / ')],
  ];
  g.font = '30px system-ui';
  rows.forEach(([k, v], i) => { g.textAlign = 'left'; g.fillStyle = '#fff9'; g.fillText(k, 32, 120 + i * 50); g.fillStyle = '#fff'; g.textAlign = 'right'; g.fillText(String(v), 480, 120 + i * 50); });
  b.tex.needsUpdate = true;
}
function drawBoards() {
  if (mode === 'fight') {
    const b = scoreBoard, { g } = b; panel(b);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 54px system-ui';
    g.fillText({ intro: 'GET READY', fight: 'ROUND ' + game.round, rest: 'REST', ko: 'K.O.!', down: 'YOU WENT DOWN' }[game.state] || '', 512, 70);
    g.font = 'bold 120px system-ui'; g.fillStyle = game.state === 'fight' && game.clock < 10 ? '#ff6a6a' : '#fff';
    g.fillText(game.state === 'down' ? 'touch gloves' : game.state === 'ko' ? 'next: ' + Math.ceil(Math.max(0, 4 - boxer.koT)) : mmss(Math.max(0, game.clock)), 512, 200);
    const bar = (x, label, v, max, col) => {
      g.textAlign = 'left'; g.font = 'bold 30px system-ui'; g.fillStyle = '#fff'; g.fillText(label, x, 290);
      g.fillStyle = '#ffffff22'; g.fillRect(x, 305, 420, 34); g.fillStyle = col; g.fillRect(x, 305, 420 * Math.max(0, v / max), 34);
    };
    bar(60, 'YOU', player.hp, 100, '#2a5bd7');
    bar(544, boxer.name + '  (lvl ' + boxer.level + ')', boxer.hp, boxer.maxHp, '#d41f3a');
    g.textAlign = 'center'; g.font = 'bold 44px system-ui'; g.fillStyle = combo.n >= 2 ? '#f0a020' : '#fff6';
    g.fillText(combo.n >= 2 ? combo.n + ' HIT COMBO' : 'best combo ' + combo.best, 512, 410);
    g.font = '26px system-ui'; g.fillStyle = '#fff9';
    g.fillText(game.state === 'down' ? 'bump your fists together to go back to the gym' : 'block his glowing glove · slip or duck the strike · punch through the gaps', 512, 470);
    b.tex.needsUpdate = true;
    drawWorkout(workoutRing);
  } else {
    drawWorkout(workoutHub);
    let b = dummyBoard, g = b.g; panel(b, 'TEST DUMMY');
    g.textAlign = 'left'; g.font = 'bold 44px system-ui'; g.fillStyle = '#f0a020'; g.fillText(lastPunch.name.toUpperCase(), 32, 128);
    g.font = '30px system-ui'; g.fillStyle = '#fff';
    g.fillText(lastPunch.speed.toFixed(1) + ' m/s' + (lastPunch.dmg ? '  ·  ' + Math.round(lastPunch.dmg) + ' dmg' : ''), 32, 180);
    g.fillStyle = '#fff9'; g.fillText('best ' + lastPunch.best.toFixed(1) + ' m/s', 32, 228);
    b.tex.needsUpdate = true;
    trainer.draw(trainBoard);
    b = hubTitle; g = b.g; panel(b);
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = 'bold 64px system-ui'; g.fillText('SLOP BOXING GYM', 400, 92);
    g.font = '28px system-ui'; g.fillStyle = '#fff9'; g.fillText('punch a pad to choose', 400, 150);
    b.tex.needsUpdate = true;
  }
}

// ---------------------------------------------------------------- punchable menu pads
const pads = [];
function makePad(label, color, pos, yaw, onPress, visible = () => true) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#fff'; g.font = 'bold 34px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  label.split('\n').forEach((l, i, a) => g.fillText(l, 128, 64 + (i - (a.length - 1) / 2) * 38));
  const mesh = new THREE.Mesh(facet(new THREE.BoxGeometry(0.3, 0.16, 0.06)), [0, 1, 2, 3].map(() => lambert(color)).concat([new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }), lambert(color)]));
  mesh.position.copy(pos); mesh.rotation.y = yaw; mesh.castShadow = true; scene.add(mesh);
  const pad = { mesh, onPress, visible, cd: 0, home: pos.clone() };
  mesh.userData.pad = pad; pads.push(pad);
  return pad;
}
function pressPad(p) {
  if (p.cd > 0 || !p.mesh.visible) return;
  p.cd = 0.6; p.mesh.position.copy(p.home).add(V3(0, 0, -0.04).applyQuaternion(p.mesh.quaternion));
  sfx.thump(0.6); sfx.chime(1.2);
  p.onPress();
}
function updatePads(dt) {
  for (const p of pads) {
    p.cd -= dt; p.mesh.visible = p.visible();
    p.mesh.position.lerp(p.home, 1 - Math.exp(-10 * dt));
    if (!p.mesh.visible || p.cd > 0) continue;
    for (const f of fists) {
      if (!f.valid) continue;
      const lv = f.body.linvel();
      const local = readPos(f.body).sub(p.mesh.position).applyQuaternion(p.mesh.quaternion.clone().invert());
      if (Math.abs(local.x) < 0.2 && Math.abs(local.y) < 0.13 && Math.abs(local.z) < 0.12 && Math.hypot(lv.x, lv.y, lv.z) > 0.8) { pressPad(p); pulse(f.side, 0.5, 40); break; }
    }
  }
}

// ---------------------------------------------------------------- technique trainer
// The coach demonstrates a technique a few times, then it's your turn: punches are checked by
// the classifier above, defence by what your head and gloves do when he throws (slowly) at you.
const TECH = [
  { name: 'Jab', kind: 'punch', want: c => c.type === 'jab' && !c.low, demo: 'jab', tip: 'Lead (left) hand straight out from your chin, palm down at the end, and snap it straight back. Fast, not hard.' },
  { name: 'Cross', kind: 'punch', want: c => c.type === 'cross' && !c.low, demo: 'cross', tip: 'Rear (right) hand straight down the middle. Turn your back hip and heel so the whole body throws it.' },
  { name: 'Lead hook', kind: 'punch', want: c => c.type === 'lead hook', demo: 'hookL', tip: 'Left elbow up level with the fist, arm bent about 90°. Pivot on the front foot and swing across, not out.' },
  { name: 'Rear hook', kind: 'punch', want: c => c.type === 'rear hook', demo: 'hookR', tip: 'Same shape with the right hand: elbow up, rotate the hips and shoulders together.' },
  { name: 'Lead uppercut', kind: 'punch', want: c => c.type === 'lead uppercut', demo: 'upperL', tip: 'Dip a little, then drive up from the legs. Palm faces you, fist travels up under the chin line.' },
  { name: 'Rear uppercut', kind: 'punch', want: c => c.type === 'rear uppercut', demo: 'upperR', tip: 'Drop the right shoulder slightly and rise through it. Short and tight, don’t wind up.' },
  { name: 'Body shot', kind: 'punch', want: c => c.low && c.type !== 'swing', demo: 'body', tip: 'Bend your knees to get level with the stomach, then punch. Don’t just reach down with the arm.' },
  { name: 'High guard (block)', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'jab' : 'cross'), demo: 'block', tip: 'Both fists up by your cheeks, elbows in. Let his glove land on your gloves. Keep your eyes on him.',
    ok: e => e.type === 'blocked' || (e.type === 'hit' && guardUp()) },
  { name: 'Slip', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'jab' : 'cross'), demo: 'slip', tip: 'As the straight comes, move your head a few inches to the side by bending at the knees and waist. Small and quick.',
    ok: e => e.type === 'dodge' && Math.abs(e.moved.dot(facingFrame().rt)) > 0.09 },
  { name: 'Duck', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'hookL' : 'hookR'), demo: 'duck', tip: 'Under a hook: bend the knees (not your back) and drop your head below it. Hands stay up.',
    ok: e => e.type === 'dodge' && e.moved.y < -0.14 },
  { name: 'Roll (bob & weave)', kind: 'defend', attack: () => (Math.random() < 0.5 ? 'hookL' : 'hookR'), demo: 'roll', tip: 'Duck in a U shape under the hook: down, across and back up on the other side, ready to punch.',
    ok: e => e.type === 'dodge' && e.moved.y < -0.1 && Math.abs(e.moved.dot(facingFrame().rt)) > 0.06 },
  { name: 'Parry', kind: 'defend', attack: () => 'jab', demo: 'parry', tip: 'Tap his incoming jab aside with your glove. A small slap is enough to knock it off line.',
    ok: e => e.type === 'blocked' },
];
function guardUp() {
  const h = player.head, { fw } = facingFrame();
  return fists.every(f => f.valid && readPos(f.body).distanceTo(h) < 0.32 && readPos(f.body).sub(h).dot(fw) > 0.02);
}
const trainer = {
  idx: 0, phase: 'demo', t: 0, reps: 0, goal: 5, done: new Set(), msg: '', msgT: 0, nextAtk: 0,
  select(i) { this.idx = (i + TECH.length) % TECH.length; this.phase = 'demo'; this.t = 0; this.reps = 0; this.demoN = 0; coach.cancelAttack(); coach.wantPos = null; this.say(''); },
  say(m, ok) { this.msg = m; this.msgT = 1.4; this.msgOk = ok; },
  get tech() { return TECH[this.idx]; },
  update(dt) {
    const T = this.tech; this.t += dt; this.msgT -= dt;
    const ph = player.head;
    if (this.phase === 'demo') {
      coach.wantPos = null;
      if (T.kind === 'punch') {
        coach.demo = null;
        if (!coach.atk && this.t > 1.0) { coach.startAttack(T.demo, { shadow: true }); this.t = 0; this.demoN = (this.demoN || 0) + 1; }
      } else coach.demo = (dt, c) => defenceDemo(T.demo, c, this.t);
      if (this.demoN >= 3 || (T.kind === 'defend' && this.t > 5)) { this.phase = 'try'; this.t = 0; coach.demo = null; coach.duck = 0; coach.slip = 0; coach.holdDuck = false; this.say('YOUR TURN'); }
    } else if (this.phase === 'try') {
      if (T.kind === 'defend') {
        // he steps up and throws it at you, slowly, again and again
        const dir = V3(coach.home.x - ph.x, 0, coach.home.z - ph.z).normalize();
        coach.wantPos = V3(ph.x, 0, ph.z).addScaledVector(dir, 0.72);
        if (!coach.atk && V3(coach.base.x - coach.wantPos.x, 0, coach.base.z - coach.wantPos.z).length() < 0.12) {
          this.nextAtk -= dt;
          if (this.nextAtk <= 0) { coach.startAttack(T.attack()); this.nextAtk = 1.6; }
        }
      } else coach.wantPos = null;
      if (this.reps >= this.goal) { this.phase = 'done'; this.done.add(this.idx); coach.wantPos = null; coach.cancelAttack(); sfx.fanfare(); this.say('NICE WORK!', true); }
    }
  },
  onPunch(f, c) {
    if (mode !== 'hub' || this.phase !== 'try' || this.tech.kind !== 'punch') return;
    if (this.tech.want(c)) { this.reps++; this.say('✓ ' + c.name.toUpperCase(), true); sfx.chime(1 + this.reps * 0.2); }
    else this.say('that was a ' + c.name + ' — try again');
  },
  onDefence(e) {
    if (mode !== 'hub' || this.phase !== 'try' || this.tech.kind !== 'defend') return;
    if (this.tech.ok(e)) { this.reps++; this.say('✓ ' + this.tech.name.toUpperCase(), true); sfx.chime(1 + this.reps * 0.2); }
    else this.say(e.type === 'hit' ? 'got you — try again' : e.type === 'blocked' ? 'blocked, but try the ' + this.tech.name.toLowerCase() : 'missed you, but not with a ' + this.tech.name.toLowerCase());
  },
  draw(b) {
    const { g } = b, T = this.tech;
    panel(b, 'TECHNIQUE TRAINER');
    g.textAlign = 'right'; g.font = '26px system-ui'; g.fillStyle = '#fff9'; g.fillText((this.idx + 1) + ' / ' + TECH.length + '   ✓ ' + this.done.size, 736, 58);
    g.textAlign = 'left'; g.font = 'bold 50px system-ui'; g.fillStyle = T.kind === 'punch' ? '#f0a020' : '#4fc3ff';
    g.fillText(T.name.toUpperCase() + (this.done.has(this.idx) ? '  ✓' : ''), 32, 128);
    g.font = '28px system-ui'; g.fillStyle = '#fff';
    const y = wrap(g, T.tip, 32, 178, 704, 36);
    g.font = 'bold 34px system-ui'; g.fillStyle = '#fff';
    const status = this.phase === 'demo' ? 'Watch the coach…' : this.phase === 'try' ? (T.kind === 'punch' ? 'Your turn: throw it at the dummy or the air' : 'Your turn: he’ll throw at you') : 'Done! Punch NEXT ▶';
    g.fillText(status, 32, Math.max(y + 16, 380));
    for (let i = 0; i < this.goal; i++) { g.fillStyle = i < this.reps ? '#1f9a4a' : '#ffffff22'; g.fillRect(32 + i * 70, 420, 58, 26); }
    if (this.msgT > 0 && this.msg) { g.font = 'bold 36px system-ui'; g.fillStyle = this.msgOk ? '#5be37d' : '#ff8a8a'; g.fillText(this.msg, 32, 510); }
    b.tex.needsUpdate = true;
  },
};
// what the coach does with his body to show a defensive move
function defenceDemo(kind, c, t) {
  const cyc = t % 1.8, k = Math.sin(Math.min(1, cyc / 0.9) * Math.PI); // in and out over ~0.9 s, then a pause
  const headC = c.pose.head.p.clone().add(V3(0, 0.12, 0));
  c.duck = 0; c.slip = 0; c.holdDuck = true;
  if (kind === 'block') { for (const s of ['L', 'R']) c.gloveGoal[s] = headC.clone().addScaledVector(c.f, 0.13).addScaledVector(c.r, (s === 'L' ? -1 : 1) * 0.07).add(V3(0, 0.02 * k, 0)); }
  else if (kind === 'slip') c.slip = (Math.floor(t / 1.8) % 2 ? 1 : -1) * 0.14 * k;
  else if (kind === 'duck') c.duck = 0.26 * k;
  else if (kind === 'roll') { const u = Math.min(1, cyc / 1.1); c.duck = 0.24 * Math.sin(u * Math.PI); c.slip = 0.13 * Math.cos(u * Math.PI); }
  else if (kind === 'parry') { const s = 'R'; c.gloveGoal[s] = headC.clone().addScaledVector(c.f, 0.3).addScaledVector(c.r, -0.18 * k + 0.08).add(V3(0, -0.04, 0)); }
}

// ---------------------------------------------------------------- the hub: dummy, coach, pads
const dummy = new Boxer({ mode: 'dummy', at: V3(0.35, 0, -1.15).add(HUB_C), yaw: Math.atan2(-0.35, 1.15), glove: 0x888888, tint: 0xb8c4d6 });
const coach = new Boxer({ mode: 'coach', at: V3(-1.15, 0, -1.25).add(HUB_C), yaw: Math.atan2(1.15, 1.25), glove: 0xd41f3a });
coach.onHitPlayer = (kind, at) => { popup('HIT', at, '#d41f3a'); sfx.thump(0.6); trainer.onDefence({ type: 'hit' }); };
coach.onDodge = info => trainer.onDefence({ type: 'dodge', moved: info.moved });
coach.onBlocked = () => trainer.onDefence({ type: 'blocked' });
makePad('START\nFIGHT', '#d41f3a', V3(0.75, 1.25, -0.45).add(HUB_C), -0.5, () => startFight(), () => mode === 'hub');
makePad('◀ PREV', '#2c3442', V3(-0.95, 1.2, -0.45).add(HUB_C), 0.6, () => trainer.select(trainer.idx - 1), () => mode === 'hub');
makePad('NEXT ▶', '#2c3442', V3(-0.62, 1.2, -0.62).add(HUB_C), 0.45, () => trainer.select(trainer.idx + 1), () => mode === 'hub');
makePad('BACK TO\nGYM', '#2c3442', V3(0.7, 1.25, -0.35).add(RING_C), -0.5, () => toHub(), () => mode === 'fight' && game.state !== 'fight' && game.state !== 'intro');

// ---------------------------------------------------------------- modes and rounds
const ROUND = 120, REST = 30;
const game = { state: 'hub', t: 0, clock: 0, round: 1 };
let mode = 'hub';
let boxer = null;
let hitStop = 0;
function moveTo(c) { dolly.position.copy(c); for (const f of fists) f.teleport = true; }
function startFight() {
  mode = 'fight'; moveTo(RING_C);
  boxer?.remove(); boxer = new Boxer({ mode: 'fight', level: 1, at: V3(0, 0, -2).add(RING_C) });
  player.hp = 100; game.state = 'intro'; game.clock = 3; game.round = 1; game.touch = 0; combo.n = 0;
  trainer.select(trainer.idx);
}
function toHub() {
  mode = 'hub'; moveTo(HUB_C); game.state = 'hub';
  boxer?.remove(); boxer = null; player.hp = 100;
}
function bell(n = 1) { for (let i = 0; i < n; i++) setTimeout(() => sfx.bell(), i * 280); }
function updateGame(dt) {
  game.t += dt;
  if (mode === 'hub') { trainer.update(dt); return; }
  if (game.state === 'intro') { game.clock -= dt; if (game.clock <= 0) { game.state = 'fight'; game.clock = ROUND; bell(1); popup('FIGHT!', V3(0, 2, -1.2).add(RING_C), '#d41f3a', 2); } }
  else if (game.state === 'fight') {
    game.clock -= dt;
    if (boxer.state === 'ko') game.state = 'ko';
    else if (game.clock <= 0) { game.state = 'rest'; game.clock = REST; boxer.state = 'rest'; boxer.cancelAttack(); bell(3); }
  } else if (game.state === 'rest') {
    game.clock -= dt; player.hp = Math.min(100, player.hp + dt * 1.2);
    if (game.clock <= 0) { game.round++; game.state = 'fight'; game.clock = ROUND; boxer.state = 'guard'; bell(1); }
  } else if (game.state === 'ko') {
    if (boxer.koT > 4) { // next, tougher opponent
      const lvl = boxer.level + 1; boxer.remove(); boxer = new Boxer({ mode: 'fight', level: lvl, at: V3(0, 0, -2).add(RING_C) });
      player.hp = Math.min(100, player.hp + 30); game.state = 'fight'; bell(1);
    }
  } else if (game.state === 'down') {
    if (fists[0].valid && fists[1].valid && readPos(fists[0].body).distanceTo(readPos(fists[1].body)) < 0.14) {
      game.touch = (game.touch || 0) + dt;
      if (game.touch > 0.6) toHub();
    } else game.touch = 0;
  }
}
addEventListener('keydown', e => { if (e.code === 'KeyR' && game.state === 'down') toHub(); });

renderer.xr.addEventListener('sessionstart', () => {
  resumeAudio(); camera.position.set(0, 0, 0);
  // ask for the highest display rate the headset offers (up to 120 Hz): poses are sampled more
  // often, so fast punches move less between frames
  const s = renderer.xr.getSession();
  const rates = s?.supportedFrameRates ? [...s.supportedFrameRates].filter(r => r <= 120) : [];
  if (rates.length && s.updateTargetFrameRate) s.updateTargetFrameRate(Math.max(...rates)).catch(() => {});
});
renderer.xr.addEventListener('sessionend', () => { camera.position.set(0, 1.65, 0); });

// ---------------------------------------------------------------- loop
moveTo(HUB_C);
const clock = new THREE.Clock();
let acc = 0, boardT = 0;
document.getElementById('loading')?.remove();
document.getElementById('ver').textContent = VERSION;
renderer.setAnimationLoop(() => {
  let dt = Math.min(clock.getDelta(), 0.05);
  updateDeskHead(dt);
  camera.getWorldPosition(player.head);
  trackFists(dt);
  if (hitStop > 0) { hitStop -= dt; dt *= 0.15; } // a few frames of hit-stop sell the impact
  acc += dt;
  const active = mode === 'fight' ? [boxer, dummy, coach] : [dummy, coach]; // the gym keeps standing while you fight
  while (acc >= FIXED) {
    acc -= FIXED;
    for (const b of active) { b.think(FIXED, player.head); b.computePose(); b.drive(FIXED); }
    driveFists(FIXED);
    world.step();
    processFistContacts();
    for (const f of fists) { // fastest moment within this frame's physics steps
      const lv = f.body.linvel(), sp = Math.hypot(lv.x, lv.y, lv.z);
      if (!f.step || sp > f.step.sp) f.step = { sp, vel: V3(lv.x, lv.y, lv.z), pos: readPos(f.body) };
    }
  }
  sweepFists(dt);
  updateGame(dt);
  trackPunches(dt);
  frameNo++;
  updatePads(dt);
  for (const f of fists) {
    f.mesh.visible = f.valid && f.source !== 'hand'; // tracked hands draw themselves
    const t = f.body.translation(), r = f.body.rotation();
    f.mesh.position.set(t.x, t.y, t.z); f.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
  for (const b of [dummy, coach, boxer]) b?.sync();
  for (const m of decor) { m.rotation.x += m.userData.spin.x * dt; m.rotation.y += m.userData.spin.y * dt; m.rotation.z += m.userData.spin.z * dt; }
  particles.update(dt);
  updatePopups(dt);
  player.flash = Math.max(0, player.flash - dt * 2.5);
  hurtSphere.material.opacity = player.flash * 0.45;
  if ((boardT -= dt) <= 0) { boardT = 0.1; drawBoards(); }
  document.getElementById('hp').textContent = Math.round(player.hp);
  renderer.render(scene, camera);
});

window.boxing = { scene, renderer, camera, game, player, fists, stats, combo, trainer, dummy, coach, lastPunch, get boxer() { return boxer; }, get mode() { return mode; }, startFight, toHub, pressPad, pads, world, Boxer };
