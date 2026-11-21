import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { RAPIER, FIXED, phys, initPhysics, GROUPS, G, grp, hullDesc, bodyAlive, floorHole, closeAllHoles } from './physics.js';
import { facet, lambert, makeSword, basisQuat } from './lowpoly.js';
import { Particles, Pieces } from './fx.js';
import { Enemy, loadEnemyModel, loadStaticModel, TYPES } from './enemy.js';
import { sfx, resumeAudio, loadAlert, setListener, playAlertAt } from './audio.js';
import { settings } from './settings.js';

// Game version shown in the HUD, the VR wrist panel and the tab title.
export const VERSION = '2.3';
loadAlert('sounds/alert.mp3');
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
try {
  await loadEnemyModel('prisoner', 'models/prisoner.glb', 1.85 * 1.05, {
    chestRe: /spine1|spine2/,
    bones: {
      pelvis: /hips_/, chest: /spine1_/, neck: /neck_/, ankle: /(left|right)foot_/,
      sh: /(left|right)arm_/, el: /(left|right)forearm_/, ha: /(left|right)hand_/, hip: /(left|right)upleg_/, kn: /(left|right)leg_/, an: /(left|right)foot_/,
    },
  });
} catch (e) { console.warn('Prisoner model failed to load:', e); }
loading.remove();
const world = phys.world;

const particles = new Particles(scene);
const pieces = new Pieces(scene);
const enemies = [];

// Player weapons: dynamic bodies chased by a hand target through a capped spring. The
// right sword always exists; a sword picked up off the floor becomes the left weapon.
const newTarget = () => ({ pos: new THREE.Vector3(0.25, 1.2, -0.5), q: new THREE.Quaternion(), vel: new THREE.Vector3(), prev: new THREE.Vector3(), valid: false });
function makeWeapon(sword, body, bladeCol, hand, target) {
  return {
    sword, body, bladeCol, hand, target,
    pre: { lin: new THREE.Vector3(), ang: new THREE.Vector3(), com: new THREE.Vector3(), q: new THREE.Quaternion(), pos: new THREE.Vector3() },
    ax: { blade: new THREE.Vector3(), edge: new THREE.Vector3(), flat: new THREE.Vector3() },
    tipHist: [], tip: new THREE.Vector3(), tipVel: new THREE.Vector3(), mult: 1,
  };
}
const psword = makeSword();
scene.add(psword.group);
const swordBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.25, 1.2, -0.5)
  .setGravityScale(0).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(0));
const bladeCol = world.createCollider(hullDesc(psword.bladeGeo).setDensity(4000).setFriction(0.4).setCollisionGroups(GROUPS.psword), swordBody);
world.createCollider(hullDesc(psword.guardGeo).setDensity(4000).setFriction(0.4).setCollisionGroups(GROUPS.psword), swordBody);
phys.info.set(bladeCol.handle, { kind: 'psword' });
const target = newTarget();
const rightW = makeWeapon(psword, swordBody, bladeCol, 'right', target);
const weapons = [rightW];

