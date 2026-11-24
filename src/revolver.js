import * as THREE from 'three';
import { RAPIER, phys, GROUPS, G, grp } from './physics.js';
import { gunSfx, playSound } from './audio.js';

// Six-shooter, following REVOLVER_MECHANICS.md. Gun-local axes: +Y up, -Z bore, origin = grip
// (the point in the palm). Held: it follows the hand. Dropped: a rigid body.

const BORE_Y = 0.06, MUZZLE_Z = -0.245, V0 = 260, GRAV = 9.81, RANGE = 150, ZERO = 15;
const REAR = { y: 0.0815, z: -0.012 }, FRONT_Z = -0.196;
const drop = r => 0.5 * GRAV * (r / V0) ** 2;
const ZERO_Y = BORE_Y - drop(ZERO);
const FRONT_Y = REAR.y + (ZERO_Y - REAR.y) * (REAR.z - FRONT_Z) / (REAR.z + ZERO);
const BULLET_Q = grp(G.PSWORD, G.GROUND | G.EALIVE | G.ESWORD | G.PIECE | G.DEBRIS);
const CHAINS_LIMBS = new Set(['uArmL', 'lArmL', 'uArmR', 'lArmR', 'thighL', 'shinL', 'thighR', 'shinR']);
const DMG = 75, PUSH = 26, LIMB_SHOTS = 3; // a limb that eats LIMB_SHOTS bullets comes off
const rnd = (a, b) => a + Math.random() * (b - a);
const TAU = Math.PI * 2;

export class Revolver {
  constructor(game) {
    this.g = game; // { scene, world, particles, enemies, pulse, player, holster(), pouch() }
    this.state = 'holstered'; this.hand = null; this.tween = 0; this.tweenFrom = null;
    this.cocked = false; this.chamber = 0; this.chambers = new Array(6).fill('live'); this.triggerArmed = true;
    this.open = false; this.openT = 0; this.ejected = false; this.crane = 0;
    this.cylAngle = 0; this.cylTarget = 0; this.freeSpin = 0; this.lastDetent = 0;
    this.hammer = 0; this.trig = 0;
    this.rec = { ang: [0, 0], z: [0, 0], yaw: [0, 0] };
    this.twirl = 0; this.twirlV = 0; this.twirlCd = 0; this.fanCd = 0; this.feedT = 0;
    this.roundsHand = null; this.flashT = 0; this.clatterCd = 0; this.recallT = 0;
    this.build();
    this.puffs = []; this.wisp = 0; this.wispT = 0;
    this.puffGeo = new THREE.IcosahedronGeometry(1, 0);
  }

