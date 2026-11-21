import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { RAPIER, FIXED, phys, initPhysics, GROUPS, G, grp, hullDesc } from './physics.js';
import { facet, lambert, makeSword, basisQuat } from './lowpoly.js';
import { Particles, Pieces } from './fx.js';
import { Enemy, loadEnemyModel, loadStaticModel, TYPES } from './enemy.js';
import { sfx, resumeAudio } from './audio.js';

// Game version shown in the HUD, the VR wrist panel and the tab title.
export const VERSION = '5.5';
document.getElementById('ver').textContent = 'v' + VERSION;
document.title = 'Slop Blade v' + VERSION;

// ---------------------------------------------------------------- tuning
// Player sword drive: a capped "spring" toward the hand (no infinite force),
// so the blade lags, carries momentum and is stopped by what it hits.
const DRIVE = {
  linK: 34,        // 1/s: position error -> desired velocity
  maxV: 16,        // m/s
  maxAcc: 170,     // m/s^2: lower = heavier sword
  angK: 26,
  maxW: 38,        // rad/s
  maxAngAcc: 900,  // rad/s^2
  snapDist: 0.9,   // teleport back to the hand if it gets stuck this far away
};
const DMG = { floor: 1.8, minTravel: 0.12, scale: 13 };
const MAX_ALIVE = 6;

// ---------------------------------------------------------------- renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(0.6);
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const BG = 0xdde1e6;
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG);
scene.fog = new THREE.Fog(BG, 14, 60);

const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.03, 200);
const dolly = new THREE.Group();
dolly.add(camera);
scene.add(dolly);
camera.position.set(0, 1.65, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a929c, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(4, 9, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 30 });
scene.add(sun, sun.target);

// ---------------------------------------------------------------- the void
{
  const floor = new THREE.Mesh(new THREE.CircleGeometry(90, 6).rotateX(-Math.PI / 2), lambert(0xcdd2d8));
  floor.receiveShadow = true;
  scene.add(floor);
  // triangular grid
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
  // centre hex
  const hex = new THREE.Mesh(new THREE.RingGeometry(1.6, 1.68, 6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xd41f3a }));
  hex.position.y = 0.006; scene.add(hex);
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

// ---------------------------------------------------------------- physics + game objects
const loading = document.getElementById('loading');
await initPhysics();
try { await loadEnemyModel('richard', 'models/richard.glb'); } catch (e) { console.warn('Richard model failed to load, using the built-in body:', e); }
try {
  await loadStaticModel('andrew', 'models/andrew.glb', { facing: -1, roles: ['feet', 'torso', 'arms', 'head', 'legs'] });
} catch (e) { console.warn('Andrew model failed to load:', e); }
loading.remove();
const world = phys.world;

const particles = new Particles(scene);
const pieces = new Pieces(scene);
const enemies = [];

// player sword: dynamic body chased by the hand
const psword = makeSword();
scene.add(psword.group);
const swordBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.25, 1.2, -0.5)
  .setGravityScale(0).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(0));
const bladeCol = world.createCollider(hullDesc(psword.bladeGeo).setDensity(4000).setFriction(0.4).setCollisionGroups(GROUPS.psword), swordBody);
world.createCollider(hullDesc(psword.guardGeo).setDensity(4000).setFriction(0.4).setCollisionGroups(GROUPS.psword), swordBody);
phys.info.set(bladeCol.handle, { kind: 'psword' });

// ghost hand (true tracked pose) + tether line, shown when the blade lags behind
const ghost = new THREE.Mesh(facet(new THREE.OctahedronGeometry(0.035, 0)), new THREE.MeshBasicMaterial({ color: 0x3a8dde, transparent: true, opacity: 0.45 }));
scene.add(ghost);
const tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
  new THREE.LineBasicMaterial({ color: 0x3a8dde, transparent: true, opacity: 0.5 }));
tether.frustumCulled = false;
scene.add(tether);

// damage flash (sphere around the head)
const flashMat = new THREE.MeshBasicMaterial({ color: 0xff0022, transparent: true, opacity: 0, side: THREE.BackSide, depthTest: false });
const flash = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), flashMat);
flash.renderOrder = 999;
camera.add(flash);

