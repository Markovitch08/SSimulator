// Tiny procedural sound kit (WebAudio), no assets.
let ctx = null, master = null, noiseBuf = null;

// --- 3D one-shots (the spawn alert), positioned in the world with HRTF panning
let alertData = null, alertBuf = null;
export function loadAlert(url) {
  fetch(url).then(r => r.arrayBuffer()).then(b => { alertData = b; decodeAlert(); }).catch(e => console.warn('alert sound failed to load', e));
}
function decodeAlert() {
  if (!ctx || !alertData || alertBuf) return;
  ctx.decodeAudioData(alertData.slice(0)).then(b => { alertBuf = b; }).catch(e => console.warn('alert decode failed', e));
}
// keep the listener on the player's head so positioned sounds come from the right place
export function setListener(pos, fwd, up) {
  if (!ctx) return;
  const L = ctx.listener;
  if (L.positionX) {
    L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
    L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
    L.upX.value = up.x; L.upY.value = up.y; L.upZ.value = up.z;
  } else { L.setPosition(pos.x, pos.y, pos.z); L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
}
export function playAlertAt(pos, volume = 0.9) {
  if (!ctx || ctx.state !== 'running' || !alertBuf) return;
  const src = ctx.createBufferSource(); src.buffer = alertBuf;
  const pan = ctx.createPanner();
  pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 20; pan.rolloffFactor = 1;
  if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; }
  else pan.setPosition(pos.x, pos.y, pos.z);
  const g = ctx.createGain(); g.gain.value = volume;
  src.connect(g).connect(pan).connect(master);
  // big open-space echo: two cross-feeding, darkening delay lines
  const wet = ctx.createGain(); wet.gain.value = 0.75;
  const d1 = ctx.createDelay(2), d2 = ctx.createDelay(2);
  d1.delayTime.value = 0.38; d2.delayTime.value = 0.61;
  const f1 = ctx.createGain(), f2 = ctx.createGain(); f1.gain.value = 0.55; f2.gain.value = 0.5;
  const lp1 = ctx.createBiquadFilter(), lp2 = ctx.createBiquadFilter();
  lp1.type = lp2.type = 'lowpass'; lp1.frequency.value = 2600; lp2.frequency.value = 1800;
  pan.connect(d1); pan.connect(d2);
  d1.connect(lp1).connect(f1).connect(d2);
  d2.connect(lp2).connect(f2).connect(d1);
  lp1.connect(wet); lp2.connect(wet);
  wet.connect(master);
  src.start();
  // tear the feedback loop down once the echo has died away, or it would run forever
  setTimeout(() => { for (const n of [src, g, pan, d1, d2, f1, f2, lp1, lp2, wet]) n.disconnect(); }, (alertBuf.duration + 6) * 1000);
}

// --- general positioned one-shots (e.g. the parasite reveal)
const sounds = {};
export function loadSound(name, url) {
  fetch(url).then(r => r.arrayBuffer()).then(b => { sounds[name] = { data: b, buf: null }; decodeSounds(); }).catch(e => console.warn(name + ' sound failed to load', e));
}
function decodeSounds() {
  if (!ctx) return;
  for (const s of Object.values(sounds)) if (!s.buf && !s.decoding) { s.decoding = true; ctx.decodeAudioData(s.data.slice(0)).then(b => { s.buf = b; }).catch(() => {}); }
}
export function playSoundAt(name, pos, volume = 1) {
  const s = sounds[name];
  if (!ctx || ctx.state !== 'running' || !s || !s.buf) return;
  const src = ctx.createBufferSource(); src.buffer = s.buf;
  const pan = ctx.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 3; pan.rolloffFactor = 1;
  if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; } else pan.setPosition(pos.x, pos.y, pos.z);
  const g = ctx.createGain(); g.gain.value = volume;
  src.connect(g).connect(pan).connect(master); src.start();
}

// non-spatial playback (keeps a stereo file's width): for sounds made right at the player.
// Returns false if the file isn't decoded yet so the caller can fall back.
export function playSound(name, volume = 1) {
  const s = sounds[name];
  if (!ctx || ctx.state !== 'running' || !s || !s.buf) return false;
  const src = ctx.createBufferSource(); src.buffer = s.buf;
  const g = ctx.createGain(); g.gain.value = volume;
  src.connect(g).connect(master);
  src.onended = () => { src.disconnect(); g.disconnect(); };
  src.start();
  return true;
}

