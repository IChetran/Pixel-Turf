// Pure game logic. No DOM, no network, so it can be unit-tested in node.
// The HOST runs this. Phones only send joystick direction and render what the host broadcasts.

export const DEFAULTS = {
  w: 60,
  h: 60,
  claimMs: 1000, // stand still on a free tile this long to claim it
  stealMs: 2000, // stand still on an enemy tile this long to steal it
  stepMs: 140,   // time between moves while the joystick is held (~7 tiles/sec)
};

export class Game {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.w = o.w;
    this.h = o.h;
    this.claimMs = o.claimMs;
    this.stealMs = o.stealMs;
    this.stepMs = o.stepMs;
    this.rand = opts.rand || Math.random;
    this.cells = new Array(this.w * this.h).fill(null); // owner pid or null
    this.players = new Map(); // pid -> player state
    this.counts = new Map();  // pid -> tiles owned
    this.changes = new Map(); // cell idx -> pid, pending broadcast
    this.lastTick = null;
  }

  idx(x, y) { return y * this.w + x; }

  addPlayer(pid, now = 0) {
    if (this.players.has(pid)) return this.players.get(pid);
    const [x, y] = this._spawnSpot();
    const p = this._blank(pid, x, y, now);
    this.players.set(pid, p);
    if (!this.counts.has(pid)) this.counts.set(pid, 0);
    this._setOwner(this.idx(x, y), pid, now); // you start with your spawn tile
    return p;
  }

  // Used when the host tab is refreshed mid-game and state is rebuilt from the database.
  placePlayer(pid, x, y) {
    let p = this.players.get(pid);
    if (!p) { p = this._blank(pid, x, y, 0); this.players.set(pid, p); }
    p.x = x; p.y = y;
    if (!this.counts.has(pid)) this.counts.set(pid, 0);
    return p;
  }

  loadCell(idx, pid) {
    const prev = this.cells[idx];
    if (prev) this.counts.set(prev, (this.counts.get(prev) || 1) - 1);
    this.cells[idx] = pid;
    this.counts.set(pid, (this.counts.get(pid) || 0) + 1);
  }

  _blank(pid, x, y, now) {
    return { pid, x, y, dx: 0, dy: 0, moveAt: 0, stand: 0, prog: 0, key: '', reachedAt: now };
  }

  _spawnSpot() {
    const n = this.players.size;
    let minD = Math.max(4, Math.floor(Math.sqrt((this.w * this.h) / (n + 2)) * 0.7));
    const m = 2;
    for (let tries = 0; tries < 600; tries++) {
      if (tries > 0 && tries % 100 === 0 && minD > 1) minD--;
      const x = m + Math.floor(this.rand() * (this.w - 2 * m));
      const y = m + Math.floor(this.rand() * (this.h - 2 * m));
      if (this.cells[this.idx(x, y)]) continue;
      let ok = true;
      for (const p of this.players.values()) {
        if (Math.abs(p.x - x) + Math.abs(p.y - y) < minD) { ok = false; break; }
      }
      if (ok) return [x, y];
    }
    return [Math.floor(this.rand() * this.w), Math.floor(this.rand() * this.h)];
  }

  _setOwner(idx, pid, now) {
    const prev = this.cells[idx];
    if (prev === pid) return;
    if (prev) this.counts.set(prev, (this.counts.get(prev) || 1) - 1);
    this.cells[idx] = pid;
    this.counts.set(pid, (this.counts.get(pid) || 0) + 1);
    this.changes.set(idx, pid);
    const p = this.players.get(pid);
    if (p) p.reachedAt = now;
  }

  // Only one axis at a time, values clamped to -1/0/1. Never trust phone input.
  setDir(pid, dx, dy) {
    const p = this.players.get(pid);
    if (!p) return;
    dx = Math.sign(Number(dx) || 0);
    dy = Math.sign(Number(dy) || 0);
    if (dx && dy) dy = 0;
    p.dx = dx; p.dy = dy;
  }

  // Advance the game to time `now` (ms). Returns true if anyone moved.
  tick(now) {
    const dt = this.lastTick == null ? 0 : Math.min(200, now - this.lastTick);
    this.lastTick = now;
    let moved = false;
    for (const p of this.players.values()) {
      if (p.dx || p.dy) {
        // moving cancels any claim in progress
        p.stand = 0; p.prog = 0; p.key = '';
        if (now >= p.moveAt) {
          const nx = p.x + p.dx, ny = p.y + p.dy;
          if (nx >= 0 && ny >= 0 && nx < this.w && ny < this.h) { p.x = nx; p.y = ny; moved = true; }
          p.moveAt = now + this.stepMs;
        }
        continue;
      }
      const i = this.idx(p.x, p.y);
      const owner = this.cells[i];
      if (owner === p.pid) { p.stand = 0; p.prog = 0; p.key = ''; continue; }
      const key = i + ':' + (owner || '');
      if (key !== p.key) { p.key = key; p.stand = 0; } // tile changed hands under you: restart
      const need = owner ? this.stealMs : this.claimMs;
      p.stand += dt;
      p.prog = Math.min(1, p.stand / need);
      if (p.stand >= need) {
        this._setOwner(i, p.pid, now);
        p.stand = 0; p.prog = 0; p.key = '';
      }
    }
    return moved;
  }

  // Take pending cell changes (idx -> pid) and clear them.
  drain() {
    const c = this.changes;
    this.changes = new Map();
    return c;
  }

  packPos() {
    const out = [];
    for (const p of this.players.values()) out.push(`${p.pid},${p.x},${p.y},${Math.round(p.prog * 99)}`);
    return out.join(';');
  }

  ranking() {
    return [...this.players.values()]
      .map((p) => ({ pid: p.pid, count: this.counts.get(p.pid) || 0, at: p.reachedAt }))
      .sort((a, b) => b.count - a.count || a.at - b.at);
  }
}