// ---------------------------------------------------------------- player state
const player = {
  head: new THREE.Vector3(0, 1.65, 0),
  tip: new THREE.Vector3(), tipVel: new THREE.Vector3(), bladeDir: new THREE.Vector3(0, 1, 0),
  hp: 100, kills: 0, dead: false, deadT: 0,
};
const tipHist = []; // {t, p} for anti-waggle swing-travel check
let simTime = 0;

const hudHp = document.getElementById('hp'), hudKills = document.getElementById('kills'), hudBar = document.querySelector('#bar>i');
const msg = document.getElementById('msg');

// ---------------------------------------------------------------- VR spawn button + wrist HUD
const pedestal = new THREE.Group();
{
  const col = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.15, 0.2, 0.86, 6).translate(0, 0.43, 0)), lambert(0x3a3f47));
  col.castShadow = true;
  pedestal.add(col);
  const btn = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 3)), lambert(0xd41f3a, { emissive: 0x330000 }));
  btn.position.y = 0.885; pedestal.add(btn); pedestal.userData.btn = btn;
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const g = c.getContext('2d'); g.fillStyle = '#d41f3a'; g.font = 'bold 44px system-ui'; g.textAlign = 'center'; g.fillText('SPAWN', 128, 48);
  const label = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.06), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true }));
  label.position.set(0, 1.0, 0); label.rotation.y = 0;
  pedestal.add(label);
}
pedestal.position.set(-0.75, 0, -0.8); // fixed in the world, not to the player
pedestal.rotation.y = 0.5;
scene.add(pedestal);
let btnCd = 0, btnPress = 0;

const wristCanvas = document.createElement('canvas'); wristCanvas.width = 256; wristCanvas.height = 96;
const wristTex = new THREE.CanvasTexture(wristCanvas);
const wrist = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.041), new THREE.MeshBasicMaterial({ map: wristTex, transparent: true }));
function drawWrist() {
  const g = wristCanvas.getContext('2d');
  g.clearRect(0, 0, 256, 96);
  g.fillStyle = 'rgba(20,24,30,.75)'; g.fillRect(0, 0, 256, 96);
  g.fillStyle = '#fff'; g.font = 'bold 30px system-ui'; g.fillText(`HP ${Math.max(0, Math.round(player.hp))}   KILLS ${player.kills}`, 12, 40);
  g.font = '20px system-ui'; g.fillStyle = '#fff9'; g.fillText('v' + VERSION, 200, 88);
  g.fillStyle = '#0006'; g.fillRect(12, 58, 232, 18);
  g.fillStyle = '#d41f3a'; g.fillRect(12, 58, 232 * Math.max(0, player.hp) / 100, 18);
  wristTex.needsUpdate = true;
  hudHp.textContent = Math.max(0, Math.round(player.hp)); hudKills.textContent = player.kills;
  hudBar.style.width = `${Math.max(0, player.hp)}%`;
}
drawWrist();

// ---------------------------------------------------------------- controllers
const grips = [0, 1].map(i => {
  const grip = renderer.xr.getControllerGrip(i);
  grip.addEventListener('connected', e => { grip.userData.hand = e.data.handedness; grip.userData.src = e.data; setupHand(grip); });
  grip.addEventListener('disconnected', () => { grip.userData.hand = null; grip.userData.src = null; grip.clear(); });
  dolly.add(grip);
  return grip;
});
function setupHand(grip) {
  grip.clear();
  if (grip.userData.hand === 'left') {
    const fist = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.045, 0)), lambert(0x3a8dde));
    grip.add(fist);
    wrist.position.set(0.0, 0.03, 0.09); wrist.rotation.set(-Math.PI / 2.4, 0, 0);
    grip.add(wrist);
  }
}
const handGrip = h => grips.find(g => g.userData.hand === h);

