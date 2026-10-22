// Persistence in localStorage. Everything is wrapped: private browsing or a full quota must never crash the game.
//
// Layout:
//   blocklands.settings.v1       settings object
//   blocklands.worlds.v1         index: [{id, name, seed, created, lastPlayed}]
//   blocklands.world.<id>.v1     one save per world (Game.serialize())
//   blocklands.save.v1           legacy single-world save (v0.1.x); migrated to a world on first launch
const SETTINGS_KEY = 'blocklands.settings.v1';
const INDEX_KEY = 'blocklands.worlds.v1';
const LEGACY_KEY = 'blocklands.save.v1';
const worldKey = (id) => `blocklands.world.${id}.v1`;

export const DEFAULT_SETTINGS = {
  renderDistance: 4,
  resolution: 1, // 0 low, 1 medium, 2 high
  sensitivity: 1,
  autoJump: true,
  math: true, // grade 1 maths: answer a sum to mine a new kind of block
  music: 0.6,
  sfx: 0.8,
  debug: false,
  seenHelp: false,
};

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
}
function remove(key) {
  try { localStorage.removeItem(key); } catch (e) { /* ignored */ }
}

export function loadSettings() {
  const s = read(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
}
export function saveSettings(s) { return write(SETTINGS_KEY, s); }

// ------------------------------------------------------------------ seeds
/** Turn what the player typed into an integer seed: empty = random, digits = that number, anything else = a string hash. */
export function parseSeed(text, random = Math.random) {
  const t = String(text ?? '').trim();
  if (!t) return Math.floor(random() * 2 ** 31);
  if (/^-?\d{1,10}$/.test(t)) {
    const n = parseInt(t, 10);
    if (Number.isSafeInteger(n) && Math.abs(n) < 2 ** 31) return n;
  }
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}

// ------------------------------------------------------------------ worlds
function cleanIndex(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const w of raw) {
    if (!w || typeof w.id !== 'string' || !w.id || seen.has(w.id)) continue;
    seen.add(w.id);
    out.push({
      id: w.id,
      name: typeof w.name === 'string' && w.name.trim() ? w.name.slice(0, 32) : 'Unnamed World',
      seed: Number.isFinite(w.seed) ? w.seed | 0 : 0,
      created: Number(w.created) || 0,
      lastPlayed: Number(w.lastPlayed) || 0,
    });
  }
  return out;
}

const newId = () => 'w' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');

function readIndex() {
  let idx = read(INDEX_KEY);
  if (idx === null) {
    // First launch of a version with worlds: adopt the old single save if there is one.
    const legacy = read(LEGACY_KEY);
    idx = [];
    if (legacy && legacy.v === 1) {
      const now = Date.now();
      const meta = { id: newId(), name: 'World 1', seed: legacy.seed | 0, created: now, lastPlayed: now };
      if (write(worldKey(meta.id), legacy)) { idx.push(meta); remove(LEGACY_KEY); }
    }
    write(INDEX_KEY, idx);
  }
  return cleanIndex(idx);
}

/** All worlds, most recently played first. */
export function listWorlds() {
  return readIndex().sort((a, b) => b.lastPlayed - a.lastPlayed || b.created - a.created);
}

export function getWorld(id) { return readIndex().find((w) => w.id === id) || null; }

/** Register a new world (no save data yet). `name` defaults to "World N". */
export function createWorld({ name, seed } = {}) {
  const idx = readIndex();
  const n = idx.length + 1;
  let label = String(name ?? '').trim().slice(0, 32);
  if (!label) {
    let k = n;
    while (idx.some((w) => w.name === `World ${k}`)) k++;
    label = `World ${k}`;
  }
  const now = Date.now();
  const meta = { id: newId(), name: label, seed: (seed ?? parseSeed('')) | 0, created: now, lastPlayed: now };
  idx.push(meta);
  write(INDEX_KEY, idx);
  return meta;
}

export function renameWorld(id, name) {
  const idx = readIndex();
  const w = idx.find((x) => x.id === id);
  const label = String(name ?? '').trim().slice(0, 32);
  if (!w || !label) return false;
  w.name = label;
  return write(INDEX_KEY, idx);
}

export function loadWorld(id) {
  const s = read(worldKey(id));
  return s && s.v === 1 ? s : null;
}

/** Write a world's save and stamp it as just played. Returns false if the browser refused (quota, private mode). */
export function saveWorld(id, data) {
  const idx = readIndex();
  const meta = idx.find((w) => w.id === id);
  if (!meta) return false;
  if (!write(worldKey(id), data)) return false;
  meta.lastPlayed = Date.now();
  if (data && Number.isFinite(data.seed)) meta.seed = data.seed | 0;
  write(INDEX_KEY, idx);
  return true;
}

/** Mark a world as played without writing its data (used when starting one). */
export function touchWorld(id) {
  const idx = readIndex();
  const meta = idx.find((w) => w.id === id);
  if (!meta) return;
  meta.lastPlayed = Date.now();
  write(INDEX_KEY, idx);
}

export function deleteWorld(id) {
  const idx = readIndex();
  remove(worldKey(id));
  write(INDEX_KEY, idx.filter((w) => w.id !== id));
}
