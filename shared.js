// Small helpers shared by host and phone pages.

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const x = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${x(f(0))}${x(f(8))}${x(f(4))}`;
}

// 36 colours: 12 hues x 3 tones. Taken colours get disabled on the join screen.
export const PALETTE = (() => {
  const hues = [0, 26, 48, 74, 112, 150, 174, 196, 222, 262, 298, 330];
  const tones = [[95, 56], [100, 76], [80, 38]];
  const out = [];
  for (const [s, l] of tones) for (const h of hues) out.push(hslToHex(h, s, l));
  return out;
})();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function genCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export function genPid() {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

export function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// "pid,x,y,prog;pid,x,y,prog" -> [{pid,x,y,prog 0..1}]
export function parsePos(str) {
  if (!str) return [];
  const out = [];
  for (const part of String(str).split(';')) {
    const [pid, x, y, p] = part.split(',');
    if (!pid) continue;
    out.push({ pid, x: +x, y: +y, prog: (+p || 0) / 99 });
  }
  return out;
}

export function joinUrl(code) {
  const u = new URL('play.html', location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('r', code);
  if (new URLSearchParams(location.search).has('mock')) u.searchParams.set('mock', '1');
  return u.toString();
}

// Draws a QR code onto a canvas. Needs qrcode-generator loaded as a global (see host.html).
export function drawQR(canvas, text) {
  if (!window.qrcode) return false;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const scale = Math.max(4, Math.floor(640 / (n + quiet * 2)));
  canvas.width = canvas.height = (n + quiet * 2) * scale;
  const c = canvas.getContext('2d');
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#070a14';
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (qr.isDark(r, col)) c.fillRect((col + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
  return true;
}