// ---------------------------------------------------------------- desktop input
const keys = new Set();
const mouse = { x: 0.2, y: 0.1, reach: 0.12, look: false };
let yaw = 0, pitch = -0.08;
addEventListener('keydown', e => {
  keys.add(e.code);
  if (e.code === 'KeyF' && !e.repeat) spawnEnemy();
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('pointerdown', e => { resumeAudio(); if (e.button === 2) mouse.look = true; });
addEventListener('pointerup', e => { if (e.button === 2) mouse.look = false; });
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('pointermove', e => {
  mouse.x = (e.clientX / innerWidth) * 2 - 1; mouse.y = (e.clientY / innerHeight) * 2 - 1;
  if (mouse.look) { yaw -= e.movementX * 0.004; pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.003, -1.2, 1.0); }
});
addEventListener('wheel', e => { mouse.reach = THREE.MathUtils.clamp(mouse.reach + e.deltaY * -0.0006, -0.1, 0.4); });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});
document.getElementById('spawn').addEventListener('click', () => { resumeAudio(); spawnEnemy(); });
renderer.xr.addEventListener('sessionstart', () => { resumeAudio(); camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0); });
renderer.xr.addEventListener('sessionend', () => { camera.position.set(0, 1.65, 0); });

// ---------------------------------------------------------------- sword target (hand pose)
const target = { pos: new THREE.Vector3(0.25, 1.2, -0.5), q: new THREE.Quaternion(), vel: new THREE.Vector3(), prev: new THREE.Vector3(), valid: false };
const GRIP_OFFSET = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + 0.25, 0, 0)); // blade out of the fist along grip -Z, tilted up a little
const deskVel = new THREE.Vector3();
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion();

function updateTarget(dt) {
  const xr = renderer.xr.isPresenting;
  target.prev.copy(target.pos);
  if (xr) {
    const rg = handGrip('right');
    if (rg) {
      rg.updateMatrixWorld(true);
      rg.matrixWorld.decompose(target.pos, target.q, tmpV);
      target.q.multiply(GRIP_OFFSET);
      target.valid = true;
    }
  } else {
    // Half Sword-style: the mouse moves the hand; the blade points out along the arm
    const hand = tmpV.set(mouse.x * 0.42, -mouse.y * 0.3 - 0.05, -0.5 - mouse.reach);
    const pivot = tmpV2.set(0.16, -0.42, 0.05);
    const camQ = camera.getWorldQuaternion(tmpQ);
    const blade = new THREE.Vector3().subVectors(hand, pivot).normalize().add(new THREE.Vector3(0, 0.55, -0.2));
    const lv = deskVel.clone().applyQuaternion(camQ.clone().invert());
    blade.addScaledVector(lv, 0.05).normalize();
    const edgeHint = lv.lengthSq() > 0.5 ? lv.clone() : new THREE.Vector3(0, 0, -1);
    target.q.copy(camQ).multiply(basisQuat(blade, edgeHint));
    target.pos.copy(hand).applyMatrix4(camera.matrixWorld);
    target.valid = true;
  }
  if (dt > 0) {
    const v = tmpV.subVectors(target.pos, target.prev).divideScalar(dt);
    if (v.length() > 30) v.set(0, 0, 0);
    target.vel.lerp(v, 0.5);
    deskVel.lerp(v, 0.25);
  }
}

// ---------------------------------------------------------------- locomotion
const prevButtons = {};
function updateLocomotion(dt) {
  if (renderer.xr.isPresenting) {
    const session = renderer.xr.getSession();
    for (const src of session.inputSources) {
      const gp = src.gamepad; if (!gp) continue;
      const h = src.handedness;
      const ax = gp.axes[2] || 0, ay = gp.axes[3] || 0;
      if (h === 'left' && Math.hypot(ax, ay) > 0.15) {
        const f = camera.getWorldDirection(tmpV).setY(0).normalize();
        const r = tmpV2.set(-f.z, 0, f.x);
        dolly.position.addScaledVector(f, -ay * 2.2 * dt).addScaledVector(r, ax * 2.2 * dt);
      }
      if (h === 'right') {
        const key = 'snap';
        if (Math.abs(ax) > 0.7 && !prevButtons[key]) { snapTurn(ax > 0 ? -Math.PI / 6 : Math.PI / 6); prevButtons[key] = true; }
        if (Math.abs(ax) < 0.3) prevButtons[key] = false;
      }
      const b = gp.buttons[4]?.pressed; // A / X
      const k = h + 'A';
      if (b && !prevButtons[k]) spawnEnemy();
      prevButtons[k] = b;
    }
  } else {
    if (keys.has('KeyQ')) yaw += 2 * dt;
    if (keys.has('KeyE')) yaw -= 2 * dt;
    dolly.rotation.y = yaw;
    camera.rotation.set(pitch, 0, 0);
    const f = tmpV.set(-Math.sin(yaw), 0, -Math.cos(yaw)), r = tmpV2.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const mv = new THREE.Vector3();
    if (keys.has('KeyW')) mv.add(f); if (keys.has('KeyS')) mv.sub(f);
    if (keys.has('KeyD')) mv.add(r); if (keys.has('KeyA')) mv.sub(r);
    if (mv.lengthSq()) dolly.position.addScaledVector(mv.normalize(), 2.4 * dt);
  }
}
function snapTurn(a) {
  const head = camera.getWorldPosition(new THREE.Vector3());
  dolly.position.sub(head).applyAxisAngle(new THREE.Vector3(0, 1, 0), a).add(head);
  dolly.rotation.y += a;
}

