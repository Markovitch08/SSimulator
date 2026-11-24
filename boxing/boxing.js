// Slop Boxing: a WebXR boxing gym. Hand tracking first (fists from the tracked joints, with
// a short prediction through tracking dropouts on fast punches), controllers as a fallback,
// mouse/keyboard on desktop. One active-ragdoll opponent at a time, each level faster.
import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { RAPIER, FIXED, phys, initPhysics, GROUPS, bodyAlive } from '../src/physics.js';
import { facet, lambert, basisQuat } from '../src/lowpoly.js';
import { Particles } from '../src/fx.js';
import { sfx, resumeAudio } from '../src/audio.js';

export const VERSION = 'boxing 0.1';

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer, { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] }));

const BG = 0xdde1e6;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 10, 40);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.02, 200);
const dolly = new THREE.Group(); dolly.add(camera); scene.add(dolly);
camera.position.set(0, 1.65, 0);
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a929c, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(3, 8, 2); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4 });
scene.add(sun);

// the ring: a canvas mat, four corner posts, three ropes a side, all in the low-poly void
const RING = 2.4; // half-size: the ropes sit at +-RING
{
  const mat = new THREE.Mesh(facet(new THREE.BoxGeometry(RING * 2 + 0.6, 0.1, RING * 2 + 0.6)), lambert(0xe9e4d8));
  mat.position.y = -0.05; mat.receiveShadow = true; scene.add(mat);
  const apron = new THREE.Mesh(facet(new THREE.BoxGeometry(RING * 2 + 0.7, 0.4, RING * 2 + 0.7)), lambert(0x2c3442));
  apron.position.y = -0.3; scene.add(apron);
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

// ---------------------------------------------------------------- physics
await initPhysics();
const world = phys.world;
const particles = new Particles(scene);

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
    target: V3(), targetQ: new THREE.Quaternion(), valid: false, closed: true,
    last: V3(), lastVel: V3(), lostT: 0, source: 'none',
    speed: 0, armed: true, peak: 0, // punch counting
    desk: { t: 1, aim: V3() },       // desktop punch animation
  };
});