// left hand: a small physical fist that follows the left controller (shoves things), can grab
// enemies / swords / junk, take a second sword, or join the right hand on the grip
const leftT = newTarget();
const handBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-0.3, 1.1, -0.3).setGravityScale(0).setCcdEnabled(true));
const handCol = world.createCollider(RAPIER.ColliderDesc.cuboid(0.045, 0.04, 0.06).setDensity(2500).setFriction(1).setCollisionGroups(GROUPS.phand), handBody);
const handMesh = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.05, 0)), lambert(0x3a8dde));
handMesh.castShadow = true; handMesh.visible = false;
scene.add(handMesh);
const left = { squeeze: false, prevSqueeze: false, grabJoint: null, grabbed: null, weapon: null, twoHand: false };

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
  g.fillStyle = '#fff'; g.font = 'bold 26px system-ui'; g.fillText(`HP ${Math.max(0, Math.round(player.hp))}  W${run.wave}  ${run.score}`, 12, 40);
  g.font = '20px system-ui'; g.fillStyle = '#fff9'; g.fillText('v' + VERSION, 200, 88);
  g.fillStyle = '#0006'; g.fillRect(12, 58, 232, 18);
  g.fillStyle = '#d41f3a'; g.fillRect(12, 58, 232 * Math.max(0, player.hp) / 100, 18);
  wristTex.needsUpdate = true;
  hudHp.textContent = Math.max(0, Math.round(player.hp)); hudKills.textContent = player.kills;
  document.getElementById('wave').textContent = run.wave || '-'; document.getElementById('score').textContent = run.score;
  document.getElementById('best').textContent = run.best ? `(best ${run.best})` : '';
  hudBar.style.width = `${Math.max(0, player.hp)}%`;
}

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
  // left hand pose: controller in VR, or a test override
  leftT.prev.copy(leftT.pos);
  const lg = xr ? handGrip('left') : null;
  const ov = window.game?.leftOverride;
  if (lg) { lg.updateMatrixWorld(true); lg.matrixWorld.decompose(leftT.pos, leftT.q, tmpV); leftT.q.multiply(GRIP_OFFSET); leftT.valid = true; }
  else if (ov) { leftT.pos.copy(ov.pos); leftT.q.copy(ov.q || target.q); leftT.valid = true; }
  else leftT.valid = false;
  // two-handed: the blade points from the left hand toward the right along the grip
  if (left.twoHand && leftT.valid) {
    const axis = tmpV2.subVectors(target.pos, leftT.pos);
    if (axis.length() > 0.35 || axis.length() < 0.02) left.twoHand = false;
    else {
      const cur = new THREE.Vector3(0, 1, 0).applyQuaternion(target.q);
      if (axis.dot(cur) < 0) axis.negate();
      const edge = new THREE.Vector3(0, 0, 1).applyQuaternion(target.q);
      target.q.copy(basisQuat(axis.normalize(), edge));
    }
  }
  if (dt > 0) {
    for (const t of [target, leftT]) {
      const v = tmpV.subVectors(t.pos, t.prev).divideScalar(dt);
      if (v.length() > 30) v.set(0, 0, 0);
      t.vel.lerp(v, 0.5);
    }
    deskVel.lerp(target.vel, 0.25);
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
    const k = intensity * settings.haptics;
    if (act?.pulse && k > 0.01) act.pulse(Math.min(1, k), ms);
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
  flying: new Set(), // thrown objects still in the air
  button: { pos: new THREE.Vector3(-0.75, 0.885, -0.8) },
  pressButton: e => pressSpawnButton(e),
  scene, particles, pieces, enemies, player,
  onLand(e) {
    particles.emit('dust', e.root.clone().setY(0.05), null, 26, 3);
    const d = e.root.distanceTo(player.head);
    sfx.thump(Math.max(0.2, 1 - d / 12));
    pulse(null, 0.3 * Math.max(0, 1 - d / 10), 80);
  },
  onKill(e, hit) { player.kills++; scoreKill(e, hit); drawWrist(); },
  damagePlayer(n) {
    if (player.dead) return;
    player.hp -= n; flashMat.color.setHex(0xff0022); flashMat.opacity = 0.55;
    sfx.hurt(); pulse(null, 1, 140); drawWrist();
    if (player.hp <= 0) { player.dead = true; player.deadT = 4; endRun(); }
  },
};

// ---------------------------------------------------------------- waves, score, healing
// The simulation runs in rounds: each wave drops more (and tougher) enemies, with a short
// breather between. Kills score points (with a streak multiplier and style bonuses) and heal.
let best = 0;
try { best = +localStorage.getItem('slopblade.best') || 0; } catch { /* no storage */ }
const run = { wave: 0, phase: 'intro', t: 5, queue: [], spawnT: 0, score: 0, streak: 0, streakT: 0, best };
const KILL_PTS = { richard: 100, andrew: 220, prisoner: 450, stitcher: 350 };