function pulse(hand, intensity, ms) {
  const s = renderer.xr.getSession?.();
  if (!s) return;
  for (const src of s.inputSources) {
    if (hand && src.handedness !== hand) continue;
    const act = src.gamepad?.hapticActuators?.[0];
    if (act?.pulse) act.pulse(Math.min(1, intensity), ms);
  }
}

// ---------------------------------------------------------------- spawning / game flow
function spawnEnemy(forceType) {
  if (player.dead) return;
  if (enemies.filter(e => !e.dead).length >= MAX_ALIVE) { sfx.beep(); return; }
  const f = camera.getWorldDirection(new THREE.Vector3()).setY(0);
  if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
  f.normalize();
  const a = Math.atan2(f.x, f.z) + (Math.random() - 0.5) * 1.4, r = 6 + Math.random() * 3;
  const pos = new THREE.Vector3(player.head.x + Math.sin(a) * r, 0, player.head.z + Math.cos(a) * r);
  let pick = Math.random() * Object.values(TYPES).reduce((a, t) => a + t.weight, 0), type = 'richard';
  for (const [name, t] of Object.entries(TYPES)) { pick -= t.weight; if (pick <= 0) { type = name; break; } }
  if (typeof forceType === 'string' && TYPES[forceType]) type = forceType;
  enemies.push(new Enemy(ctx, pos, type));
  sfx.whoosh();
}

const ctx = {
  button: { pos: new THREE.Vector3(-0.75, 0.885, -0.8) },
  pressButton: e => pressSpawnButton(e),
  scene, particles, pieces, enemies, player,
  onLand(e) {
    particles.emit('dust', e.root.clone().setY(0.05), null, 26, 3);
    const d = e.root.distanceTo(player.head);
    sfx.thump(Math.max(0.2, 1 - d / 12));
    pulse(null, 0.3 * Math.max(0, 1 - d / 10), 80);
  },
  onKill() { player.kills++; drawWrist(); },
  damagePlayer(n) {
    if (player.dead) return;
    player.hp -= n; flashMat.opacity = 0.55;
    sfx.hurt(); pulse(null, 1, 140); drawWrist();
    if (player.hp <= 0) { player.dead = true; player.deadT = 2.5; msg.style.display = 'grid'; }
  },
};

function resetGame() {
  for (const e of enemies) if (!e.dead) e.destroy();
  enemies.length = 0;
  pieces.clear(); particles.clear();
  player.hp = 100; player.dead = false; msg.style.display = 'none';
  drawWrist();
}

// ---------------------------------------------------------------- per-step sword drive + hit detection
const pre = { lin: new THREE.Vector3(), ang: new THREE.Vector3(), com: new THREE.Vector3(), q: new THREE.Quaternion(), pos: new THREE.Vector3() };
let pieceSoundCd = 0;