// hand tracking: three.js fills in the 25 joints; a low-poly box hand shows them
const handFactory = new XRHandModelFactory();
const hands = [0, 1].map(i => {
  const hand = renderer.xr.getHand(i);
  hand.add(handFactory.createHandModel(hand, 'boxes'));
  hand.addEventListener('connected', e => { hand.userData.side = e.data.handedness; });
  hand.addEventListener('disconnected', () => { hand.userData.side = null; });
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

// where each fist should be this frame
function trackFists(dt) {
  const xr = renderer.xr.isPresenting;
  for (const f of fists) {
    let got = false;
    if (xr) {
      const hand = hands.find(h => h.userData.side === f.side);
      const knuckle = hand?.joints?.['middle-finger-phalanx-proximal'], wrist = hand?.joints?.wrist, palm = hand?.joints?.['middle-finger-metacarpal'];
      if (knuckle && wrist && palm && knuckle.visible && wrist.visible) {
        knuckle.getWorldPosition(f.target); wrist.getWorldQuaternion(f.targetQ);
        // closed fist: fingertips curled in near the palm
        const pc = palm.getWorldPosition(V3());
        let d = 0, n = 0;
        for (const t of TIPS) { const j = hand.joints[t]; if (j && j.visible) { d += j.getWorldPosition(V3()).distanceTo(pc); n++; } }
        f.closed = n === 0 || d / n < 0.075;
        f.source = 'hand'; got = true;
      } else {
        const g = grips.find(c => c.userData.side === f.side && !c.userData.isHand);
        if (g && g.visible !== false && g.userData.gamepad) {
          g.getWorldPosition(f.target); g.getWorldQuaternion(f.targetQ);
          f.target.add(V3(0, 0, -0.05).applyQuaternion(f.targetQ));
          f.closed = true; f.source = 'controller'; got = true;
        }
      }
    } else {
      deskFist(f, dt); got = true; f.source = 'desktop';
    }
    if (got) {
      if (f.valid && dt > 0) f.lastVel.lerp(V3().subVectors(f.target, f.last).divideScalar(dt), 0.6);
      f.last.copy(f.target); f.lostT = 0; f.valid = true;
    } else if (f.valid && f.lostT < 0.2) {
      // tracking dropped (usually a fast punch blurring past the cameras): carry on along the
      // last velocity, easing off, so the punch still lands where it was going
      f.lostT += dt; f.lastVel.multiplyScalar(Math.exp(-6 * dt));
      f.last.addScaledVector(f.lastVel, dt); f.target.copy(f.last);
    } else f.valid = false;
  }
}

// desktop: fists sit in a guard; left/right click throws that hand at the cursor
const mouse = new THREE.Vector2();
const desk = { slip: 0, duck: 0, keys: new Set() };
addEventListener('pointermove', e => { mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('pointerdown', e => {
  resumeAudio();
  const f = fists[e.button === 2 ? 1 : 0];
  const ray = new THREE.Raycaster(); ray.setFromCamera(mouse, camera);
  f.desk.aim.copy(ray.ray.origin).addScaledVector(ray.ray.direction, 0.75); f.desk.t = 0;
});
addEventListener('keydown', e => {
  desk.keys.add(e.code); resumeAudio();
  if (e.code === 'KeyJ') fists[0].desk.t = 0, fists[0].desk.aim.copy(camera.getWorldPosition(V3()).add(camera.getWorldDirection(V3()).multiplyScalar(0.75)).add(V3(-0.05, -0.05, 0)));
  if (e.code === 'KeyK') fists[1].desk.t = 0, fists[1].desk.aim.copy(camera.getWorldPosition(V3()).add(camera.getWorldDirection(V3()).multiplyScalar(0.75)).add(V3(0.05, -0.05, 0)));
});
addEventListener('keyup', e => desk.keys.delete(e.code));
function deskFist(f, dt) {
  const camP = camera.getWorldPosition(V3()), camQ = camera.getWorldQuaternion(new THREE.Quaternion());
  const guard = V3(f.side === 'left' ? -0.17 : 0.17, -0.2, -0.4).applyQuaternion(camQ).add(camP);
  f.desk.t += dt;
  const out = 0.09, back = 0.16, t = f.desk.t;
  const k = t < out ? t / out : t < out + back ? 1 - (t - out) / back : 0;
  f.target.copy(guard).lerp(f.desk.aim, k * k * (3 - 2 * k));
  f.targetQ.copy(camQ);
  f.closed = true;
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

// haptics for controller users (hands have none: feedback is sound + hit-stop + flash)
function pulse(side, intensity, ms) {
  const s = renderer.xr.getSession?.();
  if (!s) return;
  for (const src of s.inputSources) if (src.handedness === side) src.gamepad?.hapticActuators?.[0]?.pulse?.(Math.min(1, intensity), ms);
}

// ---------------------------------------------------------------- the opponent: an active ragdoll
// Parts are boxes driven toward a hidden target pose (position + orientation per part) by
// capped velocity "muscles", all scaled by tonus. Strikes are 2-bone IK on the arms; getting
// hit knocks the tonus down, a knockout drops it to zero and he folds.
const PARTS = {
  pelvis: { size: [0.3, 0.16, 0.18], color: 0x1d2b4f, mult: 0.8 },
  chest: { size: [0.38, 0.36, 0.22], color: 0xc98f6b, mult: 1.0 },
  head: { size: [0.19, 0.24, 0.21], color: 0xd9a07a, mult: 1.4 },
  uArmL: { size: [0.09, 0.26, 0.09], color: 0xc98f6b, mult: 0.25 }, uArmR: { size: [0.09, 0.26, 0.09], color: 0xc98f6b, mult: 0.25 },
  fArmL: { size: [0.08, 0.2, 0.08], color: 0xc98f6b, mult: 0.12, glove: true }, fArmR: { size: [0.08, 0.2, 0.08], color: 0xc98f6b, mult: 0.12, glove: true },
  thighL: { size: [0.12, 0.42, 0.12], color: 0x1d2b4f, mult: 0.35 }, thighR: { size: [0.12, 0.42, 0.12], color: 0x1d2b4f, mult: 0.35 },
  shinL: { size: [0.1, 0.44, 0.1], color: 0xc98f6b, mult: 0.3 }, shinR: { size: [0.1, 0.44, 0.1], color: 0xc98f6b, mult: 0.3 },
};
const UARM = 0.27, FARM = 0.27, THIGH = 0.45, SHIN = 0.47, GLOVE_R = 0.075;
const NAMES = ['Kid Slop', 'Iron Mattress', 'The Polygon', 'Bad Normals', 'Low-Poly Joe', 'Z-Fighter', 'Mister Mipmap', 'The Culler'];

class Boxer {
  constructor(level) {
    this.level = level;
    this.name = NAMES[(level - 1) % NAMES.length] + (level > NAMES.length ? ' ' + 'I'.repeat(Math.ceil(level / NAMES.length)) : '');
    this.maxHp = 260 + level * 60; this.hp = this.maxHp;
    this.speed = 1 + (level - 1) * 0.12;          // strike speed multiplier
    this.blockSkill = Math.min(0.75, 0.15 + level * 0.08);
    this.base = V3(0, 0, -2.0); this.yaw = 0; this.f = V3(0, 0, 1); this.r = V3(-1, 0, 0);
    this.tonus = 1; this.state = 'walkin'; this.t = 0; this.next = rnd(1.2, 2); this.hitCd = 0;
    this.weave = Math.random() * 10; this.plan = []; this.atk = null; this.flash = 0;
    this.feet = { L: null, R: null }; this.stepping = null; this.koT = 0;
    this.pose = {};
    this.computePose(0);
    this.build();
  }

  build() {
    this.parts = {}; this.meshes = [];
    for (const [k, def] of Object.entries(PARTS)) {
      const p = this.pose[k];
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.p.x, p.p.y, p.p.z).setRotation(p.q).setLinearDamping(0.6).setAngularDamping(1.5));
      const [sx, sy, sz] = def.size;
      const col = world.createCollider(RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setDensity(900).setFriction(0.8).setCollisionGroups(GROUPS.ealive), body);
      phys.info.set(col.handle, { kind: 'boxer', boxer: this, part: k });
      const mesh = new THREE.Mesh(facet(new THREE.BoxGeometry(sx, sy, sz)), lambert(def.color));
      mesh.castShadow = true; scene.add(mesh);
      const part = { body, col, mesh, def, gloveCol: null };
      if (def.glove) {
        const gc = world.createCollider(RAPIER.ColliderDesc.ball(GLOVE_R).setTranslation(0, -sy / 2 - GLOVE_R * 0.6, 0).setDensity(500).setFriction(0.6).setCollisionGroups(GROUPS.ealive), body);
        phys.info.set(gc.handle, { kind: 'boxer', boxer: this, part: k, glove: true });
        const gm = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(GLOVE_R * 1.08, 1)), lambert([0x1f9a4a, 0xf0c020, 0x7a3fc0, 0x111111][(this.level - 1) % 4], { emissive: 0x000000 }));
        gm.position.set(0, -sy / 2 - GLOVE_R * 0.6, 0); gm.castShadow = true; mesh.add(gm);
        part.gloveCol = gc; part.gloveMesh = gm;
      }
      if (k === 'head') { // a face, so you know which way he's looking
        const eyeMat = lambert(0x111111);
        for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.01), eyeMat); e.position.set(s * 0.045, 0.03, sz / 2 + 0.003); mesh.add(e); }
        const brow = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.02, 0.012), lambert(0x3a2418)); brow.position.set(0, 0.06, sz / 2 + 0.004); brow.rotation.z = 0.05; mesh.add(brow);
        const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.012, 0.01), lambert(0x7a2a2a)); mouth.position.set(0, -0.06, sz / 2 + 0.003); mesh.add(mouth);
      }
      this.parts[k] = part; this.meshes.push(mesh);
    }
    const J = (a, b, w) => {
      const A = this.parts[a].body, B = this.parts[b].body;
      const la = w.clone().sub(readPos(A)).applyQuaternion(readQ(A).invert());
      const lb = w.clone().sub(readPos(B)).applyQuaternion(readQ(B).invert());
      const j = world.createImpulseJoint(RAPIER.JointData.spherical(la, lb), A, B, true);
      j.setContactsEnabled?.(false);
    };
    const P = this.pose;
    J('pelvis', 'chest', P.waist); J('chest', 'head', P.neck);
    J('chest', 'uArmL', P.shL); J('uArmL', 'fArmL', P.elL); J('chest', 'uArmR', P.shR); J('uArmR', 'fArmR', P.elR);
    J('pelvis', 'thighL', P.hipL); J('thighL', 'shinL', P.knL); J('pelvis', 'thighR', P.hipR); J('thighR', 'shinR', P.knR);
  }

  remove() {
    for (const p of Object.values(this.parts)) {
      phys.info.delete(p.col.handle); if (p.gloveCol) phys.info.delete(p.gloveCol.handle);
      if (bodyAlive(p.body)) world.removeRigidBody(p.body);
      scene.remove(p.mesh);
    }
    this.parts = {};
  }

  glovePos(side) { // world position of a glove's centre
    const b = this.parts['fArm' + side].body, sy = PARTS['fArm' + side].size[1];
    return V3(0, -sy / 2 - GLOVE_R * 0.6, 0).applyQuaternion(readQ(b)).add(readPos(b));
  }
  headPos() { return readPos(this.parts.head.body); }

  // ---- the hidden target skeleton
  computePose(dt) {
    const f = this.f, r = this.r, P = this.pose;
    const lean = this.atk && this.atk.phase === 'strike' ? 0.08 : this.state === 'stagger' ? -0.06 : 0.02;
    const bob = Math.sin(this.weave * 2.2) * 0.02, sway = Math.sin(this.weave) * 0.05;
    const dip = this.duck || 0;
    const pelvis = this.base.clone().add(V3(0, 0.98 + bob - dip * 0.6, 0)).addScaledVector(r, sway * 0.5);
    const chest = pelvis.clone().add(V3(0, 0.27, 0)).addScaledVector(f, lean).addScaledVector(r, sway + (this.slip || 0));
    const head = chest.clone().add(V3(0, 0.33, 0)).addScaledVector(f, lean * 0.6 + 0.02).addScaledVector(r, (this.slip || 0) * 0.6);
    const facing = basisQuat(UP, f);
    P.pelvis = { p: pelvis, q: facing }; P.chest = { p: chest, q: basisQuat(head.clone().sub(pelvis).normalize(), f) };
    P.head = { p: head, q: basisQuat(UP, this.lookDir || f) };
    P.waist = pelvis.clone().add(V3(0, 0.08, 0)); P.neck = chest.clone().add(V3(0, 0.18, 0)).addScaledVector(f, 0.01);
    // arms: guard by default, the active strike overrides one glove target
    for (const s of ['L', 'R']) {
      const side = s === 'L' ? -1 : 1;
      const sh = chest.clone().add(V3(0, 0.15, 0)).addScaledVector(r, side * 0.24);
      let glove = this.gloveGoal?.[s] || head.clone().addScaledVector(f, 0.2).addScaledVector(r, side * 0.09).add(V3(0, 0.02, 0));
      const { elbow, end } = ik2(sh, glove, UARM, FARM, r.clone().multiplyScalar(side * 0.6).add(V3(0, -1, 0)).addScaledVector(f, -0.2));
      P['sh' + s] = sh; P['el' + s] = elbow;
      P['uArm' + s] = { p: sh.clone().add(elbow).multiplyScalar(0.5), q: basisQuat(sh.clone().sub(elbow).normalize(), f) };
      const fy = elbow.clone().sub(end).normalize();
      const fc = elbow.clone().addScaledVector(fy, -PARTS['fArm' + s].size[1] / 2);
      P['fArm' + s] = { p: fc, q: basisQuat(fy, f) };
      // legs: hips to planted feet
      const hip = pelvis.clone().add(V3(0, -0.07, 0)).addScaledVector(r, side * 0.1);
      const foot = this.feet[s] || hip.clone().setY(0.06).addScaledVector(r, side * 0.06).addScaledVector(f, s === 'L' ? 0.08 : -0.08);
      const lg = ik2(hip, foot, THIGH, SHIN, f.clone().add(V3(0, 0.2, 0)));
      P['hip' + s] = hip; P['kn' + s] = lg.elbow;
      P['thigh' + s] = { p: hip.clone().add(lg.elbow).multiplyScalar(0.5), q: basisQuat(hip.clone().sub(lg.elbow).normalize(), f) };
      P['shin' + s] = { p: lg.elbow.clone().add(lg.end).multiplyScalar(0.5), q: basisQuat(lg.elbow.clone().sub(lg.end).normalize(), f) };
    }
  }

  // feet stay planted until the hips drift off them, then step (alternating, with a lift)
  updateFeet(dt) {
    const f = this.f, r = this.r;
    for (const s of ['L', 'R']) if (!this.feet[s]) this.feet[s] = this.base.clone().setY(0.06).addScaledVector(r, (s === 'L' ? -1 : 1) * 0.16).addScaledVector(f, s === 'L' ? 0.08 : -0.08);
    if (this.stepping) {
      const st = this.stepping; st.t += dt / 0.16;
      const k = Math.min(1, st.t);
      this.feet[st.s].lerpVectors(st.from, st.to, k).setY(0.06 + Math.sin(k * Math.PI) * 0.07);
      if (k >= 1) { this.stepping = null; this.lastStep = st.s; }
      return;
    }
    let worst = null, wd = 0.2;
    for (const s of ['L', 'R']) {
      const home = this.base.clone().setY(0.06).addScaledVector(r, (s === 'L' ? -1 : 1) * 0.16).addScaledVector(f, s === 'L' ? 0.08 : -0.08);
      const d = home.distanceTo(this.feet[s]);
      if (d > wd && s !== this.lastStep) { wd = d; worst = { s, home }; }
    }
    if (!worst) for (const s of ['L', 'R']) {
      const home = this.base.clone().setY(0.06).addScaledVector(r, (s === 'L' ? -1 : 1) * 0.16).addScaledVector(f, s === 'L' ? 0.08 : -0.08);
      if (home.distanceTo(this.feet[s]) > 0.3) { worst = { s, home }; break; }
    }
    if (worst) this.stepping = { s: worst.s, from: this.feet[worst.s].clone(), to: worst.home, t: 0 };
  }

  // ---- muscles
  drive(h) {
    if (this.tonus <= 0.01) return;
    const P = this.pose, tn = this.tonus;
    for (const [k, part] of Object.entries(this.parts)) {
      if (!bodyAlive(part.body)) continue;
      const tgt = P[k];
      const strike = this.atk && this.atk.phase === 'strike' && (k === 'fArm' + this.atk.side || k === 'uArm' + this.atk.side);
      const core = k === 'pelvis' || k === 'chest';
      driveLin(part.body, tgt.p, strike ? 45 : core ? 18 : 22, strike ? 12 * this.speed : 6, (strike ? 700 : core ? 160 : 220) * tn, h);
      driveAng(part.body, tgt.q, strike ? 40 : 22, strike ? 40 : 20, (strike ? 900 : 260) * tn, h);
    }
  }

  // ---- brain
  think(dt, ph) {
    this.t += dt; this.weave += dt * (this.state === 'guard' ? 1.6 : 0.8);
    this.hitCd -= dt; this.flash = Math.max(0, this.flash - dt * 5);
    if (this.state === 'ko') { this.tonus = 0; this.koT += dt; return; }
    // face the player
    const to = V3(ph.x - this.base.x, 0, ph.z - this.base.z), dist = to.length();
    if (dist > 1e-3) {
      const want = Math.atan2(to.x, to.z);
      let dy = want - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * (1 - Math.exp(-8 * dt));
      this.f.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); this.r.set(-this.f.z, 0, this.f.x);
    }
    this.lookDir = V3().subVectors(ph, this.headPos()).normalize();
    // recover muscle tone after hits
    const tgtTonus = this.state === 'stagger' ? 0.35 : this.state === 'rest' ? 0.8 : 1;
    this.tonus += (tgtTonus - this.tonus) * (1 - Math.exp(-3 * dt));

    // footwork: hold range, circle a bit, stay inside the ropes
    const range = this.state === 'rest' ? null : this.atk ? 0.6 : 0.95;
    // circle slowly: a gentle sway around a spot that only drifts, never a chase around you
    const cur = Math.atan2(this.base.x - ph.x, this.base.z - ph.z);
    if (this.orbitBase === undefined) this.orbitBase = cur;
    let dc = cur - this.orbitBase; dc = Math.atan2(Math.sin(dc), Math.cos(dc)); this.orbitBase += dc * (1 - Math.exp(-0.3 * dt));
    if (this.state === 'rest') this.walkTo(V3(-RING + 0.6, 0, -RING + 0.6), dt, 1.2);
    else if (this.state !== 'stagger') {
      const a = this.orbitBase + Math.sin(this.t * 0.35) * 0.3;
      const want = V3(ph.x + Math.sin(a) * range, 0, ph.z + Math.cos(a) * range);
      this.walkTo(want, dt, this.state === 'walkin' ? 0.9 : 1.4);
      if (this.state === 'walkin' && dist < 1.1) { this.state = 'guard'; this.next = rnd(0.6, 1.2); }
    }
    this.base.x = THREE.MathUtils.clamp(this.base.x, -RING + 0.35, RING - 0.35);
    this.base.z = THREE.MathUtils.clamp(this.base.z, -RING + 0.35, RING - 0.35);
    this.updateFeet(dt);

    if (this.state === 'stagger') { if ((this.staggerT -= dt) <= 0) this.state = 'guard'; this.atk = null; this.gloveGoal = null; return; }
    if (this.state !== 'guard') { this.gloveGoal = null; return; }

    // defence: an incoming fast fist may get a glove put in its way
    this.gloveGoal = {};
    for (const fi of fists) {
      if (!fi.valid || this.atk?.phase === 'strike') continue;
      const fp = readPos(fi.body), lv = fi.body.linvel(), fv = V3(lv.x, lv.y, lv.z), hp = this.headPos();
      const toHead = hp.clone().sub(fp);
      if (fv.length() > 2.5 && toHead.length() < 0.6 && fv.dot(toHead.normalize()) > 2) {
        if (!fi.blockRoll || fi.blockRoll.until < this.t) fi.blockRoll = { until: this.t + 0.4, ok: Math.random() < this.blockSkill };
        if (fi.blockRoll.ok) {
          const s = fp.clone().sub(hp).dot(this.r) > 0 ? 'R' : 'L';
          this.gloveGoal[s] = hp.clone().lerp(fp, 0.45);
          if (Math.random() < 0.02) this.slip = (s === 'L' ? 1 : -1) * 0.08;
        }
      }
    }
    this.slip = (this.slip || 0) * Math.exp(-4 * dt);

    // offence: telegraph (wind-up + glowing glove), then a committed strike at where your head WAS
    if (!this.atk) {
      this.next -= dt;
      if (this.next <= 0 && dist < 1.3 && game.state === 'fight') {
        if (!this.plan.length) this.plan = this.pickCombo();
        this.startAttack(this.plan.shift(), ph);
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

  startAttack(kind, ph) {
    const side = { jab: 'L', cross: 'R', hookL: 'L', hookR: 'R', upper: Math.random() < 0.5 ? 'L' : 'R', body: Math.random() < 0.5 ? 'L' : 'R' }[kind];
    const wind = { jab: 0.32, cross: 0.48, hookL: 0.52, hookR: 0.52, upper: 0.55, body: 0.45 }[kind] / this.speed;
    this.atk = { kind, side, phase: 'wind', t: 0, wind, strike: 0.16 / Math.sqrt(this.speed), aim: null, resolved: false };
  }

  runAttack(dt, ph) {
    const a = this.atk, s = a.side, side = s === 'L' ? -1 : 1, f = this.f, r = this.r;
    const head = this.headPos(), sh = this.pose['sh' + s];
    a.t += dt;
    const glove = this.parts['fArm' + s].gloveMesh;
    if (a.phase === 'wind') {
      // the telegraph: glove drawn back and down, glowing hotter
      const k = Math.min(1, a.t / a.wind);
      const back = { jab: 0.06, cross: 0.12, hookL: 0.05, hookR: 0.05, upper: 0.04, body: 0.06 }[a.kind];
      const low = a.kind === 'upper' ? 0.28 : a.kind === 'body' ? 0.12 : 0.04;
      const outw = a.kind.startsWith('hook') ? 0.22 : 0.05;
      this.gloveGoal[s] = head.clone().addScaledVector(f, 0.18 - back * k).addScaledVector(r, side * (0.12 + outw * k)).add(V3(0, -0.08 - low * k, 0));
      glove.material.emissive.setRGB(0.9 * k, 0.35 * k, 0);
      if (a.t >= a.wind) {
        a.phase = 'strike'; a.t = 0; a.from = this.glovePos(s);
        a.aim = ph.clone().add(V3(0, a.kind === 'body' ? -0.45 : -0.02, 0)); // locked: slip or duck now
        a.ctrl = a.kind.startsWith('hook') ? a.from.clone().lerp(a.aim, 0.5).addScaledVector(r, side * 0.35) :
          a.kind === 'upper' ? a.from.clone().lerp(a.aim, 0.5).add(V3(0, -0.2, 0)) : a.from.clone().lerp(a.aim, 0.5);
        a.headAtLock = ph.clone();
        sfx.whoosh();
      }
    } else if (a.phase === 'strike') {
      const k = Math.min(1, a.t / a.strike);
      const over = a.aim.clone().addScaledVector(a.aim.clone().sub(a.from).normalize(), 0.12);
      // quadratic bezier from the wind-up through the control point to just past the aim
      const p = a.from.clone().multiplyScalar((1 - k) * (1 - k)).addScaledVector(a.ctrl, 2 * k * (1 - k)).addScaledVector(over, k * k);
      this.gloveGoal[s] = p;
      glove.material.emissive.setRGB(1, 0.45, 0.05);
      if (!a.resolved) {
        const gp = this.glovePos(s);
        const target = a.kind === 'body' ? ph.clone().add(V3(0, -0.45, 0)) : ph;
        if (gp.distanceTo(target) < (a.kind === 'body' ? 0.22 : 0.17)) { a.resolved = true; hurtPlayer(a.kind, gp); }
      }
      if (a.t >= a.strike + 0.06) {
        if (!a.resolved) { a.resolved = true; if (ph.distanceTo(a.headAtLock) > 0.1) onDodge(); }
        a.phase = 'recover'; a.t = 0;
      }
    } else {
      glove.material.emissive.setRGB(0, 0, 0);
      if (a.t > 0.28 / this.speed) { // gloves come back up; that gap is your opening
        this.atk = null;
        this.next = this.plan.length ? rnd(0.05, 0.15) : rnd(0.9, 1.8) / this.speed;
      }
    }
  }

  blocked() { // his glove met your fist mid-strike
    if (!this.atk || this.atk.phase !== 'strike' || this.atk.resolved) return;
    this.atk.resolved = true; this.atk.phase = 'recover'; this.atk.t = 0;
    this.parts['fArm' + this.atk.side].gloveMesh.material.emissive.setRGB(0, 0, 0);
    this.plan = [];
    stats.blocks++; popup('BLOCK', this.glovePos(this.atk.side), '#2a5bd7'); sfx.thump(0.7);
  }

  walkTo(p, dt, speed) {
    const d = V3(p.x - this.base.x, 0, p.z - this.base.z);
    const L = d.length(); if (L < 0.02) return;
    this.base.addScaledVector(d.normalize(), Math.min(L, speed * dt));
  }

  takeHit(part, pt, dir, speed, fist) {
    if (this.state === 'ko' || this.hitCd > 0) return 0;
    const def = PARTS[part];
    const isGlove = this.lastContactGlove;
    let dmg = Math.min(28, Math.max(0, speed - 1.5) * 4.2) * (isGlove ? 0.08 : def.mult) * (fist.closed ? 1 : 0.4);
    if (this.state === 'rest' || dmg < 0.5) return 0;
    this.hitCd = 0.12;
    this.hp -= dmg; this.flash = 1;
    const b = this.parts[part].body;
    if (bodyAlive(b)) b.applyImpulseAtPoint(dir.clone().multiplyScalar(2 + dmg * 0.5), pt, true);
    this.tonus = Math.max(0.25, this.tonus - dmg * 0.025);
    if (isGlove) { popup('BLOCKED', pt, '#8a929c'); sfx.thump(0.4); return 0; }
    sfx.hit(Math.min(1, dmg / 25)); if (dmg > 6) sfx.grunt(Math.min(1, dmg / 30), 0.9);
    particles.emit('spark', pt, dir, 4 + Math.round(dmg / 3), 2);
    if (this.atk?.phase === 'wind' && dmg > 4) { this.atk = null; this.plan = []; this.next = rnd(0.6, 1); this.parts.fArmL.gloveMesh.material.emissive.setRGB(0, 0, 0); this.parts.fArmR.gloveMesh.material.emissive.setRGB(0, 0, 0); popup('INTERRUPTED', pt, '#1f9a4a'); }
    if (this.hp <= 0) {
      this.hp = 0; this.state = 'ko'; this.tonus = 0; this.koT = 0; this.atk = null;
      b.applyImpulseAtPoint(dir.clone().multiplyScalar(14), pt, true);
      sfx.fanfare(); popup('K.O.!', pt.clone().add(V3(0, 0.3, 0)), '#d41f3a', 2);
    } else if (dmg >= 14 && this.state === 'guard') { this.state = 'stagger'; this.staggerT = 0.55; this.atk = null; this.plan = []; }
    return dmg;
  }

  sync() {
    for (const [k, p] of Object.entries(this.parts)) {
      if (!bodyAlive(p.body)) continue;
      const t = p.body.translation(), r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z); p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      p.mesh.material.emissive?.setScalar(this.flash * 0.5);
    }
  }
}

