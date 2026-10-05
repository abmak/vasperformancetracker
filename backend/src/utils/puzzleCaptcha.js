/**
 * Slider puzzle captcha — server-side challenge generation and verification.
 *
 * Zero-dependency: draws a random scene into an RGBA buffer, cuts a puzzle piece
 * out of it, encodes both as PNG with Node's built-in zlib (no canvas/sharp/npm —
 * the production VPS has no npm registry access).
 *
 * Flow:
 *   GET  /api/auth/captcha -> { id, bg, piece, piece_y, width, height, piece_size }
 *   POST /api/auth/login   -> body includes captcha_id + captcha_x
 *
 * Security notes:
 *  - The piece X position never leaves the server; the client submits the answer.
 *  - HMAC-signed, short TTL, and single-use. Verification is stateless, so any
 *    worker can check a challenge; the single-use claim and the rate-limit
 *    counter are kept by the cluster primary (utils/sharedState.js) so both
 *    hold across workers.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { consumeOnce, rateHit } = require('./sharedState');

const W = 240, H = 160;          // background image size (width kept compact per UX request)
const S = 52;                    // puzzle piece size
const TOLERANCE = 8;             // accepted |answer - truth| in px
const TTL_MS = 3 * 60 * 1000;    // challenge lifetime

const SECRET = process.env.CAPTCHA_SECRET ||
  crypto.createHash('sha256').update(String(process.env.JWT_SECRET || 'vas-captcha-fallback')).digest('hex');

/* ── Tiny PNG encoder (RGBA, non-interlaced) ──────────────────────────────── */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba = full RGBA frame; rows are prefixed with filter byte 0 in the PNG stream */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type 6 = RGBA
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── Drawing helpers (RGBA buffer) ────────────────────────────────────────── */

function setPx(buf, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a === undefined ? 255 : a;
}

function fillRect(buf, x0, y0, w, h, col) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(buf, x, y, col[0], col[1], col[2]);
}

function fillCircle(buf, cx, cy, rad, col) {
  const r2 = rad * rad;
  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) setPx(buf, x, y, col[0], col[1], col[2]);
    }
  }
}

function drawLine(buf, x0, y0, x1, y1, col, thick) {
  const th = thick || 1;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + (x1 - x0) * i / steps);
    const y = Math.round(y0 + (y1 - y0) * i / steps);
    for (let t = -th; t <= th; t++) for (let s = -th; s <= th; s++) setPx(buf, x + t, y + s, col[0], col[1], col[2]);
  }
}

/* ── Scene generation ─────────────────────────────────────────────────────── */

