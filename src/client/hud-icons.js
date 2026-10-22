// Pixel-art hearts and drumsticks for the health / hunger bars, painted from code (no image assets).
// Each icon is a 9x9 map; states are 'full', 'half' and 'empty'. Results are cached PNG data URLs.

const HEART = [
  '.OOO.OOO.',
  'OWWROXRRO',
  'OWRRRRRRO',
  'ORRRRRRRO',
  '.ORRRRRO.',
  '..ORRRO..',
  '...ORO...',
  '....O....',
  '.........',
];
const FOOD = [
  '....OOOO.',
  '..OOMMMMO',
  '.OMMMHHMO',
  '.OMMMMMMO',
  '.OMMMMMO.',
  '..OMMMOO.',
  '.OBOOOO..',
  'OBBO.....',
  '.OO......',
];

const PALETTE = {
  heart: {
    full: { O: [44, 6, 8], W: [255, 176, 170], R: [214, 38, 44], X: [44, 6, 8] },
    empty: { O: [44, 6, 8], W: [92, 40, 44], R: [66, 24, 28], X: [44, 6, 8] },
  },
  food: {
    full: { O: [50, 24, 6], H: [255, 214, 140], M: [206, 120, 44], B: [240, 232, 210] },
    empty: { O: [50, 24, 6], H: [96, 70, 40], M: [86, 56, 28], B: [110, 104, 92] },
  },
};
const MAPS = { heart: HEART, food: FOOD };

function paint(kind, state) {
  const map = MAPS[kind];
  const full = PALETTE[kind].full, empty = PALETTE[kind].empty;
  const c = document.createElement('canvas');
  c.width = c.height = 9;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(9, 9);
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const ch = map[y][x];
      if (ch === '.') continue;
      // half icons: the left half of a heart is lit; the right half of a drumstick is (the meat sits top right)
      const lit = state === 'full' || (state === 'half' && (kind === 'heart' ? x <= 4 : x >= 4));
      const pal = ch === 'O' || ch === 'X' ? full : lit ? full : empty;
      const col = pal[ch];
      if (!col) continue;
      const i = (y * 9 + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** Install the icons as CSS custom properties (--ic-heart-full ...) once. */
export function installHudIcons(root = document.documentElement) {
  for (const kind of ['heart', 'food']) {
    for (const state of ['full', 'half', 'empty']) {
      root.style.setProperty(`--ic-${kind}-${state}`, `url(${paint(kind, state)})`);
    }
  }
}