function waveRoster(n) {
  const list = [];
  for (let i = 0; i < 2 + n; i++) {
    const r = Math.random();
    if (n >= 5 && r < 0.14) list.push('prisoner');
    else if (n >= 4 && r < 0.26 && TYPES.stitcher) list.push('stitcher');
    else if (n >= 3 && r < 0.5) list.push('andrew');
    else list.push('richard');
  }
  return list;
}
function startRun() {
  endGlitch(); closeAllHoles(); glitch.next = 20;
  Object.assign(run, { wave: 0, phase: 'intro', t: 5, queue: [], score: 0, streak: 0, streakT: 0 });
  board('SIMULATION ONLINE', 'first wave incoming');
  drawWrist();
}
function startWave() {
  run.wave++; run.phase = 'active'; run.queue = waveRoster(run.wave); run.spawnT = 0;
  board(`WAVE ${run.wave}`, `${run.queue.length} hostiles`);
  sfx.fanfare(); drawWrist();
}
function updateRun(dt) {
  run.streakT -= dt;
  if (run.streakT <= 0) run.streak = 0;
  if (player.dead) return;
  if (run.phase !== 'active') {
    run.t -= dt;
    if (run.t <= 0) startWave();
    return;
  }
  const alive = enemies.filter(e => !e.dead).length;
  run.spawnT -= dt;
  if (run.queue.length && alive < Math.min(MAX_ALIVE, 2 + run.wave) && run.spawnT <= 0) { spawnEnemy(run.queue.shift()); run.spawnT = 1.3; }
  if (!run.queue.length && alive === 0) {
    const bonus = 500 * run.wave;
    run.score += bonus; heal(25);
    run.phase = 'break'; run.t = 8;
    board(`WAVE ${run.wave} CLEARED`, `+${bonus}  ·  next wave in 8`);
    sfx.fanfare(); saveBest(); drawWrist();
  }
}
// ---------------------------------------------------------------- simulation glitches
// From wave 2, every 18-32 s the simulation misbehaves for 7 s.
const glitch = { active: null, t: 0, next: 20, holes: [], last: null };
const GLITCHES = {
  'LOW GRAVITY': {
    start() { world.gravity = { x: 0, y: -2.2, z: 0 }; },
    end() { world.gravity = { x: 0, y: -9.81, z: 0 }; },
  },
  'FLOOR COLLAPSE': {
    start() {
      glitch.holes = [];
      for (let i = 0; i < 3; i++) {
        let x, z, tries = 0;
        do {
          const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 5;
          x = player.head.x + Math.cos(a) * r; z = player.head.z + Math.sin(a) * r;
        } while (Math.hypot(x - player.head.x, z - player.head.z) < 1.6 + 1.3 && ++tries < 20);
        const rad = 1 + Math.random() * 0.5;
        floorHole(x, z, rad, true);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(rad, 6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x05060a }));
        disc.position.set(x, 0.012, z);
        const rim = new THREE.Mesh(new THREE.RingGeometry(rad, rad + 0.08, 6).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x3a8dde }));
        rim.position.set(x, 0.014, z);
        scene.add(disc, rim);
        glitch.holes.push({ x, z, rad, disc, rim });
      }
    },
    end() {
      for (const h of glitch.holes) { floorHole(h.x, h.z, h.rad, false); scene.remove(h.disc, h.rim); }
      glitch.holes = [];
    },
  },
  'TELEPORT SCRAMBLE': {
    start() {
      for (const e of enemies) {
        if (e.dead || e.state === 'fall') continue;
        const a = Math.random() * Math.PI * 2, r = 2.5 + Math.random() * 3.5;
        const nx = player.head.x + Math.cos(a) * r, nz = player.head.z + Math.sin(a) * r;
        const dx = nx - e.root.x, dz = nz - e.root.z;
        particles.emit('spark', e.root.clone().setY(1.2), null, 20, 3);
        e.root.x += dx; e.root.z += dz;
        const bodies = [...Object.entries(e.parts).filter(([k]) => !e.lost.has(k)).map(([, p]) => p.body)];
        if (e.armed) bodies.push(e.swordBody);
        if (e.sword2 && e.armed2) bodies.push(e.sword2Body);
        for (const b of bodies) { const t = b.translation(); b.setTranslation({ x: t.x + dx, y: t.y, z: t.z + dz }, true); }
        particles.emit('spark', e.root.clone().setY(1.2), null, 20, 3);
      }
    },
    end() {},
  },
};
const BG_COLOR = new THREE.Color(BG), GLITCH_COLOR = new THREE.Color(0x9fc4e8);
function updateGlitch(dt) {
  if (glitch.active) {
    glitch.t -= dt;
    // flicker the void while it lasts
    const k = Math.random() < 0.15 ? 1 : 0.35 + 0.25 * Math.sin(performance.now() / 60);
    scene.background.copy(BG_COLOR).lerp(GLITCH_COLOR, k); scene.fog.color.copy(scene.background);
    if (glitch.t <= 0) endGlitch();
    return;
  }
  if (run.phase !== 'active' || run.wave < 2 || player.dead) return;
  glitch.next -= dt;
  if (glitch.next > 0) return;
  const names = Object.keys(GLITCHES).filter(n => n !== glitch.last);
  const name = names[(Math.random() * names.length) | 0];
  glitch.active = name; glitch.last = name; glitch.t = 7;
  GLITCHES[name].start();
  board('GLITCH', name, '#3a8dde');
  sfx.glitch();
}
function endGlitch() {
  if (!glitch.active) return;
  GLITCHES[glitch.active].end();
  glitch.active = null; glitch.next = 18 + Math.random() * 14;
  scene.background.copy(BG_COLOR); scene.fog.color.copy(BG_COLOR);
  sfx.glitch();
}

