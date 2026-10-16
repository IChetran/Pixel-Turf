// Shared canvas renderer. Used by the host (full map / follow cam) and by phones (follow cam).
// Coordinates: tile (i,j) covers [i,i+1) x [j,j+1). camX/camY is the world point at screen center.

const lightCache = new Map();

export function lighten(hex, amt = 0.5) {
  const key = hex + amt;
  let v = lightCache.get(key);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const m = (c) => Math.round(c + (255 - c) * amt);
  v = `rgb(${m(r)},${m(g)},${m(b)})`;
  lightCache.set(key, v);
  return v;
}

export function drawWorld(ctx, v) {
  const { W, H, map, owner, colorOf, players, camX, camY, cell, selfPid, t } = v;
  const effects = v.effects || [];

  ctx.fillStyle = '#05070f';
  ctx.fillRect(0, 0, W, H);

  const X = (i) => Math.round(W / 2 + (i - camX) * cell);
  const Y = (j) => Math.round(H / 2 + (j - camY) * cell);

  // map floor
  const mx0 = X(0), my0 = Y(0), mx1 = X(map.w), my1 = Y(map.h);
  ctx.fillStyle = '#0d1226';
  ctx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);

  const i0 = Math.max(0, Math.floor(camX - W / 2 / cell) - 1);
  const i1 = Math.min(map.w - 1, Math.ceil(camX + W / 2 / cell) + 1);
  const j0 = Math.max(0, Math.floor(camY - H / 2 / cell) - 1);
  const j1 = Math.min(map.h - 1, Math.ceil(camY + H / 2 / cell) + 1);

  // claimed tiles
  ctx.globalAlpha = 0.88;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const o = owner(i, j);
      if (!o) continue;
      ctx.fillStyle = colorOf(o);
      const x = X(i), y = Y(j);
      ctx.fillRect(x, y, X(i + 1) - x, Y(j + 1) - y);
    }
  }
  ctx.globalAlpha = 1;

  // faint tile grid
  if (cell >= 9) {
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const yTop = Y(j0), yBot = Y(j1 + 1), xLeft = X(i0), xRight = X(i1 + 1);
    for (let i = i0; i <= i1 + 1; i++) { const x = X(i) + 0.5; ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); }
    for (let j = j0; j <= j1 + 1; j++) { const y = Y(j) + 0.5; ctx.moveTo(xLeft, y); ctx.lineTo(xRight, y); }
    ctx.stroke();
  }

  // territory borders: only edges where the neighbour is not the same owner
  const th = Math.max(2, Math.min(6, Math.round(cell * 0.13)));
  const at = (a, b) => (a < 0 || b < 0 || a >= map.w || b >= map.h ? '#void' : owner(a, b));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const o = owner(i, j);
      if (!o) continue;
      const x = X(i), y = Y(j), w = X(i + 1) - x, h = Y(j + 1) - y;
      ctx.fillStyle = lighten(colorOf(o), 0.6);
      if (at(i, j - 1) !== o) ctx.fillRect(x, y, w, th);
      if (at(i, j + 1) !== o) ctx.fillRect(x, y + h - th, w, th);
      if (at(i - 1, j) !== o) ctx.fillRect(x, y, th, h);
      if (at(i + 1, j) !== o) ctx.fillRect(x + w - th, y, th, h);
    }
  }

  // map edge
  ctx.strokeStyle = '#3d5bff';
  ctx.lineWidth = 3;
  ctx.strokeRect(mx0 - 1.5, my0 - 1.5, mx1 - mx0 + 3, my1 - my0 + 3);

  // claim pops
  for (const e of effects) {
    const age = (t - e.t0) / 450;
    if (age < 0 || age > 1) continue;
    const s = cell * (1 + age * 1.1);
    const cx = X(e.x) + cell / 2, cy = Y(e.y) + cell / 2;
    ctx.globalAlpha = 1 - age;
    ctx.strokeStyle = lighten(e.color, 0.7);
    ctx.lineWidth = Math.max(2, cell * 0.08);
    ctx.strokeRect(cx - s / 2, cy - s / 2, s, s);
  }
  ctx.globalAlpha = 1;

  // players: you ARE the highlighted tile
  const labelPx = Math.max(10, Math.min(18, cell * 0.42));
  ctx.font = `700 ${labelPx}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const pulse = 0.5 + 0.5 * Math.sin(t / 170);
  // draw self last so it's on top
  const ordered = players.slice().sort((a, b) => (a.pid === selfPid) - (b.pid === selfPid));
  for (const p of ordered) {
    const x = Math.round(W / 2 + (p.x - camX) * cell), y = Math.round(H / 2 + (p.y - camY) * cell);
    if (x < -cell * 2 || y < -cell * 2 || x > W + cell || y > H + cell) continue;
    const s = Math.round(cell);
    const self = p.pid === selfPid;

    ctx.fillStyle = `rgba(255,255,255,${0.1 + 0.16 * pulse})`;
    ctx.fillRect(x, y, s, s);

    if (p.prog > 0.01) {
      const hh = Math.round(s * p.prog);
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = p.color;
      ctx.fillRect(x, y + s - hh, s, hh);
      ctx.globalAlpha = 1;
    }

    ctx.save();
    if (self) { ctx.shadowColor = p.color; ctx.shadowBlur = cell * 0.6; }
    const lw = self ? Math.max(2, cell * 0.09) : Math.max(1.5, cell * 0.06);
    ctx.lineWidth = lw;
    ctx.strokeStyle = self ? '#ffffff' : lighten(p.color, 0.7);
    ctx.strokeRect(x + lw / 2, y + lw / 2, s - lw, s - lw);
    ctx.restore();

    const d = s * 0.26;
    ctx.fillStyle = self ? '#ffffff' : lighten(p.color, 0.75);
    ctx.fillRect(x + (s - d) / 2, y + (s - d) / 2, d, d);

    if (p.name) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(5,7,15,0.9)';
      ctx.strokeText(p.name, x + s / 2, y - 4);
      ctx.fillStyle = self ? '#ffffff' : lighten(p.color, 0.8);
      ctx.fillText(p.name, x + s / 2, y - 4);
    }
  }
}

// Minimap: tiles drawn 1px each into a small canvas that CSS scales up with pixelated rendering.
export function rebuildMini(canvas, map, entries, colorOf) {
  if (canvas.width !== map.w) canvas.width = map.w;
  if (canvas.height !== map.h) canvas.height = map.h;
  const c = canvas.getContext('2d');
  c.fillStyle = '#0d1226';
  c.fillRect(0, 0, map.w, map.h);
  for (const [idx, pid] of entries) {
    c.fillStyle = colorOf(pid);
    c.fillRect(idx % map.w, Math.floor(idx / map.w), 1, 1);
  }
}

// Overlay on top of the minimap: viewport rectangle and player dots. Cheap, redrawn every frame.
export function drawMiniOverlay(canvas, map, players, selfPid, view, t) {
  const c = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  c.clearRect(0, 0, W, H);
  const sx = W / map.w, sy = H / map.h;
  for (const p of players) {
    if (p.pid === selfPid) continue;
    c.fillStyle = lighten(p.color, 0.6);
    c.fillRect(p.x * sx - 1, p.y * sy - 1, 3, 3);
  }
  const me = players.find((p) => p.pid === selfPid);
  if (me) {
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 1;
    c.strokeRect((view.camX - view.cols / 2) * sx, (view.camY - view.rows / 2) * sy, view.cols * sx, view.rows * sy);
    if (Math.floor(t / 250) % 2 === 0) {
      c.fillStyle = '#fff';
      c.fillRect(me.x * sx - 2, me.y * sy - 2, 5, 5);
    }
  }
}