export function resumeAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0.7; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  decodeAlert(); decodeSounds();
}

function env(g, t, a, peak, dec) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
}

function noise(t, dur, freq, q, peak, type = 'lowpass') {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
  const g = ctx.createGain(); env(g, t, 0.003, peak, dur);
  s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + dur + 0.05);
}

function tone(t, f0, f1, dur, peak, type = 'sine') {
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  const g = ctx.createGain(); env(g, t, 0.004, peak, dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
}

const ok = () => ctx && ctx.state === 'running';

export const sfx = {
  hit(i = 0.5) { if (!ok()) return; const t = ctx.currentTime; tone(t, 140, 45, 0.18 + i * 0.1, 0.5 + i * 0.4); noise(t, 0.12, 900 + i * 900, 0.8, 0.35 + i * 0.3); },
  glance() { if (!ok()) return; const t = ctx.currentTime; noise(t, 0.05, 3500, 2, 0.15, 'bandpass'); },
  clang(i = 0.6) {
    if (!ok()) return; const t = ctx.currentTime;
    for (const [f, a] of [[820, 1], [1347, 0.7], [2110, 0.5], [3170, 0.35]]) tone(t, f, f * 0.98, 0.5 + i * 0.3, 0.12 * a * (0.5 + i));
    noise(t, 0.04, 5000, 1, 0.25, 'highpass');
  },
  splat() { if (!ok()) return; const t = ctx.currentTime; tone(t, 90, 30, 0.35, 0.9); noise(t, 0.3, 600, 0.7, 0.7); noise(t + 0.03, 0.2, 2400, 1.5, 0.3, 'bandpass'); },
  thump(i = 0.5) { if (!ok()) return; const t = ctx.currentTime; tone(t, 80, 35, 0.25, 0.4 + i * 0.5); noise(t, 0.1, 400, 0.7, 0.2 + i * 0.3); },
  whoosh() { if (!ok()) return; const t = ctx.currentTime; const s = ctx.createBufferSource(); s.buffer = noiseBuf; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3; f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(2500, t + 0.6); const g = ctx.createGain(); env(g, t, 0.3, 0.25, 0.4); s.connect(f).connect(g).connect(master); s.start(t); s.stop(t + 0.8); },
  hurt() { if (!ok()) return; const t = ctx.currentTime; tone(t, 220, 60, 0.3, 0.6, 'sawtooth'); noise(t, 0.15, 700, 1, 0.5); },
  // vocal grunt: buzzy source through two formant filters, pitch falling off
  grunt(i = 0.5, pitch = 1, len = 0) {
    if (!ok()) return; const t = ctx.currentTime;
    const dur = len || 0.16 + i * 0.16 + Math.random() * 0.06;
    const f0 = (105 + Math.random() * 25) * pitch;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0 * 1.15, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.75, t + dur);
    const g = ctx.createGain(); env(g, t, 0.015, 0.35 + i * 0.45, dur);
    const mix = ctx.createGain(); mix.gain.value = 1;
    for (const [f, q, a] of [[(560 + Math.random() * 120) * pitch, 5, 1], [(1050 + Math.random() * 200) * pitch, 7, 0.55], [2400 * pitch, 9, 0.2]]) {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const ga = ctx.createGain(); ga.gain.value = a * 2.2;
      o.connect(bp).connect(ga).connect(mix);
    }
    mix.connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.05);
    noise(t, dur * 0.6, 900 * pitch, 1.2, 0.06 + i * 0.08, 'bandpass'); // breath
  },
  // rising arpeggio for kills; higher with a bigger streak multiplier
  chime(mult = 1) { if (!ok()) return; const t = ctx.currentTime; const base = 520 * Math.pow(1.12, mult - 1); [0, 0.06, 0.12].forEach((d, i) => tone(t + d, base * [1, 1.26, 1.5][i], base * [1, 1.26, 1.5][i], 0.18, 0.16, 'triangle')); },
  fanfare() { if (!ok()) return; const t = ctx.currentTime; [0, 0.12, 0.24, 0.4].forEach((d, i) => tone(t + d, [392, 494, 587, 784][i], [392, 494, 587, 784][i], 0.35, 0.2, 'square')); },
  heal() { if (!ok()) return; const t = ctx.currentTime; tone(t, 660, 1320, 0.25, 0.12, 'sine'); },
  // digital stutter for simulation glitches
  glitch() { if (!ok()) return; const t = ctx.currentTime; for (let i = 0; i < 9; i++) { const f = 120 + Math.random() * 1600; tone(t + i * 0.045, f, f * (0.5 + Math.random()), 0.05, 0.12, 'square'); } noise(t, 0.4, 3000, 0.5, 0.15, 'bandpass'); },
  beep() { if (!ok()) return; const t = ctx.currentTime; tone(t, 660, 990, 0.12, 0.25, 'triangle'); },
};