function heal(n) {
  if (player.dead) return;
  player.hp = Math.min(100, player.hp + n);
  flashMat.color.setHex(0x22ff66); flashMat.opacity = Math.max(flashMat.opacity, 0.18);
  sfx.heal(); drawWrist();
}
function scoreKill(e, hit) {
  run.streak = run.streakT > 0 ? run.streak + 1 : 1;
  run.streakT = 4;
  const mult = Math.min(5, run.streak);
  let pts = KILL_PTS[e.type.name] || 100, tag = '';
  if (hit && hit.void) { pts += 200; tag = 'INTO THE VOID'; }
  else if (hit && hit.part === 'head' && hit.cut) { pts += 150; tag = 'DECAPITATION'; }
  else if (hit && hit.dmg === 0) { pts += 50; tag = 'BLED OUT'; }
  else if (e.lost && e.lost.size >= 2) { pts += 100; tag = 'DISMANTLED'; }
  pts *= mult;
  run.score += pts;
  const c = e.parts.chest.body.translation();
  popup(`+${pts}${tag ? ' ' + tag : ''}${mult > 1 ? '  x' + mult : ''}`, new THREE.Vector3(c.x, c.y + 0.9, c.z), mult > 2 ? '#ffd23a' : '#ffffff');
  sfx.chime(mult);
  heal(tag === 'DECAPITATION' ? 16 : 10);
  saveBest();
}
function saveBest() {
  if (run.score > run.best) { run.best = run.score; try { localStorage.setItem('slopblade.best', run.best); } catch { /* ignore */ } }
}
function endRun() {
  saveBest();
  board('SIMULATION TERMINATED', `wave ${run.wave}  ·  score ${run.score}  ·  best ${run.best}`, '#d41f3a');
  msg.innerHTML = `SIMULATION TERMINATED<br><span style="font-size:.45em">wave ${run.wave} · score ${run.score} · best ${run.best}</span>`;
  msg.style.display = 'grid';
}

// big floating scoreboard above the arena, always turned toward the player
const boardCanvas = document.createElement('canvas'); boardCanvas.width = 1024; boardCanvas.height = 256;
const boardTex = new THREE.CanvasTexture(boardCanvas);
const boardSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: boardTex, transparent: true, depthWrite: false }));
boardSprite.scale.set(6, 1.5, 1);
scene.add(boardSprite);
let boardT = 0;
function board(title, sub = '', color = '#1d2229') {
  const g = boardCanvas.getContext('2d');
  g.clearRect(0, 0, 1024, 256);
  g.textAlign = 'center';
  g.fillStyle = color; g.font = 'bold 110px system-ui'; g.fillText(title, 512, 130);
  g.fillStyle = '#1d2229cc'; g.font = '52px system-ui'; g.fillText(sub, 512, 215);
  boardTex.needsUpdate = true; boardT = 4; boardSprite.material.opacity = 1;
}
const popups = [];
function popup(text, pos, color = '#fff') {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d'); g.textAlign = 'center'; g.font = 'bold 56px system-ui';
  g.lineWidth = 8; g.strokeStyle = '#000a'; g.strokeText(text, 256, 68); g.fillStyle = color; g.fillText(text, 256, 68);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
  sp.scale.set(1.4, 0.26, 1); sp.position.copy(pos); sp.renderOrder = 998;
  scene.add(sp); popups.push({ sp, t: 0 });
}
function updateBoards(dt) {
  const f = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
  boardSprite.position.set(player.head.x + f.x * 7, 3.4, player.head.z + f.z * 7);
  boardT -= dt;
  boardSprite.material.opacity = THREE.MathUtils.clamp(boardT, 0, 1);
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i]; p.t += dt;
    p.sp.position.y += dt * 0.5; p.sp.material.opacity = Math.max(0, 1 - p.t / 1.6);
    if (p.t > 1.6) { scene.remove(p.sp); p.sp.material.map.dispose(); p.sp.material.dispose(); popups.splice(i, 1); }
  }
}

function resetGame() {
  ctx.flying.clear();
  releaseLeft(false);
  for (const e of enemies) if (!e.dead) e.destroy();
  enemies.length = 0;
  pieces.clear(); particles.clear();
  player.hp = 100; player.dead = false; msg.style.display = 'none';
  startRun();
  drawWrist();
}

// ---------------------------------------------------------------- per-step sword drive + hit detection
let pieceSoundCd = 0;
const readPose = (body, outPos, outQ) => { const t = body.translation(), r = body.rotation(); outPos.set(t.x, t.y, t.z); outQ.set(r.x, r.y, r.z, r.w); };

