// One-time asset generator: draws colored placement tiles (1-8, "good" and
// "bad" variants) as PNGs into assets/placement-icons/, styled after
// arenasweats.lol's own recent-games grid. Pure-JS PNG encoding via pngjs
// (no canvas/native dependency) — a hand-rolled 5x7 bitmap digit font drawn
// onto a rounded-corner colored square.
//
// Usage: node scripts/generate-placement-icons.js
// Re-run any time the colors/size need tweaking; re-upload afterwards with
// scripts/upload-placement-emojis.js.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'placement-icons');
const SIZE = 80;
const CORNER_RADIUS = 14;
const SCALE = 8;

const COLORS = {
  good: { r: 46, g: 125, b: 79 }, // top-half placement
  bad: { r: 178, g: 58, b: 58 }, // bottom-half placement
};
const TEXT_COLOR = { r: 255, g: 255, b: 255 };

// Classic 5-wide x 7-tall bitmap digit font, '1' = pixel on.
const DIGITS = {
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
};

function isInsideRoundedRect(x, y, size, radius) {
  const corners = [
    { cx: radius, cy: radius, inRegion: x < radius && y < radius },
    { cx: size - radius, cy: radius, inRegion: x > size - radius && y < radius },
    { cx: radius, cy: size - radius, inRegion: x < radius && y > size - radius },
    { cx: size - radius, cy: size - radius, inRegion: x > size - radius && y > size - radius },
  ];
  const corner = corners.find((c) => c.inRegion);
  if (!corner) return true;
  const dx = x - corner.cx;
  const dy = y - corner.cy;
  return dx * dx + dy * dy <= radius * radius;
}

function drawTile(digit, variant) {
  const png = new PNG({ width: SIZE, height: SIZE });
  const bg = COLORS[variant];
  const pattern = DIGITS[digit];
  const glyphWidth = 5 * SCALE;
  const glyphHeight = 7 * SCALE;
  const offsetX = Math.round((SIZE - glyphWidth) / 2);
  const offsetY = Math.round((SIZE - glyphHeight) / 2);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const idx = (SIZE * y + x) << 2;

      if (!isInsideRoundedRect(x + 0.5, y + 0.5, SIZE, CORNER_RADIUS)) {
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 0;
        continue;
      }

      let color = bg;
      const gx = x - offsetX;
      const gy = y - offsetY;
      if (gx >= 0 && gx < glyphWidth && gy >= 0 && gy < glyphHeight) {
        const col = Math.floor(gx / SCALE);
        const row = Math.floor(gy / SCALE);
        if (pattern[row][col] === '1') {
          color = TEXT_COLOR;
        }
      }

      png.data[idx] = color.r;
      png.data[idx + 1] = color.g;
      png.data[idx + 2] = color.b;
      png.data[idx + 3] = 255;
    }
  }

  return png;
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

for (const digit of Object.keys(DIGITS)) {
  for (const variant of ['good', 'bad']) {
    const png = drawTile(digit, variant);
    const outPath = path.join(OUTPUT_DIR, `${digit}-${variant}.png`);
    png.pack().pipe(fs.createWriteStream(outPath)).on('finish', () => {
      console.log(`Wrote ${outPath}`);
    });
  }
}