function driveSword(h) {
  const t = swordBody.translation(), r = swordBody.rotation();
  const pos = tmpV.set(t.x, t.y, t.z), q = tmpQ.set(r.x, r.y, r.z, r.w);
  const err = new THREE.Vector3().subVectors(target.pos, pos);
  if (err.length() > DRIVE.snapDist) {
    swordBody.setTranslation(target.pos, true); swordBody.setRotation(target.q, true);
    swordBody.setLinvel({ x: 0, y: 0, z: 0 }, true); swordBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return;
  }
  // angular
  const qe = target.q.clone().multiply(q.clone().invert());
  if (qe.w < 0) { qe.x *= -1; qe.y *= -1; qe.z *= -1; qe.w *= -1; }
  const angle = 2 * Math.acos(Math.min(1, qe.w));
  const s = Math.sqrt(Math.max(1e-9, 1 - qe.w * qe.w));
  const wDes = new THREE.Vector3(qe.x / s, qe.y / s, qe.z / s).multiplyScalar(angle * DRIVE.angK);
  if (angle < 1e-4) wDes.set(0, 0, 0);
  if (wDes.length() > DRIVE.maxW) wDes.setLength(DRIVE.maxW);
  const av = swordBody.angvel();
  const w = new THREE.Vector3(av.x, av.y, av.z);
  const dw = wDes.sub(w); const maxDw = DRIVE.maxAngAcc * h;
  if (dw.length() > maxDw) dw.setLength(maxDw);
  w.add(dw);
  // linear (drive the grip point; convert to centre-of-mass velocity)
  const vDes = err.multiplyScalar(DRIVE.linK).add(target.vel);
  if (vDes.length() > DRIVE.maxV) vDes.setLength(DRIVE.maxV);
  const c = swordBody.worldCom();
  const rOff = new THREE.Vector3(pos.x - c.x, pos.y - c.y, pos.z - c.z);
  const vComDes = vDes.sub(new THREE.Vector3().crossVectors(w, rOff));
  const lv = swordBody.linvel();
  const v = new THREE.Vector3(lv.x, lv.y, lv.z);
  const dv = vComDes.sub(v); const maxDv = DRIVE.maxAcc * h;
  if (dv.length() > maxDv) dv.setLength(maxDv);
  v.add(dv);
  swordBody.setLinvel(v, true); swordBody.setAngvel(w, true);
}

function swingTravel(window = 0.2) {
  let d = 0;
  for (let i = tipHist.length - 1; i > 0 && simTime - tipHist[i].t < window; i--) d += tipHist[i].p.distanceTo(tipHist[i - 1].p);
  return d;
}

const ax = { blade: new THREE.Vector3(), edge: new THREE.Vector3(), flat: new THREE.Vector3() };
const SWEEP_GROUPS = grp(G.PSWORD, G.EALIVE);
const SWEEP_FRACS = [0.15, 0.35, 0.55, 0.75, 0.9, 1.0];

// one place that turns "blade touched enemy part at pt with blade velocity v" into a hit
const stats = { hits: 0, glances: 0, clashes: 0, rayHits: 0, contactHits: 0 };
function registerHit(e, partKey, pt, v, tipW, travel, hitThisStep) {
  if (e.dead || e.hitCd > 0 || hitThisStep.has(e)) return;
  // relative to the enemy's own movement (not the limb's post-impact velocity, which the
  // blade itself just changed)
  const vr = v.clone().sub(e.vel).sub(e.knock);
  const slash = Math.abs(vr.dot(ax.edge));
  const flat = Math.abs(vr.dot(ax.flat));
  const along = vr.dot(ax.blade);
  const thrust = pt.distanceTo(tipW) < 0.22 && along > 0 ? along : 0;
  const eff = Math.max(slash, thrust * 1.25, flat * 0.45);
  if (eff < DMG.floor || travel < DMG.minTravel) {
    // too slow / off-edge: a glance. It doesn't block a real hit right after it.
    stats.glances++;
    if (!(e.glanceCd > simTime)) { e.glanceCd = simTime + 0.25; sfx.glance(); particles.emit('spark', pt, null, 4, 1.5); pulse('right', 0.15, 20); }
    return;
  }
  hitThisStep.add(e);
  const part = e.parts[partKey];
  const dmg = Math.min(140, (eff - 1.5) * DMG.scale * part.mult);
  stats.hits++;
  e.hitCd = 0.15;
  const cut = slash >= thrust * 1.25 && slash >= flat * 0.45; // edge-led, so it can sever a limb
  e.takeHit({ part: partKey, point: pt, dir: vr.clone().normalize(), speed: eff, dmg, cut });
  pulse('right', 0.35 + dmg / 80, 40 + dmg);
}