// capped velocity drive of a body toward a target pose; mult > 1 = stronger (two hands)
function driveBody(body, tgt, h, mult = 1, snap = DRIVE.snapDist) {
  const t = body.translation(), r = body.rotation();
  const pos = new THREE.Vector3(t.x, t.y, t.z), q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  const err = new THREE.Vector3().subVectors(tgt.pos, pos);
  if (err.length() > snap) {
    body.setTranslation(tgt.pos, true); body.setRotation(tgt.q, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true); body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    return;
  }
  const weight = settings.swordWeight;
  const qe = tgt.q.clone().multiply(q.clone().invert());
  if (qe.w < 0) { qe.x *= -1; qe.y *= -1; qe.z *= -1; qe.w *= -1; }
  const angle = 2 * Math.acos(Math.min(1, qe.w));
  const s = Math.sqrt(Math.max(1e-9, 1 - qe.w * qe.w));
  const wDes = new THREE.Vector3(qe.x / s, qe.y / s, qe.z / s).multiplyScalar(angle * DRIVE.angK);
  if (angle < 1e-4) wDes.set(0, 0, 0);
  if (wDes.length() > DRIVE.maxW) wDes.setLength(DRIVE.maxW);
  const av = body.angvel();
  const w = new THREE.Vector3(av.x, av.y, av.z);
  const dw = wDes.sub(w); const maxDw = DRIVE.maxAngAcc * mult / weight * h;
  if (dw.length() > maxDw) dw.setLength(maxDw);
  w.add(dw);
  const vDes = err.multiplyScalar(DRIVE.linK).add(tgt.vel);
  const maxV = DRIVE.maxV * Math.min(1.15, mult);
  if (vDes.length() > maxV) vDes.setLength(maxV);
  const c = body.worldCom();
  const rOff = new THREE.Vector3(pos.x - c.x, pos.y - c.y, pos.z - c.z);
  const vComDes = vDes.sub(new THREE.Vector3().crossVectors(w, rOff));
  const lv = body.linvel();
  const v = new THREE.Vector3(lv.x, lv.y, lv.z);
  const dv = vComDes.sub(v); const maxDv = DRIVE.maxAcc * mult / weight * h;
  if (dv.length() > maxDv) dv.setLength(maxDv);
  v.add(dv);
  body.setLinvel(v, true); body.setAngvel(w, true);
}

function swingTravel(w, window = 0.2) {
  let d = 0;
  const hst = w.tipHist;
  for (let i = hst.length - 1; i > 0 && simTime - hst[i].t < window; i--) d += hst[i].p.distanceTo(hst[i - 1].p);
  return d;
}

const SWEEP_GROUPS = grp(G.PSWORD, G.EALIVE);
const SWEEP_FRACS = [0.15, 0.35, 0.55, 0.75, 0.9, 1.0];

// one place that turns "blade touched enemy part at pt with blade velocity v" into a hit
const stats = { hits: 0, glances: 0, clashes: 0, rayHits: 0, contactHits: 0 };
function registerHit(w, e, partKey, pt, v, tipW, travel, hitThisStep) {
  if (e.dead || e.hitCd > 0 || hitThisStep.has(e)) return;
  // relative to the enemy's own movement (not the limb's post-impact velocity, which the
  // blade itself just changed)
  const vr = v.clone().sub(e.vel).sub(e.knock);
  const slash = Math.abs(vr.dot(w.ax.edge));
  const flat = Math.abs(vr.dot(w.ax.flat));
  const along = vr.dot(w.ax.blade);
  const thrust = pt.distanceTo(tipW) < 0.22 && along > 0 ? along : 0;
  const eff = Math.max(slash, thrust * 1.25, flat * 0.45);
  if (eff < DMG.floor || travel < DMG.minTravel) {
    // too slow / off-edge: a glance. It doesn't block a real hit right after it.
    stats.glances++;
    if (!(e.glanceCd > simTime)) { e.glanceCd = simTime + 0.25; sfx.glance(); particles.emit('spark', pt, null, 4, 1.5); pulse(w.hand, 0.15, 20); }
    return;
  }
  hitThisStep.add(e);
  const part = e.parts[partKey];
  const twoHand = w === rightW && left.twoHand ? 1.25 : 1;
  const dmg = Math.min(160, (eff - 1.5) * DMG.scale * part.mult * twoHand);
  stats.hits++;
  e.hitCd = 0.15;
  const cut = slash >= thrust * 1.25 && slash >= flat * 0.45; // edge-led, so it can sever a limb
  e.takeHit({ part: partKey, point: pt, dir: vr.clone().normalize(), speed: eff, dmg, cut });
  pulse(w.hand, 0.35 + dmg / 80, 40 + dmg);
  if (twoHand > 1) pulse('left', 0.25 + dmg / 120, 30 + dmg);
}

