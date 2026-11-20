import * as THREE from 'three';
import { RAPIER, phys, GROUPS, hullDesc, removeBody } from './physics.js';
import { facet, lambert, makeSword, basisQuat } from './lowpoly.js';
import { sfx } from './audio.js';

// ---------------------------------------------------------------------------
// Enemy = hidden procedural "target skeleton" (two-bone IK, no keyframed
// animation, as Half Sword does) driving kinematic body parts while alive.
// On death every part becomes a dynamic rigid body: the core is jointed into a
// ragdoll, the rest is cut loose as separate pieces.
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

const UARM = 0.3, LARM = 0.29, THIGH = 0.44, SHIN = 0.44;

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
    this.hp = 170; this.dead = false;
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
    this.mats = [lambert(0xd41f3a, { emissive: 0x000000 }), lambert(0x8f1024, { emissive: 0x000000 })];
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0xffd23a });
    const G = geos();
    this.parts = {};
    for (const [key, type, mult, slot] of PARTS) {
      const group = new THREE.Group();
      for (const g of G[type]) { const m = new THREE.Mesh(g, this.mats[slot]); m.castShadow = true; group.add(m); }
      if (key === 'head') {
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
      part.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(ps.p.x, ps.p.y, ps.p.z).setRotation(ps.q));
      const col = w.createCollider(hullDesc(G[part.type]).setCollisionGroups(GROUPS.ealive), part.body);
      phys.info.set(col.handle, { kind: 'enemy', enemy: this, part: part.key });
    }
    const sp = this.pose.sword;
    this.swordBody = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(sp.p.x, sp.p.y, sp.p.z).setRotation(sp.q));
    const sc = w.createCollider(hullDesc(this.sword.bladeGeo).setCollisionGroups(GROUPS.esword), this.swordBody);
    phys.info.set(sc.handle, { kind: 'esword', enemy: this });
    this.applyPose();

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
        this.vy -= 9.81 * adt; this.root.y += this.vy * adt;
        handT = [0.35, 2.05, 0.1]; bladeT = [0.3, 1, -0.2]; handK = 8;
        this.marker.material.opacity = 0.5 + 0.4 * Math.sin(performance.now() / 80);
        if (this.root.y <= 0) {
          this.root.y = 0;
          ctx.onLand(this);
          ctx.scene.remove(this.marker);
          this.setState('land', 0.45);
        }
        turn = 0;
        break;
      }
      case 'land': {
        crouch = 0.28 * (1 - this.stateT / this.stateDur);
        if (this.stateT >= this.stateDur) this.setState('approach');
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
    this.applyPose();
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
    P.pelvis.p.copy(this.root).add(tA.set(0, 0.92 - bob - (this.crouch || 0), 0));
    P.pelvis.q.copy(pelvisQ);
    P.chest.p.copy(P.pelvis.p).add(tA.set(0, 0.08, 0).applyQuaternion(pelvisQ));
    P.chest.q.copy(chestQ);
    P.head.p.copy(P.chest.p).add(tA.set(0, 0.5, 0).applyQuaternion(chestQ));
    P.head.q.copy(chestQ);

    // arms
    for (const side of ['R', 'L']) {
      const sx = side === 'R' ? -0.22 : 0.22;
      const sh = P['uArm' + side].p.copy(P.chest.p).add(tA.set(sx, 0.44, 0).applyQuaternion(chestQ));
      const handLocal = side === 'R' ? this.hand : this.handL;
      const target = this.toWorld(handLocal, new THREE.Vector3());
      const pole = new THREE.Vector3().addScaledVector(fwd, -0.6).addScaledVector(rightW, side === 'R' ? 0.7 : -0.7).add(tA.set(0, -0.6, 0));
      const elbow = P['lArm' + side].p;
      const hand = new THREE.Vector3();
      twoBone(sh, target, UARM, LARM, pole, elbow, hand);
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
      const hx = side === 'R' ? -0.1 : 0.1;
      const hip = P['thigh' + side].p.copy(P.pelvis.p).add(tA.set(hx, -0.07, 0).applyQuaternion(pelvisQ));
      const ph = this.phase + (side === 'R' ? Math.PI : 0);
      let foot;
      if (this.state === 'fall') {
        foot = new THREE.Vector3(hip.x, hip.y - 0.8, hip.z).addScaledVector(fwd, Math.sin(performance.now() / 120 + ph) * 0.2);
      } else {
        foot = new THREE.Vector3(hip.x, 0.06 + Math.max(0, Math.cos(ph)) * lift, hip.z)
          .addScaledVector(moveDir, Math.sin(ph) * amp).addScaledVector(rightW, side === 'R' ? 0.03 : -0.03);
      }
      const pole = new THREE.Vector3().copy(fwd).add(tA.set(0, 0.2, 0));
      const knee = P['shin' + side].p;
      const ankle = new THREE.Vector3();
      twoBone(hip, foot, THIGH, SHIN, pole, knee, ankle);
      basisQuat(tA.subVectors(hip, knee), fwd, P['thigh' + side].q);
      basisQuat(tA.subVectors(knee, ankle), fwd, P['shin' + side].q);
    }
  }

  applyPose() {
    const f = this.flash;
    for (const m of this.mats) m.emissive.setRGB(f, f, f);
    for (const part of Object.values(this.parts)) {
      const ps = this.pose[part.key];
      part.mesh.position.copy(ps.p); part.mesh.quaternion.copy(ps.q);
      if (part.body) { part.body.setNextKinematicTranslation(ps.p); part.body.setNextKinematicRotation(ps.q); }
    }
    const sp = this.pose.sword;
    this.sword.group.position.copy(sp.p); this.sword.group.quaternion.copy(sp.q);
    if (this.swordBody) { this.swordBody.setNextKinematicTranslation(sp.p); this.swordBody.setNextKinematicRotation(sp.q); }
  }

  // Enemy blade segment vs a capsule around the player's head/torso.
  checkPlayerHit() {
    const P = this.ctx.player;
    const sp = this.pose.sword;
    const a = tA.set(0, this.sword.baseY, 0).applyQuaternion(sp.q).add(sp.p);
    const b = tB.set(0, this.sword.tipY, 0).applyQuaternion(sp.q).add(sp.p);
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
    if (this.state !== 'fall') this.setState('stagger', 0.3 + Math.min(0.3, hit.dmg / 150));
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
    const ctx = this.ctx, w = phys.world, G = geos();
    ctx.scene.remove(this.marker);
    const base = new THREE.Vector3().copy(this.vel).add(this.knock);
    const bodies = {};
    for (const part of Object.values(this.parts)) {
      const ps = this.pose[part.key];
      removeBody(part.body); part.body = null;
      const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(ps.p.x, ps.p.y, ps.p.z).setRotation(ps.q)
        .setLinearDamping(0.05).setAngularDamping(1.2));
      w.createCollider(hullDesc(G[part.type]).setDensity(985).setFriction(0.8).setRestitution(0.05).setCollisionGroups(GROUPS.piece), body);
      const f = Math.exp(-ps.p.distanceTo(hit.point) / 0.45);
      const v = tA.copy(base).addScaledVector(hit.dir, Math.min(hit.speed, 11) * (part.key === hit.part ? 0.85 : 0.45 * f)).addScaledVector(UP, 1.2 * f);
      body.setLinvel(v, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 8 * f, y: (Math.random() - 0.5) * 8 * f, z: (Math.random() - 0.5) * 8 * f }, true);
      bodies[part.key] = body;
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
      const pa = bodies[a], pb = bodies[b];
      const jp = this.pose[b].p;
      if (cuts.has(b)) {
        const out = tA.subVectors(jp, this.pose[a].p).normalize();
        const v = pb.linvel();
        pb.setLinvel({ x: v.x + out.x * 2 + (Math.random() - 0.5) * 2, y: v.y + 1.5 + Math.random() * 1.5, z: v.z + out.z * 2 + (Math.random() - 0.5) * 2 }, true);
        pb.setAngvel({ x: (Math.random() - 0.5) * 16, y: (Math.random() - 0.5) * 16, z: (Math.random() - 0.5) * 16 }, true);
        ctx.particles.emit('blood', jp, out, 18, 2.2);
        ctx.pieces.shards(jp, out, 2, 0xb3001b, 2);
        continue;
      }
      const qa = this.pose[a].q;
      const anchor = tB.subVectors(jp, this.pose[a].p).applyQuaternion(qA.copy(qa).invert());
      const j = w.createImpulseJoint(RAPIER.JointData.spherical({ x: anchor.x, y: anchor.y, z: anchor.z }, { x: 0, y: 0, z: 0 }), pa, pb, true);
      j.setContactsEnabled(false);
    }

    // the sword drops as a loose physics piece
    removeBody(this.swordBody); this.swordBody = null;
    this.sword.bladeMat.emissive.setRGB(0, 0, 0);
    const sp = this.pose.sword;
    const sb = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(sp.p.x, sp.p.y, sp.p.z).setRotation(sp.q).setAngularDamping(0.8));
    w.createCollider(hullDesc([this.sword.bladeGeo, this.sword.guardGeo, this.sword.gripGeo]).setDensity(3000).setFriction(0.6).setCollisionGroups(GROUPS.piece), sb);
    sb.setLinvel({ x: base.x + hit.dir.x * 2, y: 1.5, z: base.z + hit.dir.z * 2 }, true);
    sb.setAngvel({ x: Math.random() * 8 - 4, y: Math.random() * 8 - 4, z: Math.random() * 8 - 4 }, true);
    ctx.pieces.add(this.sword.group, sb, 35);

    ctx.pieces.shards(hit.point, hit.dir, Math.min(hit.speed, 10), 0xd41f3a, 8);
    ctx.particles.emit('blood', hit.point, hit.dir, 70, 3.5);
    for (const m of this.mats) m.emissive.setRGB(0, 0, 0);
    sfx.splat();
    ctx.onKill(this, hit);
  }

  destroy() {
    for (const part of Object.values(this.parts)) {
      if (part.body) removeBody(part.body);
      this.ctx.scene.remove(part.mesh);
    }
    if (this.swordBody) removeBody(this.swordBody);
    this.ctx.scene.remove(this.sword.group);
    this.ctx.scene.remove(this.marker);
    this.dead = true;
  }
}
