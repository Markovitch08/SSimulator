// Player-tunable settings, saved in this browser. Changed from the VR wrist panel
// (left Y button) or the desktop Settings panel.
export const SETTINGS_META = [
  { key: 'swordWeight', label: 'Sword weight', min: 0.5, max: 2, def: 1 },
  { key: 'enemyToughness', label: 'Enemy toughness', min: 0.5, max: 2.5, def: 1 },
  { key: 'cutThreshold', label: 'Limb toughness', min: 0.5, max: 2.5, def: 1 },
  { key: 'haptics', label: 'Haptics', min: 0, max: 1.5, def: 1 },
];
const KEY = 'slopblade.settings';
export const settings = Object.fromEntries(SETTINGS_META.map(m => [m.key, m.def]));
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  for (const m of SETTINGS_META) if (typeof saved[m.key] === 'number') settings[m.key] = Math.min(m.max, Math.max(m.min, saved[m.key]));
} catch { /* storage unavailable: defaults */ }

const listeners = [];
export function onSettingsChange(fn) { listeners.push(fn); }
export function setSetting(key, value) {
  const m = SETTINGS_META.find(x => x.key === key);
  if (!m) return;
  settings[key] = Math.min(m.max, Math.max(m.min, value));
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  for (const fn of listeners) fn(key, settings[key]);
}
