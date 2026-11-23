import * as THREE from 'three';
import { RAPIER, phys, GROUPS, removeBody } from './physics.js';
import { sfx } from './audio.js';

// The parasite: when its host gets within ~5 m of its target, the host freezes, the top of the
// skull hinges open and a long, stretchy tongue whips out. The tongue is a chain of segments
// solved with FABRIK toward a tip target the parasite steers like a fencer: guard, wind up,
// lash, parry. It can't be hurt (it clashes like a blade); only the frozen host's body can.

const N = 16, SEG = 0.3; // 4.8 m at rest, stretches a little further
const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a, b) => a + Math.random() * (b - a);
const smooth = t => t * t * (3 - 2 * t);
const COLLIDER_AT = Array.from({ length: N }, (_, i) => i + 1); // every joint: the whole tongue can be parried

export class Tongue {
  constructor(enemy) {
    this.e = enemy;
    const scene = enemy.ctx.scene;
    this.pts = Array.from({ length: N + 1 }, () => new THREE.Vector3());
    this.tip = new THREE.Vector3(); this.tipTarget = new THREE.Vector3();
    this.ext = 0; this.out = false; this.t = 0; this.lid = 0;
    this.sub = 'guard'; this.subT = 0; this.guardT = rnd(0.4, 0.9); this.thinkT = 0;
    this.side = 1; this.hit = false;

    // flesh chain + a bone barb at the tip
    const flesh = new THREE.MeshStandardMaterial({ color: 0xc4485a, roughness: 0.45, metalness: 0.05, flatShading: true });
    const unit = new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0);
    this.segs = [];
    for (let i = 0; i < N; i++) {
      const m = new THREE.Mesh(unit, flesh);
      m.castShadow = true; m.visible = false; m.frustumCulled = false;
      m.userData.r = 0.055 - 0.035 * (i / N);
      scene.add(m); this.segs.push(m);
    }
    // a rounded, slightly flattened tongue tip
    this.barb = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8).scale(0.048, 0.085, 0.028).translate(0, 0.045, 0), flesh);
    this.barb.visible = false; scene.add(this.barb);

    // a few kinematic balls along the outer tongue, so it physically clashes with your sword
    this.bodies = COLLIDER_AT.map(() => {
      const b = phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
      const c = phys.world.createCollider(RAPIER.ColliderDesc.ball(0.065).setCollisionGroups(GROUPS.none), b);
      phys.info.set(c.handle, { kind: 'esword', enemy });
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

  open() { if (!this.out && this.ext < 0.02) this.fresh = true; this.out = true; this.sub = 'guard'; this.subT = 0; this.guardT = rnd(0.3, 0.7); }
  close() { this.out = false; }
  get busy() { return this.out || this.ext > 0.02; }

  basePoint(out) {
    const b = this.e.parts.head.body, t = b.translation(), r = b.rotation();
    return out.copy(this.mouth).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(t.x, t.y, t.z));
  }

  // h: physics step. target: world point the parasite cares about ('player' or the button)
  update(h, mode) {
    const e = this.e, ctx = e.ctx, P = ctx.player;
    this.t += h;
    this.lid += ((this.out ? 1 : 0) - this.lid) * (1 - Math.exp(-10 * h));
    this.lidGroup.rotation.x = -this.lid * 1.9;
    this.ext += ((this.out && this.lid > 0.6 ? 1 : 0) - this.ext) * (1 - Math.exp(-(this.out ? 5 : 8) * h));
    const visible = this.ext > 0.02;
    for (const s of this.segs) s.visible = visible;
    this.barb.visible = visible;
    for (const { c } of this.bodies) c.setCollisionGroups(visible && this.out ? GROUPS.esword : GROUPS.none);
    if (!visible) { this.tip.copy(this.basePoint(new THREE.Vector3())); return; }

    const base = this.basePoint(new THREE.Vector3());
    if (this.fresh) { this.fresh = false; this.tip.copy(base); this.pts.forEach((p, i) => p.copy(base).addScaledVector(UP, 0.01 * i)); }
    const goalPt = mode === 'button' ? ctx.button.pos.clone() : P.head.clone().add(new THREE.Vector3(0, -0.3, 0));
    const toGoal = goalPt.clone().sub(base); const flat = toGoal.clone().setY(0).normalize();
    const side = new THREE.Vector3().crossVectors(UP, flat).normalize();
    const guard = base.clone().addScaledVector(flat, 1.5).add(new THREE.Vector3(0, 0.45, 0))
      .addScaledVector(side, Math.sin(this.t * 2.3) * 0.35).add(new THREE.Vector3(0, Math.cos(this.t * 1.7) * 0.25, 0));
    let k = 9;
    this.subT += h; this.thinkT -= h;

    if (mode === 'button') {
      // reach out and slap the spawn button
      this.tipTarget.copy(goalPt).add(new THREE.Vector3(0, 0.05, 0)); k = 6;
      if (this.tip.distanceTo(ctx.button.pos) < 0.2) { ctx.pressButton(e); e.tongueDone = true; }
    } else {
      // read the player's blade: if it's about to cut through the tongue, shrivel out of its way
      if (this.thinkT <= 0 && this.sub !== 'lash' && this.sub !== 'evade') {
        this.thinkT = rnd(0.04, 0.08);
        if (P.tipVel.length() > 2.5) {
          const path = new THREE.Line3(P.tip.clone(), P.tip.clone().addScaledVector(P.tipVel, 0.15));
          let best = Infinity, at = null;
          for (let i = 2; i <= N; i += 2) {
            const c = path.closestPointToPoint(this.pts[i], true, new THREE.Vector3());
            const d = c.distanceTo(this.pts[i]);
            if (d < best) { best = d; at = c; }
          }
          if (best < 0.4) {
            // away from where the blade will pass, mostly sideways
            const mid = this.pts[(N * 0.6) | 0];
            this.evadeDir = mid.clone().sub(at).setY(0);
            if (this.evadeDir.lengthSq() < 1e-4) this.evadeDir.copy(side);
            this.evadeDir.normalize();
            this.sub = 'evade'; this.subT = 0;
          }
        }
      }
      switch (this.sub) {
        case 'guard':
          this.tipTarget.copy(guard);
          if (this.subT > this.guardT) this.startWindup(goalPt, flat, side);
          break;
        case 'windup': // swing the tongue out wide to one side, past the target
          this.tipTarget.copy(this.lashFrom).add(new THREE.Vector3(0, 0.35, 0)); k = 7;
          if (this.subT > 0.5) { this.sub = 'lash'; this.subT = 0; this.hit = false; }
          break;
        case 'lash': { // sweep across behind the target: the last metre of tongue cuts through it
          const u = Math.min(1, this.subT / 0.45);
          this.tipTarget.lerpVectors(this.lashFrom, this.lashTo, smooth(u)); k = 20;
          if (!this.hit) this.checkHit();
          if (u >= 1) { this.sub = 'recover'; this.subT = 0; }
          break;
        }
        case 'recover':
          this.tipTarget.copy(guard); k = 7;
          if (this.subT > 0.45) { this.sub = 'guard'; this.subT = 0; this.guardT = rnd(0.4, 1.0); }
          break;
        case 'evade': { // contract a little and slip aside, just enough to miss
          this.tipTarget.copy(this.tip).sub(base).multiplyScalar(0.68).add(base).addScaledVector(this.evadeDir, 0.35).add(new THREE.Vector3(0, 0.12, 0)); k = 20;
          if (this.subT > 0.28) { this.sub = 'guard'; this.subT = 0; this.guardT = Math.random() < 0.55 ? 0.05 : 0.3; }
          break;
        }
      }
    }
    // the tip can't go further than the (stretchy) tongue reaches
    const maxLen = N * SEG * 1.3 * this.ext;
    const d = this.tipTarget.clone().sub(base);
    if (d.length() > maxLen) this.tipTarget.copy(base).addScaledVector(d.normalize(), maxLen);
    this.tip.lerp(this.tipTarget, 1 - Math.exp(-k * h));
    this.solve(base);

    // place segments, barb and colliders
    for (let i = 0; i < N; i++) {
      const a = this.pts[i], b = this.pts[i + 1], m = this.segs[i];
      const dir = b.clone().sub(a), len = dir.length() || 1e-3;
      m.position.copy(a); m.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
      const r = m.userData.r * (0.6 + 0.4 * this.ext) * (this.sub === 'evade' ? 0.78 : 1);
      m.scale.set(r, len, r);
    }
    const tdir = this.pts[N].clone().sub(this.pts[N - 1]).normalize();
    this.barb.position.copy(this.pts[N]); this.barb.quaternion.setFromUnitVectors(UP, tdir);
    COLLIDER_AT.forEach((i, j) => this.bodies[j].b.setNextKinematicTranslation(this.pts[i]));
  }

  // FABRIK from the mouth to the tip, then a living wiggle along the middle
  solve(base) {
    // stretchy: it's only ever as long as the reach needs (+12% slack for a soft arc),
    // so it never folds up into loops
    const reach = this.tip.distanceTo(base);
    const pts = this.pts, L = Math.min(SEG * 1.3, Math.max(0.02, reach * 1.12 / N));
    pts[0].copy(base);
    if (reach >= L * N * 0.999) { // fully out: stretch in a line
      const dir = this.tip.clone().sub(base).normalize();
      for (let i = 1; i <= N; i++) pts[i].copy(base).addScaledVector(dir, (reach / N) * i);
    } else {
      // keep the previous shape as the starting guess (gives the tongue momentum)
      for (let it = 0; it < 4; it++) {
        pts[N].copy(this.tip);
        for (let i = N - 1; i >= 0; i--) { pts[i].sub(pts[i + 1]); if (pts[i].lengthSq() < 1e-8) pts[i].set(0, -1e-3, 0); pts[i].setLength(L).add(pts[i + 1]); }
        pts[0].copy(base);
        for (let i = 1; i <= N; i++) { pts[i].sub(pts[i - 1]); if (pts[i].lengthSq() < 1e-8) pts[i].set(0, 1e-3, 0); pts[i].setLength(L).add(pts[i - 1]); }
      }
    }
    const axis = this.tip.clone().sub(base).normalize();
    const perp = new THREE.Vector3().crossVectors(axis, UP); if (perp.lengthSq() < 1e-4) perp.set(1, 0, 0); perp.normalize();
    const perp2 = new THREE.Vector3().crossVectors(axis, perp).normalize();
    for (let i = 1; i < N; i++) {
      const f = i / N, env = Math.sin(f * Math.PI) * (this.sub === 'evade' ? 0.16 : 0.09);
      pts[i].addScaledVector(perp, Math.sin(this.t * 7 + i * 0.8) * env).addScaledVector(perp2, Math.cos(this.t * 5 + i * 0.6) * env * 0.7);
    }
  }

  // pick a side; the sweep runs behind the target from that side to the other, about 0.8 m
  // beyond it, so the tongue's line passes through the target mid-sweep
  startWindup(goalPt, flat, side) {
    this.side = Math.random() < 0.5 ? 1 : -1;
    const behind = goalPt.clone().addScaledVector(flat, 0.8).add(new THREE.Vector3(0, rnd(-0.1, 0.25), 0));
    this.lashFrom = behind.clone().addScaledVector(side, 1.2 * this.side);
    this.lashTo = behind.clone().addScaledVector(side, -1.2 * this.side);
    this.sub = 'windup'; this.subT = 0;
  }

  // the barbed end and the last stretch of tongue against the player's head/torso
  checkHit() {
    const P = this.e.ctx.player;
    const top = P.head, bot = new THREE.Vector3(P.head.x, P.head.y - 0.8, P.head.z);
    for (let s = N - 4; s < N; s++) { // the last ~1.2 m of tongue does the hitting
      const seg = new THREE.Line3(this.pts[s], this.pts[s + 1]);
      for (let i = 0; i <= 5; i++) {
        const q = new THREE.Vector3().lerpVectors(top, bot, i / 5);
        if (seg.closestPointToPoint(q, true, new THREE.Vector3()).distanceTo(q) < (i === 0 ? 0.12 : 0.18)) {
          this.hit = true; this.e.ctx.damagePlayer(12, this.e); sfx.hit(0.5); return;
        }
      }
    }
  }

  // a clash against the player's blade during a lash throws the tongue back
  clashed() {
    // parried mid-lash: it recoils; otherwise it flinches away
    if (this.sub === 'lash') { this.sub = 'recover'; this.subT = 0; this.tip.addScaledVector(this.e.ctx.player.tipVel, 0.03); }
    else if (this.sub !== 'evade') { this.evadeDir = this.e.ctx.player.tipVel.clone().setY(0).normalize(); this.sub = 'evade'; this.subT = 0; }
  }

  destroy() {
    const scene = this.e.ctx.scene;
    for (const s of this.segs) scene.remove(s);
    scene.remove(this.barb);
    for (const { b } of this.bodies) removeBody(b);
    this.bodies = [];
  }
}