function processContacts(w, h, hitThisStep) {
  const pre = w.pre;
  w.ax.blade.set(0, 1, 0).applyQuaternion(pre.q);
  w.ax.edge.set(0, 0, 1).applyQuaternion(pre.q);
  w.ax.flat.set(1, 0, 0).applyQuaternion(pre.q);
  const tipW = new THREE.Vector3(0, w.sword.tipY, 0).applyQuaternion(pre.q).add(pre.pos);
  const travel = swingTravel(w);
  const velAt = pt => new THREE.Vector3().crossVectors(pre.ang, tmpV.subVectors(pt, pre.com)).add(pre.lin);

  // 1) real contacts
  world.contactPairsWith(w.bladeCol, other => {
    const info = phys.info.get(other.handle);
    if (!info) return;
    let pt = null;
    world.contactPair(w.bladeCol, other, m => {
      if (!pt && m.numSolverContacts() > 0) { const p = m.solverContactPoint(0); pt = new THREE.Vector3(p.x, p.y, p.z); }
    });
    if (!pt) return;
    const v = velAt(pt);
    if (info.kind === 'enemy' && !hitThisStep.has(info.enemy)) stats.contactHits++;
    if (info.kind === 'enemy') registerHit(w, info.enemy, info.part, pt, v, tipW, travel, hitThisStep);
    else if (info.kind === 'esword') {
      stats.clashes++;
      const parried = info.enemy.onClash(v.length());
      if (info.enemy.clashCd > 0.14 || parried) {
        sfx.clang(Math.min(1, v.length() / 8 + (parried ? 0.4 : 0)));
        particles.emit('spark', pt, null, parried ? 14 : 6, 2.5);
        pulse(w.hand, parried ? 1 : 0.5, parried ? 90 : 40);
      }
    } else if (info.kind === 'piece' && pieceSoundCd <= 0 && v.length() > 3) {
      pieceSoundCd = 0.1; sfx.thump(Math.min(0.6, v.length() / 15)); pulse(w.hand, 0.25, 25);
    }
  });

  // 2) swept rays along the blade's path this step, so fast swings can't skip past thin limbs
  for (const f of SWEEP_FRACS) {
    const y = w.sword.baseY + (w.sword.tipY - w.sword.baseY) * f;
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
    registerHit(w, info.enemy, info.part, pt, v, tipW, travel, hitThisStep);
  }
}

// ---------------------------------------------------------------- left hand: grab / pick up / two hands
const GRAB_GROUPS = grp(G.PHAND, G.EALIVE | G.ESWORD | G.PIECE | G.DEBRIS);
function updateLeftInput() {
  const xr = renderer.xr.isPresenting;
  let sq = false;
  if (xr) {
    for (const src of renderer.xr.getSession().inputSources) if (src.handedness === 'left' && src.gamepad) sq = !!src.gamepad.buttons[1]?.pressed;
  } else sq = !!window.game?.leftOverride?.squeeze;
  left.prevSqueeze = left.squeeze; left.squeeze = sq && leftT.valid;
  if (left.squeeze && !left.prevSqueeze) tryGrab();
  if (!left.squeeze && left.prevSqueeze) releaseLeft(true);
}

function tryGrab() {
  const hp = leftT.pos;
  // 1) on the right sword's grip -> two-handed
  const sp = new THREE.Vector3(), sq = new THREE.Quaternion();
  readPose(swordBody, sp, sq);
  const g0 = new THREE.Vector3(0, -0.13, 0).applyQuaternion(sq).add(sp), g1 = new THREE.Vector3(0, 0.09, 0).applyQuaternion(sq).add(sp);
  if (new THREE.Line3(g0, g1).closestPointToPoint(hp, true, new THREE.Vector3()).distanceTo(hp) < 0.1) {
    left.twoHand = true; handCol.setCollisionGroups(GROUPS.none); pulse('left', 0.4, 40); return;
  }
  // 2) the nearest thing within reach of the fist
  const proj = world.projectPoint(hp, true, undefined, GRAB_GROUPS);
  if (!proj || tmpV.set(proj.point.x, proj.point.y, proj.point.z).distanceTo(hp) > 0.13) return;
  const body = proj.collider.parent();
  const entry = pieces.find(body);
  if (entry && entry.sword && !left.weapon) {
    // a loose sword: it becomes the left weapon
    pieces.detach(entry);
    entry.thrownBy = null;
    const col = body.collider(0);
    col.setCollisionGroups(GROUPS.psword);
    phys.info.set(col.handle, { kind: 'psword' });
    body.setGravityScale(0, true); body.setAngularDamping(0); body.setLinearDamping(0);
    left.weapon = makeWeapon(entry.sword, body, col, 'left', leftT);
    left.weapon.entry = entry;
    weapons.push(left.weapon);
    handCol.setCollisionGroups(GROUPS.none);
    sfx.clang(0.3); pulse('left', 0.6, 60);
    return;
  }
  // otherwise hold it: weld the fist to it where they touch
  const hpos = new THREE.Vector3(), hq = new THREE.Quaternion(), bpos = new THREE.Vector3(), bq = new THREE.Quaternion();
  readPose(handBody, hpos, hq); readPose(body, bpos, bq);
  const P = new THREE.Vector3(proj.point.x, proj.point.y, proj.point.z);
  const a1 = P.clone().sub(hpos).applyQuaternion(hq.clone().invert());
  const a2 = P.clone().sub(bpos).applyQuaternion(bq.clone().invert());
  const f1 = hq.clone().invert(), f2 = bq.clone().invert();
  left.grabJoint = world.createImpulseJoint(RAPIER.JointData.fixed(a1, f1, a2, f2), handBody, body, true);
  left.grabJoint.setContactsEnabled(false);
  left.grabbed = body;
  if (entry) entry.thrownBy = 'player';
  pulse('left', 0.5, 50);
}