// two-bone IK with equal-ish segments: returns the elbow/knee and the reachable end point
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

// ---------------------------------------------------------------- hits between fists and the boxer
function processFistContacts() {
  for (const f of fists) {
    const lv = f.body.linvel(), v = V3(lv.x, lv.y, lv.z);
    world.contactPairsWith(f.col, other => {
      const info = phys.info.get(other.handle);
      if (!info || info.kind !== 'boxer') return;
      let pt = null;
      world.contactPair(f.col, other, m => { if (!pt && m.numSolverContacts() > 0) { const p = m.solverContactPoint(0); pt = V3(p.x, p.y, p.z); } });
      if (!pt) return;
      const bx = info.boxer;
      if (info.glove && bx.atk && bx.atk.phase === 'strike' && 'fArm' + bx.atk.side === info.part) { bx.blocked(); pulse(f.side, 0.6, 50); return; }
      const sp = v.length();
      if (sp < 2) return;
      bx.lastContactGlove = !!info.glove;
      const dmg = bx.takeHit(info.part, pt, v.clone().normalize(), sp, f);
      if (dmg > 0) {
        stats.landed++; stats.dmg += dmg; combo.n++; combo.t = 1.6; combo.best = Math.max(combo.best, combo.n);
        if (f.punchId !== f.countedLanded) f.countedLanded = f.punchId;
        pulse(f.side, 0.4 + dmg / 30, 30 + dmg * 2);
        hitStop = Math.min(0.06, 0.015 + dmg * 0.0015);
        if (combo.n >= 3) popup(combo.n + ' HIT COMBO', pt.clone().add(V3(0, 0.25, 0)), '#f0a020');
      }
    });
  }
}