function processContacts(h) {
  ax.blade.set(0, 1, 0).applyQuaternion(pre.q);
  ax.edge.set(0, 0, 1).applyQuaternion(pre.q);
  ax.flat.set(1, 0, 0).applyQuaternion(pre.q);
  const tipW = new THREE.Vector3(0, psword.tipY, 0).applyQuaternion(pre.q).add(pre.pos);
  const travel = swingTravel();
  const hitThisStep = new Set();
  const velAt = pt => new THREE.Vector3().crossVectors(pre.ang, tmpV.subVectors(pt, pre.com)).add(pre.lin);

  // 1) real contacts
  world.contactPairsWith(bladeCol, other => {
    const info = phys.info.get(other.handle);
    if (!info) return;
    let pt = null;
    world.contactPair(bladeCol, other, m => {
      if (!pt && m.numSolverContacts() > 0) { const p = m.solverContactPoint(0); pt = new THREE.Vector3(p.x, p.y, p.z); }
    });
    if (!pt) return;
    const v = velAt(pt);
    if (info.kind === 'enemy' && !hitThisStep.has(info.enemy)) stats.contactHits++;
    if (info.kind === 'enemy') registerHit(info.enemy, info.part, pt, v, tipW, travel, hitThisStep);
    else if (info.kind === 'esword') {
      stats.clashes++;
      const parried = info.enemy.onClash(v.length());
      if (info.enemy.clashCd > 0.14 || parried) {
        sfx.clang(Math.min(1, v.length() / 8 + (parried ? 0.4 : 0)));
        particles.emit('spark', pt, null, parried ? 14 : 6, 2.5);
        pulse('right', parried ? 1 : 0.5, parried ? 90 : 40);
      }
    } else if (info.kind === 'piece' && pieceSoundCd <= 0 && v.length() > 3) {
      pieceSoundCd = 0.1; sfx.thump(Math.min(0.6, v.length() / 15)); pulse('right', 0.25, 25);
    }
  });

  // 2) swept rays along the blade's path this step, so fast swings can't skip past thin limbs
  for (const f of SWEEP_FRACS) {
    const y = psword.baseY + (psword.tipY - psword.baseY) * f;
    const o = new THREE.Vector3(0, y, 0).applyQuaternion(pre.q).add(pre.pos);
    const v = velAt(o);
    const len = v.length() * h * 1.5 + 0.01;
    if (v.length() < 1) continue;
    const d = v.clone().normalize();
    const hit = world.castRay(new RAPIER.Ray(o, d), len, true, undefined, SWEEP_GROUPS);
    if (!hit) continue;
    const info = phys.info.get(hit.collider.handle);
    if (info?.kind !== 'enemy') continue;
    const pt = o.clone().addScaledVector(d, hit.timeOfImpact);
    if (!hitThisStep.has(info.enemy)) stats.rayHits++;
    registerHit(info.enemy, info.part, pt, v, tipW, travel, hitThisStep);
  }
}

function fixedStep(h) {
  simTime += h;
  pieceSoundCd -= h;
  // remember the real (post-solve) motion of the blade from the previous step
  const lv = swordBody.linvel(), av = swordBody.angvel(), c = swordBody.worldCom(), t = swordBody.translation(), r = swordBody.rotation();
  pre.lin.set(lv.x, lv.y, lv.z); pre.ang.set(av.x, av.y, av.z); pre.com.set(c.x, c.y, c.z);
  pre.pos.set(t.x, t.y, t.z); pre.q.set(r.x, r.y, r.z, r.w);

  if (target.valid) driveSword(h);
  for (const e of enemies) e.update(h);
  world.step();
  processContacts(h);

  const tt = swordBody.translation(), rr = swordBody.rotation();
  const q = tmpQ.set(rr.x, rr.y, rr.z, rr.w);
  const tip = new THREE.Vector3(0, psword.tipY, 0).applyQuaternion(q).add(tmpV.set(tt.x, tt.y, tt.z));
  player.tipVel.subVectors(tip, player.tip).divideScalar(h).clampLength(0, 40);
  player.tip.copy(tip);
  player.bladeDir.set(0, 1, 0).applyQuaternion(q);
  tipHist.push({ t: simTime, p: tip });
  while (tipHist.length > 60) tipHist.shift();

  for (let i = enemies.length - 1; i >= 0; i--) if (enemies[i].dead) enemies.splice(i, 1);
}