// letting go: whatever was held keeps its momentum (so you can throw it)
function releaseLeft(keepMomentum) {
  if (left.grabJoint) {
    // if the held body was cleaned up, its joint went with it
    if (bodyAlive(left.grabbed)) world.removeImpulseJoint(left.grabJoint, true);
    const e = left.grabbed && pieces.find(left.grabbed);
    if (e) e.thrownBy = null;
    left.grabJoint = null; left.grabbed = null;
  }
  if (left.weapon) {
    const w = left.weapon;
    weapons.splice(weapons.indexOf(w), 1);
    w.bladeCol.setCollisionGroups(GROUPS.piece);
    w.body.setGravityScale(1, true); w.body.setAngularDamping(0.8);
    if (!keepMomentum) w.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    w.entry.age = 0;
    pieces.list.push(w.entry);
    phys.info.set(w.bladeCol.handle, { kind: 'piece' });
    left.weapon = null;
  }
  left.twoHand = false;
  handCol.setCollisionGroups(GROUPS.phand);
}

// Anything an enemy has thrown that touches (or passes right by) a blade gets batted away
// and can no longer hurt the player.
function deflectThrown() {
  if (!ctx.flying.size) return;
  for (const entry of ctx.flying) {
    if (entry.removed || !bodyAlive(entry.body)) { ctx.flying.delete(entry); continue; }
    const t = entry.body.translation(), pp = new THREE.Vector3(t.x, t.y, t.z);
    for (const w of weapons) {
      const p = new THREE.Vector3(), q = new THREE.Quaternion();
      readPose(w.body, p, q);
      const a = new THREE.Vector3(0, -0.12, 0).applyQuaternion(q).add(p); // from the pommel, guard included
      const b = new THREE.Vector3(0, w.sword.tipY, 0).applyQuaternion(q).add(p);
      const c = new THREE.Line3(a, b).closestPointToPoint(pp, true, new THREE.Vector3());
      // forgiving: a fast swat covers more space between physics steps
      const reach = Math.min(0.26, 0.13 + w.tipVel.length() * 0.012);
      if (c.distanceTo(pp) > reach) continue;
      // bat it along the blade's motion at that point, plus away from the player
      const lv = w.body.linvel(), av = w.body.angvel(), com = w.body.worldCom();
      const bv = new THREE.Vector3(av.x, av.y, av.z).cross(c.clone().sub(tmpV.set(com.x, com.y, com.z))).add(tmpV2.set(lv.x, lv.y, lv.z));
      const away = pp.clone().sub(player.head).setY(0).normalize();
      const v = bv.multiplyScalar(1.3).addScaledVector(away, 4).add(tmpV.set(0, 1.5, 0));
      entry.body.setLinvel(v, true);
      entry.body.setAngvel({ x: (Math.random() - 0.5) * 30, y: (Math.random() - 0.5) * 30, z: (Math.random() - 0.5) * 30 }, true);
      entry.inFlight = false; ctx.flying.delete(entry);
      stats.deflects = (stats.deflects || 0) + 1;
      sfx.clang(0.7); particles.emit('spark', c, null, 12, 2.5); pulse(w.hand, 0.8, 60);
      break;
    }
  }
}