// ---------------------------------------------------------------- the player getting hit
const hurtSphere = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd41f3a, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false }));
hurtSphere.renderOrder = 999; camera.add(hurtSphere);
function hurtPlayer(kind, at) {
  if (game.state !== 'fight') return;
  const dmg = { jab: 6, cross: 10, hookL: 11, hookR: 11, upper: 12, body: 8 }[kind] * (1 + (boxer.level - 1) * 0.08);
  player.hp = Math.max(0, player.hp - dmg); player.flash = 1;
  stats.taken++;
  sfx.hurt(); sfx.hit(0.7); combo.n = 0;
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

// ---------------------------------------------------------------- workout tracking
const stats = { thrown: 0, landed: 0, dmg: 0, taken: 0, blocks: 0, dodges: 0, squats: 0, speedSum: 0, kcal: 0, time: 0 };
const combo = { n: 0, t: 0, best: 0 };
const squat = { down: false };
function trackWorkout(dt) {
  if (game.state === 'fight' || game.state === 'rest') stats.time += dt;
  for (const f of fists) {
    if (!f.valid) continue;
    const lv = f.body.linvel(), sp = Math.hypot(lv.x, lv.y, lv.z);
    if (f.armed && sp > 2.5) { f.armed = false; f.peak = sp; stats.thrown++; f.punchId = (f.punchId || 0) + 1; }
    if (!f.armed) { f.peak = Math.max(f.peak, sp); if (sp < 1.4) { f.armed = true; stats.speedSum += f.peak; stats.kcal += 0.12 + f.peak * 0.03; } }
  }
  // standing height follows the highest recent head position; a 22 cm drop counts as a squat/duck
  player.standY = Math.max(player.head.y, player.standY - dt * 0.01);
  if (!squat.down && player.head.y < player.standY - 0.22) { squat.down = true; stats.squats++; stats.kcal += 0.3; }
  if (squat.down && player.head.y > player.standY - 0.1) squat.down = false;
  // a resting rate while you're in the ring, plus the work above (a rough estimate)
  if (game.state === 'fight') stats.kcal += dt * 0.07;
  combo.t -= dt; if (combo.t <= 0) combo.n = 0;
}

// ---------------------------------------------------------------- scoreboard (in the world, above the ring)
const board = document.createElement('canvas'); board.width = 1024; board.height = 512;
const boardTex = new THREE.CanvasTexture(board);
const boardMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.1), new THREE.MeshBasicMaterial({ map: boardTex, transparent: true }));
boardMesh.position.set(0, 2.9, -RING - 0.4); scene.add(boardMesh);
const workout = document.createElement('canvas'); workout.width = 512; workout.height = 640;
const workoutTex = new THREE.CanvasTexture(workout);
const workoutMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.125), new THREE.MeshBasicMaterial({ map: workoutTex, transparent: true }));
workoutMesh.position.set(RING + 0.5, 1.7, -0.6); workoutMesh.rotation.y = -Math.PI / 3; scene.add(workoutMesh);
const mmss = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function drawBoards() {
  let g = board.getContext('2d');
  g.clearRect(0, 0, 1024, 512); g.fillStyle = 'rgba(20,24,30,.9)'; g.fillRect(0, 0, 1024, 512);
  g.fillStyle = '#fff'; g.textAlign = 'center';
  g.font = 'bold 54px system-ui';
  const label = { intro: 'GET READY', fight: 'ROUND ' + game.round, rest: 'REST', ko: 'K.O.!', down: 'YOU WENT DOWN' }[game.state];
  g.fillText(label, 512, 70);
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
  g.fillText(game.state === 'down' ? 'bump your fists together to go again' : 'block his glowing glove · slip or duck the strike · punch through the gaps', 512, 470);
  boardTex.needsUpdate = true;

  g = workout.getContext('2d');
  g.clearRect(0, 0, 512, 640); g.fillStyle = 'rgba(20,24,30,.9)'; g.fillRect(0, 0, 512, 640);
  g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = 'bold 40px system-ui'; g.fillText('WORKOUT', 32, 60);
  const rows = [
    ['time', mmss(stats.time)], ['punches thrown', stats.thrown], ['landed', stats.landed + (stats.thrown ? '  (' + Math.round(100 * stats.landed / stats.thrown) + '%)' : '')],
    ['avg punch speed', (stats.thrown ? (stats.speedSum / Math.max(1, stats.thrown)).toFixed(1) : '0.0') + ' m/s'],
    ['ducks / squats', stats.squats], ['dodges', stats.dodges], ['blocks', stats.blocks], ['hits taken', stats.taken],
    ['est. calories', Math.round(stats.kcal) + ' kcal'], ['fists', fists.map(f => f.source).join(' / ')],
  ];
  g.font = '30px system-ui';
  rows.forEach(([k, v], i) => { g.fillStyle = '#fff9'; g.fillText(k, 32, 120 + i * 50); g.fillStyle = '#fff'; g.textAlign = 'right'; g.fillText(String(v), 480, 120 + i * 50); g.textAlign = 'left'; });
  workoutTex.needsUpdate = true;
}