// ---------------------------------------------------------------- spawn button press
// Pressed by either hand or any part of the blade. Each probe is tested along the path it
// travelled since the last frame, so a fast tap can't skip over the button.
const BTN_R = 0.17;
let btnPrev = [];
function updateButton(dt) {
  btnCd -= dt;
  btnPress = Math.max(0, btnPress - dt * 4);
  const btn = pedestal.userData.btn;
  btn.position.y = 0.885 - btnPress * 0.03;
  const bp = btn.getWorldPosition(new THREE.Vector3());
  const st = swordBody.translation(), sr = swordBody.rotation();
  const sq = new THREE.Quaternion(sr.x, sr.y, sr.z, sr.w), sp = new THREE.Vector3(st.x, st.y, st.z);
  const probes = [0.1, 0.35, 0.6, 0.8, 1].map(f => new THREE.Vector3(0, psword.tipY * f, 0).applyQuaternion(sq).add(sp));
  for (const g of grips) if (g.userData.hand) probes.push(g.getWorldPosition(new THREE.Vector3()));
  let near = false, hit = false;
  const seg = new THREE.Line3(), c = new THREE.Vector3();
  probes.forEach((p, i) => {
    const prev = btnPrev[i] || p;
    seg.set(prev, p).closestPointToPoint(bp, true, c);
    const dxz = Math.hypot(c.x - bp.x, c.z - bp.z), dy = c.y - bp.y;
    if (dxz < BTN_R + 0.08 && dy > -0.1 && dy < 0.25) near = true;
    if (dxz < BTN_R && dy > -0.08 && dy < 0.12) hit = true;
  });
  btnPrev = probes;
  btn.material.emissive.setHex(near || btnPress > 0 ? 0x992222 : 0x330000);
  ctx.button.pos.copy(bp);
  if (hit) pressSpawnButton();
}

// shared by the player and by enemies calling in reinforcements
function pressSpawnButton(byEnemy) {
  if (btnCd > 0) return false;
  btnCd = 0.6; btnPress = 1; resumeAudio(); sfx.beep(); spawnEnemy();
  if (!byEnemy) pulse(null, 0.6, 50);
  return true;
}

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
let acc = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  updateLocomotion(dt);
  camera.updateMatrixWorld(true);
  camera.getWorldPosition(player.head);
  updateTarget(dt);

  acc += dt;
  let n = 0;
  while (acc >= FIXED && n < 6) { fixedStep(FIXED); acc -= FIXED; n++; }
  if (n === 6) acc = 0;

  const t = swordBody.translation(), r = swordBody.rotation();
  psword.group.position.set(t.x, t.y, t.z);
  psword.group.quaternion.set(r.x, r.y, r.z, r.w);
  ghost.position.copy(target.pos); ghost.quaternion.copy(target.q);
  const gap = target.pos.distanceTo(psword.group.position);
  ghost.visible = tether.visible = gap > 0.04;
  tether.geometry.attributes.position.setXYZ(0, target.pos.x, target.pos.y, target.pos.z);
  tether.geometry.attributes.position.setXYZ(1, t.x, t.y, t.z);
  tether.geometry.attributes.position.needsUpdate = true;

  for (const e of enemies) e.syncMeshes();
  pieces.update(dt);
  particles.update(dt);
  updateButton(dt);
  for (const d of decor) { d.rotation.x += d.userData.spin.x * dt; d.rotation.y += d.userData.spin.y * dt; }
  flashMat.opacity = Math.max(0, flashMat.opacity - dt * 1.5);
  sun.position.set(player.head.x + 4, 9, player.head.z + 3); sun.target.position.set(player.head.x, 0, player.head.z);

  if (player.dead) { player.deadT -= dt; flashMat.opacity = Math.max(flashMat.opacity, 0.35); if (player.deadT <= 0) resetGame(); }

  renderer.render(scene, camera);
});

// test / debug hook
window.game = { Enemy, ctx, stats, spawnEnemy, enemies, player, pieces, target, mouse, swordBody, resetGame, world, DRIVE };
