import * as THREE from 'three';
import { RAPIER, phys, GROUPS, removeBody } from './physics.js';
import { facet, lambert } from './lowpoly.js';

// ---------- Triangle particles (blood, sparks, dust) ----------
const MAX = 900;
const triGeo = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.6, 0, -0.52, -0.3, 0, 0.52, -0.3, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  return g;
})();

export class Particles {
  constructor(scene) {
    this.mesh = new THREE.InstancedMesh(triGeo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.p = [];
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.e = new THREE.Euler();
    this.col = new THREE.Color();
  }
  emit(kind, pos, dir, n, speed = 3) {
    for (let i = 0; i < n; i++) {
      if (this.p.length >= MAX) this.p.shift();
      const v = new THREE.Vector3((Math.random() - 0.5), Math.random() * 0.8 + 0.2, (Math.random() - 0.5)).normalize()
        .multiplyScalar(speed * (0.3 + Math.random() * 0.8));
      if (dir) v.addScaledVector(dir, speed * (0.4 + Math.random() * 0.6));
      const blood = kind === 'blood';
      this.p.push({
        kind, pos: pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08)),
        vel: kind === 'dust' ? v.multiplyScalar(0.35).setY(Math.abs(v.y) * 0.4) : v,
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        spin: (Math.random() - 0.5) * 20,
        size: blood ? 0.025 + Math.random() * 0.05 : kind === 'dust' ? 0.06 + Math.random() * 0.08 : 0.015 + Math.random() * 0.02,
        life: blood ? 14 : kind === 'dust' ? 0.9 : 0.35,
        age: 0, landed: false,
        color: blood ? (Math.random() < 0.5 ? 0xb3001b : 0xe0102f) : kind === 'dust' ? 0xb8bec6 : 0xfff3c4,
      });
    }
  }
  update(dt) {
    let n = 0;
    const keep = [];
    for (const p of this.p) {
      p.age += dt;
      if (p.age > p.life) continue;
      keep.push(p);
      if (!p.landed) {
        if (p.kind !== 'dust') p.vel.y -= 9.8 * dt; else p.vel.multiplyScalar(Math.exp(-3 * dt));
        p.pos.addScaledVector(p.vel, dt);
        p.rot.x += p.spin * dt; p.rot.y += p.spin * 0.7 * dt;
        if (p.pos.y <= 0.003 && p.kind === 'blood') {
          // splat: lie flat on the floor as a decal
          p.landed = true; p.pos.y = 0.002 + Math.random() * 0.002;
          p.rot.set(-Math.PI / 2, 0, Math.random() * 6.28); p.size *= 1.8 + Math.random();
        } else if (p.pos.y < 0) { p.pos.y = 0; p.vel.y *= -0.3; }
      }
      let sc = p.size;
      const fade = p.life - p.age;
      if (fade < 1) sc *= Math.max(0, fade);
      if (p.kind !== 'blood') sc *= 1 - p.age / p.life;
      this.q.setFromEuler(p.rot); this.s.setScalar(sc);
      this.m.compose(p.pos, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      this.mesh.setColorAt(n, this.col.setHex(p.color));
      n++;
    }
    this.p = keep;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  clear() { this.p.length = 0; this.mesh.count = 0; }
}

// ---------- Physics pieces (dead body parts, swords, shards) ----------
const MAX_PIECES = 160;
const shardGeo = facet(new THREE.TetrahedronGeometry(1, 0));

export class Pieces {
  constructor(scene) { this.scene = scene; this.list = []; }
  // meta.loose: a free object someone could pick up and throw; meta.sword: a usable sword
  add(mesh, body, life = 30, meta = {}) {
    const entry = { mesh, body, age: 0, life, base: mesh.scale.clone(), ...meta };
    this.list.push(entry);
    return entry;
    phys.info.set(body.collider(0).handle, { kind: 'piece' });
    while (this.list.length > MAX_PIECES) this.remove(this.list[0]);
  }
  shards(pos, dir, speed, color, n) {
    const mat = lambert(color);
    for (let i = 0; i < n; i++) {
      const s = 0.035 + Math.random() * 0.045;
      const mesh = new THREE.Mesh(shardGeo, mat);
      mesh.scale.setScalar(s); mesh.castShadow = true;
      mesh.position.copy(pos);
      this.scene.add(mesh);
      const body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setAngularDamping(0.5));
      const pts = new Float32Array(shardGeo.attributes.position.array.length);
      shardGeo.attributes.position.array.forEach((v, k) => { pts[k] = v * s; });
      phys.world.createCollider(RAPIER.ColliderDesc.convexHull(pts).setDensity(600).setFriction(0.8).setCollisionGroups(GROUPS.debris), body);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(1.5 + Math.random() * 2.5)
        .addScaledVector(dir, speed * (0.3 + Math.random() * 0.5));
      body.setLinvel(v, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 30, y: (Math.random() - 0.5) * 30, z: (Math.random() - 0.5) * 30 }, true);
      this.add(mesh, body, 8 + Math.random() * 4, { loose: true });
    }
  }
  // a single chunk (e.g. torn-up floor) sitting at pos, for an enemy to throw
  rubble(pos, color = 0x9aa1a9, size = 0.1575) {
    const mesh = new THREE.Mesh(shardGeo, lambert(color));
    mesh.scale.setScalar(size); mesh.castShadow = true; mesh.position.copy(pos);
    this.scene.add(mesh);
    const body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setAngularDamping(0.5));
    const pts = new Float32Array(shardGeo.attributes.position.array.length);
    shardGeo.attributes.position.array.forEach((v, k) => { pts[k] = v * size; });
    phys.world.createCollider(RAPIER.ColliderDesc.convexHull(pts).setDensity(1200).setFriction(0.8).setCollisionGroups(GROUPS.debris), body);
    this.add(mesh, body, 20, { loose: true, rubble: true });
    return this.list[this.list.length - 1];
  }
  // take an object out of the list without destroying it (the player picked it up)
  detach(entry) {
    const i = this.list.indexOf(entry);
    if (i >= 0) this.list.splice(i, 1);
    entry.mesh.scale.copy(entry.base);
    return entry;
  }
  find(body) { return this.list.find(p => p.body === body); }
  update(dt) {
    for (const p of this.list.slice()) {
      p.age += dt;
      const t = p.body.translation(), r = p.body.rotation();
      p.mesh.position.set(t.x, t.y, t.z);
      p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const left = p.life - p.age;
      if (left < 1) p.mesh.scale.copy(p.base).multiplyScalar(Math.max(0.01, left));
      if (left <= 0 || t.y < -20) this.remove(p);
    }
  }
  remove(p) {
    p.removed = true; // anyone still holding this entry (thrown object, grab) must let go
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
    this.scene.remove(p.mesh);
    removeBody(p.body);
  }
  clear() { for (const p of this.list.slice()) this.remove(p); }
}