// ---------------------------------------------------------------- rounds
const ROUND = 120, REST = 30;
const game = { state: 'intro', t: 0, clock: 3, round: 1 };
let boxer = new Boxer(1);
let hitStop = 0;
function bell(n = 1) { for (let i = 0; i < n; i++) setTimeout(() => sfx.bell(), i * 280); }
function updateGame(dt) {
  game.t += dt;
  if (game.state === 'intro') { game.clock -= dt; if (game.clock <= 0) { game.state = 'fight'; game.clock = ROUND; bell(1); popup('FIGHT!', V3(0, 2, -1.2), '#d41f3a', 2); } }
  else if (game.state === 'fight') {
    game.clock -= dt;
    if (boxer.state === 'ko') { game.state = 'ko'; }
    else if (game.clock <= 0) { game.state = 'rest'; game.clock = REST; boxer.state = 'rest'; boxer.atk = null; bell(3); }
  } else if (game.state === 'rest') {
    game.clock -= dt; player.hp = Math.min(100, player.hp + dt * 1.2);
    if (game.clock <= 0) { game.round++; game.state = 'fight'; game.clock = ROUND; boxer.state = 'guard'; bell(1); }
  } else if (game.state === 'ko') {
    if (boxer.koT > 4) { // next, tougher opponent
      const lvl = boxer.level + 1; boxer.remove(); boxer = new Boxer(lvl);
      player.hp = Math.min(100, player.hp + 30); game.state = 'fight'; bell(1);
    }
  } else if (game.state === 'down') {
    // touch gloves to restart
    if (fists[0].valid && fists[1].valid && readPos(fists[0].body).distanceTo(readPos(fists[1].body)) < 0.14) {
      game.touch = (game.touch || 0) + dt;
      if (game.touch > 0.6) restart();
    } else game.touch = 0;
  }
}
function restart() {
  boxer.remove(); boxer = new Boxer(1);
  player.hp = 100; game.state = 'intro'; game.clock = 3; game.round = 1; game.touch = 0;
  Object.assign(stats, { thrown: 0, landed: 0, dmg: 0, taken: 0, blocks: 0, dodges: 0, squats: 0, speedSum: 0, kcal: 0, time: 0 });
  combo.n = 0; combo.best = 0;
}
addEventListener('keydown', e => { if (e.code === 'KeyR' && game.state === 'down') restart(); });