// ---------------------------------------------------------------- revolver sounds
// Gunshot: six layers into a per-shot soft-clip waveshaper (never a shared one). Mechanical
// sounds: short noise+tone clicks with a little random pitch/gain each time. Every node here
// belongs to one sound and is released when that sound ends.
function nz(t, dur, type, f0, f1, q, gain, out) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f).connect(g).connect(out); s.start(t); s.stop(t + dur + 0.02);
}
function osc(t, dur, type, f0, f1, gain, out) {
  const o = ctx.createOscillator(); o.type = type;
  o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.02);
}
let clipCurve = null;
function click(f, gain = 0.25, dur = 0.025) {
  if (!ok()) return; const t = ctx.currentTime, k = 0.9 + Math.random() * 0.2, gv = gain * (0.85 + Math.random() * 0.3);
  nz(t, dur, 'bandpass', 3200 * k, 1800 * k, 2, gv, master); osc(t, dur * 1.2, 'square', f * k, f * 0.7 * k, gv * 0.4, master);
}
export const gunSfx = {
  shot() {
    if (!ok()) return; const t = ctx.currentTime;
    if (!clipCurve) { clipCurve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; clipCurve[i] = Math.tanh(2.2 * x); } }
    const shaper = ctx.createWaveShaper(); shaper.curve = clipCurve; // fresh per shot
    const bus = ctx.createGain(); bus.gain.value = 0.55; bus.connect(shaper).connect(master);
    nz(t, 0.04, 'highpass', 3000, 1800, 0.7, 0.9, bus);   // crack
    nz(t, 0.22, 'bandpass', 900, 220, 0.9, 1.0, bus);     // mid punch
    nz(t, 0.9, 'lowpass', 3500, 90, 0.7, 1.2, bus);       // blast body
    osc(t, 0.6, 'sine', 95, 32, 1.4, bus);                // sub boom
    osc(t, 1.0, 'sine', 58, 26, 1.0, bus);                // low rumble
    osc(t, 0.12, 'triangle', 180, 60, 0.6, bus);          // chest thump
    setTimeout(() => { bus.disconnect(); shaper.disconnect(); }, 1200);
  },
  cock() { click(900, 0.22); setTimeout(() => click(1300, 0.2), 45); },
  dry() { click(520, 0.4, 0.035); },
  open() { click(700, 0.25, 0.04); },
  close() { click(1000, 0.3, 0.03); },
  ejector() { click(600, 0.2, 0.06); },
  insert() { click(1600, 0.12, 0.02); },
  ratchet() { click(2200, 0.06, 0.012); },
  detent() { click(1400, 0.18, 0.02); },
  holster() { if (!ok()) return; const t = ctx.currentTime; nz(t, 0.12, 'lowpass', 500, 150, 0.7, 0.5, master); },
  clatter(i = 0.5) { if (!ok()) return; const t = ctx.currentTime; nz(t, 0.08, 'lowpass', 600, 200, 0.7, 0.3 * i, master); osc(t, 0.15, 'triangle', 1400 + Math.random() * 400, 900, 0.12 * i, master); },
  tink() { if (!ok()) return; const t = ctx.currentTime, f = 3000 + Math.random() * 1500; osc(t, 0.12, 'sine', f, f * 0.95, 0.06, master); },
  impact(kind) {
    if (!ok()) return; const t = ctx.currentTime;
    if (kind === 'flesh') { nz(t, 0.09, 'lowpass', 900, 200, 0.7, 0.45, master); osc(t, 0.1, 'sine', 120, 50, 0.3, master); }
    else if (kind === 'steel') { const f = 1800 + Math.random() * 900; osc(t, 0.3, 'sine', f, f * 0.97, 0.12, master); nz(t, 0.03, 'highpass', 5000, 4000, 1, 0.2, master); }
    else nz(t, 0.12, 'lowpass', 700, 150, 0.7, 0.3, master);
  },
};