function fixedStep(h) {
  simTime += h;
  pieceSoundCd -= h;
  // remember the real (post-solve) motion of each blade from the previous step
  for (const w of weapons) {
    const lv = w.body.linvel(), av = w.body.angvel(), c = w.body.worldCom(), t = w.body.translation(), r = w.body.rotation();
    w.pre.lin.set(lv.x, lv.y, lv.z); w.pre.ang.set(av.x, av.y, av.z); w.pre.com.set(c.x, c.y, c.z);
    w.pre.pos.set(t.x, t.y, t.z); w.pre.q.set(r.x, r.y, r.z, r.w);
  }
  for (const w of weapons) if (w.target.valid) driveBody(w.body, w.target, h, w === rightW && left.twoHand ? 1.6 : 1);
  // the fist follows the left controller (lighter, so it shoves rather than smashes)
  if (leftT.valid && !left.weapon) driveBody(handBody, leftT, h, 0.8, 0.6);
  for (const e of enemies) e.update(h);
  world.step();
  deflectThrown();
  const hitThisStep = new Set();
  for (const w of weapons) processContacts(w, h, hitThisStep);

  // blade tips; the AI reads the fastest-moving one
  let fastest = null;
  for (const w of weapons) {
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    readPose(w.body, p, q);
    const tip = new THREE.Vector3(0, w.sword.tipY, 0).applyQuaternion(q).add(p);
    w.tipVel.subVectors(tip, w.tip).divideScalar(h).clampLength(0, 40);
    w.tip.copy(tip); w.bladeDir = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    w.tipHist.push({ t: simTime, p: tip });
    while (w.tipHist.length > 60) w.tipHist.shift();
    if (!fastest || w.tipVel.lengthSq() > fastest.tipVel.lengthSq()) fastest = w;
  }
  player.tip.copy(fastest.tip); player.tipVel.copy(fastest.tipVel); player.bladeDir.copy(fastest.bladeDir);

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
  const probes = [];
  for (let wi = 0; wi < 2; wi++) {
    const w = weapons[wi];
    for (const f of [0.1, 0.35, 0.6, 0.8, 1]) {
      if (!w) { probes.push(null); continue; }
      const sp = new THREE.Vector3(), sq = new THREE.Quaternion();
      readPose(w.body, sp, sq);
      probes.push(new THREE.Vector3(0, w.sword.tipY * f, 0).applyQuaternion(sq).add(sp));
    }
  }
  for (const g of grips) if (g.userData.hand) probes.push(g.getWorldPosition(new THREE.Vector3()));
  let near = false, hit = false;
  const seg = new THREE.Line3(), c = new THREE.Vector3();
  probes.forEach((p, i) => {
    if (!p) return;
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
  // the alert rings out from high above the button
  playAlertAt(new THREE.Vector3(ctx.button.pos.x, ctx.button.pos.y + 25, ctx.button.pos.z));
  if (!byEnemy) pulse(null, 0.6, 50);
  return true;
}

// ---------------------------------------------------------------- main loop
const clock = new THREE.Clock();
let acc = 0;
startRun();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  updateLocomotion(dt);
  camera.updateMatrixWorld(true);
  camera.getWorldPosition(player.head);
  {
    const q = camera.getWorldQuaternion(tmpQ);
    setListener(player.head, tmpV.set(0, 0, -1).applyQuaternion(q), tmpV2.set(0, 1, 0).applyQuaternion(q));
  }
  updateTarget(dt);
  updateLeftInput();

  acc += dt;
  let n = 0;
  while (acc >= FIXED && n < 6) { fixedStep(FIXED); acc -= FIXED; n++; }
  if (n === 6) acc = 0;

  for (const w of weapons) readPose(w.body, w.sword.group.position, w.sword.group.quaternion);
  const t = swordBody.translation();
  readPose(handBody, handMesh.position, handMesh.quaternion);
  handMesh.visible = leftT.valid && !left.weapon && !left.twoHand;
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
  updateRun(dt);
  updateBoards(dt);
  updateGlitch(dt);
  for (const d of decor) { d.rotation.x += d.userData.spin.x * dt; d.rotation.y += d.userData.spin.y * dt; }
  flashMat.opacity = Math.max(0, flashMat.opacity - dt * 1.5);
  sun.position.set(player.head.x + 4, 9, player.head.z + 3); sun.target.position.set(player.head.x, 0, player.head.z);

  if (player.dead) { player.deadT -= dt; flashMat.opacity = Math.max(flashMat.opacity, 0.35); if (player.deadT <= 0) resetGame(); }

  renderer.render(scene, camera);
});

// test / debug hook
window.game = { glitch, GLITCHES, run, popups, left, weapons, leftT, settings, handBody, Enemy, ctx, stats, spawnEnemy, enemies, player, pieces, target, mouse, swordBody, resetGame, world, DRIVE };