  build() {
    const steel = new THREE.MeshStandardMaterial({ color: 0x3b3f45, metalness: 0.8, roughness: 0.35, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.6, roughness: 0.5, flatShading: true });
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.7, flatShading: true });
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 0.8, roughness: 0.3, flatShading: true });
    this.mats = { steel, dark, wood, brass };
    const root = this.root = new THREE.Group();
    const twirl = this.twirlPivot = new THREE.Group(); twirl.position.set(0, 0.022, -0.012); root.add(twirl);
    const rp = this.recoilPivot = new THREE.Group(); rp.position.set(0, -0.022, 0.012); twirl.add(rp);
    const add = (geo, mat, x, y, z, parent = rp) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
    add(new THREE.BoxGeometry(0.028, 0.04, 0.1), steel, 0, 0.055, -0.035);                                 // frame
    add(new THREE.CylinderGeometry(0.0085, 0.0085, 0.19, 8).rotateX(Math.PI / 2), steel, 0, BORE_Y, -0.15); // barrel
    add(new THREE.CylinderGeometry(0.004, 0.004, 0.13, 6).rotateX(Math.PI / 2), dark, 0, BORE_Y - 0.014, -0.15); // ejector rod
    const grip = add(new THREE.BoxGeometry(0.026, 0.1, 0.036), wood, 0, -0.005, 0.03); grip.rotation.x = -0.35;
    add(new THREE.TorusGeometry(0.018, 0.003, 4, 8, Math.PI).rotateY(Math.PI / 2), steel, 0, 0.022, -0.02); // trigger guard
    // sights: rear notch (two posts) and a front blade with a brass bead
    add(new THREE.BoxGeometry(0.006, 0.006, 0.008), steel, -0.005, REAR.y - 0.002, REAR.z);
    add(new THREE.BoxGeometry(0.006, 0.006, 0.008), steel, 0.005, REAR.y - 0.002, REAR.z);
    add(new THREE.BoxGeometry(0.003, FRONT_Y - BORE_Y, 0.012), steel, 0, (FRONT_Y + BORE_Y) / 2 - 0.002, FRONT_Z);
    add(new THREE.SphereGeometry(0.0022, 6, 4), brass, 0, FRONT_Y, FRONT_Z);
    // hammer and trigger on their pins
    this.hammerPin = new THREE.Group(); this.hammerPin.position.set(0, 0.07, 0.012); rp.add(this.hammerPin);
    add(new THREE.BoxGeometry(0.007, 0.022, 0.01), steel, 0, 0.008, 0.004, this.hammerPin);
    this.spur = add(new THREE.BoxGeometry(0.008, 0.006, 0.014), dark, 0, 0.02, 0.012, this.hammerPin);
    this.triggerPin = new THREE.Group(); this.triggerPin.position.set(0, 0.035, -0.008); rp.add(this.triggerPin);
    add(new THREE.BoxGeometry(0.005, 0.02, 0.006), steel, 0, -0.01, 0, this.triggerPin);
    // crane + cylinder (swings out to the left)
    this.cranePin = new THREE.Group(); this.cranePin.position.set(-0.012, BORE_Y - 0.02, -0.04); rp.add(this.cranePin);
    this.cyl = new THREE.Group(); this.cyl.position.set(0.012, 0.02, 0); this.cranePin.add(this.cyl);
    add(new THREE.CylinderGeometry(0.021, 0.021, 0.045, 12).rotateX(Math.PI / 2), steel, 0, 0, 0, this.cyl);
    this.rounds = [];
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * TAU;
      const r = add(new THREE.CylinderGeometry(0.0055, 0.0055, 0.003, 8).rotateX(Math.PI / 2), brass, Math.cos(a) * 0.012, Math.sin(a) * 0.012, 0.0235, this.cyl);
      this.rounds.push(r);
    }
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.flash.position.set(0, BORE_Y, MUZZLE_Z - 0.03); this.flash.visible = false; rp.add(this.flash);
    this.g.scene.add(root);
    // rigid body: kinematic while held/holstered, dynamic once dropped
    this.body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -20, 0));
    this.col = phys.world.createCollider(RAPIER.ColliderDesc.cuboid(0.016, 0.03, 0.12).setTranslation(0, 0.045, -0.09).setDensity(1100).setFriction(0.7).setCollisionGroups(GROUPS.none), this.body);
    phys.world.createCollider(RAPIER.ColliderDesc.cuboid(0.014, 0.05, 0.02).setTranslation(0, -0.005, 0.03).setDensity(1100).setCollisionGroups(GROUPS.none), this.body);
    // the round cluster a hand holds while reloading
    this.cluster = new THREE.Group();
    for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.0055, 0.0055, 0.03, 6), brass); m.position.set((i % 3) * 0.012 - 0.012, 0, (i / 3 | 0) * 0.012); this.cluster.add(m); }
    this.cluster.visible = false; this.g.scene.add(this.cluster);
  }

  get held() { return this.state === 'held'; }
  muzzleRay() {
    const o = new THREE.Vector3(0, BORE_Y, MUZZLE_Z).applyMatrix4(this.recoilPivot.matrixWorld);
    const d = new THREE.Vector3(0, 0, -1).transformDirection(this.recoilPivot.matrixWorld);
    return { o, d };
  }

  // a hand squeezed: grab the gun if it's within reach (or in its holster)
  tryGrab(hand) {
    if (this.held) return false;
    const grip = this.root.getWorldPosition(new THREE.Vector3());
    if (hand.pos.distanceTo(grip) > 0.2) return false;
    this.setBody('kinematic');
    this.state = 'held'; this.hand = hand.side; this.tween = 0.08; this.tweenFrom = { p: grip.clone(), q: this.root.quaternion.clone() };
    this.g.pulse(hand.side, 0.3, 30);
    return true;
  }

  release(hand) {
    if (!this.held || hand.side !== this.hand) return;
    this.cocked = false; if (this.open) this.closeCylinder(false);
    this.twirl = 0; this.twirlV = 0;
    const h = this.g.holster();
    if (hand.pos.distanceTo(h.p) < 0.22) { this.state = 'holstering'; this.tween = 0.18; this.tweenFrom = { p: this.root.position.clone(), q: this.root.quaternion.clone() }; gunSfx.holster(); return; }
    this.state = 'dropped'; this.hand = null;
    this.setBody('dynamic');
    this.body.setLinvel(hand.avgVel, true); this.body.setAngvel(hand.avgAngVel, true);
  }

  recall() {
    if (this.state !== 'dropped') return;
    this.state = 'recalling'; this.tween = 0.35; this.tweenFrom = { p: this.root.position.clone(), q: this.root.quaternion.clone() };
    this.setBody('kinematic');
  }

  setBody(kind) {
    const w = phys.world;
    if (kind === 'dynamic') {
      this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      for (let i = 0; i < this.body.numColliders(); i++) this.body.collider(i).setCollisionGroups(GROUPS.piece);
      phys.info.set(this.col.handle, { kind: 'gun' });
    } else {
      this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
      for (let i = 0; i < this.body.numColliders(); i++) this.body.collider(i).setCollisionGroups(GROUPS.none);
    }
  }

  // ---------------------------------------------------------------- per frame
  update(dt, hands) {
    const gh = this.hand ? hands[this.hand] : null;
    const other = this.hand ? hands[this.hand === 'right' ? 'left' : 'right'] : null;
    this.fanCd -= dt; this.twirlCd -= dt; this.clatterCd -= dt; this.flashT -= dt;
    this.flash.visible = this.flashT > 0;
    this.updatePuffs(dt);
    if (this.wisp > 0) { // smoke curling up out of a hot barrel
      this.wisp -= dt; this.wispT -= dt;
      if (this.wispT <= 0) {
        this.wispT = 0.05;
        const { o } = this.muzzleRay();
        this.puff(o, new THREE.Vector3(rnd(-0.03, 0.03), 0.12, rnd(-0.03, 0.03)), { size: 0.008, grow: 0.05 * this.wisp, life: 1.1, opacity: 0.35 * Math.min(1, this.wisp), drag: 1, rise: 0.15 });
      }
    }

    // where the gun goes
    const hol = this.g.holster();
    if (this.state === 'holstered') {
      this.root.position.copy(hol.p); this.root.quaternion.copy(hol.q);
      // sitting in the holster tops the cylinder back up, one round every 0.4 s, with a faint click
      const need = this.chambers.findIndex(c => c !== 'live');
      if (need < 0) this.refillT = 0.4;
      else if ((this.refillT = (this.refillT ?? 0.4) - dt) <= 0) { this.chambers[need] = 'live'; this.refillT = 0.4; gunSfx.insert(0.035); }
    }
    else if (this.state === 'holstering' || this.state === 'recalling') {
      this.tween -= dt; const t = 1 - Math.max(0, this.tween) / (this.state === 'holstering' ? 0.18 : 0.35);
      this.root.position.lerpVectors(this.tweenFrom.p, hol.p, t); this.root.quaternion.slerpQuaternions(this.tweenFrom.q, hol.q, t);
      if (this.tween <= 0) this.state = 'holstered';
    } else if (this.held && gh) {
      if (this.tween > 0) {
        this.tween -= dt; const t = 1 - Math.max(0, this.tween) / 0.08;
        this.root.position.lerpVectors(this.tweenFrom.p, gh.pos, t); this.root.quaternion.slerpQuaternions(this.tweenFrom.q, gh.q, t);
      } else { this.root.position.copy(gh.pos); this.root.quaternion.copy(gh.q); }
    } else if (this.state === 'dropped') {
      const t = this.body.translation(), r = this.body.rotation();
      this.root.position.set(t.x, t.y, t.z); this.root.quaternion.set(r.x, r.y, r.z, r.w);
      // lost: falls out of the world or ends up far away -> back to the holster
      if (t.y < -2 || this.root.position.distanceTo(this.g.player.head) > 60) this.recall();
      const v = this.body.linvel(), sp = Math.hypot(v.x, v.y, v.z);
      if (this.lastSpeed > 0.5 && sp < this.lastSpeed * 0.6 && this.clatterCd <= 0) { gunSfx.clatter(Math.min(1, this.lastSpeed / 4)); this.clatterCd = 0.08; }
      this.lastSpeed = sp;
    }
    if (this.state !== 'dropped') { this.body.setNextKinematicTranslation(this.root.position); this.body.setNextKinematicRotation(this.root.quaternion); }

    if (this.held && gh) this.handleInput(dt, gh, other);
    else this.trig = 0;

    // free cylinder spin after a flick close
    if (this.freeSpin > 0) {
      this.freeSpin *= Math.exp(-2.6 * dt);
      this.cylAngle += this.freeSpin * dt;
      const det = Math.floor(this.cylAngle / (TAU / 6));
      if (det !== this.lastDetent) { this.lastDetent = det; gunSfx.ratchet(); if (gh) this.g.pulse(this.hand, 0.08, 8); }
      if (this.freeSpin < 2.5) {
        this.freeSpin = 0; const k = Math.round(this.cylAngle / (TAU / 6));
        this.cylTarget = k * TAU / 6; this.chamber = ((-k % 6) + 6) % 6; gunSfx.detent();
      }
    } else this.cylAngle += (this.cylTarget - this.cylAngle) * (1 - Math.exp(-25 * dt));

    // animate parts
    this.hammer += ((this.cocked ? 0.6 : 0) - this.hammer) * (1 - Math.exp(-40 * dt));
    this.hammerPin.rotation.x = this.hammer;
    this.triggerPin.rotation.x = -0.35 * this.trig;
    this.crane += ((this.open ? 1.6 : 0) - this.crane) * (1 - Math.exp(-18 * dt));
    this.cranePin.rotation.z = this.crane;
    this.cyl.rotation.z = this.cylAngle;
    this.rounds.forEach((m, i) => { m.visible = this.chambers[i] !== 'empty'; m.material = this.chambers[i] === 'spent' ? this.mats.dark : this.mats.brass; });

    // recoil spring (fixed 1/240 sub-steps), on the visual pivot
    let rem = dt;
    while (rem > 1e-5) {
      const h = Math.min(1 / 240, rem); rem -= h;
      for (const ch of Object.values(this.rec)) { const acc = -320 * ch[0] - 26 * ch[1]; ch[1] += acc * h; ch[0] += ch[1] * h; }
    }
    this.recoilPivot.rotation.set(this.rec.ang[0], this.rec.yaw[0], 0);
    this.recoilPivot.position.set(0, -0.022, 0.012 + this.rec.z[0]);

    // reload pose: muzzle tips up and the gun rolls to show the open cylinder
    const rl = this.open ? Math.sin(Math.min(1, this.openT / 1.5) * Math.PI) : 0;
    this.reloadPose = (this.reloadPose || 0) + (rl - (this.reloadPose || 0)) * (1 - Math.exp(-20 * dt));
    this.twirlPivot.rotation.set(0.7 * this.reloadPose, 0, 0.6 * this.reloadPose);

    // rounds held in the free hand while reloading
    const rh = this.roundsHand ? hands[this.roundsHand] : null;
    this.cluster.visible = !!rh;
    if (rh) { this.cluster.position.copy(rh.pos); this.cluster.quaternion.copy(rh.q); }
    this.root.updateMatrixWorld(true);
  }

  handleInput(dt, gh, other) {

    // reload (B/Y): one quick automatic animation. The crane swings out, the empties fall,
    // six fresh rounds click in, and a flick snaps it shut with a spin.
    if (gh.bPressed && !this.open && this.chambers.some(c => c !== 'live')) this.openCylinder();
    if (this.open) {
      this.openT += dt;
      if (!this.ejected && this.openT > 0.12) this.eject(gh);
      if (this.openT > 0.45) {
        this.feedT -= dt;
        if (this.feedT <= 0) {
          for (let k = 1; k <= 6; k++) {
            const i = (this.chamber + k) % 6;
            if (this.chambers[i] !== 'live') { this.chambers[i] = 'live'; gunSfx.insert(); this.g.pulse(this.hand, 0.1, 10); break; }
          }
          this.feedT = 0.14;
        }
      }
      if (this.chambers.every(c => c === 'live') && this.openT > 1.35) { this.closeCylinder(false); this.g.pulse(this.hand, 0.4, 30); }
      this.trig = gh.trigger; this.triggerArmed = gh.trigger < 0.25;
      return; // nothing fires while it's open
    }

    // cocking: A/X, thumbstick pulled back, or fanning with the free hand
    const cockNow = gh.aPressed || gh.stickBack;
    let fanned = false;
    if (other && this.fanCd <= 0 && !this.roundsHand) {
      const spur = this.spur.getWorldPosition(new THREE.Vector3());
      if (other.pos.distanceTo(spur) < 0.1 && other.vel.length() > 1.0) { fanned = true; this.fanCd = 0.15; this.g.pulse(other.side, 0.35, 20); }
    }
    if ((cockNow || fanned) && !this.cocked) this.cock();

    // trigger
    this.trig = gh.trigger;
    if (gh.trigger < 0.25) this.triggerArmed = true;
    if (this.triggerArmed) {
      if (this.cocked && gh.trigger >= 0.55) this.dropHammer();
      else if (!this.cocked && gh.trigger >= 0.97) { this.advance(); this.dropHammer(); }
    }
  }

  advance() { this.chamber = (this.chamber + 1) % 6; this.cylTarget -= TAU / 6; }
  cock() { this.advance(); this.cocked = true; gunSfx.cock(); this.g.pulse(this.hand, 0.25, 25); }

  dropHammer() {
    this.cocked = false; this.triggerArmed = false;
    if (this.chambers[this.chamber] === 'live') { this.chambers[this.chamber] = 'spent'; this.shoot(); }
    else { gunSfx.dry(); this.g.pulse(this.hand, 0.15, 15); }
  }

  openCylinder() { this.open = true; this.openT = 0; this.feedT = 0; this.ejected = false; this.cocked = false; gunSfx.open(); }
  closeCylinder(spin) {
    this.open = false; gunSfx.close();
    if (spin) { this.freeSpin = 26 * rnd(0.85, 1.15); this.lastDetent = Math.floor(this.cylAngle / (TAU / 6)); }
  }

  eject(gh) {
    this.ejected = true;
    let any = false;
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.root.quaternion);
    this.rounds.forEach((m, i) => {
      if (this.chambers[i] !== 'spent') return;
      this.chambers[i] = 'empty'; any = true;
      const p = m.getWorldPosition(new THREE.Vector3());
      const v = back.clone().multiplyScalar(rnd(0.6, 1.1)).add(new THREE.Vector3(rnd(-0.2, 0.2), rnd(-0.6, -0.3), rnd(-0.2, 0.2))).add(gh.avgVel);
      this.g.spawnCasing(p, v);
    });
    if (any) gunSfx.ejector();
  }

  // ---------------------------------------------------------------- shooting
  // soft low-poly puffs: gun smoke and blood mist. Each grows, drifts and fades, then is reused.
  puff(pos, vel, { color = 0xd8dce0, size = 0.03, grow = 0.25, life = 0.9, opacity = 0.55, drag = 3, rise = 0.25 } = {}) {
    let p = this.puffs.find(x => x.age >= x.life);
    if (!p) {
      if (this.puffs.length >= 70) p = this.puffs.reduce((a, b) => (a.age / a.life > b.age / b.life ? a : b));
      else {
        p = { m: new THREE.Mesh(this.puffGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })), vel: new THREE.Vector3() };
        p.m.frustumCulled = false; this.g.scene.add(p.m); this.puffs.push(p);
      }
    }
    p.m.material.color.setHex(color); p.m.position.copy(pos); p.vel.copy(vel); p.m.visible = true;
    p.m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    Object.assign(p, { age: 0, life, size, grow, opacity, drag, rise });
  }
  updatePuffs(dt) {
    for (const p of this.puffs) {
      if (p.age >= p.life) { p.m.visible = false; continue; }
      p.age += dt; const k = Math.min(1, p.age / p.life);
      p.vel.multiplyScalar(Math.exp(-p.drag * dt)); p.vel.y += p.rise * dt;
      p.m.position.addScaledVector(p.vel, dt);
      p.m.scale.setScalar(p.size + p.grow * (1 - (1 - k) * (1 - k)));
      p.m.material.opacity = p.opacity * (1 - k) * (1 - k);
      p.m.rotation.x += dt * 0.6; p.m.rotation.y += dt * 0.4;
    }
  }

  shoot() {
    this.root.updateMatrixWorld(true);
    const { o, d } = this.muzzleRay();
    this.trace(o, d.clone().multiplyScalar(V0)); // bullet first...
    this.rec.ang[1] += 9 * rnd(0.9, 1.1);         // ...then recoil
    this.rec.z[1] += 0.55; this.rec.yaw[1] += rnd(-1, 1) * 2.5;
    this.flashT = 0.05; this.flash.rotation.z = Math.random() * TAU; this.flash.scale.setScalar(rnd(0.8, 1.3));
    this.g.particles.emit('spark', o, d, 8, 3);
    // a thick cloud out of the barrel, a ring blown off the cylinder gap, then a lingering wisp
    for (let i = 0; i < 9; i++) this.puff(o.clone().addScaledVector(d, 0.02 + i * 0.03), d.clone().multiplyScalar(rnd(1.5, 6)).add(new THREE.Vector3(rnd(-0.4, 0.4), rnd(-0.2, 0.5), rnd(-0.4, 0.4))), { size: rnd(0.025, 0.045), grow: rnd(0.12, 0.22), life: rnd(0.9, 1.6), opacity: 0.6, drag: 4 });
    const cylW = this.cyl.getWorldPosition(new THREE.Vector3()), side = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion);
    for (const s of [-1, 1]) this.puff(cylW, side.clone().multiplyScalar(s * rnd(0.8, 1.6)).add(new THREE.Vector3(0, 0.3, 0)), { size: 0.02, grow: 0.08, life: 0.7, opacity: 0.45 });
    this.wisp = 1.6;
    if (!playSound('gunshot', 0.9)) gunSfx.shot(); // recorded shot + echo; synth until it's decoded
    this.g.pulse(this.hand, 1, 90);
  }

  // purely visual: a red mist that blooms out of the wound and the exit, plus a spray of droplets
  bloodBurst(pt, dir) {
    for (let i = 0; i < 7; i++) {
      const out = i < 4 ? dir.clone().multiplyScalar(rnd(1.5, 3.5)) : dir.clone().multiplyScalar(-rnd(0.8, 2));
      out.add(new THREE.Vector3(rnd(-0.8, 0.8), rnd(-0.3, 0.9), rnd(-0.8, 0.8)));
      this.puff(pt, out, { color: i % 2 ? 0x9e0016 : 0xc8102e, size: rnd(0.02, 0.035), grow: rnd(0.08, 0.16), life: rnd(0.25, 0.45), opacity: 0.85, drag: 7, rise: -1.5 });
    }
    this.g.particles.emit('blood', pt, dir, 14, 4);
    this.g.particles.emit('blood', pt, dir.clone().negate(), 6, 2);
  }

  // ballistic trace in 1/120 s steps, a raycast per segment; the first hit wins
  trace(o, v) {
    const pos = o.clone(), vel = v.clone(), h = 1 / 120;
    let travelled = 0;
    while (travelled < RANGE) {
      const next = pos.clone().addScaledVector(vel, h).add(new THREE.Vector3(0, -0.5 * GRAV * h * h, 0));
      vel.y -= GRAV * h;
      const seg = next.clone().sub(pos), len = seg.length();
      const hit = phys.world.castRay(new RAPIER.Ray(pos, seg.clone().divideScalar(len)), len, true, undefined, BULLET_Q);
      if (hit) { this.impact(pos.clone().addScaledVector(seg, hit.timeOfImpact / len), seg.normalize(), hit.collider); return travelled + hit.timeOfImpact; }
      travelled += len; pos.copy(next);
    }
    return null;
  }

  impact(pt, dir, collider) {
    const info = phys.info.get(collider.handle), g = this.g;
    if (info && info.kind === 'enemy' && !info.enemy.dead) {
      const e = info.enemy, part = e.parts[info.part];
      const armored = e.armor && e.armor[info.part] && e.armor[info.part].hp > 0;
      e.takeHit({ part: info.part, point: pt, dir: dir.clone(), speed: 6, dmg: DMG, cut: false });
      if (!armored && !e.dead && info.part !== 'head' && CHAINS_LIMBS.has(info.part) && !e.lost.has(info.part)) {
        e.gunHits ||= {}; e.gunHits[info.part] = (e.gunHits[info.part] || 0) + 1;
        if (e.gunHits[info.part] >= LIMB_SHOTS) { e.gunHits[info.part] = 0; e.cutLimb(info.part, { part: info.part, point: pt, dir: dir.clone(), speed: 8, dmg: DMG, cut: true }); }
      }
      if (!armored) this.bloodBurst(pt, dir);
      if (!e.lost.has(info.part) && part.body && !e.dead) part.body.applyImpulseAtPoint(dir.clone().multiplyScalar(PUSH), pt, true);
      else if (e.dead && part.body) part.body.applyImpulseAtPoint(dir.clone().multiplyScalar(PUSH), pt, true);
      gunSfx.impact('flesh');
    } else if (info && info.kind === 'tongue') {
      info.tongue.hitSegment(info.idx, pt, dir.clone().multiplyScalar(8)); gunSfx.impact('flesh');
    } else if (info && info.kind === 'esword') {
      g.particles.emit('spark', pt, dir.clone().negate(), 10, 2.5); gunSfx.impact('steel');
      collider.parent()?.applyImpulseAtPoint(dir.clone().multiplyScalar(4), pt, true);
    } else if (collider.parent() && collider.parent().isDynamic()) {
      collider.parent().applyImpulseAtPoint(dir.clone().multiplyScalar(3), pt, true);
      g.particles.emit('spark', pt, null, 4, 1.5); gunSfx.impact('steel');
    } else {
      g.particles.emit('dust', pt, null, 8, 1.5); gunSfx.impact('ground');
    }
  }
}