renderer.xr.addEventListener('sessionstart', () => { resumeAudio(); camera.position.set(0, 0, 0); });
renderer.xr.addEventListener('sessionend', () => { camera.position.set(0, 1.65, 0); });

// ---------------------------------------------------------------- loop
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
  while (acc >= FIXED) {
    acc -= FIXED;
    boxer.think(FIXED, player.head);
    boxer.computePose(FIXED);
    boxer.drive(FIXED);
    driveFists(FIXED);
    world.step();
    processFistContacts();
  }
  updateGame(dt);
  trackWorkout(dt);
  for (const f of fists) {
    f.mesh.visible = f.valid && f.source !== 'hand'; // tracked hands draw themselves
    const t = f.body.translation(), r = f.body.rotation();
    f.mesh.position.set(t.x, t.y, t.z); f.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
  boxer.sync();
  particles.update(dt);
  updatePopups(dt);
  player.flash = Math.max(0, player.flash - dt * 2.5);
  hurtSphere.material.opacity = player.flash * 0.45;
  if ((boardT -= dt) <= 0) { boardT = 0.1; drawBoards(); }
  document.getElementById('hp').textContent = Math.round(player.hp);
  renderer.render(scene, camera);
});

window.boxing = { game, player, fists, stats, combo, get boxer() { return boxer; }, Boxer, restart, world };