const PALETTES = [
  [[22, 101, 52], [34, 197, 94], [74, 222, 128], [134, 239, 172], [240, 253, 244]],   // greens
  [[30, 58, 138], [59, 130, 246], [96, 165, 250], [147, 197, 253], [239, 246, 255]],   // blues
  [[180, 83, 9], [245, 158, 11], [251, 191, 36], [254, 243, 199], [255, 251, 235]],    // ambers
  [[91, 33, 182], [147, 51, 234], [192, 132, 252], [233, 213, 255], [250, 245, 255]],  // purples
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lerp(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Draw a deterministic random scene; return { bg, piece, pieceY, pieceX } */
function buildScene(rand) {
  const pal = PALETTES[Math.floor(rand() * PALETTES.length)];
  const [c0, c1, c2, c3, c4] = pal;
  const bg = Buffer.alloc(W * H * 4, 255);

  // vertical gradient background
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const c = t < 0.5 ? lerp(c0, c1, t * 2) : lerp(c1, c2, (t - 0.5) * 2);
    for (let x = 0; x < W; x++) setPx(bg, x, y, c[0], c[1], c[2]);
  }

  // scattered shapes (deterministic per seed)
  const nShapes = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < nShapes; i++) {
    const col = [c1, c2, c3][Math.floor(rand() * 3)];
    const size = 14 + Math.floor(rand() * 26);
    const x = Math.floor(rand() * (W - 80)) + 40;
    const y = Math.floor(rand() * (H - 80)) + 40;
    if (rand() < 0.5) fillCircle(bg, x, y, size, col);
    else fillRect(bg, x, y, size, size, col);
  }

  // a few texture lines
  for (let i = 0; i < 3; i++) {
    const col = i % 2 ? c3 : c4;
    drawLine(bg, rand() * W, rand() * H, rand() * W, rand() * H, col, 1);
  }

  // piece position (hole must stay reachable: pieceX <= W - S)
  const pieceX = 60 + Math.floor(rand() * (W - S - 100));
  const pieceY = 20 + Math.floor(rand() * (H - S - 40));

  // extract the piece
  const piece = Buffer.alloc(S * S * 4, 0);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const src = ((pieceY + y) * W + (pieceX + x)) * 4;
      const dst = (y * S + x) * 4;
      piece[dst] = bg[src]; piece[dst + 1] = bg[src + 1]; piece[dst + 2] = bg[src + 2]; piece[dst + 3] = 255;
    }
  }

  // punch a dark hole where the piece came from, with a light border
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = ((pieceY + y) * W + (pieceX + x)) * 4;
      const edge = (x === 0 || y === 0 || x === S - 1 || y === S - 1);
      if (edge) {
        bg[i] = 245; bg[i + 1] = 245; bg[i + 2] = 245; bg[i + 3] = 255;
      } else {
        bg[i] = Math.floor(bg[i] * 0.30); bg[i + 1] = Math.floor(bg[i + 1] * 0.30); bg[i + 2] = Math.floor(bg[i + 2] * 0.30); bg[i + 3] = 255;
      }
    }
  }

  return { bg, piece, pieceY, pieceX };
}

/* ── Challenge sign / verify (stateless) ──────────────────────────────────── */

function signPayload(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function issueChallenge() {
  const now = Date.now();
  const rand = mulberry32(crypto.randomInt(0, 2 ** 31));
  const { bg, piece, pieceY, pieceX } = buildScene(rand);
  const payload = `${now}.${pieceX}`;
  const sig = signPayload(payload);
  return {
    id: `${payload}.${sig}`,
    bg: `data:image/png;base64,${encodePng(W, H, bg).toString('base64')}`,
    piece: `data:image/png;base64,${encodePng(S, S, piece).toString('base64')}`,
    piece_y: pieceY,
    width: W, height: H, piece_size: S,
  };
}

async function verifyChallenge(id, answerX) {
  const parts = String(id || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [ts, truth, sig] = parts;
  const expect = signPayload(`${ts}.${truth}`);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad-sig' };
  const issued = Number(ts);
  if (!Number.isFinite(issued) || Date.now() - issued > TTL_MS) return { ok: false, reason: 'expired' };

  // Single-use: ANY verification attempt (right or wrong) consumes the
  // challenge, so a solved puzzle cannot be replayed for more guesses within
  // its TTL. Frontend fetches a fresh puzzle after every failed login.
  if (await consumeOnce(sig, issued + TTL_MS - Date.now())) return { ok: false, reason: 'used' };

  const ans = Number(answerX);
  if (!Number.isFinite(ans)) return { ok: false, reason: 'no-answer' };
  if (Math.abs(ans - Number(truth)) > TOLERANCE) return { ok: false, reason: 'wrong' };
  return { ok: true };
}

/* ── Per-IP rate limit for the captcha endpoint ───────────────────────────── */

const RATE_LIMIT = 30;      // challenges per IP per minute
const RATE_WINDOW_MS = 60_000;

async function captchaRateLimit(req, res, next) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  try {
    const hits = await rateHit(`captcha:${ip}`, RATE_WINDOW_MS);
    if (hits > RATE_LIMIT) return res.status(429).json({ error: 'Too many captcha requests. Wait a minute.' });
  } catch {
    // Never let the limiter itself block a legitimate login page.
  }
  next();
}

module.exports = { issueChallenge, verifyChallenge, captchaRateLimit, TOLERANCE, TTL_MS };
