import * as THREE from 'three';
import { RAPIER, phys, GROUPS, removeBody } from './physics.js';
import { sfx } from './audio.js';

// The parasite: when its host gets within ~4.5 m of its target, the host freezes, the top of the
// skull hinges open and a long, stretchy tongue comes out and whips at the target nonstop.
// The tongue works like the prisoner's armour: each segment takes 2-3 sword hits, and breaking
// one severs it and everything beyond it. Any part of the moving tongue hurts on contact.
// Only killing the frozen host's body kills the parasite.

const N = 16, SEG = 0.3; // 4.8 m at rest, stretches a little further
const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const smooth = t => t * t * (3 - 2 * t);
const CONTACT_DMG = 7;

export class Tongue {
  constructor(enemy) {
    this.e = enemy;
    const scene = enemy.ctx.scene;
    this.pts = Array.from({ length: N + 1 }, () => new THREE.Vector3());
    this.prev = Array.from({ length: N + 1 }, () => new THREE.Vector3());
    this.tip = new THREE.Vector3(); this.tipTarget = new THREE.Vector3();
    this.ext = 0; this.out = false; this.t = 0; this.lid = 0;
    this.sub = 'windup'; this.subT = 0; this.side = 1;
    this.alive = N; this.gone = false; this.hurtCd = 0;
    this.segHp = new Array(N).fill(4); // a strong blow takes 2, a light tap 1
    this.hitCd = new Array(N).fill(0);

    this.flesh = new THREE.MeshStandardMaterial({ color: 0xc4485a, roughness: 0.45, metalness: 0.05, flatShading: true });
    this.unit = new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0);
    this.segs = [];
    for (let i = 0; i < N; i++) {
      const m = new THREE.Mesh(this.unit, this.flesh);
      m.castShadow = true; m.visible = false; m.frustumCulled = false;
      m.userData.r = 0.055 - 0.035 * (i / N);
      scene.add(m); this.segs.push(m);
    }
    // a rounded, slightly flattened tongue tip
    this.barb = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8).scale(0.048, 0.085, 0.028).translate(0, 0.045, 0), this.flesh);
    this.barb.visible = false; scene.add(this.barb);

    // one kinematic ball per joint: the sword physically meets every part of the tongue
    this.bodies = Array.from({ length: N }, (_, i) => {
      const b = phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
      const c = phys.world.createCollider(RAPIER.ColliderDesc.ball(0.065).setCollisionGroups(GROUPS.none), b);
      phys.info.set(c.handle, { kind: 'tongue', tongue: this, idx: i });
      return { b, c };
    });

    this.splitHead();
  }

  // cut the head mesh so the top of the skull is a lid hinged at the back
  splitHead() {
    const head = this.e.parts.head.mesh;
    const meshes = head.children.filter(o => o.isMesh);
    const box = new THREE.Box3();
    for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox); }
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const cutY = box.min.y + size.y * 0.47;
    this.hinge = new THREE.Vector3(c.x, cutY, box.min.z);
    this.mouth = new THREE.Vector3(c.x, cutY, c.z);
    this.lidGroup = new THREE.Group();
    this.lidGroup.position.copy(this.hinge);
    head.add(this.lidGroup);
    for (const m of meshes) {
      const g = m.geometry, pos = g.attributes.position, uv = g.attributes.uv;
      const lo = { p: [], u: [] }, hi = { p: [], u: [] };
      for (let t = 0; t < pos.count; t += 3) {
        const cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
        const dst = cy > cutY ? hi : lo;
        for (let k = 0; k < 3; k++) {
          const off = dst === hi ? this.hinge : null;
          dst.p.push(pos.getX(t + k) - (off ? off.x : 0), pos.getY(t + k) - (off ? off.y : 0), pos.getZ(t + k) - (off ? off.z : 0));
          if (uv) dst.u.push(uv.getX(t + k), uv.getY(t + k));
        }
      }
      const make = d => { const ng = new THREE.BufferGeometry(); ng.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3)); if (d.u.length) ng.setAttribute('uv', new THREE.Float32BufferAttribute(d.u, 2)); ng.computeVertexNormals(); return ng; };
      m.geometry = make(lo); // the shared model geometry is left untouched
      const lid = new THREE.Mesh(make(hi), m.material); lid.castShadow = true;
      this.lidGroup.add(lid);
    }
    // the wet cavity you see once it opens
    const cav = new THREE.Mesh(new THREE.CircleGeometry(Math.min(size.x, size.z) * 0.42, 8).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4a0612 }));
    cav.position.set(c.x, cutY - 0.004, c.z);
    head.add(cav);
    const roof = new THREE.Mesh(new THREE.CircleGeometry(Math.min(size.x, size.z) * 0.5, 10).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x8e2333, roughness: 0.4, side: THREE.DoubleSide }));
    roof.position.set(c.x - this.hinge.x, 0.004, c.z - this.hinge.z);
    this.lidGroup.add(roof);
  }

  open() { if (this.gone) return; if (!this.out && this.ext < 0.02) this.fresh = true; this.out = true; this.ready = null; }
  close() { this.out = false; }
  get busy() { return this.out || this.ext > 0.02; }

  basePoint(out) {
    const b = this.e.parts.head.body, t = b.translation(), r = b.rotation();
    return out.copy(this.mouth).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  }

  update(h, mode) {
    const e = this.e, ctx = e.ctx, P = ctx.player;
    this.t += h; this.hurtCd -= h;
    this.lid += ((this.out ? 1 : 0) - this.lid) * (1 - Math.exp(-10 * h));
    this.lidGroup.rotation.x = -this.lid * 1.9;
    this.ext += ((this.out && this.lid > 0.6 && !this.gone ? 1 : 0) - this.ext) * (1 - Math.exp(-(this.out ? 5 : 8) * h));
    const visible = this.ext > 0.02 && this.alive > 0;
    for (let i = 0; i < N; i++) this.segs[i].visible = visible && i < this.alive;
    this.barb.visible = visible && this.alive === N;
    for (let i = 0; i < N; i++) this.bodies[i].c.setCollisionGroups(visible && this.out && i < this.alive ? GROUPS.esword : GROUPS.none);
    if (!visible) { this.tip.copy(this.basePoint(new THREE.Vector3())); return; }

    const base = this.basePoint(new THREE.Vector3());
    if (this.fresh) { this.fresh = false; this.tip.copy(base); this.pts.forEach((p, i) => p.copy(base).addScaledVector(UP, 0.01 * i)); }
    const goalPt = mode === 'button' ? ctx.button.pos.clone() : P.head.clone().add(new THREE.Vector3(0, -0.3, 0));
    const flat = goalPt.clone().sub(base).setY(0).normalize();
    const side = new THREE.Vector3().crossVectors(UP, flat).normalize();
    let k;
    this.subT += h;

    if (mode === 'button') {
      this.tipTarget.copy(goalPt).add(new THREE.Vector3(0, 0.05, 0)); k = 6;
      if (this.tip.distanceTo(ctx.button.pos) < 0.2) { ctx.pressButton(e); e.tongueDone = true; }
    } else {
      // nonstop whip, always in front: coil up between host and target, strike straight out
      // through the target, snap back a little, coil again
      if (!this.ready) this.startWindup(goalPt, flat, side);
      if (this.sub === 'windup') {
        this.tipTarget.copy(this.ready); k = 8;
        if (this.subT > 0.35) { this.sub = 'strike'; this.subT = 0; this.strikeTo = goalPt.clone().addScaledVector(flat, 0.35).addScaledVector(side, rnd(-0.2, 0.2)).add(new THREE.Vector3(0, rnd(0, 0.25), 0)); }
      } else if (this.sub === 'strike') {
        const u = Math.min(1, this.subT / 0.55); // a deliberate lunge, not a snap
        this.tipTarget.lerpVectors(this.ready, this.strikeTo, Math.pow(u, 1.4)); k = 16; // accelerates into the target
        if (this.subT >= 0.7) { this.sub = 'recoil'; this.subT = 0; } // brief hold at full reach
      } else { // recoil: come back part of the way, then set up the next strike
        this.tipTarget.lerpVectors(this.strikeTo, this.ready, 0.6); k = 10;
        if (this.subT > 0.3) this.startWindup(goalPt, flat, side);
      }
    }
    // keep the tip where the player can see it: within 55 deg of their view direction
    if (mode !== 'button' && P.forward && this.sub !== 'strike') { // (the lunge itself has to reach the body)
      const v = this.tipTarget.clone().sub(P.head), dist = v.length();
      if (dist > 0.05) {
        const dir = v.divideScalar(dist), c = dir.dot(P.forward), lim = Math.cos(55 * Math.PI / 180);
        if (c < lim) {
          const u = dir.addScaledVector(P.forward, -c);
          if (u.lengthSq() > 1e-6) { u.normalize(); this.tipTarget.copy(P.head).addScaledVector(P.forward, lim * dist).addScaledVector(u, Math.sin(55 * Math.PI / 180) * dist); }
        }
      }
    }
    const maxLen = this.alive * SEG * 1.3 * this.ext;
    const d = this.tipTarget.clone().sub(base);
    if (d.length() > maxLen) this.tipTarget.copy(base).addScaledVector(d.normalize(), maxLen);
    this.tip.lerp(this.tipTarget, 1 - Math.exp(-k * h));
    for (let i = 0; i <= this.alive; i++) this.prev[i].copy(this.pts[i]);
    this.solve(base);

    const n = this.alive;
    for (let i = 0; i < n; i++) {
      const a = this.pts[i], b = this.pts[i + 1], m = this.segs[i];
      const dir = b.clone().sub(a), len = dir.length() || 1e-3;
      m.position.copy(a); m.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
      const r = m.userData.r * (0.6 + 0.4 * this.ext);
      m.scale.set(r, len, r);
    }
    const tdir = this.pts[n].clone().sub(this.pts[n - 1]).normalize();
    this.barb.position.copy(this.pts[n]); this.barb.quaternion.setFromUnitVectors(UP, tdir);
    for (let i = 0; i < n; i++) this.bodies[i].b.setNextKinematicTranslation(this.pts[i + 1]);
    if (this.out && mode !== 'button') this.checkHit(h);
  }

  // the coil point sits between host and target, a bit high and varied left/right/overhead
  startWindup(goalPt, flat, side) {
    const base = this.basePoint(new THREE.Vector3());
    const span = Math.max(0.8, Math.min(2.2, base.clone().setY(0).distanceTo(goalPt.clone().setY(0)) * 0.45));
    this.ready = base.clone().addScaledVector(flat, span).addScaledVector(side, rnd(-0.5, 0.5)).add(new THREE.Vector3(0, rnd(0.5, 1.0), 0));
    this.sub = 'windup'; this.subT = 0;
  }

  // FABRIK from the mouth to the tip over the segments that are left, plus a living wiggle
  solve(base) {
    const pts = this.pts, n = this.alive;
    const reach = this.tip.distanceTo(base);
    const L = Math.min(SEG * 1.3, Math.max(0.02, reach * 1.12 / n));
    pts[0].copy(base);
    if (reach >= L * n * 0.999) {
      const dir = this.tip.clone().sub(base).normalize();
      for (let i = 1; i <= n; i++) pts[i].copy(base).addScaledVector(dir, (reach / n) * i);
    } else {
      for (let it = 0; it < 4; it++) {
        pts[n].copy(this.tip);
        for (let i = n - 1; i >= 0; i--) { pts[i].sub(pts[i + 1]); if (pts[i].lengthSq() < 1e-8) pts[i].set(0, -1e-3, 0); pts[i].setLength(L).add(pts[i + 1]); }
        pts[0].copy(base);
        for (let i = 1; i <= n; i++) { pts[i].sub(pts[i - 1]); if (pts[i].lengthSq() < 1e-8) pts[i].set(0, 1e-3, 0); pts[i].setLength(L).add(pts[i - 1]); }
      }
    }
    const axis = this.tip.clone().sub(base).normalize();
    const perp = new THREE.Vector3().crossVectors(axis, UP); if (perp.lengthSq() < 1e-4) perp.set(1, 0, 0); perp.normalize();
    const perp2 = new THREE.Vector3().crossVectors(axis, perp).normalize();
    for (let i = 1; i < n; i++) {
      const f = i / n, env = Math.sin(f * Math.PI) * 0.09;
      pts[i].addScaledVector(perp, Math.sin(this.t * 7 + i * 0.8) * env).addScaledVector(perp2, Math.cos(this.t * 5 + i * 0.6) * env * 0.7);
    }
  }

  // any moving part of the tongue that strikes the player's head/torso hurts
  checkHit(h) {
    if (this.hurtCd > 0) return;
    const P = this.e.ctx.player;
    const top = P.head, bot = new THREE.Vector3(P.head.x, P.head.y - 0.8, P.head.z);
    for (let s = 1; s < this.alive; s++) {
      if (this.pts[s + 1].distanceTo(this.prev[s + 1]) / h < 1.5) continue; // resting tongue doesn't hurt
      const seg = new THREE.Line3(this.pts[s], this.pts[s + 1]);
      for (let i = 0; i <= 5; i++) {
        const q = new THREE.Vector3().lerpVectors(top, bot, i / 5);
        if (seg.closestPointToPoint(q, true, new THREE.Vector3()).distanceTo(q) < (i === 0 ? 0.12 : 0.18) + this.segs[s].userData.r) {
          this.hurtCd = 1.1; this.e.ctx.damagePlayer(CONTACT_DMG, this.e); sfx.hit(0.45);
          const push = this.pts[s + 1].clone().sub(this.prev[s + 1]).setY(0);
          if (push.lengthSq() < 1e-6) push.copy(q).sub(this.pts[0]).setY(0);
          if (this.e.ctx.knockPlayer) this.e.ctx.knockPlayer(push);
          return;
        }
      }
    }
  }

  // the player's blade hit segment i
  hitSegment(i, pt, v) {
    if (i >= this.alive || this.gone) return false;
    const ctx = this.e.ctx;
    const strong = v.length() > 6;
    this.segHp[i] -= strong ? 2 : 1;
    ctx.particles.emit('blood', pt, v.clone().normalize(), strong ? 8 : 4, 2);
    sfx.thump(strong ? 0.5 : 0.25);
    if (this.segHp[i] > 0) return true;
    this.sever(i, v);
    return true;
  }

  // break segment i: it and everything beyond it fall off as flesh debris
  sever(i, v) {
    const ctx = this.e.ctx, pieces = ctx.pieces;
    for (let s = i; s < this.alive; s++) {
      const m = this.segs[s];
      const len = m.scale.y, r = Math.max(0.02, m.scale.x);
      const piece = new THREE.Mesh(this.unit, this.flesh);
      piece.scale.copy(m.scale); piece.position.copy(m.position); piece.quaternion.copy(m.quaternion);
      ctx.scene.add(piece);
      const body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(m.position.x, m.position.y, m.position.z).setRotation(m.quaternion).setAngularDamping(0.8));
      phys.world.createCollider(RAPIER.ColliderDesc.cuboid(r, Math.max(0.02, len / 2), r).setTranslation(0, len / 2, 0).setDensity(1100).setCollisionGroups(GROUPS.piece), body);
      const pv = this.pts[s + 1].clone().sub(this.prev[s + 1]).multiplyScalar(30).clampLength(0, 6);
      body.setLinvel({ x: pv.x + v.x * 0.25, y: pv.y + 1, z: pv.z + v.z * 0.25 }, true);
      body.setAngvel({ x: rnd(-8, 8), y: rnd(-8, 8), z: rnd(-8, 8) }, true);
      pieces.add(piece, body, 20, { loose: true, limb: true });
      ctx.particles.emit('blood', m.position.clone(), null, 4, 1.5);
    }
    this.alive = i;
    ctx.particles.emit('blood', this.pts[i].clone(), v.clone().normalize(), 18, 2.5);
    sfx.splat(); sfx.grunt(0.8, this.e.voice * 0.7);
    if (this.alive === 0) { this.gone = true; this.out = false; }
  }

  destroy() {
    const scene = this.e.ctx.scene;
    for (const s of this.segs) scene.remove(s);
    scene.remove(this.barb);
    for (const { b } of this.bodies) removeBody(b);
    this.bodies = [];
  }
}
