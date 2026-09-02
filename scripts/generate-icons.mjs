/**
 * Uygulama simgelerini koddan üretir — dış bağımlılık ve fotoğraf kullanmadan.
 *
 *   npm run icons
 *
 * Marka işareti: koyu zemin üzerinde altın rengi bir madeni para ve içinde
 * yukarı yönlü bir işaret (takip / artış). Kişiye özel logo veya fotoğraf yoktur.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OUT_DIR = resolve(process.cwd(), "public/icons");

const COLORS = {
  bg: [13, 16, 20, 255],
  coin: [224, 184, 78, 255],
  coinDark: [176, 138, 45, 255],
  mark: [13, 16, 20, 255],
};

const SS = 3; // kenar yumuşatma için süper örnekleme

function createCanvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function blend(canvas, x, y, color, coverage) {
  if (coverage <= 0) return;
  const index = (y * canvas.size + x) * 4;
  const alpha = (color[3] / 255) * coverage;
  for (let channel = 0; channel < 3; channel += 1) {
    canvas.data[index + channel] =
      canvas.data[index + channel] * (1 - alpha) + color[channel] * alpha;
  }
  canvas.data[index + 3] = canvas.data[index + 3] * (1 - alpha) + 255 * alpha;
}

function paint(canvas, color, test) {
  const step = 1 / SS;
  const offset = step / 2;
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          if (test(x + sx * step + offset, y + sy * step + offset)) hits += 1;
        }
      }
      if (hits > 0) blend(canvas, x, y, color, hits / (SS * SS));
    }
  }
}

const roundedRect = (x0, y0, x1, y1, radius) => (px, py) => {
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= radius * radius;
};

const ring = (cx, cy, outer, inner) => (px, py) => {
  const distance = Math.hypot(px - cx, py - cy);
  return distance <= outer && distance >= inner;
};

const disc = (cx, cy, radius) => (px, py) => Math.hypot(px - cx, py - cy) <= radius;

function segment(x0, y0, x1, y1, width) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;
  return (px, py) => {
    const t =
      lengthSquared === 0
        ? 0
        : Math.min(1, Math.max(0, ((px - x0) * dx + (py - y0) * dy) / lengthSquared));
    const nearestX = x0 + t * dx;
    const nearestY = y0 + t * dy;
    return Math.hypot(px - nearestX, py - nearestY) <= width / 2;
  };
}

function union(...tests) {
  return (px, py) => tests.some((test) => test(px, py));
}

function drawIcon(size, { maskable }) {
  const canvas = createCanvas(size);
  const unit = size / 512;

  // Zemin: standart simgede yuvarlatılmış kare, maskable'da tam kare.
  if (maskable) {
    paint(canvas, COLORS.bg, () => true);
  } else {
    paint(canvas, COLORS.bg, roundedRect(0, 0, size, size, 112 * unit));
  }

  // Maskable simgede içerik güvenli alanda (merkezin %80'i) kalır.
  const scale = maskable ? 0.78 : 1;
  const cx = size / 2;
  const cy = size / 2;
  const coinRadius = 168 * unit * scale;

  paint(canvas, COLORS.coin, disc(cx, cy, coinRadius));
  paint(canvas, COLORS.coinDark, ring(cx, cy, coinRadius, coinRadius - 14 * unit * scale));

  // Yukarı yönlü işaret: takip edilen değerin yönünü anlatır.
  const armLength = 74 * unit * scale;
  const stroke = 34 * unit * scale;
  const apexY = cy - 46 * unit * scale;
  const baseY = cy + 28 * unit * scale;

  paint(
    canvas,
    COLORS.mark,
    union(
      segment(cx - armLength, baseY, cx, apexY, stroke),
      segment(cx, apexY, cx + armLength, baseY, stroke),
      segment(cx, apexY + 4 * unit * scale, cx, cy + 92 * unit * scale, stroke),
    ),
  );

  return canvas;
}

// ---------------------------------------------------------------- PNG kodlama

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(canvas) {
  const { size, data } = canvas;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let cursor = 0;
  for (let y = 0; y < size; y += 1) {
    raw[cursor] = 0; // filtre: none
    cursor += 1;
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      raw[cursor] = Math.round(data[index]);
      raw[cursor + 1] = Math.round(data[index + 1]);
      raw[cursor + 2] = Math.round(data[index + 2]);
      raw[cursor + 3] = Math.round(data[index + 3]);
      cursor += 4;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit derinliği
  header[9] = 6; // renk tipi: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function write(file, buffer) {
  const target = resolve(OUT_DIR, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buffer);
  console.log(`  ${file} (${buffer.length} bayt)`);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Altın Takip">
  <rect width="512" height="512" rx="112" fill="#0d1014"/>
  <circle cx="256" cy="256" r="168" fill="#e0b84e"/>
  <circle cx="256" cy="256" r="161" fill="none" stroke="#b08a2d" stroke-width="14"/>
  <path d="M182 284 256 210 330 284" fill="none" stroke="#0d1014" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M256 214 256 348" fill="none" stroke="#0d1014" stroke-width="34" stroke-linecap="round"/>
</svg>
`;

console.log("Simgeler üretiliyor...");
write("icon.svg", Buffer.from(SVG, "utf8"));
write("icon-192.png", encodePng(drawIcon(192, { maskable: false })));
write("icon-512.png", encodePng(drawIcon(512, { maskable: false })));
write("maskable-512.png", encodePng(drawIcon(512, { maskable: true })));
write("apple-touch-icon.png", encodePng(drawIcon(180, { maskable: true })));
console.log("Tamamlandı.");
